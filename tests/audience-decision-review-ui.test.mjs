import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

const evidence = { source_event_id:'17', text:'Hello, can anyone explain the starter pack?',
  published_at:'2026-08-04T10:00:00.000Z', source_updated_at:'2026-08-04T10:03:00.000Z',
  observed_at:'2026-08-04T10:04:00.000Z' };

function validReview(disposition='no_need_proposed', overrides={}) {
  return { version:1, scope:'supplied_packet_only', disposition,
    summary:'The sampled exchange is a greeting and does not state a need.',
    unknowns:['Whether the author has a question elsewhere.'],
    exchange_reviews:[{ exchange_id:'exchange-1', judgment:disposition === 'needs_proposed' ? 'relevant' : 'no_proposal',
      reason:'This message contains no request or unresolved problem.', evidence_event_ids:['17'],
      support_quotes:[{ source_event_id:'17', quote:'Hello, can anyone explain the starter pack?' }] }],
    ...overrides };
}

function makeApi(assessment) {
  const goal = { id:'goal-1', title:'Understand public setup questions', objective:'Find what people need to get started.',
    status:'OPEN', revision:1, ready:false, backlog:false, watches:[], needs:[], assessments:[{ id:assessment.id, status:assessment.status }],
    attention:{ model_configured:true, model_ready:false, source_current:true, ready:false, can_grant:false,
      grants:[], block_reasons:['AUDIENCE_MODEL_DISABLED'] } };
  return async route => {
    if (route.startsWith('/api/audience?')) return { enabled:true, model_enabled:false, items:[{ id:goal.id, title:goal.title, status:'OPEN', revision:1 }] };
    if (route === `/api/audience/${goal.id}`) return structuredClone(goal);
    if (route === `/api/audience/assessments/${assessment.id}`) return structuredClone(assessment);
    throw new Error(`Unexpected UI read: ${route}`);
  };
}

function createView(assessment) {
  const api = makeApi(assessment);
  const view = createAudienceView({ api, command:async () => { throw new Error('decision review is read-only'); }, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`, field:()=>'', modal:()=>{}, refresh:async()=>{}, notify:()=>{} });
  return { view, select:async () => { await view.load(); await view.act('audience-goal','goal-1'); await view.act('audience-assessment',assessment.id); } };
}

function assessment({ id='assessment-1', status='proposed', state='current', review=validReview(), output=null, current=true }={}) {
  return { id, goal_id:'goal-1', status, current, basis_fingerprint:'basis-fp',
    packet:{ id:'goal-1', assessment_id:id, basis_fingerprint:'basis-fp', unknowns:['The sample may not represent the whole source.'],
      coverage:{ source_completeness:'unknown' }, withheld_exchanges:[],
      exchanges:[{ id:'exchange-1', source_ref:'public:fixture', current:true, reasons:[], evidence:[evidence] }] },
    output:output ?? { needs:[], decision_review:review },
    decision_review:{ state, review:state === 'current' || state === 'stale' ? review : null,
      epistemic_status:'unverified_model_interpretation', resolution:'unknown', scope:'supplied_packet_only' },
    attempt_receipt:{ run_id:'run-1', status:'completed', model_api_calls:1, input_tokens:13800,
      output_tokens:300, usage_status:'known', cost_status:'unknown', estimated_cost_usd:null } };
}

test('current no-need decision explains abstention with exact packet citation and clocks', async () => {
  const a = assessment();
  const { view, select } = createView(a);
  await select();
  const html = view.render();
  assert.match(html, /Решение модели по предоставленному снимку/);
  assert.match(html, /не предложена/);
  assert.match(html, /contains no request or unresolved problem/);
  assert.match(html, /Hello, can anyone explain the starter pack\?/);
  assert.match(html, /2026/);
  assert.match(html, /Неизвестно, решена ли потребность/);
  assert.match(html, /непроверенная интерпретация модели/);
  assert.match(html, /только предоставленный снимок/);
  assert.doesNotMatch(html, /audience-accept|audience-propose|audience-open-work/);
});

test('a positive decision review shows its reasoning but remains separate from a material or acceptance', async () => {
  const review = validReview('needs_proposed', { summary:'A direct setup question supports a narrow clarification.' });
  const { view, select } = createView(assessment({ review,
    output:{ needs:[{ need_id:'need-1', title:'Clarify setup', material_preview:{ content:'Draft' } }], decision_review:review } }));
  await select();
  const html = view.render();
  assert.match(html, /A direct setup question supports a narrow clarification\./);
  assert.match(html, /Предложена гипотеза/);
  assert.match(html, /Связано с целью/);
  assert.match(html, /не является решением владельца/);
  assert.doesNotMatch(html, /decision_review.*accepted/i);
});

test('stale review retains its historical rationale and says the resolution remains unknown', async () => {
  const review = validReview('no_need_proposed', { summary:'Historical conclusion for the old source head.' });
  const { view, select } = createView(assessment({ state:'stale', review, current:false }));
  await select();
  const html = view.render();
  assert.match(html, /Историческое объяснение сохранено/);
  assert.match(html, /Historical conclusion for the old source head\./);
  assert.match(html, /устарело/);
  assert.match(html, /Неизвестно, решена ли потребность/);
});

test('stale late result with no recorded review says it was withheld, not malformed', async () => {
  const { view, select } = createView(assessment({ status:'stale', state:'stale', review:null, current:false, output:{ needs:[] } }));
  await select();
  const html = view.render();
  assert.match(html, /Ответ не применён: основание устарело; объяснение решения не записано/);
  assert.doesNotMatch(html, /Объяснение решения не прошло проверку/);
});

test('assessment coverage shows only bounded withheld sample counts and escaped reasons, never excluded text', async () => {
  const a = assessment();
  a.packet.withheld_exchanges = [
    { id:'withheld-1', reasons:['SOURCE_UNSUPPORTED', '<img src=x onerror=reason()>'], evidence:[{ text:'WITHHELD SECRET ONE' }] },
    { id:'withheld-2', reasons:['SOURCE_UNSUPPORTED'], evidence:[{ text:'WITHHELD SECRET TWO' }] },
  ];
  a.packet.coverage.omitted_sample_exchanges = 3;
  const { view, select } = createView(a);
  await select();
  const html = view.render();
  assert.match(html, /включено 1 обменов/);
  assert.match(html, /исключённых обменов — 2/);
  assert.match(html, /SOURCE_UNSUPPORTED \(2\)/);
  assert.match(html, /&lt;img src=x onerror=reason\(\)&gt; \(1\)/);
  assert.match(html, /Общее число исключённых или ожидающих обменов неизвестно/);
  assert.match(html, /3 кандидатов не вошли в пакет/);
  assert.doesNotMatch(html, /WITHHELD SECRET|<img src=x/);
});

test('current and stale labels fail closed when they disagree with packet currency', async () => {
  const mismatches = [
    assessment({ state:'current', current:false }),
    assessment({ state:'stale', current:true }),
  ];
  for (const a of mismatches) {
    const { view, select } = createView(a);
    await select();
    const html = view.render();
    assert.match(html, /Объяснение решения не прошло проверку/);
    assert.doesNotMatch(html, /The sampled exchange is a greeting/);
  }
});

test('invalid review is withheld, including from the raw saved-output disclosure', async () => {
  const poison = '<img src=x onerror=run()> INVALID_REVIEW_SECRET';
  const { view, select } = createView(assessment({ state:'invalid', review:validReview('no_need_proposed', { summary:poison }),
    output:{ needs:[], decision_review:{ summary:poison, exchange_reviews:[{ reason:poison }] } } }));
  await select();
  const html = view.render();
  assert.match(html, /Объяснение решения не прошло проверку/);
  assert.doesNotMatch(html, /INVALID_REVIEW_SECRET|onerror=run/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('forged API reviews missing mandatory unknowns or complete evidence citations fail closed', async () => {
  const cases = [
    validReview('no_need_proposed', { unknowns:[] }),
    validReview('no_need_proposed', { unknowns:['   '] }),
    validReview('no_need_proposed', { exchange_reviews:[{ ...validReview().exchange_reviews[0], evidence_event_ids:[] }] }),
    validReview('no_need_proposed', { exchange_reviews:[{ ...validReview().exchange_reviews[0], support_quotes:[] }] }),
    validReview('no_need_proposed', { exchange_reviews:[{ ...validReview().exchange_reviews[0], support_quotes:[{ source_event_id:'17', quote:'   ' }] }] }),
    validReview('no_need_proposed', { exchange_reviews:[{ ...validReview().exchange_reviews[0], evidence_event_ids:['17','17'] }] }),
  ];
  for (const review of cases) {
    const poison = review.summary;
    const { view, select } = createView(assessment({ review, output:{ needs:[], decision_review:review } }));
    await select();
    const html = view.render();
    assert.match(html, /Объяснение решения не прошло проверку/);
    assert.doesNotMatch(html, new RegExp(poison.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('historical empty output says no rationale was recorded instead of inventing an abstention', async () => {
  const poison = 'UNRECORDED_DECISION_REVIEW';
  const { view, select } = createView(assessment({ status:'proposed', state:'not_recorded', review:null,
    output:{ needs:[], decision_review:{ summary:poison } } }));
  await select();
  const html = view.render();
  assert.match(html, /Объяснение решения не записано для этой исторической оценки/);
  assert.doesNotMatch(html, /не предложено по причине|UNRECORDED_DECISION_REVIEW/);
});

test('pending assessment says rationale is not recorded yet and does not fabricate a decision', async () => {
  const { view, select } = createView(assessment({ status:'running', state:'not_recorded', review:null, output:null }));
  await select();
  const html = view.render();
  assert.match(html, /Оценка ещё выполняется; объяснение решения пока не записано/);
  assert.doesNotMatch(html, /не предложено по причине/);
});

test('model review text and canonical packet metadata are escaped before display', async () => {
  const review = validReview('no_need_proposed', { summary:'<script>summary()</script>',
    exchange_reviews:[{ exchange_id:'exchange-1', judgment:'no_proposal', reason:'<b>reason</b>', evidence_event_ids:['17'],
      support_quotes:[{ source_event_id:'17', quote:'<img src=x onerror=quote()>' }] }] });
  const a = assessment({ review });
  a.packet.exchanges[0].source_ref = '<svg onload=source()>';
  a.packet.exchanges[0].evidence[0].text = '<img src=x onerror=quote()>';
  const { view, select } = createView(a);
  await select();
  const html = view.render();
  assert.match(html, /&lt;script&gt;summary\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;reason&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x onerror=quote\(\)&gt;/);
  assert.match(html, /&lt;svg onload=source\(\)&gt;/);
  assert.doesNotMatch(html, /<script>|<svg onload|<img src=x/);
});

test('focused coverage reads its nested canonical withheld sample without exposing excluded text',async () => {
  const a = assessment();
  delete a.packet.withheld_exchanges;
  a.packet.coverage.withheld_exchanges=[{id:'omitted',reasons:['AUDIENCE_ANCHOR_UNSUPPORTED'],evidence:[{text:'PRIVATE_EXCLUDED_TEXT'}]}];
  const {view,select}=createView(a); await select();
  const html=view.render();
  assert.match(html,/исключённых обменов — 1/);
  assert.match(html,/AUDIENCE_ANCHOR_UNSUPPORTED \(1\)/);
  assert.doesNotMatch(html,/PRIVATE_EXCLUDED_TEXT/);
});
