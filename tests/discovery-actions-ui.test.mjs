// Stage 4E: the Discovery viewer gains the operator's existing write commands — and nothing else.
// proof_level=integration; live_proof=false. No new business rule, no model, no send, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function ui({ list, detail } = {}) {
  const calls = [], forms = [];
  const context = vm.createContext({ console, Date, Map, JSON, Promise, Date,
    crypto: { randomUUID: () => 'fixture-id' }, URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
    document: { querySelector: () => ({ textContent: '', className: '', style: {} }),
      querySelectorAll: () => [] } });
  const bootstrap = source.slice(0, source.indexOf("document.addEventListener('click'"));
  vm.runInContext(bootstrap + `
    globalThis.tab='discovery';
    globalThis.discoveryList=${JSON.stringify(list ?? { items: [], next_cursor: null })};
    globalThis.discoveryError=null; globalThis.discoveryDetailError='';
    globalThis.discoverySelection=null;
    globalThis.api=async(route,body)=>{
      globalThis.calls.push({ route, body, method: body===undefined?'GET':'POST' });
      if(route==='/api/discovery/reason-states') return globalThis.discoveryList;
      if(route.startsWith('/api/discovery/')){
        const id=decodeURIComponent(route.split('/').at(-1));
        if(globalThis.failNext && globalThis.failNext.route===route){ const e=new Error(globalThis.failNext.message); e.code=globalThis.failNext.code; throw e; }
        return { ...globalThis.discoveryDetail, situation_id:id };
      }
      if(route==='/api/commands'){
        if(globalThis.failCommand) { const e=new Error(globalThis.failCommand.message); e.code=globalThis.failCommand.code; throw e; }
        return { ok:true };
      }
      throw new Error('unexpected route');
    };
    globalThis.loadDiscovery=loadDiscovery;
    globalThis.selectSituation=selectSituation;
    globalThis.discoveryTab=discoveryTab;
    globalThis.discoveryDetailPanel=discoveryDetailPanel;
    globalThis.operatorActions=discoveryOperatorActions;
    globalThis.act=act;
    globalThis.render=()=>{};
    globalThis.refresh=async()=>{ globalThis.refreshed=(globalThis.refreshed??0)+1; };
    globalThis.notify=(message)=>{ globalThis.notices=[...(globalThis.notices??[]),message]; };
    globalThis.modal=(title,content,submit)=>{ globalThis.form={ title, content, submit }; };
    globalThis.calls=[]; globalThis.failNext=null; globalThis.failCommand=null;
  `, context);
  context.discoveryDetail = detail;
  context.calls = calls;
  context.forms = forms;
  return context;
}

const situation = (over = {}) => ({
  situation_id: 'sit-1', status: 'OBSERVING', storage_status: 'OBSERVING', revision: 4,
  evidence_fingerprint: 'fp-1', freshness: { fresh: true, reasons: [] },
  basis: { source_ref: 'public:x', subject_ref: 'user:1', context_key: 'thread:1', purpose: 'opportunity',
    expires_at: '2026-12-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z' },
  evidence: [{ source_event_id: '9', message_id: 'message:1', message_version: 1, author_id: 'user:1',
    observed_at: '2026-01-01T00:00:00.000Z', text: 'Что входит?', text_truncated: false }],
  assessments: [{ id: '5', created_at: '2026-01-01T00:00:01.000Z', decision: 'CANDIDATE',
    result_revision: 4, evidence_fingerprint: 'fp-1',
    epistemic_status: 'unverified_proposal', reasoning_version: 1, reasoning_shape: 'structured_v1',
    hypothesis: { text: 'Возможно.', text_truncated: false, attributed_claims: [], inferences: [],
      uncertainty: ['Не проверено'] },
    why_now: { reason: 'Вопрос.', reason_truncated: false, evidence_event_ids: ['9'] },
    freshness: { fresh: true, reasons: [] }, executable: false, contact_permission: false, allowed_effects: [] }],
  opening_proposals: [], review_tasks: [{ id: 'task-1', status: 'proposed', created_at: '2026-01-01T00:00:02.000Z' }],
  executable: false, contact_permission: false, sent: false, allowed_effects: [], ...over });

const commandCall = (ctx) => [...ctx.calls].reverse().find((call) => call.route === '/api/commands');

const row = (over = {}) => ({ situation_id: 'sit-1', storage_status: 'OBSERVING', revision: 4,
  evidence_fingerprint: 'fp-1', transition_id: '4', decision: 'WAIT',
  wait: { kind: 'evidence_change' }, state: 'BLOCKED', unlock: 'EVIDENCE_CHANGE', reason: 'Ждём',
  freshness: { fresh: true, reasons: [] }, executable: false, contact_permission: false, allowed_effects: [], ...over });

test('4E a proposed review can be approved or rejected from the Discovery tab', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.match(html, /discovery-review-approve/);
  assert.match(html, /discovery-review-reject/);

  await ctx.act('discovery-review-approve', 'task-1');
  const approval = commandCall(ctx);
  assert.equal(approval.route, '/api/commands');
  assert.equal(approval.body.action, 'discovery.review');
  assert.equal(approval.body.payload.decision, 'approve');
  assert.equal(approval.body.payload.expected_revision, 4);
  assert.equal(approval.body.payload.expected_evidence_fingerprint, 'fp-1');
});

// The click handler passes the button's dataset, so the real path is exercised through the
// rendered markup rather than through a hand-written argument.
const clickAction = async (ctx, html, doName, mode) => {
  const buttons = [...html.matchAll(new RegExp(`<button[^>]*data-do="${doName}"[^>]*>`, 'g'))].map((match) => match[0]);
  const chosen = mode ? buttons.find((markup) => markup.includes(`data-mode="${mode}"`)) : buttons[0];
  assert.ok(chosen, `${doName}${mode ? ` (${mode})` : ''} must be rendered`);
  await ctx.act(doName, chosen.match(/data-id="([^"]+)"/)?.[1] ?? '',
    chosen.match(/data-mode="([^"]+)"/)?.[1] ?? '');
};

test('4E every reason decision is reachable from the rendered buttons, and each one sends itself', async () => {
  for (const decision of ['WAIT', 'IGNORE', 'STOP']) {
    const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
    await ctx.loadDiscovery();
    await ctx.selectSituation('sit-1');
    await clickAction(ctx, ctx.discoveryDetailPanel(), 'discovery-reason-open', decision);
    assert.match(ctx.form.title, new RegExp(decision), `the form must name the decision ${decision}`);
    await ctx.form.submit({ reason: `Причина: ${decision}`, wait_kind: 'evidence_change' });
    assert.equal(commandCall(ctx).body.payload.decision, decision);
  }
});

test('4E a refused reason decision is reported and never retried, and the state is re-read', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  await clickAction(ctx, ctx.discoveryDetailPanel(), 'discovery-reason-open');
  ctx.failCommand = { code: 'DISCOVERY_EVIDENCE_FINGERPRINT_CONFLICT', message: 'Основание изменилось' };
  await assert.rejects(ctx.form.submit({ reason: 'Причина', wait_kind: 'evidence_change' }),
    { message: 'Основание изменилось' });
  assert.equal(ctx.calls.filter((call) => call.route === '/api/commands').length, 1, 'one attempt only');
  assert.equal(ctx.calls.at(-1).route, '/api/discovery/sit-1', 'canonical state is re-read after the refusal');
});

test('4E a stale basis shows no decision controls at all', async () => {
  const stale = situation({ freshness: { fresh: false, reasons: ['DISCOVERY_EVIDENCE_STALE'] } });
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: stale });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.doesNotMatch(html, /discovery-review-approve/);
  assert.doesNotMatch(html, /discovery-reason-open/);
  assert.match(html, /Основание устарело/);
  assert.match(html, /DISCOVERY_EVIDENCE_STALE/);
  // The record stays readable: a stale basis hides the decisions, not the evidence behind them.
  assert.match(html, /Что входит\?/);
});

test('4E a reason decision is sent with the exact assessment, revision and fingerprint', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  await ctx.act('discovery-reason-open', 'sit-1', 'IGNORE');
  assert.ok(ctx.form, 'a reason needs an explicit reason from the operator');
  await ctx.form.submit({ reason: 'Сигнал неинтересен' });
  const sent = commandCall(ctx);
  assert.equal(sent.route, '/api/commands');
  assert.equal(sent.body.action, 'discovery.reason');
  assert.equal(sent.body.payload.decision, 'IGNORE');
  assert.equal(sent.body.payload.assessment_id, '5');
  assert.equal(sent.body.payload.expected_revision, 4);
  assert.equal(sent.body.payload.expected_evidence_fingerprint, 'fp-1');
  assert.equal(sent.body.payload.reason, 'Сигнал неинтересен');
});

test('4E a WAIT cannot be submitted without a wait condition, and a deadline must be explicit', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  await ctx.act('discovery-reason-open', 'sit-1', 'WAIT');
  await assert.rejects(ctx.form.submit({ reason: 'Ждём', wait_kind: 'deadline', wait_at: '' }),
    { message: /условие/i }, 'a deadline wait without a date is not submittable');
  await assert.rejects(ctx.form.submit({ reason: 'Ждём' }), { message: /условие/i },
    'a WAIT without any condition is not submittable');
  await assert.rejects(ctx.form.submit({ reason: '', wait_kind: 'evidence_change' }),
    { message: /причина/i }, 'a reason is mandatory for every decision');
  const before = ctx.calls.filter((call) => call.route === '/api/commands').length;
  await ctx.form.submit({ reason: 'Ждём', wait_kind: 'evidence_change' });
  assert.equal(ctx.calls.filter((call) => call.route === '/api/commands').length, before + 1);
  assert.equal(commandCall(ctx).body.payload.wait.kind, 'evidence_change');
});

test('4E a stale or conflicting command is shown to the operator and never retried silently', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  ctx.failCommand = { code: 'DISCOVERY_REVISION_CONFLICT', message: 'Ситуация изменилась' };
  // The click handler surfaces the rejection to the operator; act() must reject and stop there.
  await assert.rejects(ctx.act('discovery-review-approve', 'task-1'), { message: 'Ситуация изменилась' });
  assert.equal(ctx.calls.filter((call) => call.route === '/api/commands').length, 1,
    'a rejected command must not be retried');
  // And the UI goes back to canonical state rather than pretending the decision happened.
  assert.equal(ctx.calls.at(-1).route, '/api/discovery/sit-1', 'the situation is re-read after the refusal');
});

test('4E after any action the UI re-reads the canonical situation instead of trusting its own state', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const before = ctx.calls.length;
  await ctx.act('discovery-review-approve', 'task-1');
  const after = ctx.calls.slice(before);
  assert.equal(after.at(-1).route, '/api/discovery/sit-1', 'the situation is re-read last');
  assert.ok(after.some((call) => call.route === '/api/commands'));
});

test('4E the write surface exposes no send, no contact and no invented command', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryTab() + ctx.discoveryDetailPanel();
  for (const action of ['discovery-send', 'discovery-contact', 'discovery-permission', 'discovery-draft',
    'discovery-transfer', 'discovery-assess', 'discovery-dismiss']) {
    assert.equal(html.includes(`data-do="${action}`), false, `must not offer ${action}`);
  }
  const offered = [...html.matchAll(/data-do="([^"]+)"/g)].map((match) => match[1]);
  for (const action of offered) {
    assert.match(action, /^discovery-(select|next|review-approve|review-reject|reason-open|reason-cancel)$/,
      `unexpected Discovery action offered: ${action}`);
  }
});

test('4E the viewer never fabricates a decision the situation does not allow', async () => {
  const stopped = situation({ status: 'STOPPED', storage_status: 'DISMISSED', review_tasks: [] });
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: stopped });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.doesNotMatch(html, /discovery-review-approve/);
  assert.doesNotMatch(html, /discovery-reason-open/);
  assert.match(html, /недоступн|закрыт|STOPPED/i);
});

test('4E reason controls disappear once the situation has moved past the latest assessment', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  assert.match(ctx.discoveryDetailPanel(), /data-mode="IGNORE"/, 'a current basis offers the decisions');

  // An approve moves the situation revision on. The assessment is still the latest one, but it no
  // longer produced the current revision, so the reason buttons must be gone.
  ctx.discoveryDetail = situation({ revision: 5, review_tasks: [] });
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.doesNotMatch(html, /data-mode="IGNORE"/);
  assert.doesNotMatch(html, /data-mode="WAIT"/);
  assert.doesNotMatch(html, /data-mode="STOP"/);
});

test('4E a stale situation stays readable with no decisions, exactly like a closed one', async () => {
  const stale = situation({ status: 'STALE', freshness: { fresh: false, reasons: ['DISCOVERY_NOT_LIVE'] } });
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: stale });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.match(html, /Что входит\?/, 'the record is still readable');
  assert.match(html, /STALE/);
  assert.doesNotMatch(html, /discovery-review-approve/);
  assert.doesNotMatch(html, /data-mode="IGNORE"/);
});

test('4E the write screen states exactly what it does and does not do', async () => {
  const ctx = ui({ list: { items: [row()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.match(html, /решения меняют только состояние Discovery/);
  assert.doesNotMatch(html, /ничего из этого экрана выполнить нельзя/);
});
