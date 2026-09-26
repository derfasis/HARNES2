// The refusal sidecar: a refused call leaves a record of why, and the record is structure only.
// proof_level=synthetic_contract_eval; live_proof=false. The model call is stubbed in tests and
// this file spends none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { structuralType, shapeErrorOf } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';
import { REFUSAL_FILE, REFUSAL_REASONS, readRefusals, recordRefusal, refusalReceipt,
  validateReceipt } from '../docs/benchmarks/decision-quality-eval-v0/generation/refusal.mjs';
import { completedOutputs } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';
import { readArtefacts, runGeneration } from '../docs/benchmarks/decision-quality-eval-v0/generation/run.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-'));
const temp = (name) => {
  const directory = path.join(scratch(), name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};
const readSidecar = (directory) => fs.readFileSync(path.join(directory, REFUSAL_FILE), 'utf8');

const message = (over = {}) => ({ source_event_id: 'ev-1', author_id: 'user-02', version: 1,
  channel: 'public', direction: 'in', text: 'Как устроено партнёрство?', created_at: '2026-01-01T00:01:00.000Z',
  reply_to_id: null, is_anchor: true, ...over });

const stagedCase = (over = {}) => ({
  case_id: 'case-1',
  provenance: { kind: 'sanitized_fixture' },
  situation: { situation_id: 'sit-1', goal_text: 'Assess usefulness for operator review only.',
    allowed_channels: ['public'] },
  subject: { author_id: 'user-02' },
  messages: [message({ source_event_id: 'ev-1', author_id: 'user-01', text: 'Обсуждаем партнёрство.',
    is_anchor: false }), message({ source_event_id: 'ev-2' })],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: ['Цена не подтверждена.'],
  ...over });

const stagedInput = (cases = [stagedCase()]) => ({
  input_id: 'd4-generation-v0', live_proof: false, prompt_ref: 'prompt-7', cases });

// The output contract in full: every required field is here, so a refusal this test provokes is
// the one it means to provoke and not an earlier `required` failure standing in for it.
const validOutput = () => ({
  hypothesis: { text: null, evidence: [], contradictions: [], unknowns: ['Цена не подтверждена.'] },
  next_action: { schema_version: 1, situation_id: 'sit-1', decision: 'IGNORE', confidence: 0.4,
    strategy: 'Не отвечать, пока нет запроса, на который можно ответить.',
    reason: 'В сообщении нет прямого запроса к агенту.', evidence_message_ids: ['ev-1'],
    unknowns: [], risk_flags: [], draft: null,
    review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
  authority: { contact_permission: false, allowed_effects: [] },
});

const span = (over = {}) => ({ source_event_id: 'ev-1', author_id: 'user-01', version: 1,
  text: 'Обсуждаем', kind: 'question', attribution: 'author_statement', ...over });

const response = (over = {}) => ({ raw: JSON.stringify(validOutput()), model_id: 'runtime-model',
  model_version: 'runtime-2026-02', ...over });

// The run is driven with the gate, preflight and plan stubbed out: these tests are about what a
// refusal leaves behind, and a staged corpus is not what is under test.
const run = (directory, callModel, cases = [stagedCase()]) => runGeneration({
  input: stagedInput(cases), callModel, directory, environment: {},
  gate: { allowed: true, reasons: [] }, problems: [],
  store: (caseId, payload) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${caseId}.json`), JSON.stringify(payload, null, 2));
  } });

// The live run's failure, reproduced exactly: a span-shaped slot that received a bare string.
const stringInContradictions = JSON.stringify({ ...validOutput(),
  hypothesis: { text: 'Обсуждаем партнёрство.', evidence: [span()], unknowns: [],
    contradictions: ['not a span'] } });

test('a schema refusal records the path, the keyword and the type that arrived', async () => {
  const directory = temp('schema');
  const result = await run(directory, async () => response({ raw: stringInContradictions }));
  assert.equal(result.summary.refused, 1);
  const { receipts, corrupted } = readRefusals(directory);
  assert.deepEqual(corrupted, []);
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.reason, 'schema');
  assert.equal(receipt.case_id, 'case-1');
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.instance_path, '/hypothesis/contradictions/0');
  assert.equal(receipt.keyword, 'type');
  assert.equal(receipt.expected_type, 'object');
  assert.equal(receipt.actual_type, 'string');
  assert.match(receipt.schema_path, /^#\/\$defs\//);
});

test('a schema refusal leaves no output artefact, and the sidecar is not one either', async () => {
  const directory = temp('no-artefact');
  await run(directory, async () => response({ raw: stringInContradictions }));
  // Nothing is stored as an answer: the rule that a refused output is written nowhere still holds.
  assert.deepEqual(readArtefacts(directory), {});
  // And the record of the refusal is not promoted into one by being counted as an artefact.
  const input = stagedInput();
  assert.equal(completedOutputs(input, readArtefacts(directory)).size, 0);
  assert.deepEqual(readArtefacts(directory), {});
  // A receipt-shaped file is still not an artefact, whatever it is called.
  const directory2 = temp('sidecar-name');
  await run(directory2, async () => response({ raw: stringInContradictions }));
  fs.writeFileSync(path.join(directory2, 'case-1.json'), readSidecar(directory2));
  assert.deepEqual(Object.keys(readArtefacts(directory2)), ['case-1']);
  assert.equal(completedOutputs(stagedInput(), readArtefacts(directory2)).size, 0);
});

test('no receipt anywhere on disk holds the refused text, the offending value or a provider message',
  async () => {
    const secret = 'sk-live-abcdef0123456789';
    const directory = temp('no-leak');
    await run(directory, async () => response({ raw: stringInContradictions }));
    await run(directory, async () => { throw new Error(`provider said ${secret}`); },
      [stagedCase({ case_id: 'case-2' })]);
    const sidecar = readSidecar(directory);
    assert.ok(!sidecar.includes(secret), 'provider message leaked into the sidecar');
    assert.ok(!sidecar.includes('not a span'), 'the offending value leaked into the sidecar');
    assert.ok(!sidecar.includes('Обсуждаем'), 'the model text leaked into the sidecar');
    assert.ok(!sidecar.includes('Цена не подтверждена'), 'the model text leaked into the sidecar');
    // The value's type is recorded; the value is not.
    assert.ok(sidecar.includes('"actual_type":"string"'));
  });

test('the closed reason set covers every way a call can be refused', () => {
  const cases = [
    [['model_transport_call_failed:boom'], 'transport'],
    [['runtime_did_not_report_model_id'], 'identity'],
    [['runtime_did_not_report_model_version'], 'identity'],
    [['output_is_not_json'], 'parse'],
    [['output_is_not_a_json_object'], 'parse'],
    [['raw_must_be_the_text_the_runtime_returned'], 'parse'],
    [['output_schema:type/hypothesis/contradictions/0'], 'schema'],
    [['output_invents_situation_id'], 'contract'],
    [['span_text_is_not_grounded_in_its_own_message:ev-1'], 'contract'],
    [['this_evaluation_is_frozen_to_another_model'], 'frozen_identity'],
  ];
  for (const [failures, reason] of cases) {
    const receipt = refusalReceipt({ caseId: 'case-1', attempt: 1, failures });
    assert.equal(receipt.reason, reason, `${failures[0]} should be ${reason}`);
    assert.ok(REFUSAL_REASONS.includes(receipt.reason));
  }
  // A rule this module has never seen is a contract problem, not a new category invented at
  // runtime: the set is closed so a receipt means the same thing in a later run.
  assert.equal(refusalReceipt({ caseId: 'c', attempt: 1, failures: ['something_new'] }).reason,
    'contract');
  // A transport message is dropped, not stored: only the rule name reaches the record.
  const transport = refusalReceipt({ caseId: 'c', attempt: 1,
    failures: ['model_transport_call_failed:401 from api.example with key sk-live-1'] });
  assert.equal(transport.code, 'model_transport_call_failed');
  assert.ok(!JSON.stringify(transport).includes('sk-live-1'));
  assert.equal(refusalReceipt({ caseId: 'c', attempt: 1, failures: [] }), null);
});

test('an accepted case writes no receipt, and a retry appends rather than overwrites', async () => {
  const accepted = temp('accepted');
  await run(accepted, async () => response());
  assert.equal(fs.existsSync(path.join(accepted, REFUSAL_FILE)), false);
  // A refused attempt, then a second attempt at the same case that is accepted. The plan only
  // skips a case that produced an answer, so a refusal leaves the case in the plan — which is
  // what makes the second attempt happen at all.
  const directory = temp('retry');
  const cases = [stagedCase()];
  await run(directory, async () => response({ raw: stringInContradictions }), cases);
  const first = readSidecar(directory);
  await run(directory, async () => response(), cases);
  assert.equal(readSidecar(directory), first, 'the accepted retry must leave the receipt alone');
  assert.equal(readSidecar(directory).trim().split('\n').length, 1,
    'an accepted case writes no receipt of its own');
  // A second refusal at the same case is a second line with its own attempt number, so a retry
  // cannot read as the first try, and the first record is not overwritten.
  const second = temp('retry-twice');
  await run(second, async () => response({ raw: stringInContradictions }), cases);
  const afterFirst = readSidecar(second);
  await run(second, async () => response({ raw: stringInContradictions }), cases);
  assert.equal(readSidecar(second).startsWith(afterFirst), true,
    'the first receipt must still stand verbatim at the top of the file');
  const both = readRefusals(second).receipts;
  assert.deepEqual(both.map((entry) => entry.attempt), [1, 2]);
  assert.deepEqual(both.map((entry) => entry.case_id), ['case-1', 'case-1']);
});

test('a malformed receipt is refused on the way in, and a damaged line is reported, not skipped',
  () => {
    assert.equal(validateReceipt({ ...refusalReceipt({ caseId: 'c', attempt: 1, failures: ['x'] }),
      reason: 'whatever' }), 'refusal_reason_must_be_one_of:transport|identity|parse|schema|contract|frozen_identity');
    assert.throws(() => recordRefusal(temp('bad'), { case_id: 'c', attempt: 0, reason: 'schema',
      code: null, instance_path: null, schema_path: null, keyword: null, expected_type: null,
      actual_type: null }), /malformed refusal receipt/);
    // A case id the staging contract would have refused to stage cannot reach the sidecar either:
    // the record is never wider than the inputs it describes.
    for (const caseId of ['', ' ', 'live ddX-013', '../escape', 'имя', 'a'.repeat(151), 42, null])
      assert.equal(validateReceipt({ ...refusalReceipt({ caseId: 'live-ddX-013', attempt: 1,
        failures: ['output_is_not_json'] }), case_id: caseId }),
      'receipt_case_id_must_match_the_staging_contract_pattern', `${String(caseId)} should be refused`);
    assert.equal(validateReceipt({ ...refusalReceipt({ caseId: 'live-ddX-013', attempt: 1,
      failures: ['output_is_not_json'] }), case_id: 'live-ddX-013' }), null);
    const directory = temp('damaged');
    fs.writeFileSync(path.join(directory, REFUSAL_FILE),
      '{"attempt":1,"case_id":"c","reason":"schema","code":"output_schema:type","instance_path":"/a",'
      + '"schema_path":"#/$defs/x","keyword":"type","expected_type":"object","actual_type":"string"}\n'
      + 'not json at all\n'
      + '{"attempt":2,"case_id":"c","reason":"invented","code":null,"instance_path":null,'
      + '"schema_path":null,"keyword":null,"expected_type":null,"actual_type":null}\n');
    const { receipts, corrupted } = readRefusals(directory);
    assert.equal(receipts.length, 1);
    assert.deepEqual(corrupted, [{ line: 2, why: 'receipt_line_is_not_json' },
      { line: 3, why: 'refusal_reason_must_be_one_of:transport|identity|parse|schema|contract|frozen_identity' }]);
  });

test('a receipt the run cannot write is reported on the case instead of vanishing', async () => {
  const directory = temp('unwritable');
  await run(directory, async () => response({ raw: stringInContradictions }));
  // A directory where the sidecar belongs makes the append impossible on every platform, which a
  // read-only file does not: on Windows the write bit is not enforced this way.
  fs.rmSync(path.join(directory, REFUSAL_FILE));
  fs.mkdirSync(path.join(directory, REFUSAL_FILE));
  const result = await run(directory, async () => response({ raw: stringInContradictions }),
    [stagedCase({ case_id: 'case-2' })]);
  const reported = result.summary.results.filter((entry) => entry.case_id === 'case-2');
  assert.equal(reported.length, 1, 'a case must still have exactly one result');
  assert.ok(reported[0].problems.some((problem) => problem.startsWith('refusal_receipt_not_recorded:')));
  assert.equal(result.summary.refused, 1, 'the call is refused whether or not the record lands');
});

test('the run summary reports the sidecar, and its damage, without re-reading the answers',
  async () => {
    const directory = temp('summary');
    const result = await run(directory, async () => response({ raw: stringInContradictions }));
    assert.equal(result.summary.refusals_on_record, 1);
    assert.equal(result.summary.refusal_records_corrupted, undefined);
    fs.appendFileSync(path.join(directory, REFUSAL_FILE), 'garbage\n');
    const second = await run(directory, async () => response({ raw: stringInContradictions }),
      [stagedCase({ case_id: 'case-2' })]);
    // Two refusals on record, one of them from a line that is not a receipt at all.
    assert.equal(second.summary.refusals_on_record, 2);
    assert.deepEqual(second.summary.refusal_records_corrupted, [{ line: 2, why: 'receipt_line_is_not_json' }]);
  });

test('a type is described by its name, and never by its value', () => {
  assert.equal(structuralType('text'), 'string');
  assert.equal(structuralType(7), 'integer');
  assert.equal(structuralType(7.5), 'number');
  assert.equal(structuralType(null), 'null');
  assert.equal(structuralType([{ a: 1 }]), 'array');
  assert.equal(structuralType({ a: 1 }), 'object');
  assert.equal(structuralType(true), 'boolean');
  assert.equal(structuralType(undefined), 'undefined');
  // An answer that is not JSON at all is not a shape error, and is described as a parse refusal.
  assert.equal(shapeErrorOf('prose, not json'), null);
  // An answer that satisfies the shape is not a shape error either.
  assert.equal(shapeErrorOf(JSON.stringify(validOutput())), null);
  // A document that is missing a required key is one, and its pointer is empty: that names the
  // document as a whole rather than a place inside it. No type arrived, because no value did.
  const missing = shapeErrorOf('{"next_action":{}}');
  assert.equal(missing.keyword, 'required');
  assert.equal(missing.instance_path, '');
  assert.equal(missing.expected_type, null);
  assert.equal(missing.actual_type, null);
  const shaped = shapeErrorOf(stringInContradictions);
  assert.equal(shaped.actual_type, 'string');
  assert.ok(!JSON.stringify(shaped).includes('not a span'));
});
