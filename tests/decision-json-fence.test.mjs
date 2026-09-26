// What counts as "the model returned the object": the fence is presentation, but only a bare
// object wrapped in one fence is the contract's answer.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRaw } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';

const OBJECT = { contract_version: 'opportunity-projection-v0', decision: 'IGNORE' };
const BODY = JSON.stringify(OBJECT);

test('a bare object is parsed, fenced or not', () => {
  assert.deepEqual(parseRaw(BODY).parsed, OBJECT);
  assert.deepEqual(parseRaw(BODY).problems, []);
  assert.deepEqual(parseRaw('```json\n' + BODY + '\n```').parsed, OBJECT);
  assert.deepEqual(parseRaw('```\n' + BODY + '\n```').parsed, OBJECT);
  assert.deepEqual(parseRaw('```JSON\n' + BODY + '\n```').parsed, OBJECT);
});

test('only one outer fence around exactly one object is unwrapped', () => {
  // Each of these is the model saying something in addition to the object, or wrapping it twice.
  // Reading meaning into that is exactly what the evaluation must not do.
  const refused = [
    ['prose before the fence', 'Here is my answer:\n```json\n' + BODY + '\n```'],
    ['prose after the fence', '```json\n' + BODY + '\n```\nLet me know if you need more.'],
    ['two objects in one fence', '```json\n' + BODY + '\n' + BODY + '\n```'],
    ['a fence inside the fence', '```json\n{"a":1}\n```\n```\n' + BODY + '\n```'],
    ['an unterminated fence', '```json\n' + BODY],
    ['a fence that does not wrap everything', '```json\n' + BODY + '\n```\n```json\n{}\n```'],
  ];
  for (const [label, raw] of refused) {
    const { parsed, problems } = parseRaw(raw);
    assert.equal(parsed, null, `${label}: must not be read as an answer`);
    assert.ok(problems.length, `${label}: must come back as a finding`);
  }
});

test('text that is not JSON at all is still refused', () => {
  for (const raw of ['', '   ', 'I cannot help with that.', '{"unclosed": ', 'not json at all']) {
    assert.equal(parseRaw(raw).parsed, null, JSON.stringify(raw));
  }
  assert.equal(parseRaw(42).problems[0], 'raw_must_be_the_text_the_runtime_returned');
});

test('a JSON array is not the contract object, even when it is well formed', () => {
  // The evaluation scores one object. A bare array parses, but it is not what was asked for, and
  // accepting it would let a wrong-shaped answer through the same door the fence fix opened.
  const { parsed, problems } = parseRaw('[1,2,3]');
  assert.equal(parsed, null);
  assert.deepEqual(problems, ['output_is_not_a_json_object']);
  const fenced = parseRaw('```json\n[1,2,3]\n```');
  assert.equal(fenced.parsed, null);
  assert.deepEqual(fenced.problems, ['output_is_not_a_json_object']);
});
