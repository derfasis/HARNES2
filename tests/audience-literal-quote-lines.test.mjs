import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionBindings } from '../business/audience-decisions.mjs';
import { validateOutput } from '../business/audience.mjs';

// Synthetic reproduction of a live failure: the model replaced a source newline
// with a space. That answer was valid JSON but failed the literal evidence proof.
const packet = { exchanges: [{ id: 'exchange-1', evidence: [{ source_event_id: '1',
  text: 'Публичная заметка.\nУсловия программы уточняются.\nРезультат пока не подтверждён.' }] }] };
const output = quote => ({ needs: [], decision_review: {
  version: 1, scope: 'supplied_packet_only', disposition: 'no_need_proposed',
  summary: 'В заметке нет индивидуального запроса.', unknowns: ['Результат неизвестен.'],
  exchange_reviews: [{ exchange_id: 'exchange-1', judgment: 'no_proposal',
    reason: 'Это общая заметка без вопроса участника.', evidence_event_ids: ['1'],
    support_quotes: [{ source_event_id: '1', quote }] }],
} });

test('a schema-valid review cannot join two source lines into a fabricated contiguous quote', () => {
  const candidate = output('Условия программы уточняются. Результат пока не подтверждён.');
  assert.equal(validateOutput(candidate), true);
  assert.throws(() => decisionBindings(candidate, packet),
    error => error.code === 'AUDIENCE_DECISION_QUOTE_MISMATCH');
});

test('a literal excerpt from a single source line remains admissible', () => {
  const candidate = output('Условия программы уточняются.');
  assert.equal(validateOutput(candidate), true);
  assert.equal(decisionBindings(candidate, packet), candidate.decision_review);
});

test('a JSON-encoded multiline quote preserves its literal source newline', () => {
  const candidate = JSON.parse(JSON.stringify(output('Условия программы уточняются.\nРезультат пока не подтверждён.')));
  assert.equal(validateOutput(candidate), true);
  assert.equal(decisionBindings(candidate, packet), candidate.decision_review);
});
