import { contextFor } from './context.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { processSourceOpportunity } from './opportunity-pipeline.mjs';
import { id } from './store.mjs';
import { now } from './errors.mjs';

export class Scheduler {
  constructor(service, runtime, telegram) { this.service = service; this.runtime = runtime; this.telegram = telegram; this.busy = false; this.stopped = false; this.lastReason = null; this.activeRun = null; }
  start() { this.timer = setInterval(() => this.tick().catch(() => { this.lastReason = 'Ошибка обработки очереди; подробности в журнале запуска'; }), this.service.config.scheduler.tickSeconds * 1000); }
  status() { return { enabled: this.service.config.scheduler.enabled, busy: this.busy, active_run: this.activeRun, reason: this.lastReason, model: runtimeReadiness(this.service.config) }; }
  async tick() {
    if (this.busy || this.stopped || !this.service.config.scheduler.enabled) return;
    this.busy = true;
    try {
      const cfg = this.service.config;
      if (cfg.opportunity?.automatic) {
        const result = await processSourceOpportunity(this.service, this.runtime);
        this.lastReason = result.disposition; return;
      }
      if (!runtimeReadiness(cfg).ready) { this.lastReason = 'Задачи сохранены. Ожидается подключение модели.'; return; }
      const day = now().slice(0,10), count = this.service.store.get('SELECT COUNT(*) AS n,COALESCE(SUM(estimated_cost_usd),0) AS cost,SUM(CASE WHEN cost_status=\'unknown\' THEN 1 ELSE 0 END) AS unknown FROM runs WHERE created_at>=?', day);
      if (count.n >= cfg.runtime.maxRunsPerDay) { this.lastReason = 'Достигнут дневной лимит запусков (UTC)'; return; }
      if (cfg.runtime.dailyBudgetUsd !== null && (count.cost >= cfg.runtime.dailyBudgetUsd || count.unknown > 0)) {
        this.lastReason = count.unknown ? 'Стоимость предыдущего запуска неизвестна. Укажите тарифы и разберите расходы перед продолжением.' : 'Достигнут дневной порог учтённых расходов'; return;
      }
      await this.ensurePlanningTask();
      const prepared = await this.service.exclusive(() => this.service.store.transaction(() => {
        const task = this.service.store.get("SELECT * FROM tasks WHERE partner_id=? AND status='pending' AND kind<>'opportunity_review' AND due_at<=? ORDER BY due_at,created_at LIMIT 1", cfg.partnerId, now());
        if (!task) return null;
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
        const cancelled = task.status === 'cancelled', status = cancelled ? 'cancelled' : result.completed && !result.error ? 'completed' : 'failed';
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
