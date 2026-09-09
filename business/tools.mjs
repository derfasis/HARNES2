import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { contextFor, searchExperience } from './context.mjs';
import { ensure, now } from './errors.mjs';
import { id } from './store.mjs';

const definitions = readJson(path.join(ROOT, 'contracts/tools.json'));
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const validators = new Map(definitions.map(d => [d.name, ajv.compile(d.inputSchema)]));
const actions = { partner_propose_draft: 'draft.create', partner_propose_fact: 'fact.propose', partner_propose_task: 'task.propose', partner_propose_lesson: 'lesson.propose', partner_propose_capability: 'capability.propose' };
export function toolDefinitions(scope) { return definitions.filter(d => !d.conversationOnly || scope.conversationId).map(({ conversationOnly, ...d }) => d); }
export async function callTool(service, scope, name, args, requestId) {
  ensure(toolDefinitions(scope).some(d => d.name === name), 'Инструмент недоступен в этой области', 403);
  const valid = validators.get(name); ensure(valid && valid(args), 'Аргументы не соответствуют схеме инструмента');
  if (scope.runId) {
    const run = service.store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', scope.runId, service.config.partnerId);
    ensure(run?.status === 'running', 'Запуск завершён', 409);
    if (scope.conversationId) service.assertRunFresh(scope, scope.conversationId);
    if (run.task_id) ensure(service.store.get('SELECT status FROM tasks WHERE id=?', run.task_id)?.status === 'running', 'Задача отменена', 409);
  }
  let result;
  if (name === 'partner_get_context') result = contextFor(service, scope.conversationId ?? null);
  else if (name === 'partner_list_work') result = scope.conversationId
    ? service.store.all("SELECT * FROM tasks WHERE conversation_id=? AND status IN ('pending','proposed','running') ORDER BY due_at LIMIT 50", scope.conversationId)
    : service.store.all("SELECT * FROM tasks WHERE partner_id=? AND status IN ('pending','proposed','running') ORDER BY due_at LIMIT 100", service.config.partnerId);
  else if (name === 'partner_search_experience') result = searchExperience(service, args.query, scope.conversationId ?? null, service.config.context.maxLessons);
  else {
    const payload = { ...args };
    if (scope.conversationId) {
      ensure(!payload.conversation_id || payload.conversation_id === scope.conversationId, 'Разговор вне области запуска', 403);
      payload.conversation_id = scope.conversationId;
    }
    result = await service.command(actions[name], payload, requestId, { ...scope, kind: 'agent' });
  }
  if (scope.runId) service.store.run('INSERT INTO tool_calls VALUES(?,?,?,?,?,?)', id(), scope.runId, name, JSON.stringify(args), JSON.stringify(result), now());
  return result;
}
