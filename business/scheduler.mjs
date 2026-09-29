import { contextFor } from './context.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { processSourceOpportunity } from './opportunity-pipeline.mjs';
import { pollSource, pollFailureKind } from './source-transport.mjs';
import { dueBrowserSources, markBrowserConsidered, markBrowserRead } from './browser-polling.mjs';
import { sourceTransportKind } from './source-ingestion.mjs';
import { sourceCheckpointState } from './source-ingestion.mjs';
import { id } from './store.mjs';
import { now } from './errors.mjs';
import { processContinuity } from './continuity-reasoning.mjs';
import { ActionRuntime } from './action-runtime.mjs';
import { processActionPlan } from './action-reasoning.mjs';
import { processExecutive } from './executive-reasoning.mjs';

export class Scheduler {
  constructor(service, runtime, telegram, sourceReaders = []) { this.sourceReaders = sourceReaders; this.service = service; this.runtime = runtime; this.telegram = telegram; this.busy = false; this.reasonBusy = false; this.stopped = false; this.lastReason = null; this.sourceReadReason = null; this.activeRun = null; this.readersAbsentReported = false; this.sourceReadersState = null; this.browserPolls = new Map(); this.sourceReadFailures = new Map();
    // Tri-state on purpose. `false` is a claim — "a reconciliation was attempted and it failed" —
    // and a partner that has not run a pass yet has made no such claim. Reporting `false` at cold
    // start told the operator the partner was broken when the only true thing was that it had not
    // looked yet. `null` is that third answer, and reasoning treats it exactly like `false`: not
    // established is not healthy, and the model still does not run.
    this.continuityHealthy = null; this.executiveHealthy = null; this.actionHealthy = null;
    this.actionRuntime = new ActionRuntime(service, { ready: () => !this.stopped && !this.busy
      && this.continuityHealthy === true && this.executiveHealthy === true && this.actionHealthy === true }); }
  // Two loops, one clock, on purpose.
  //
  // The source loop is the partner's eyes: it polls readers, advances watch cursors and retires
  // revoked scope. It calls no model. The reasoning loop is the partner's head: Continuity,
  // Opportunity and Executive each make one bounded inference. They are separate timers because a
  // head that thinks for three minutes must not cost the eyes three minutes of blindness — a source
  // left unpolled goes stale against its own `maxLagSeconds`, and that staleness is the evidence
  // the reasoning loop is about to be asked to judge. A model call and a watch cursor share a
  // clock only if one of them is allowed to be wrong.
  //
  // What is NOT relaxed to get this: preparation stays durable, the answer is revalidated against
  // the basis and evidence it was given, a stale answer is discarded rather than stored, and one
  // reasoning pass at a time per scheduler. Only the *waiting* moved out of the source path.
  start() {
    const seconds = this.service.config.scheduler.tickSeconds * 1000;
    const failed = () => { this.lastReason = 'Ошибка обработки очереди; подробности в журнале запуска'; };
    // The two timers call the two halves, never `tick()`. A single timer that called the whole
    // pass would put the head back on the eyes' clock, which is the whole defect.
    this.timer = setInterval(() => this.sourceTick().catch(failed), seconds);
    this.reasonTimer = setInterval(() => this.reasonTick().catch(failed), seconds);
    this.actionTimer = setInterval(() => this.actionTick().catch(failed), seconds);
  }
  // One full pass, eyes then head, in that order. This is what an operator or a test means by
  // "run a tick", and it is what `/api/scheduler/wake` uses. The scheduled loops never call it,
  // because the guarantee that matters — that polling does not wait on inference — only holds if
  // the timers drive the halves separately.
  async tick() {
    await this.sourceTick();
    await this.reasonTick();
    await this.actionTick();
  }
  async actionTick() {
    if (this.stopped || !this.service.config.scheduler.enabled) return;
    this.actionState = await this.actionRuntime.tick();
    return this.actionState;
  }
  // `reason` normally carries the pipeline's business disposition; a source poll that was actually
  // attempted and failed may override it, because a failed poll is why the partner is doing
  // nothing. Reader absence is reported separately and never takes this slot: it is a transport
  // condition, and replacing the disposition there took away the reason an operator needs most.
  // `reason_busy` is reported beside `busy` rather than inside it: the two loops are independent,
  // and an operator looking at one long-running tick must be able to tell whether the eyes or the
  // head is the thing that is working.
  status() { return { enabled: this.service.config.scheduler.enabled, busy: this.busy, reason_busy: this.reasonBusy, action_busy: this.actionRuntime.busy, actions: this.actionState ?? { disposition: 'not_run' }, active_run: this.activeRun, reason: this.lastReason, model: runtimeReadiness(this.service.config), source_readers: this.sourceReadersState, continuity: this.continuityState ?? { disposition: 'not_run' }, executive: this.executiveState ?? { disposition: 'not_run' }, outcomes: this.outcomesState ?? { disposition: 'not_run' } }; }
  // The source loop. Poll, checkpoint, retire, discover. No model call anywhere in it.
  async sourceTick() {
    if (this.busy || this.stopped || !this.service.config.scheduler.enabled) return;
    this.busy = true;
    try {
      const cfg = this.service.config;
      // The first thing a source pass does, before any reconciliation and before anything is
      // begun. This is the only moment at which "a refresh attempt is still `running`" means "the
      // pass that owned it is gone" — it is true because `busy` admits one pass at a time, so
      // reaching this line proves the previous pass returned. Anywhere else in the system a
      // `running` refresh is simply a refresh in progress, and treating it as an orphan there
      // would kill work that is waiting on the network.
      try { await this.service.exclusive(() => this.service.store.transaction(
        () => this.service.executive.sweepOrphanedRefreshes())); }
      catch { /* Recovery must never stop the pass it is recovering. */ }
      // No model is needed to preserve watch cursors, revoke old scope, or notice a
      // deadline. Disabled continuity still retires revoked historical watches.
      //
      // Reconciliation stays here, in the loop that must keep its promise every tick, and not in
      // the reasoning loop. A revoked watch retired by a model call that is slow to be scheduled
      // is a revoked watch that keeps its authority for the length of that delay. Reconciliation
      // needs no inference, so it owes no inference any patience.
      // Set to `null` for the duration of the attempt, not to `true`. Setting `true` first is a
      // race the split introduced: this line awaits, and the reasoning loop runs on its own timer,
      // so a head pass starting during the await would read "healthy" for a reconciliation that
      // has not finished and may still fail. `null` is the honest value while the answer is not
      // known, and it withholds reasoning exactly as `false` does — a check in progress is not a
      // check that passed. Written this way the flag is only ever a claim about a *completed*
      // attempt, which is the only kind of claim worth reading.
      this.continuityHealthy = null;
      try {
        await this.service.exclusive(() => this.service.continuity.reconcile());
        // Outcome observation belongs to the source loop, not the reasoning one: what the loop
        // owes is "did anything come back", and that is a transport question. It runs before the
        // reconciliations because a window that has already closed is settled regardless of
        // whether the reasoning above it is healthy, and leaving it unsettled for want of a model
        // is how a rate silently improves because nothing was counted.
        if (cfg.outcomes?.enabled === true) {
          try { await this.service.exclusive(() => this.service.outcomes.reconcile()); }
          catch { this.outcomesState = { disposition: "reconcile_failed" }; }
        }
        this.continuityHealthy = true;
        // A reconciliation that recovers clears its own failure. The state used to be written
        // only on the way down, so one transient fault pinned the partner to
        // `reconciliation_failed` for the rest of the process even though every later pass
        // succeeded — an operator reading status() was told the partner was broken when the only
        // thing that had happened was that it had recovered.
        if (this.continuityState?.disposition === 'reconciliation_failed') this.continuityState = { disposition: 'reconciled' };
      }
      catch { this.continuityHealthy = false; this.continuityState = { disposition: 'reconciliation_failed' }; }
      this.executiveHealthy = null;
      try {
        await this.service.exclusive(() => this.service.executive.reconcile());
        this.executiveHealthy = true;
        if (this.executiveState?.disposition === 'reconciliation_failed') this.executiveState = { disposition: 'reconciled' };
      }
      catch { this.executiveHealthy = false; this.executiveState = { disposition: 'reconciliation_failed' }; }
      // The head is told which of the two reconciliations are trustworthy rather than being asked
      // to find out. A failed reconciliation is a reason to withhold derived work, and it is
      // recorded once per pass instead of being rediscovered inside every inference.
      // `let`, not `const`: both flags are cleared below when a receipt cannot be written, and
      // `const` on a name that is reassigned throws a `TypeError` at the first failure — which is
      // the exact moment this code exists to handle. The instance flags are written at the same
      // time so the next pass sees the failure too; the locals carry it through this one.
      this.actionHealthy = null;
      try { await this.service.exclusive(() => this.service.actions.reconcile()); this.actionHealthy = true; }
      catch { this.actionHealthy = false; this.actionState = { disposition: 'reconciliation_failed' }; }
      let continuityHealthy = this.continuityHealthy, executiveHealthy = this.executiveHealthy;
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
        // Whether a poll failed is now recorded per source in `sourceReadFailures` rather than
        // as one flag for the pass. The flag was the bug: a pass that read nothing reported the
        // partner healthy because nothing had been tried, not because anything had worked.
        let sourceReadFailure=null;
        // Telegram is polled exactly as before, every tick, all of it. Browser sources are chosen
        // by their own interval and capped per tick, because a page that has not changed in five
        // minutes does not need to be fetched every twenty seconds — and a page that is down must
        // not be retried on every tick for being down.
        const { selected: dueBrowser, considered } = dueBrowserSources(this.service, this.sourceReaders, this.browserPolls);
        const dueBrowserIds = new Set(dueBrowser.map((entry) => entry.sourceId));
        // Everything the tick looked at is stamped, read or not: a source that was due and
        // passed over because the budget was spent is not due again on the next tick, or the
        // budget would drain the whole list in a minute and the interval would mean nothing.
        for (const sourceId of considered) markBrowserConsidered(this.browserPolls, sourceId);
        for (const { sourceId, transport } of this.sourceReaders) {
          // Membership decides, full stop. An earlier version guarded the skip with
          // `dueBrowser.length && …`, which meant that on a tick where nothing was due the guard
          // was false, no source was skipped, and the whole cadence was skipped with it: every page
          // was re-read on every tick until one happened to be due. A set has no empty case.
          const isBrowser = sourceTransportKind(this.service, sourceId) === 'browser';
          if (isBrowser && !dueBrowserIds.has(sourceId)) continue;
          // Read sources carry a second stamp: a source that was read is older than one that was
          // merely passed over, and that is what makes the next round reach a different pair.
          if (isBrowser) markBrowserRead(this.browserPolls, sourceId);
          // Stamped once, before the attempt rather than in one branch after another, so the two
          // outcomes cannot stamp differently and so a source that fails waits exactly as long as
          // one that succeeds.
          let researchAttempts = [], pollResult = null, pollFailed = false;
          if (isBrowser && executiveHealthy) {
            try { researchAttempts = await this.service.exclusive(() => this.service.store.transaction(() => this.service.executive.beginPoll(sourceId))); }
            catch { this.executiveHealthy = false; executiveHealthy = false; this.executiveState = { disposition: 'receipt_failed' }; }
          }
          try { pollResult = await pollSource(this.service, sourceId, transport); this.sourceReadFailures.delete(sourceId); }
          catch (error) {
            pollFailed = true;
            // A poll that fails silently is a source that can end up blocked with no evidence
            // left behind, which would otherwise leave the source failure without durable
            // evidence. Record the class of failure, the cursor it read at and the checkpoint's
            // own state, and nothing else: no message
            // text, no provider payload, no stack, no credentials.
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
            // Recorded per source, and only on a real attempt. A source that was not due this
            // pass is left exactly as it was: its failure is still the truth about it until a
            // pass that actually reads it says otherwise, and the interval between two attempts
            // can be minutes. Clearing on a tick where nothing was read is how a transport stops
            // being reported while still being broken.
            this.sourceReadFailures.set(sourceId, code);
            sourceReadFailure={ source_id:sourceId, code,
              checkpoint_pts:state?.pts ?? null, phase:state?.phase ?? null, reason:state?.reason ?? null };
            try { await this.service.exclusive(() => this.service.store.transaction(
              // Filed under the transport that actually failed, so a browser failure is never
              // recorded as a Telegram one and the two histories stay separately readable.
              () => this.service.store.event(cfg.partnerId, null, pollFailureKind(this.service, sourceId), 'system', sourceReadFailure))); }
            catch { /* Telemetry must never stop the queue. */ }
          }
          if (researchAttempts.length) {
            try { await this.service.exclusive(() => this.service.store.transaction(() => this.service.executive.finishPoll(researchAttempts, pollResult, pollFailed))); }
            catch {
              // The receipt write is what makes the poll mean anything to Executive, and it is
              // the one thing here that can fail after the page was already read and ingested.
              // A failure used to leave the attempt `running` with nothing to move it: the intent
              // waited on a refresh that would never complete, and only a restart cleared it. That
              // is fail-closed, and it is also a source that is silently never refreshed again —
              // so the attempts are retired here, in a second transaction, by the same rule a
              // crash uses. A receipt that cannot be written leaves the refresh unproven, and an
              // unproven refresh must not stay in flight.
              this.executiveHealthy = false; executiveHealthy = false;
              this.executiveState = { disposition: 'receipt_failed' };
              try { await this.service.exclusive(() => this.service.store.transaction(
                () => this.service.executive.abandonPoll(researchAttempts, 'RECEIPT_PERSIST_FAILED'))); }
              catch { /* The attempts stay running; reconciliation retires them on a later pass. */ }
            }
          }
        }
        if (cfg.discovery?.enabled === true) {
          try { await this.service.reconcileDiscovery(); }
          catch { this.lastReason = 'Discovery reconciliation failed; source truth remains durable'; }
        }
        // The pipeline's business disposition is no longer computed here — it belongs to the
        // reasoning loop, and a source loop that overwrote it every twenty seconds would erase
        // whatever the head last concluded before an operator could read it. What the source loop
        // owns is the transport truth, so that is what it writes: a failed poll, or the word for
        // "the sources are current" which is what an idle partner is.
        // Derived from the unresolved set, not from whether this pass happened to fail. The set
        // only changes when a source is actually read: a failure stays until a real attempt
        // succeeds, a success clears only its own source, and a pass in which nothing was due
        // leaves every known failure standing. One failing source is never hidden by another's
        // success.
        //
        // The code is the lowest sorted one, so the same state always reads the same way. Which
        // source failed is in status().source_readers and in the durable `source.*.poll.failed`
        // event; this slot answers only "are the sources current", and a deterministic answer to
        // that is worth more than a precise one nobody can act on.
        this.sourceReadReason = this.sourceReadFailures.size
          ? `source_read_failed:${[...this.sourceReadFailures.values()].sort()[0]}`
          : null;
        this.lastReason = this.sourceReadReason ?? this.lastReason ?? 'sources_current';
        return;
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
        const task = this.service.store.get("SELECT * FROM tasks WHERE partner_id=? AND status='pending' AND kind NOT IN ('opportunity_review','discovery_review','owner_action') AND due_at<=? ORDER BY due_at,created_at LIMIT 1", cfg.partnerId, now());
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
    } finally {
      this.busy = false; this.activeRun = null;
      // Timers begin together. Wake the independent action pass after observation
      // as well, or an action timer that always sees busy=true can starve forever.
      // Do not await effects here: observation must keep its own cadence.
      if (this.timer && !this.stopped) this.actionTick().catch(() => { this.actionState = { disposition: 'processing_failed' }; });
    }
  }
  // The reasoning loop. Three bounded inferences, at most one at a time, and never on the source
  // loop's clock.
  //
  // Each stage revalidates what it was given, and that revalidation is the reason this could be
  // moved at all rather than merely made faster. Continuity refuses a stale basis and marks the
  // turn stale; Executive re-asserts authority, basis and evidence before it records a plan or a
  // brief; Opportunity re-derives the context state and refuses a transport that is no longer
  // current. A model that took three minutes to answer is therefore answering about a world that
  // has since been checked, and a world that moved underneath it produces a refusal, not a
  // confident summary of something that stopped being true.
  async reasonTick() {
    if (this.reasonBusy || this.stopped || !this.service.config.scheduler.enabled) return;
    this.reasonBusy = true;
    try {
      const cfg = this.service.config;
      // Read what the source loop last established rather than re-deriving it. A reconciliation
      // that is failing withholds derived work — that is the fail-closed direction, and it is the
      // reason this reads a flag instead of calling reconcile() a second time and hoping.
      //
      // "Never established" withholds exactly like "established and failed", because reasoning on
      // a transport whose health nobody has checked is the expensive side of that choice. What
      // differs is only what the operator is told: a partner that has not looked yet is waiting,
      // not broken. One word of telemetry is the whole difference between a cold start and an
      // incident, and conflating them is how an operator learns to ignore the field.
      if (cfg.opportunity?.automatic !== true) return;
      if (this.continuityHealthy !== true) {
        this.continuityState = { disposition: this.continuityHealthy === false ? 'reconciliation_failed' : 'waiting_reconciliation' };
        return;
      }
      try { this.continuityState = await processContinuity(this.service, this.runtime); }
      catch { this.continuityState = { disposition: 'reasoning_failed' }; }
      const result = await processSourceOpportunity(this.service, this.runtime);
      // `=== true` rather than a truthiness test: `null` must mean "not established" here for the
      // same reason it does for continuity, and a falsy check would keep the two honest by accident
      // rather than by statement.
      if (cfg.executive?.enabled === true && this.executiveHealthy === true) {
        try { this.executiveState = await processExecutive(this.service, this.runtime); }
        catch { this.executiveState = { disposition: 'processing_failed' }; }
      }
      if (this.actionHealthy === true && this.executiveHealthy === true) {
        try { this.actionPlanState = await processActionPlan(this.service, this.runtime); }
        catch { this.actionPlanState = { disposition: 'processing_failed' }; }
      }
      // The disposition is the head's answer to "what is the partner doing". It does not take the
      // slot from a failed poll: a transport that cannot be read is why the partner is not doing
      // anything, and a business disposition would hide that. The failed poll wins, and it is the
      // source loop that wrote it, so the two loops can no longer overwrite each other.
      this.lastReason = this.sourceReadReason ?? result.disposition;
    } finally { this.reasonBusy = false; }
  }
  async ensurePlanningTask() {
    const cfg = this.service.config.scheduler; if (!cfg.dailyPlanning) return;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts().map(p => [p.type,p.value]));
    if (Number(parts.hour) < cfg.planningHour) return;
    const key = `planning:${parts.year}-${parts.month}-${parts.day}`;
    await this.service.exclusive(() => this.service.store.transaction(() => this.service.addTask({ kind: 'planning', title: 'План партнёра на день', instructions: 'Просмотри цель, незавершённые дела и доступные сведения. Предложи несколько полезных следующих действий; не дублируй существующие задачи.', due_at: now(), dedupe_key: key }, 'system', 'pending')));
  }
  cancel(runId) { this.runtime.cancel(runId); }
  // Both timers, and the reason the reasoning loop needs its own: `clearInterval` on the source
  // timer alone left the head running, and `runtime.close()` then killed the worker out from
  // under a completion transaction that was mid-write. The caller drains `reasonBusy` before the
  // store is closed; this only stops the clock and says so.
  stop() { this.stopped = true; clearInterval(this.timer); clearInterval(this.reasonTimer); clearInterval(this.actionTimer); this.actionRuntime.stop(); this.runtime.close(); }
}
