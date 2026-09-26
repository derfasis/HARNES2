import { contextFor } from './context.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { processSourceOpportunity } from './opportunity-pipeline.mjs';
import { pollTelegramSource } from './sources/telegram-readonly.mjs';
import { sourceCheckpoint } from './source-ingestion.mjs';
import { id } from './store.mjs';
import { now } from './errors.mjs';

export class Scheduler {
  constructor(service, runtime, telegram, sourceReaders = []) { this.sourceReaders = sourceReaders; this.service = service; this.runtime = runtime; this.telegram = telegram; this.busy = false; this.stopped = false; this.lastReason = null; this.activeRun = null; this.readersAbsentReported = false; }
  start() { this.timer = setInterval(() => this.tick().catch(() => { this.lastReason = 'Ошибка обработки очереди; подробности в журнале запуска'; }), this.service.config.scheduler.tickSeconds * 1000); }
  status() { return { enabled: this.service.config.scheduler.enabled, busy: this.busy, active_run: this.activeRun, reason: this.lastReason, model: runtimeReadiness(this.service.config) }; }
  async tick() {
    if (this.busy || this.stopped || !this.service.config.scheduler.enabled) return;
    this.busy = true;
    try {
      const cfg = this.service.config;
      if (cfg.opportunity?.automatic) {
        // A source that is configured but has no reader is not a quiet source. The poll loop
        // below skips it, it sits at its last confirmed cursor forever, and every other signal
        // keeps saying the transport is fine: the process answers, the connection is up, and
        // nothing throws. This happened live — the reader failed to start after a reconnect, and
        // the source froze for an hour looking healthy.
        //
        // The test is per source, not per list length. Two configured sources with one reader
        // alive is one dead source, and a system that only counted readers would call that fine.
        const configured = (cfg.opportunity?.telegramSources ?? []).map((policy) => policy.sourceId);
        const active = new Set(this.sourceReaders.map((entry) => entry.sourceId));
        const missing = configured.filter((sourceId) => !active.has(sourceId));
        const readersAbsent = missing.length > 0;
        // Numbers and a code, never a source id and never the message behind the failure.
        this.lastReadersAbsentCause = typeof this.telegram?.lastSourceCode === 'string'
          && /^[A-Z][A-Z0-9_]{1,63}$/.test(this.telegram.lastSourceCode)
          ? this.telegram.lastSourceCode : 'SOURCE_READER_BOOTSTRAP_FAILED';
        if (readersAbsent && !this.readersAbsentReported) {
          this.readersAbsentReported = true;
          try { await this.service.exclusive(() => this.service.store.transaction(
            () => this.service.store.event(cfg.partnerId, null, 'source.telegram.readers_absent',
              'system', { configured_sources: configured.length, active_readers: active.size,
                missing_readers: missing.length, cause_code: this.lastReadersAbsentCause }))); }
          catch { /* Telemetry must never stop the queue. */ }
        } else if (!readersAbsent) this.readersAbsentReported = false;
        // Empty by default. Only a trusted bootstrap can supply narrowed read-only
        // transport capabilities. Reuse this tick, never the private-chat adapter.
        let sourceReadFailed=false, sourceReadFailure=null;
        for (const { sourceId, transport } of this.sourceReaders) {
          try { await pollTelegramSource(this.service, sourceId, transport); }
          catch (error) {
            // A poll that fails silently is a source that can end up blocked with no evidence
            // left behind, which is exactly what happened live. Record the class of failure, the
            // cursor it read at and the checkpoint's own state, and nothing else: no message
            // text, no provider payload, no stack, no credentials.
            sourceReadFailed=true;
            // Reading the checkpoint can itself fail on a corrupt row, and telemetry that throws
            // while reporting a failure would abort the very tick it is reporting about.
            let state=null;
            try { state=sourceCheckpoint(this.service, sourceId); } catch { state=null; }
            const raw=String(error?.code ?? '');
            // Only something shaped like a code is recorded. Anything else could be a provider
            // message carrying payload, and this lands in durable storage.
            const code=/^[A-Za-z0-9_.:-]{1,80}$/.test(raw) ? raw : 'UNCLASSIFIED';
            sourceReadFailure={ source_id:sourceId, code,
              checkpoint_pts:state?.pts ?? null, phase:state?.phase ?? null, reason:state?.reason ?? null };
            try { await this.service.exclusive(() => this.service.store.transaction(
              () => this.service.store.event(cfg.partnerId, null, 'source.telegram.poll.failed', 'system', sourceReadFailure))); }
            catch { /* Telemetry must never stop the queue. */ }
          }
        }
        if (cfg.discovery?.enabled === true) {
          try { await this.service.reconcileDiscovery(); }
          catch { this.lastReason = 'Discovery reconciliation failed; source truth remains durable'; }
        }
        const result = await processSourceOpportunity(this.service, this.runtime);
        // No reader outranks every other reason: a source nobody is reading makes whatever the
        // opportunity pass reports about that source worth nothing.
        this.lastReason = readersAbsent ? `source_readers_absent:${this.lastReadersAbsentCause ?? 'SOURCE_READER_BOOTSTRAP_FAILED'}`
          : sourceReadFailed?`source_read_failed:${sourceReadFailure?.code ?? 'UNCLASSIFIED'}`:result.disposition; return;
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
