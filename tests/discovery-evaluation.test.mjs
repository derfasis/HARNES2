import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {discoveryEvaluationContexts,validateDiscoveryCorpus,evaluateDiscoveryPredictions} from '../business/discovery-evaluation.mjs';
const corpus=JSON.parse(fs.readFileSync(new URL('../benchmarks/discovery-v1/corpus.json',import.meta.url),'utf8'));
const contexts=discoveryEvaluationContexts(corpus);
function predictions() {
  return {contract_version:'discovery-predictions-v1',provenance:{kind:'synthetic_test',label:'Hand-authored arithmetic oracle, not model capability'},
    predictions:corpus.episodes.flatMap(e=>e.checkpoints).map(cp=>{
      const context=contexts.find(c=>c.checkpoint_id===cp.id);
      return {checkpoint_id:cp.id,prefix_hash:context.prefix_hash,offer_version:corpus.offer.version,
        decision:cp.judgment.acceptable_decisions[0],assessment:cp.judgment.acceptable_assessments[0],
        evidence:structuredClone(cp.judgment.sufficient_evidence[0]??[]),authority:{contact_permission:false,allowed_effects:[]}};
    })};
}
test('corpus is temporal, explicitly synthetic and default report never claims measured model quality',()=>{
  validateDiscoveryCorpus(corpus);const r=evaluateDiscoveryPredictions(corpus);
  assert.equal(r.episodes,15);assert.equal(r.checkpoints,31);assert.deepEqual(r.labels,{positive:10,negative:15,uncertain:2,insufficient_evidence:4});
  assert.equal(r.model_quality_measured,false);assert.equal(r.live_proof,false);assert.equal(r.precision,null);assert.equal(r.recall,null);
});
test('blind prefixes contain no gold, later validation or future messages; edits replace earlier evidence',()=>{
  for(const c of contexts)assert.doesNotMatch(JSON.stringify(c),/acceptable_decisions|sufficient_evidence|later_validation|rationale/);
  const earlier=contexts.find(c=>c.checkpoint_id==='later-new-need-1');assert.equal(earlier.observations.length,1);assert.doesNotMatch(JSON.stringify(earlier),/впервые/);
  const edited=contexts.find(c=>c.checkpoint_id==='edited-evidence-2');assert.equal(edited.observations.length,1);assert.equal(edited.observations[0].version,2);
  const deleted=contexts.find(c=>c.checkpoint_id==='deleted-evidence-2');assert.equal(deleted.observations.length,0);assert.equal(deleted.coverage.incomplete,true);
});
test('old optional opaque is omitted; required opaque and missing parents mark incomplete coverage',()=>{
  assert.equal(contexts.find(c=>c.checkpoint_id==='opaque-boundaries-1').coverage.incomplete,true);
  assert.equal(contexts.find(c=>c.checkpoint_id==='opaque-boundaries-2').coverage.incomplete,false);
  assert.equal(contexts.find(c=>c.checkpoint_id==='missing-parent-1').coverage.incomplete,true);
});
test('oracle tests arithmetic only; WAIT on all positive cases yields zero recall despite zero false positives',()=>{
  const oracle=predictions();const perfect=evaluateDiscoveryPredictions(corpus,oracle);
  assert.equal(perfect.precision,1);assert.equal(perfect.recall,1);assert.equal(perfect.model_quality_measured,false);
  for(const p of oracle.predictions){p.decision='WAIT';p.assessment='uncertain';p.evidence=[];}
  const r=evaluateDiscoveryPredictions(corpus,oracle);assert.equal(r.recall,0);assert.equal(r.confusion.false_negative,10);assert.equal(r.confusion.false_positive,0);
  assert.equal(r.positive_misses_total,10);assert.ok(r.detection_windows.every(x=>x.missed_in_window));
});
test('missing and invalid predictions stay in recall denominator; forged spans and permission fail boundaries',()=>{
  const set=predictions();const positives=set.predictions.filter(p=>p.decision==='REVIEW');
  set.predictions=set.predictions.filter(p=>p!==positives[0]);positives[1].evidence[0].span='Never said this';positives[2].authority.contact_permission=true;
  const r=evaluateDiscoveryPredictions(corpus,set);assert.equal(r.missing_by_label.positive,1);assert.equal(r.invalid_by_label.positive,2);
  assert.equal(r.recall,0.7);assert.equal(r.grounded_recall,0.7);assert.equal(r.positive_misses_total,3);
});
test('false positives, abstentions and uncertain positives are distinct; conservative precision includes unadjudicated proposals',()=>{
  const set=predictions();
  for(const cp of ['professional-profile-1','weak-hint-2']) {
    const p=set.predictions.find(p=>p.checkpoint_id===cp),c=contexts.find(c=>c.checkpoint_id===cp),m=c.observations.at(-1);
    p.decision='REVIEW';p.assessment='opportunity';p.evidence=[{source_event_id:m.source_event_id,span:m.text,kind:'question',attribution:'author_statement'}];
  }
  const r=evaluateDiscoveryPredictions(corpus,set);assert.equal(r.confusion.false_positive,1);assert.equal(r.unadjudicated_positive_proposals,1);
  assert.equal(r.precision,10/11);assert.equal(r.conservative_precision,10/12);
});
test('detection delay measures first eligible prefix, not future hindsight; refusal closes its window',()=>{
  const set=predictions();const p=set.predictions.find(p=>p.checkpoint_id==='accumulating-situation-3');p.decision='WAIT';p.assessment='uncertain';
  const r=evaluateDiscoveryPredictions(corpus,set),window=r.detection_windows.find(w=>w.episode_id==='accumulating-situation');
  assert.equal(window.delay_observations,1);assert.equal(r.detection_windows.find(w=>w.episode_id==='explicit-refusal').window_closed,true);
  const invalid=structuredClone(corpus);invalid.episodes.find(e=>e.id==='later-new-need').later_validation[0].interpretation='missed_existing_evidence';
  assert.throws(()=>validateDiscoveryCorpus(invalid),/HINDSIGHT_RELABEL/);
});
test('unknown/duplicate checkpoints and time/version rollback fail instead of silently improving scores',()=>{
  const set=predictions();set.predictions.push(set.predictions[0]);assert.throws(()=>evaluateDiscoveryPredictions(corpus,set),/DUPLICATE_PREDICTION/);
  set.predictions.pop();set.predictions[0].prefix_hash='a'.repeat(64);assert.equal(evaluateDiscoveryPredictions(corpus,set).invalid_by_label.negative,1);
  const invalid=structuredClone(corpus);invalid.episodes[0].events[1].observed_at='2000-01-01T00:00:00.000Z';assert.throws(()=>validateDiscoveryCorpus(invalid),/REVERSED_OBSERVATION_TIME/);
});
