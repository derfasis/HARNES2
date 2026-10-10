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
  const calls = [], goal = { id:'goal-a002', title:'Understand setup concerns', status:'OPEN', revision:4,
    objective:'Learn what participants need before deciding whether to act.', source_refs:['forum:setup'],
    needs:[{ id:'need-a002', title:'A002 hypothesis', status:'accepted', revision:8 }] };
  const need = { id:'need-a002', goal_id:goal.id, assessment_id:'assessment-a002', status:'accepted', revision:8,
    title:'A002 hypothesis', hypothesis:'Participants may need a starter recommendation.',
    why_now:'The model inferred an opportunity from the saved sample.', next_step:'prepare_material',
    reason:'The model read the exchange as interest in buying.', epistemic_status:'unverified_interpretation',
    unknowns:['Whether anyone wants a purchase recommendation is unknown.'],
    evidence_event_ids:['ev-current'], counterevidence_event_ids:['ev-peer'], context_event_ids:['ev-context'],
    exchange_ids:['exchange-a002'], support_quotes:[{source_event_id:'ev-current',quote:'The model shortened this into a purchase question.'}],
    proposal_version:2, context_review:[{exchange_id:'exchange-a002',classification:'supporting',
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
  const assessment = { id:'assessment-a002', goal_id:goal.id, status:'captured', current:true,
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
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`, field:()=>'', modal:()=>{}, refresh:async()=>{}, notify:()=>{} });
  return { view, goal, need, assessment, evidence, calls };
}

async function openNeed(h) {
  await h.view.load();
  await h.view.act('audience-goal', h.goal.id);
  await h.view.act('audience-need', h.need.id);
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
  h.assessment.packet.exchanges.push({ id:'exchange-independent-peer', source_ref:'forum:peer', current:true, evidence:[unselected] });
  await openNeed(h); const html=h.view.render();
  const block=sourceBlock(html);
  assert.ok(block, 'saved source block is present');
  assert.ok(block.includes(unselected.text), 'full unselected cancellation text is present');
  assert.ok(block.includes(unselected.author_id), 'independent author remains distinct');
  assert.ok(block.includes(unselected.message_id));
  assert.match(block,/не выбрано моделью|не выбрана моделью|не выбиралось моделью/i);
  assert.ok(html.indexOf(unselected.text)<html.indexOf('Гипотеза:'), 'unselected saved source precedes model interpretation');
  assert.deepEqual(h.calls,[]);
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
