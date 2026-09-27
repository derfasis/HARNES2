import { contextFor } from './context.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { processSourceOpportunity } from './opportunity-pipeline.mjs';
import { pollSource, pollFailureKind } from './source-transport.mjs';
import { dueBrowserSources, markBrowserAttempted } from './browser-polling.mjs';
import { sourceTransportKind } from './source-ingestion.mjs';
import { sourceCheckpointState } from './source-ingestion.mjs';
import { id } from './store.mjs';
import { now } from './errors.mjs';

export class Scheduler {
  constructor(service, runtime, telegram, sourceReaders = []) { this.sourceReaders = sourceReaders; this.service = service; this.runtime = runtime; this.telegram = telegram; this.busy = false; this.stopped = false; this.lastReason = null; this.activeRun = null; this.readersAbsentReported = false; this.sourceReadersState = null; this.browserPolls = new Map(); }
  start() { this.timer = setInterval(() => this.tick().catch(() => { this.lastReason = 'Ошибка обработки очереди; подробности в журнале запуска'; }), this.service.config.scheduler.tickSeconds * 1000); }
  // `reason` normally carries the pipeline's business disposition; a source poll that was actually
  // attempted and failed may override it, because a failed poll is why the partner is doing
  // nothing. Reader absence is reported separately and never takes this slot: it is a transport
  // condition, and replacing the disposition there took away the reason an operator needs most.
  status() { return { enabled: this.service.config.scheduler.enabled, busy: this.busy, active_run: this.activeRun, reason: this.lastReason, model: runtimeReadiness(this.service.config), source_readers: this.sourceReadersState }; }
  async tick() {
    if (this.busy || this.stopped || !this.service.config.scheduler.enabled) return;
    this.busy = true;
    try {
      const cfg = this.service.config;
      if (cfg.opportunity?.automatic) {
        // A source that is configured but has no reader is not a quiet source. The poll loop
        // below skips it, it sits at its last confirmed cursor forever, and every other signal
        // keeps saying the transport is fine: the process answers, the connection is up, and
        // nothing throws. No live incident of this has been observed — the one soak that looked
        // like one turned out to be a misread on our side. It is a failure mode the code admits
        // and the diagnostics could not previously see, which is why it is reported now.
        //
        // The test is per source, not per list length. Two configured sources with one reader
        // alive is one dead source, and a system that only counted readers would call that fine.
        // Both transports are counted: a browser source that lost its reader is as unread as a
        // Telegram one, and counting only Telegram made exactly that invisible.
        const configured = [
          ...(cfg.opportunity?.telegramSources ?? []).map((policy) => ({ sourceId: policy.sourceId, kind: 'telegram' })),
          ...(cfg.opportunity?.browserSources ?? []).map((policy) => ({ sourceId: policy.sourceId, kind: 'browser' })),
        ];
        const active = new Set(this.sourceReaders.map((entry) => entry.sourceId));
        const missing = configured.filter((entry) => !active.has(entry.sourceId));
        const readersAbsent = missing.length > 0;
        // The class of the failure, per kind of what went missing. A missing browser reader has no
        // Telegram bootstrap code to report, and inventing one would file a transport's silence
        // under another transport's name.
        const causeFor = (kind) => {
          if (kind === 'browser') return 'BROWSER_READER_ABSENT';
          return typeof this.telegram?.lastSourceCode === 'string'
            && /^[A-Z][A-Z0-9_]{1,63}$/.test(this.telegram.lastSourceCode)
            ? this.telegram.lastSourceCode : 'SOURCE_READER_BOOTSTRAP_FAILED';
        };
        const missingKinds = [...new Set(missing.map((entry) => entry.kind))].sort();
        this.sourceReadersState = {
          configured_sources: configured.length, active_readers: active.size,
          missing_readers: missing.length,
          missing_telegram: missing.filter((entry) => entry.kind === 'telegram').length,
          missing_browser: missing.filter((entry) => entry.kind === 'browser').length,
          cause_code: readersAbsent ? causeFor(missingKinds[0]) : null,
        };
        if (readersAbsent && !this.readersAbsentReported) {
          this.readersAbsentReported = true;
          // Filed under the transport that went missing, so the two histories stay separately
          // readable and a Telegram reader coming back does not clear a browser reader's absence.
          const kind = missingKinds.length === 1 ? missingKinds[0] : 'source';
          try { await this.service.exclusive(() => this.service.store.transaction(
            () => this.service.store.event(cfg.partnerId, null, `source.${kind}.readers_absent`,
              'system', { ...this.sourceReadersState }))); }
          catch { /* Telemetry must never stop the queue. */ }
        } else if (!readersAbsent) this.readersAbsentReported = false;
        // Empty by default. Only a trusted bootstrap can supply narrowed read-only
        // transport capabilities. Reuse this tick, never the private-chat adapter.
        let sourceReadFailed=false, sourceReadFailure=null;
        // Telegram is polled exactly as before, every tick, all of it. Browser sources are chosen
        // by their own interval and capped per tick, because a page that has not changed in five
        // minutes does not need to be fetched every twenty seconds — and a page that is down must
        // not be retried on every tick for being down.
        const dueBrowser = dueBrowserSources(this.service, this.sourceReaders, this.browserPolls);
        for (const { sourceId, transport } of this.sourceReaders) {
          if (dueBrowser.length && !dueBrowser.some((entry) => entry.sourceId === sourceId)) {
            const kind = (() => { try { return sourceTransportKind(this.service, sourceId); }
              catch { return 'unknown'; } })();
            if (kind === 'browser') continue;   // not due yet, or over the tick's budget
          }
          try { await pollSource(this.service, sourceId, transport); }
          catch (error) {
            // A poll that fails silently is a source that can end up blocked with no evidence
            // left behind, which would otherwise leave the source failure without durable
            // evidence. Record the class of failure, the cursor it read at and the checkpoint's
            // own state, and nothing else: no message
            // text, no provider payload, no stack, no credentials.
            sourceReadFailed=true;
            // Stamped here, on the failure path as well as the success path, and before the
            // telemetry is written: a source that only backed off on success would back off never,
            // and a site that is down would be re-read on every tick for the rest of the day.
            if (sourceTransportKind(this.service, sourceId) === 'browser') {
              markBrowserAttempted(this.browserPolls, sourceId);
            }
            // Reading the checkpoint can itself fail on a corrupt row, and telemetry that throws
            // while reporting a failure would abort the very tick it is reporting about. The
            // checkpoint is the one for the transport that failed: a browser source has no pts at
            // all, so reading the Telegram cursor for it reported numbers belonging to nothing.
            let state=null;
            try { state = sourceCheckpointState(this.service, sourceId); } catch { state=null; }
            const raw=String(error?.code ?? '');
            // Only something shaped like a code is recorded. Anything else could be a provider
            // message carrying payload, and this lands in durable storage.
            const code=/^[A-Za-z0-9_.:-]{1,80}$/.test(raw) ? raw : 'UNCLASSIFIED';
            sourceReadFailure={ source_id:sourceId, code,
              checkpoint_pts:state?.pts ?? null, phase:state?.phase ?? null, reason:state?.reason ?? null };
            try { await this.service.exclusive(() => this.service.store.transaction(
              // Filed under the transport that actually failed, so a browser failure is never
              // recorded as a Telegram one and the two histories stay separately readable.
              () => this.service.store.event(cfg.partnerId, null, pollFailureKind(this.service, sourceId), 'system', sourceReadFailure))); }
            catch { /* Telemetry must never stop the queue. */ }
          }
          // Stamped after the attempt, success or failure alike. Kept separate from the catch above
          // so the two paths cannot drift: a stamp only in the failure branch would make a healthy
          // page look permanently due, and a stamp only on success would make a broken one so.
          if (sourceTransportKind(this.service, sourceId) === 'browser') {
            try { markBrowserAttempted(this.browserPolls, sourceId); } catch { /* the tick still counts */ }
          }
        }
        if (cfg.discovery?.enabled === true) {
          try { await this.service.reconcileDiscovery(); }
          catch { this.lastReason = 'Discovery reconciliation failed; source truth remains durable'; }
        }
        const result = await processSourceOpportunity(this.service, this.runtime);
        // The disposition is the answer to "what is the partner doing", and a failed poll is
        // reported in that same slot because it *is* why the partner is not doing anything. A
        // missing reader is deliberately not: it is a transport fact, already recorded as an event
        // and exposed in status().source_readers, and overwriting the disposition here took away
        // the reason an operator needs most.
        this.lastReason = sourceReadFailed ? `source_read_failed:${sourceReadFailure?.code ?? 'UNCLASSIFIED'}` : result.disposition; return;
      }
      if (cfg.discovery?.enabled === true) {
        try { await this.service.reconcileDiscovery(); }
        catch { this.lastReason = 'Discovery reconciliation failed; source truth remains durable'; }
      }
      await this.service.exclusive(() => this.service.store.transaction(() => this.service.engagement.sweep()));
      if (!runtimeReadiness(cfg).ready) { this.lastReason = 'Задачи сохранены. Ожидается подключение модели.'; return; }
      const day = now().slice(0,10), count = this.service.store.get('SELECT COUNT(*) AS n,COALESCE(SUM(estimated_cost_usd),0) AS cost,SUM(CASE WHEN cost_status=\'unknown\' THEN 1 ELSE 0 END) AS unknown FROM runs WHERE created_at>=?', day);
      if (count.n >= cfg.runtime.maxRunsPerDay) { this.lastReason = 'Достигнут дневной лимит запусков (UTC)'; return; }
      if (cfg.runtime.dailyBudgetUsd !== null && (count.cost >= cfg.runtime.dailyBudgetUsd || count.unknown > 0)) {
        this.lastReason = count.unknown ? 'Стоимость предыдущего запуска неизвестна. Укажите тарифы и разберите расходы перед продолжением.' : 'Достигнут дневной порог учтённых расходов'; return;
      }
      await this.ensurePlanningTask();
      const prepared = await this.service.exclusive(() => this.service.store.transaction(() => {
        const task = this.service.store.get("SELECT * FROM tasks WHERE partner_id=? AND status='pending' AND kind NOT IN ('opportunity_review','discovery_review') AND due_at<=? ORDER BY due_at,created_at LIMIT 1", cfg.partnerId, now());
        if (!task) return null;
        if (task.conversation_id && this.service.engagement.managed(task.conversation_id)) {
          const e=this.service.engagement.current(task.conversation_id);
          if (!e || task.kind!=='engagement_evaluate' || !this.service.store.get('SELECT task_id FROM engagement_tasks WHERE task_id=? AND engagement_id=?',task.id,e.id)) {
            this.service.store.run("UPDATE tasks SET status='blocked' WHERE id=?",task.id); return null;
          }
        }
        if (task.conversation_id) {
          try { this.service.active(task.conversation_id); }
          catch { this.service.store.run("UPDATE tasks SET status='blocked' WHERE id=?", task.id); return null; }
        }
        const runId = id(), context = contextFor(this.service, task.conversation_id, task);
        this.service.store.run("UPDATE tasks SET status='running' WHERE id=?", task.id);
        this.service.store.run('INSERT INTO runs(id,partner_id,task_id,conversation_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', runId, cfg.partnerId, task.id, task.conversation_id, 'running', 'hermes', cfg.runtime.model, JSON.stringify({ ...context, model_config: cfg.runtime }), now());
        this.service.store.event(cfg.partnerId, task.conversation_id, 'run.started', 'system', { run_id: runId, task_id: task.id });
        return { run: this.service.store.get('SELECT * FROM runs WHERE id=?', runId), context };
      }));
      if (!prepared) { this.lastReason = 'Нет готовых к выполнению задач'; return; }
      const { run, context } = prepared; this.activeRun = run.id; this.lastReason = null;
      let result;
      try { result = await this.runtime.run(run, context); }
      catch (error) { result = { completed: false, error: error.message }; }
      await this.service.exclusive(() => this.service.store.transaction(() => {
        const task = this.service.store.get('SELECT * FROM tasks WHERE id=?', run.task_id);
        const decision = task.kind==='engagement_evaluate' ? this.service.store.get('SELECT * FROM engagement_decisions WHERE run_id=?',run.id) : null;
        if (task.kind==='engagement_evaluate' && result.completed && !result.error && !decision) {
          result = {...result,completed:false,error:'ENGAGEMENT_DECISION_MISSING'};
        }
        // HANDOFF/STOP deliberately cancel AI-owned work, including their own
        // running attention. A durable terminal decision from this exact run is
        // completion; unrelated cancellation remains cancellation.
        const terminal = result.completed && !result.error && ['HANDOFF','STOP'].includes(decision?.kind);
        const cancelled = task.status === 'cancelled' && !terminal, status = cancelled ? 'cancelled' : result.completed && !result.error ? 'completed' : 'failed';
        const { input, output, cost, costStatus } = usageAccounting(cfg.runtime, result.usage);
        this.service.store.run('UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?', status, JSON.stringify(result), result.error ? String(result.error).slice(0,2000) : null, input, output, cost, costStatus, now(), run.id);
        if (!cancelled) this.service.store.run('UPDATE tasks SET status=? WHERE id=?', status === 'completed' ? 'done' : 'failed', task.id);
        this.service.store.event(cfg.partnerId, run.conversation_id, `run.${status}`, 'system', { run_id: run.id, task_id: task.id, cost_status: costStatus });
      }));
      if (run.conversation_id && result.completed && !result.error) {
        await this.service.exclusive(() => this.service.store.transaction(() => this.service.autopilotHandoff(run.id)));
        const readiness = this.telegram?.readiness();
        const sendReady = readiness?.enabled && readiness.live_sending && (readiness.configured || readiness.connected);
        if (sendReady) for (const draft of this.service.autopilotCandidates(run.id)) {
          try {
            await this.service.exclusive(() => this.service.store.transaction(() => this.service.approveAutopilot(draft.id, run.id)));
            await this.telegram.sendApproved(draft.id, { autopilot: true });
          } catch (error) {
            await this.service.exclusive(() => this.service.store.transaction(() => this.service.store.event(cfg.partnerId, run.conversation_id, 'autopilot.blocked', 'system', { draft_id: draft.id, run_id: run.id, model: cfg.runtime.model, reason: error.message })));
          }
        }
      }
    } finally { this.busy = false; this.activeRun = null; }
  }
  async ensurePlanningTask() {
    const cfg = this.service.config.scheduler; if (!cfg.dailyPlanning) return;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts().map(p => [p.type,p.value]));
    if (Number(parts.hour) < cfg.planningHour) return;
    const key = `planning:${parts.year}-${parts.month}-${parts.day}`;
    await this.service.exclusive(() => this.service.store.transaction(() => this.service.addTask({ kind: 'planning', title: 'План партнёра на день', instructions: 'Просмотри цель, незавершённые дела и доступные сведения. Предложи несколько полезных следующих действий; не дублируй существующие задачи.', due_at: now(), dedupe_key: key }, 'system', 'pending')));
  }
  cancel(runId) { this.runtime.cancel(runId); }
  stop() { this.stopped = true; clearInterval(this.timer); this.runtime.close(); }
}
