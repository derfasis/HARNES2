// Strict new model contract; local fake provider only, no model/network credentials used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, proposalFrom } from './audience-test-helpers.mjs';

test('a new model assessment cannot return a legacy proposal or omit supplied context accounting', async t => {
  const before = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-test-sentinel-never-sent';
  t.after(() => { if (before === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = before; });
  for (const missing of ['proposal_version', 'context_review']) {
    const h = audienceHarness(t);
    h.config.audience.modelEnabled = true; h.config.audience.maxRunsPerDay = 3;
    Object.assign(h.config.runtime, { maxRunsPerDay: 20, baseUrl: 'https://never-contacted.invalid/v1', model: 'offline-fake', dailyBudgetUsd: null });
    await h.open(); await h.ingest({ message_id: 'request', text: 'Could you explain how to get started?' });
    h.service.audience.reconcile({ limit: 10 });
    let calls = 0;
    const runtime = { decide: async (_run, context) => {
      calls++;
      assert.equal(context.packet.proposal_contract_version, 2);
      assert.ok(context.output_contract.properties.needs.items.required.includes('context_review'));
      const output = proposalFrom(context.packet);
      delete output.needs[0][missing];
      if (missing === 'proposal_version') { delete output.needs[0].context_event_ids; delete output.needs[0].context_review; }
      return { completed: true, final_response: JSON.stringify(output), usage: { input_tokens: 13, output_tokens: 7 } };
    } };
    const result = await processAudienceAssessment(h.service, runtime);
    assert.equal(result.disposition, 'AUDIENCE_PROPOSAL_INVALID');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
    assert.equal(h.store.get('SELECT input_tokens FROM runs').input_tokens, 13);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
    await processAudienceAssessment(h.service, runtime);
    assert.equal(calls, 1, 'a malformed new-contract result cannot silently rebuy the considered packet');
  }
});
