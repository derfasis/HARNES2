import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceModelPacket } from '../business/audience-decisions.mjs';

test('model projection preserves every selected source fact and clock without operator or withheld text', () => {
  const packet = { id:'goal',revision:1,title:'Owner objective',objective:'Help with running information',
    assessment_id:'assessment',proposal_contract_version:2,basis_fingerprint:'basis',
    exchanges:[{ id:'exchange',source_ref:'public:test',anchor_id:'root',fingerprint:'fp',current:true,
      evidence:[{ source_event_id:'1',text:'Where is the meeting?',published_at:'2025-01-01T00:00:00Z',source_updated_at:null,
        observed_at:'2026-01-01T00:00:00Z',confirmed_at:null,reply_to_id:null,author_id:'unproven-account' },
        { source_event_id:'2',text:'Already found the answer.',published_at:null,source_updated_at:null,
          observed_at:'2026-01-01T00:00:01Z',confirmed_at:null,reply_to_id:'root' }],unsupported_count:1 }],
    needs:[{id:'old-need',hypothesis:'Historical guess',semantic_role:'hypothesis_memory_not_source_evidence',resolution:'unknown'}],
    coverage:{source_completeness:'unknown',identity_independence:'unproven'},
    assessments:[{output:'operator history must not enter prompt'}],
    withheld_exchanges:[{id:'opaque',reasons:['AUDIENCE_ANCHOR_UNSUPPORTED'],evidence:[{text:'WITHHELD SECRET CONTEXT'}]}],
    watches:[{health:{reason:'operator-only'}}],scope:{goal_id:'goal'},observation_heads:[['public:test',2]] };
  const before = JSON.stringify(packet), model = audienceModelPacket(packet);
  assert.equal(JSON.stringify(packet), before, 'canonical durable packet is never modified');
  assert.deepEqual(model.exchanges[0].evidence,packet.exchanges[0].evidence,'selected counter/resolving text and clocks survive exactly');
  assert.equal(model.exchanges[0].unsupported_count,1,'opaque leaves remain explicit unknowns');
  assert.deepEqual(model.needs,packet.needs,'historical interpretation is labeled and retained');
  assert.equal(model.coverage.source_completeness,'unknown');
  assert.equal(model.coverage.withheld_reason_counts.AUDIENCE_ANCHOR_UNSUPPORTED,1);
  for (const key of ['assessments','withheld_exchanges','watches','observation_heads','scope']) assert.equal(model[key],undefined,key);
  assert.equal(JSON.stringify(model).includes('WITHHELD SECRET CONTEXT'),false);
  assert.equal(JSON.stringify(model).includes('operator history'),false);
  assert.ok(Buffer.byteLength(JSON.stringify(model)) < Buffer.byteLength(before));
  model.exchanges[0].evidence[0].text='mutated projection';
  assert.equal(JSON.stringify(packet),before,'projection owns its data');
});

test('focused projection reports its nested bounded exclusions without claiming a zero or complete backlog', () => {
  const packet = {id:'goal',revision:1,exchanges:[],needs:[],coverage:{source_completeness:'unknown',
    omitted_sample_exchanges:2,withheld_exchanges:[{id:'omitted',reasons:['AUDIENCE_ANCHOR_UNSUPPORTED'],evidence:[{text:'EXCLUDED'}]}]}};
  const model = audienceModelPacket(packet);
  assert.equal(model.coverage.withheld_sample_exchanges,1);
  assert.equal(model.coverage.withheld_reason_counts.AUDIENCE_ANCHOR_UNSUPPORTED,1);
  assert.equal(model.coverage.omitted_sample_exchanges,2);
  assert.equal(model.coverage.source_completeness,'unknown');
  assert.equal(model.coverage.withheld_exchanges,undefined);
  assert.equal(JSON.stringify(model).includes('EXCLUDED'),false);
});
