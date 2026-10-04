// Real Scheduler/HermesAdapter routing with a fully intercepted child. No provider/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { readJson, ROOT } from '../business/config.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { proposalFrom, modelOutputFrom, audienceHarness, SOURCE } from './audience-test-helpers.mjs';

const PROFILE_URL = 'https://followthrough-runtime-fixture.invalid/v1';
const OLD_TEXT = 'Old source wording must remain structural history only.';
const freshText = 'A new current reply reports progress and asks for the next step.';

function setup(t, name) {
  t.mock.timers.enable({ apis:['Date'], now:new Date('2026-01-01T00:30:00.000Z') });
  const oldKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'synthetic-runtime-test-sentinel';
  t.after(() => oldKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = oldKey);
  const h = audienceHarness(t);
  Object.assign(h.config.runtime, { enabled:false, baseUrl:'', model:'', dailyBudgetUsd:null,
    maxRunsPerDay:50, timeoutSeconds:30 });
  h.config.scheduler.enabled = false;
  h.config.audience.enabled = true; h.config.audience.modelEnabled = false; h.config.audience.maxRunsPerDay = 20;
  h.config.modelProfiles = { allowedBaseUrls:[PROFILE_URL] };
  h.config.controlPlane.enabled = true; h.config.controlPlane.maxConcurrent = 3;
  h.config.continuity.enabled = false; h.config.executive.enabled = false; h.config.opportunity.automatic = true;

  return (async () => {
    const goal = await h.open({ title:`Runtime ${name}`, objective:'Use only a fresh synthetic follow-up observation.',
      source_ids:[SOURCE], max_age_seconds:3600 });
    await h.ingest({ message_id:`${name}-old`, thread_id:`${name}-thread`, text:OLD_TEXT });
    await h.service.exclusive(() => h.service.audience.reconcile({ limit:10 }));
    const detail = h.service.audience.detail(goal.goal_id);
    const captured = await h.command('audience.capture', { goal_id:goal.goal_id,
      expected_revision:detail.revision, expected_basis_fingerprint:detail.basis_fingerprint });
    const originalAssessment = h.service.audience.assessment(captured.assessment_id);
    const originalEventId = originalAssessment.packet.exchanges[0].evidence[0].source_event_id;
    const proposed = await h.command('audience.propose', { assessment_id:captured.assessment_id,
      output:proposalFrom(originalAssessment.packet) });
    let need = h.service.audience.need(proposed.need_ids[0]);
    await h.command('audience.review', { need_id:need.id, expected_revision:need.revision,
      expected_basis_fingerprint:need.basis_fingerprint, decision:'accept', note:'Synthetic original review.' });
    need = h.service.audience.need(need.id);

    t.mock.timers.tick(2*60*60*1000);
    const fresh = await h.ingest({ message_id:`${name}-fresh`, thread_id:`${name}-thread`,
      reply_to_id:`${name}-old`, text:freshText });
    await h.service.exclusive(() => h.service.audience.reconcile({ limit:10, event_limit:50 }));
    const context = h.service.followup.context(need.id);
    assert.equal(context.available,true,JSON.stringify(context.reasons));
    const profile = await h.command('model.profile_create', { label:`Synthetic ${name} profile`, provider:'custom',
      api_mode:'chat_completions', base_url:PROFILE_URL, model:'followthrough-runtime-model', max_output_tokens:777,
      input_usd_per_million:2, output_usd_per_million:3 });
    const requested = await h.command('audience.followup_request', { need_id:need.id,
      expected_revision:context.need_revision, expected_basis_fingerprint:context.need_basis_fingerprint,
      expected_context_fingerprint:context.context_fingerprint, model_profile_id:profile.profile_id,
      expected_profile_hash:profile.definition_hash, expires_at:new Date(Date.now()+60*60*1000).toISOString(),
      reason:'One synthetic current-evidence follow-up.' });
    return { h, goal, need, context, profile, requested, originalEventId, freshEventId:fresh.source_event_id };
  })();
}

function interceptWorker(t, envelopeOutput) {
  const invocations = [];
  const intercepted = t.mock.method(childProcess, 'spawn', (_python, args, options) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    child.stdin.end = text => {
      const envelope = JSON.parse(text);
      invocations.push({ args, options, envelope });
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify(envelopeOutput(envelope)));
        child.emit('close', 0);
      });
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  return { invocations, intercepted };
}

function blockNetwork(t) {
  const denied = () => { throw new Error('Network access is forbidden in the intercepted runtime test.'); };
  const guards = [t.mock.method(globalThis,'fetch',denied), t.mock.method(Socket.prototype,'connect',denied)];
  t.after(() => { for (const guard of guards) assert.equal(guard.mock.callCount(),0); });
}

function successfulWorker(envelope) {
  const packet = envelope.context.packet;
  const output = proposalFrom(packet, { need_id:packet.followup.need_id,
    title:'Freshly supported synthetic revision',
    hypothesis:'A fresh reply reports progress and asks for the next step.',
    why_now:'The current reply introduces a new unresolved question.',
    next_step:'observe', reason:'This one current reply supports a narrow continuation.' });
  return { completed:true, final_response:JSON.stringify(modelOutputFrom(packet, output)),
    usage:{ input_tokens:41, output_tokens:17 },
    model_identity:{ model_id:'followthrough-runtime-model', model_version:'synthetic-runtime-v1' }, api_calls:1 };
}

test('Scheduler admits one focused public turn through HermesAdapter using frozen bounds and no tools or ambient run capability', async t => {
  blockNetwork(t);
  const { h, need, profile, requested, originalEventId, freshEventId } = await setup(t, 'adapter');
  assert.deepEqual(requested.executable,false); assert.equal(h.config.audience.modelEnabled,false);
  assert.equal(h.config.runtime.enabled,false); assert.equal(h.config.runtime.baseUrl,'');
  const bounds = h.service.followup.checked(requested.request_id).d.execution_bounds;
  assert.deepEqual(bounds,{ timeout_seconds:30, max_api_calls:2 });

  // Establish the healthy source-reconciliation precondition before allowing Scheduler's public slot.
  await h.service.exclusive(() => h.service.audience.reconcile());
  await h.service.exclusive(() => h.service.continuity.reconcile());
  const tokens = new Map(), adapter = new HermesAdapter(h.service, tokens);
  t.after(() => adapter.close());
  const { invocations, intercepted } = interceptWorker(t, successfulWorker);
  const scheduler = new Scheduler(h.service, adapter, null, []);
  scheduler.audienceHealthy = true; scheduler.continuityHealthy = false; scheduler.executiveHealthy = false;
  scheduler.actionHealthy = false;
  // A hot global timeout change after explicit request creation cannot retarget its approved bounds.
  h.config.runtime.timeoutSeconds = 900;
  await scheduler.audienceReasonTick();

  assert.equal(scheduler.audienceState.disposition,'proposal_created');
  assert.equal(intercepted.mock.callCount(),1); assert.equal(invocations.length,1);
  const [{ args, options, envelope }] = invocations;
  assert.match(args[0],/situation_router_worker\.py$/);
  assert.equal(envelope.model.provider,'custom'); assert.equal(envelope.model.apiMode,'chat_completions');
  assert.equal(envelope.model.baseUrl,PROFILE_URL); assert.equal(envelope.model.model,'followthrough-runtime-model');
  assert.equal(envelope.model.maxOutputTokens,777); assert.equal(envelope.model.timeoutSeconds,30);
  assert.equal(envelope.model.maxIterations,2); assert.equal(envelope.model.maxApiCalls,2); assert.deepEqual(envelope.tools,[]);
  assert.equal(envelope.business_url,undefined); assert.equal(envelope.context.router_instructions,undefined);
  assert.equal(envelope.context.owner_language,readJson(`${ROOT}/partner/profile.json`).language);
  assert.ok(envelope.context.packet.exchanges.flatMap(e=>e.evidence).some(e=>e.source_event_id===freshEventId && e.text===freshText));
  assert.ok(envelope.context.packet.exchanges.some(e=>e.structural_event_ids.includes(originalEventId)),
    'old anchor is visible only as structural ancestry');
  assert.equal(JSON.stringify(envelope.context.packet).includes(OLD_TEXT),false);
  assert.ok(envelope.context.packet.exchanges.every(e=>e.current_event_ids.includes(freshEventId)
    && !e.current_event_ids.includes(originalEventId)));
  for (const key of ['PARTNER_RUN_TOKEN','PARTNER_TELEGRAM_SESSION','PARTNER_TELEGRAM_API_HASH'])
    assert.equal(options.env[key],undefined);
  assert.equal(tokens.size,0);

  const run = h.store.get("SELECT * FROM runs WHERE runtime='hermes-audience-v1'");
  const receipt = JSON.parse(run.result_json), requestDetail = h.service.followup.detail(requested.request_id);
  assert.equal(run.status,'completed'); assert.equal(run.model,'followthrough-runtime-model');
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17); assert.equal(run.cost_status,'configured_estimate');
  assert.equal(run.estimated_cost_usd,(41*2+17*3)/1e6);
  assert.equal(receipt.model_api_calls,1); assert.equal(receipt.model_identity.model_id,'followthrough-runtime-model');
  assert.equal(receipt.followup_request.id,requested.request_id);
  assert.equal(receipt.model_profile.id,profile.profile_id);
  assert.equal(requestDetail.attempt.run_id,run.id); assert.equal(requestDetail.state,'consumed');
  assert.equal(requestDetail.receipt.model_api_calls,1);
  assert.equal(h.service.audience.need(need.id).status,'proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts').n,0,
    'no ordinary attention grant was borrowed');
  for (const table of ['persons','conversations','drafts','delivery_attempts','action_proposals'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} remains untouched`);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-continuity-v1'").n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-private-v1'").n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-executive-v1'").n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime<>'hermes-audience-v1'").n,0,
    'public focused routing does not admit ordinary or private runtime planes');
});

test('a corrupted frozen follow-up timeout fails before the intercepted Hermes child can start', async t => {
  blockNetwork(t);
  const { h, requested } = await setup(t, 'tamper');
  const { invocations, intercepted } = interceptWorker(t, successfulWorker);
  const adapter = new HermesAdapter(h.service, new Map()); t.after(() => adapter.close());
  const scheduler = new Scheduler(h.service, adapter, null, []);
  scheduler.audienceHealthy = true; scheduler.continuityHealthy = false; scheduler.executiveHealthy = false;
  scheduler.actionHealthy = false;
  const result = await (async () => {
    // Directly exercise Scheduler's normal focused dispatch, injecting a consistent persisted/run-object mutation
    // after transactional binding but before HermesAdapter validates the frozen execution bounds.
    const { processAudienceAssessment } = await import('../business/audience-reasoning.mjs');
    return processAudienceAssessment(h.service, { decide:async (run, context) => {
      const frozen = JSON.parse(run.context_json);
      frozen.model_config.timeoutSeconds += 1;
      run.context_json = JSON.stringify(frozen);
      h.store.run('UPDATE runs SET context_json=? WHERE id=?',run.context_json,run.id);
      return adapter.decide(run,context);
    } });
  })();
  assert.notEqual(result.disposition,'proposal_created');
  assert.equal(intercepted.mock.callCount(),0); assert.equal(invocations.length,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',requested.request_id).n,1,
    'failed tampering does not release or replay the consumed authority');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-audience-v1'").n,1);
  assert.equal(h.store.get('SELECT status FROM runs WHERE runtime=?','hermes-audience-v1').status,'failed');
});
