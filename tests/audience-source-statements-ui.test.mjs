import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const hostile = '<img src=x onerror="run()">';
const sourceBlock = html => {
  const start = html.indexOf('Слова участников · сохранённый снимок');
  if (start < 0) return null;
  const end = html.indexOf('</section>', start);
  return html.slice(start, end < 0 ? html.length : end);
};

function harness({ current=true }={}) {
  const calls = [], dialogs = [], goal = { id:'goal-a002', title:'Understand setup concerns', status:'OPEN', revision:4,
    objective:'Learn what participants need before deciding whether to act.', source_refs:['forum:setup'],
    needs:[{ id:'need-a002', title:'A002 hypothesis', status:'accepted', revision:8 }] };
  const need = { id:'need-a002', goal_id:goal.id, assessment_id:'assessment-a002', status:'accepted', revision:8, basis_fingerprint:'need-basis-a002',
    title:'A002 hypothesis', hypothesis:'Participants may need a starter recommendation.',
    why_now:'The model inferred an opportunity from the saved sample.', next_step:'prepare_material',
    reason:'The model read the exchange as interest in buying.', epistemic_status:'unverified_interpretation',
    unknowns:['Whether anyone wants a purchase recommendation is unknown.'],
    evidence_event_ids:['ev-current'], counterevidence_event_ids:['ev-peer'], context_event_ids:['ev-context'],
    exchange_ids:['exchange-a002'], support_quotes:[{source_event_id:'ev-current',quote:'The model shortened this into a purchase question.'}],
    proposal_version:2, preview_sha256:'preview-hash-a002', context_review:[{exchange_id:'exchange-a002',classification:'supporting',
      evidence_event_ids:['ev-current','ev-peer','ev-context'],reason:'The complete exchange was reviewed; the selected items remain model interpretations.'}],
    preview_basis_event_ids:['ev-current','ev-peer','ev-context'],
    current, reasons:current ? [] : ['SOURCE_TRANSPORT_STALE'], material_preview:{title:'Possible purchase guide',content:'A fabricated paraphrase appears here.',evidence_event_ids:['ev-current']} };
  const evidence = [
    { source_event_id:'ev-current', source_ref:'forum:setup', message_id:'message-current-v3', message_version:3,
      author_id:'participant-17', text:'I am checking the current setup facts; I am not asking for a purchase recommendation and I do not consent to being contacted.',
      published_at:'2026-09-01T10:00:00Z', source_updated_at:'2026-09-01T10:04:00Z', observed_at:'2026-09-01T10:05:00Z', confirmed_at:'2026-09-01T10:06:00Z' },
    { source_event_id:'ev-peer', source_ref:'forum:setup', message_id:'message-peer-v1', message_version:1,
      author_id:'participant-29', text:'I already have the item; no initial purchase is planned.',
      published_at:'2026-09-01T11:00:00Z', source_updated_at:null, observed_at:'2026-09-01T11:05:00Z', confirmed_at:null },
    { source_event_id:'ev-context', source_ref:'forum:setup', message_id:'message-context-v2', message_version:2,
      author_id:'participant-17', text:'For context, I am only comparing the published setup notes.',
      published_at:'2026-09-01T12:00:00Z', source_updated_at:'2026-09-01T12:01:00Z', observed_at:'2026-09-01T12:03:00Z' },
  ];
  const assessment = { id:'assessment-a002', goal_id:goal.id, producer:'model', status:'captured', current:true,
    packet:{ exchanges:[{ id:'exchange-a002', source_ref:'forum:setup', current:true, evidence }] }, output:null };
  const api = async route => {
    if (route.startsWith('/api/audience?')) return { items:[{id:goal.id,title:goal.title,status:'OPEN',revision:4}],
      next_cursor:null,enabled:true,model_enabled:false,source_refs:['forum:setup'] };
    if (route === `/api/audience/${goal.id}`) return structuredClone(goal);
    if (route === `/api/audience/needs/${need.id}`) return structuredClone(need);
    if (route.startsWith('/api/audience/assessments/')) return structuredClone(assessment);
    assert.fail(`Unexpected API route ${route}`);
  };
  const view = createAudienceView({ api, command:async (action,payload) => { calls.push({action,payload}); return {}; }, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`, field:()=>'', modal:(title,html,submit) => dialogs.push({title,html,submit}), refresh:async()=>{}, notify:()=>{} });
  return { view, goal, need, assessment, evidence, calls, dialogs };
}

async function openNeed(h) {
  await h.view.load();
  await h.view.act('audience-goal', h.goal.id);
  await h.view.act('audience-need', h.need.id);
}

function invalidateSource(h, kind) {
  if (kind === 'assessment-id') h.assessment.id='sibling-assessment';
  else if (kind === 'assessment-goal') h.assessment.goal_id='sibling-goal';
  else if (kind === 'missing-event') h.need.context_event_ids=['missing-context-event'];
  else throw new Error(`Unknown invalid source scenario ${kind}`);
}

function addFirstContact(h, state='pending') {
  const maxAge=86400;
  const publishedAt=new Date(Date.now()-60_000).toISOString();
  h.evidence[0].published_at=publishedAt;
  const freshUntil=new Date(Date.parse(publishedAt)+maxAge*1000).toISOString();
  const targetQuote='I am checking the current setup facts';
  h.need.first_contact={version:1,target_event_id:'ev-current',target_quote:targetQuote,channel:'public_reply',
    help:'A public note could point to the saved setup facts.',channel_reason:'A public source supports a public response.'};
  h.need.first_contact_state={version:1,state,proposal_sha256:'a'.repeat(64),
    target:{source_ref:'forum:setup',source_event_id:'ev-current',message_id:'message-current-v3',author_ref:'participant-17'},
    target_freshness:{state:'current',published_at:publishedAt,fresh_until:freshUntil,max_age_seconds:maxAge},
    review:state==='approved' ? {id:'review-approved-1',decision:'approve',note:'Reviewed exact proposal.',reviewed_at:new Date().toISOString()} : null,
    fit:'unknown',executable:false,contact_permission:false,allowed_effects:[],outcome:'not_observed'};
}

test('A002 review puts the saved participant snapshot before model hypothesis and material', async () => {
  const h = harness(); await openNeed(h);
  const html = h.view.render();
  const block = sourceBlock(html);
  assert.ok(block, 'saved participant snapshot is rendered');
  const blockStart = html.indexOf('Слова участников · сохранённый снимок');
  assert.notEqual(blockStart, -1);
  assert.ok(blockStart < html.indexOf('Гипотеза:'), 'saved participant statements precede model interpretation');
  assert.ok(blockStart < html.indexOf('Предпросмотр предлагаемого материала'), 'saved statements precede material');
  assert.match(html,/Текущее намерение и разрешение на контакт этим снимком не подтверждены\./);
  for (const item of h.evidence) assert.ok(html.includes(item.text), `full saved source text is present: ${item.source_event_id}`);
  assert.ok(html.includes('participant-17')); assert.ok(html.includes('participant-29'));
  assert.ok(html.includes('message-current-v3')); assert.ok(html.includes('message-peer-v1'));
  assert.ok(html.includes('forum:setup'));
  for (const value of ['2026-09-01T10:00:00Z','2026-09-01T10:04:00Z','2026-09-01T10:05:00Z','2026-09-01T10:06:00Z']) {
    assert.ok(html.includes(new Date(value).toLocaleString('ru-RU')));
  }
  assert.match(html,/моделью выбрано|выбрано моделью/i);
  assert.match(html,/не является подтверждённым критерием автора|не подтверждает критерии автора/i);
  assert.match(html,/не проверен.{0,50}(человек|личност)|не подтверждён.{0,50}(человек|личност)/i);
  assert.ok(html.indexOf('I am checking the current setup facts') < html.indexOf('Гипотеза:'));
  assert.doesNotMatch(block,/The model shortened this into a purchase question/);
  assert.doesNotMatch(block,/Participants may need a starter recommendation\./);
  assert.doesNotMatch(block,/A fabricated paraphrase appears here/);
  assert.match(html,/Непроверенная интерпретация модели/);
  assert.match(html,/Participants may need a starter recommendation\./);
  assert.match(html,/The model shortened this into a purchase question/);
  assert.match(html,/A fabricated paraphrase appears here/);
  assert.deepEqual(h.calls,[]);
});

test('model-generated need title first appears inside the unverified interpretation section', async () => {
  const h=harness();
  const modelTitle='MODEL_TITLE_STARTER_PURCHASE';
  h.need.title=modelTitle;
  h.goal.needs[0].title=modelTitle;
  await openNeed(h); const html=h.view.render();
  const sourceStart=html.indexOf('Слова участников · сохранённый снимок');
  const interpretationStart=html.indexOf('Непроверенная интерпретация модели');
  const titleStart=html.indexOf(modelTitle);
  assert.notEqual(sourceStart,-1);
  assert.ok(sourceStart<interpretationStart,'saved statements precede the model attribution section');
  assert.ok(interpretationStart<titleStart,'model-generated title is introduced inside its interpretation section');
  assert.equal(html.slice(0,sourceStart).includes(modelTitle),false,'need list and panel headings stay neutral before source');
});

test('assessment or goal collision hides the source snapshot and fails closed', async () => {
  for (const scenario of [
    { marker:'FOREIGN_ASSESSMENT_TEXT_47', author:'FOREIGN_AUTHOR_47', mutate:h => { h.assessment.id='sibling-assessment'; } },
    { marker:'FOREIGN_GOAL_TEXT_83', author:'FOREIGN_AUTHOR_83', mutate:h => { h.assessment.goal_id='sibling-goal'; } },
  ]) {
    const h=harness();
    scenario.mutate(h);
    h.evidence[0].text=scenario.marker;
    h.evidence[0].author_id=scenario.author;
    await openNeed(h); const html=h.view.render();
    assert.match(html,/Сохранённое основание недоступно или не совпадает с этой гипотезой\./);
    assert.doesNotMatch(html,/Слова участников · сохранённый снимок/);
    assert.equal(sourceBlock(html),null);
    assert.equal(html.includes(scenario.marker),false,'foreign packet text is withheld everywhere');
    assert.equal(html.includes(scenario.author),false,'foreign packet author is withheld everywhere');
    assert.deepEqual(h.calls,[]);
  }
});

test('missing event, missing text, or conflicting duplicate source ID hides the whole snapshot', async () => {
  const mutations = [
    h => { h.need.context_event_ids=['missing-event']; },
    h => { h.evidence[1].text='   '; },
    h => { h.assessment.packet.exchanges.push({id:'exchange-duplicate',source_ref:'forum:other',evidence:[
      {...h.evidence[0],source_ref:'forum:other',text:'Conflicting text for the same ID.'}
    ]}); },
  ];
  for (const mutate of mutations) {
    const h=harness(); mutate(h); await openNeed(h); const html=h.view.render();
    assert.match(html,/Сохранённое основание недоступно или не совпадает с этой гипотезой\./);
    assert.doesNotMatch(html,/Слова участников · сохранённый снимок/);
    const savedBlock=sourceBlock(html);
    assert.equal(savedBlock,null);
    assert.ok(!savedBlock || !savedBlock.includes('Conflicting text for the same ID.'));
  }
});

test('source snapshot includes unselected messages from every bounded packet exchange', async () => {
  const h=harness();
  const unselected = { source_event_id:'ev-independent-peer', source_ref:'forum:peer', message_id:'peer-cancel-v4',
    message_version:4, author_id:'participant-independent-83',
    text:'I was considering a purchase, but changed my mind and cancelled it; no recommendation is needed.',
    published_at:'2026-09-02T10:00:00Z', source_updated_at:'2026-09-02T10:02:00Z', observed_at:'2026-09-02T10:03:00Z' };
  const sameAuthorCancellation={source_event_id:'ev-later-cancel',source_ref:'forum:setup',message_id:'message-later-cancel-v5',
    message_version:5,author_id:'participant-17',
    text:'I later cancelled the idea after checking the setup facts; this is not a request to buy or contact me.',
    published_at:'2026-09-04T10:00:00Z',source_updated_at:'2026-09-04T10:02:00Z',observed_at:'2026-09-04T10:03:00Z'};
  h.assessment.packet.exchanges.push({ id:'exchange-independent-peer', source_ref:'forum:peer', current:true, evidence:[unselected] });
  h.assessment.packet.exchanges.push({id:'exchange-later-cancellation',source_ref:'forum:setup',current:true,evidence:[sameAuthorCancellation]});
  await openNeed(h); const html=h.view.render();
  const block=sourceBlock(html);
  assert.ok(block, 'saved source block is present');
  assert.ok(block.includes(unselected.text), 'full unselected cancellation text is present');
  assert.ok(block.includes(unselected.author_id), 'independent author remains distinct');
  assert.ok(block.includes(unselected.message_id));
  assert.ok(block.includes(sameAuthorCancellation.text),'later cancellation by the already represented author remains in the snapshot');
  assert.ok(block.includes(sameAuthorCancellation.author_id));
  assert.ok(block.includes(sameAuthorCancellation.message_id));
  for (const value of ['2026-09-04T10:00:00Z','2026-09-04T10:02:00Z','2026-09-04T10:03:00Z']) {
    assert.ok(block.includes(new Date(value).toLocaleString('ru-RU')));
  }
  assert.match(block,/не выбрано моделью|не выбрана моделью|не выбиралось моделью/i);
  assert.ok(html.indexOf(unselected.text)<html.indexOf('Гипотеза:'), 'unselected saved source precedes model interpretation');
  assert.deepEqual(h.calls,[]);
});

test('source attribution follows proposal producer and stays neutral when producer is unknown', async () => {
  const h=harness();
  const unselected={source_event_id:'ev-operator-unselected',source_ref:'forum:peer',message_id:'operator-peer-v1',
    author_id:'operator-peer-61',text:'I changed my mind and cancelled; I am not asking for any advice.',published_at:'2026-09-03T10:00:00Z',
    source_updated_at:null,observed_at:'2026-09-03T10:02:00Z'};
  h.assessment.packet.exchanges.push({id:'exchange-operator-peer',source_ref:'forum:peer',current:true,evidence:[unselected]});
  h.assessment.producer='operator';
  await openNeed(h);
  let html=h.view.render();
  let block=sourceBlock(html);
  assert.ok(block);
  for (const item of h.evidence) assert.ok(block.includes(item.text));
  assert.match(block,/Выбрано оператором/);
  assert.match(block,/Не выбрано оператором/);
  assert.ok(block.includes(unselected.text));
  assert.match(block,/Не выбрано оператором/);
  assert.doesNotMatch(block,/Выбрано моделью|Не выбрано моделью/);
  assert.doesNotMatch(html,/Непроверенная интерпретация модели/);
  assert.match(html,/Непроверенная интерпретация оператора/);

  delete h.assessment.producer;
  await h.view.load();
  html=h.view.render();
  block=sourceBlock(html);
  assert.ok(block);
  assert.match(block,/Выбрано автором гипотезы/);
  assert.match(block,/Не выбрано автором гипотезы/);
  assert.doesNotMatch(block,/Выбрано моделью|Выбрано оператором/);
  assert.match(html,/Непроверенная интерпретация · автор не указан/);
  assert.doesNotMatch(html,/Gemini|OpenAI/i);
  assert.deepEqual(h.calls,[]);
});

test('unavailable source blocks positive need, material, contact, and Continuity actions in render and action paths', async () => {
  const cases=[
    {action:'audience-accept',prepare:h=>{h.need.status='proposed';}},
    {action:'audience-import-preview',prepare:h=>{h.need.linked_work_case={id:'case-1',revision:3,current:true};}},
    {action:'audience-first-contact-approve',prepare:addFirstContact},
    {action:'audience-open-work',prepare:()=>{}},
    {action:'audience-refresh-work',prepare:h=>{h.need.thread_id='thread-existing';}},
  ];
  for (const invalidation of ['assessment-id','missing-event']) {
    for (const scenario of cases) {
      const h=harness(); scenario.prepare(h); invalidateSource(h,invalidation); await openNeed(h);
      const html=h.view.render();
      assert.match(html,/Сохранённое основание недоступно или не совпадает с этой гипотезой\./);
      assert.doesNotMatch(html,new RegExp(`data-do="${scenario.action}"`));
      await assert.rejects(h.view.act(scenario.action,h.need.id),undefined,`${scenario.action} blocked for ${invalidation}`);
      assert.deepEqual(h.calls,[],`${scenario.action} issued no command for ${invalidation}`);
    }
  }
});

test('acceptance and first-contact approval recheck source binding when a modal is submitted', async () => {
  for (const invalidation of ['assessment-id','missing-event']) {
    for (const action of ['audience-accept','audience-first-contact-approve']) {
      const h=harness();
      if (action==='audience-accept') h.need.status='proposed';
      else addFirstContact(h);
      await openNeed(h);
      await h.view.act(action,h.need.id);
      assert.equal(h.dialogs.length,1,'valid source opens the review modal');
      invalidateSource(h,invalidation);
      await h.view.load();
      assert.equal(sourceBlock(h.view.render()),null);
      await assert.rejects(h.dialogs[0].submit({note:'Reviewed the saved basis.'}),undefined,
        `${action} modal submit blocked after ${invalidation}`);
      assert.deepEqual(h.calls,[]);
    }
  }
});

test('acceptance modal is bound to the need revision and basis shown at review time', async () => {
  const h=harness(); h.need.status='proposed'; await openNeed(h);
  await h.view.act('audience-accept',h.need.id);
  h.need.revision+=1; h.need.basis_fingerprint='changed-basis';
  await h.view.load();
  await assert.rejects(h.dialogs.at(-1).submit({note:'Submit after basis changed.'}));
  assert.deepEqual(h.calls,[]);
});

test('valid saved source still permits explicit hypothesis acceptance and material import', async () => {
  const accept=harness(); accept.need.status='proposed'; await openNeed(accept);
  assert.match(accept.view.render(),/data-do="audience-accept"/);
  assert.ok(sourceBlock(accept.view.render()));
  await accept.view.act('audience-accept',accept.need.id);
  await accept.dialogs.at(-1).submit({note:'Reviewed the saved source and hypothesis.'});
  assert.equal(accept.calls.at(-1).action,'audience.review');
  assert.equal(accept.calls.at(-1).payload.decision,'accept');

  const importCase=harness();
  importCase.need.linked_work_case={id:'case-valid-source',revision:6,current:true};
  await openNeed(importCase);
  assert.ok(sourceBlock(importCase.view.render()));
  assert.match(importCase.view.render(),/data-do="audience-import-preview"/);
  await importCase.view.act('audience-import-preview',importCase.need.id);
  assert.equal(importCase.calls.at(-1).action,'audience.import_preview');
});

test('acceptance and contact-approval modals reject late current or status changes', async () => {
  const lateChanges=[
    h=>{h.need.current=false;},
    h=>{h.need.status='stale';},
  ];
  for (const change of lateChanges) {
    const accept=harness(); accept.need.status='proposed'; await openNeed(accept);
    await accept.view.act('audience-accept',accept.need.id);
    change(accept); await accept.view.load();
    await assert.rejects(accept.dialogs.at(-1).submit({note:'Submit after need state changed.'}));
    assert.deepEqual(accept.calls,[]);

    const contact=harness(); addFirstContact(contact); await openNeed(contact);
    await contact.view.act('audience-first-contact-approve',contact.need.id);
    change(contact); await contact.view.load();
    await assert.rejects(contact.dialogs.at(-1).submit({note:'Submit after contact basis changed.'}));
    assert.deepEqual(contact.calls,[]);
  }
});

test('reject, approved-contact withdrawal, and independent reassessment cancellation remain available with missing source', async () => {
  const reject=harness(); reject.need.status='proposed'; invalidateSource(reject,'missing-event');
  reject.goal.assessments=[{id:'assessment-a002',status:'captured',producer:'model'}];
  reject.assessment.status='captured'; reject.assessment.packet.reassessment={version:1,need_id:reject.need.id};
  await openNeed(reject);
  let html=reject.view.render();
  assert.equal(sourceBlock(html),null);
  assert.match(html,/data-do="audience-reject"/);
  assert.match(html,/data-do="audience-cancel-reassessment"/);
  await reject.view.act('audience-reject',reject.need.id);
  await reject.dialogs.at(-1).submit({note:'Rejecting remains available.'});
  await reject.view.act('audience-cancel-reassessment','assessment-a002');
  assert.deepEqual(reject.calls.map(call=>call.action),['audience.review','audience.cancel_reassessment']);

  const withdrawal=harness(); addFirstContact(withdrawal,'approved');
  invalidateSource(withdrawal,'missing-event'); await openNeed(withdrawal);
  html=withdrawal.view.render();
  assert.equal(sourceBlock(html),null);
  assert.match(html,/data-do="audience-first-contact-reject"/);
  assert.doesNotMatch(html,/data-do="audience-first-contact-approve"/);
  await withdrawal.view.act('audience-first-contact-reject',withdrawal.need.id);
  await withdrawal.dialogs.at(-1).submit({note:'Withdraw the prior text approval.'});
  assert.deepEqual(withdrawal.calls.map(call=>call.action),['audience.review_first_contact']);
  assert.equal(withdrawal.calls[0].payload.decision,'reject');
});

test('foreign need and assessment matching each other cannot bind to the selected goal', async () => {
  const h=harness();
  h.need.goal_id='sibling-goal'; h.assessment.goal_id='sibling-goal';
  await openNeed(h); const html=h.view.render();
  assert.match(html,/Сохранённое основание недоступно или не совпадает с этой гипотезой\./);
  assert.equal(sourceBlock(html),null);
  assert.equal(html.includes(h.evidence[0].text),false);
});

test('assessment panel and cancellation require a present matching goal binding', async () => {
  for (const goalBinding of ['missing','foreign']) {
    const h=harness();
    h.goal.assessments=[{id:'assessment-a002',status:'captured',producer:'model'}];
    h.assessment.status='captured'; h.assessment.packet.reassessment={version:1,need_id:h.need.id};
    if (goalBinding==='missing') delete h.assessment.goal_id;
    else h.assessment.goal_id='sibling-goal';
    await h.view.load(); await h.view.act('audience-goal',h.goal.id);
    await h.view.act('audience-assessment','assessment-a002');
    const html=h.view.render();
    assert.match(html,/Открыть сбор/,'bounded assessment history remains visible');
    assert.doesNotMatch(html,/<h2>Основание сбора<\/h2>/,`${goalBinding} goal must not open a focused panel`);
    assert.doesNotMatch(html,/data-do="audience-cancel-reassessment"/);
    await assert.rejects(h.view.act('audience-cancel-reassessment','assessment-a002'));
    assert.deepEqual(h.calls,[]);
  }
});

test('historical snapshot is labeled stale; absent author and clocks stay explicitly unknown', async () => {
  const h=harness({current:false});
  delete h.evidence[0].author_id;
  h.evidence[0].source_updated_at=null; delete h.evidence[0].confirmed_at;
  await openNeed(h); const html=h.view.render();
  assert.match(html,/Исторический снимок; основание гипотезы сейчас неактуально\./);
  assert.match(html,/неизвестен/);
  assert.match(html,/неизвестно/);
  assert.doesNotMatch(html,/participant-29.{0,120}author|author.{0,120}participant-29/i);
});

test('source statements and metadata are escaped, including hostile event and identity fields', async () => {
  const h=harness();
  Object.assign(h.evidence[0],{text:hostile,author_id:hostile,source_ref:hostile,message_id:hostile,
    published_at:hostile,source_updated_at:hostile,observed_at:hostile,confirmed_at:hostile});
  await openNeed(h); const html=h.view.render();
  assert.ok(html.includes('&lt;img src=x onerror=&quot;run()&quot;&gt;'));
  assert.equal(html.includes(hostile),false);
  assert.match(html,/Слова участников · сохранённый снимок/);
});
