// The record of what a generation refused, kept beside the outputs and outside them.
//
// A refused answer is stored nowhere, which is the rule that keeps a failed call from being
// mistaken for a result. The cost of that rule is that a refused call and a call that never
// happened look identical on disk: the error line in the console is the only trace. Two schema
// refusals in the first live run were exactly that — `output_schema:type` on
// `/hypothesis/contradictions/0`, with no way to tell whether the model wrote a string or a
// number, and no way to find out without paying for the call again.
//
// So the refusal is recorded, and recorded as structure only: which case, which attempt, which
// category, and for a schema refusal the path, the keyword, the expected type and the type that
// arrived. Never the offending value, never the model's text, never the transport's message. The
// answer that was refused stays refused on disk, and the reason it was refused stops being a
// guess.
import fs from 'node:fs';
import path from 'node:path';
import { shapeErrorOf } from './staging.mjs';

export const REFUSAL_FILE = 'refusal-attempts.jsonl';

// Closed by design. A reason outside this list is a bug in the caller, not a new category to
// invent at runtime: the set is what makes the file readable across runs.
export const REFUSAL_REASONS = ['transport', 'identity', 'parse', 'schema', 'contract',
  'frozen_identity'];

const PARSE_RULES = new Set(['raw_must_be_the_text_the_runtime_returned', 'output_is_not_json',
  'output_is_not_a_json_object']);

// A code is a rule name, never a sentence. `model_transport_call_failed:<provider message>` and
// `span_text_is_not_grounded_in_its_own_message:<event id>` both carry free text after the colon,
// and a transport message can carry anything at all, so only the name survives.
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
// A type or a keyword is one word, and an empty one means the field was never filled in — which
// has to be null rather than "".
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
// A pointer is a location, and may legitimately be empty: that names the document as a whole.
const PATH = /^[A-Za-z0-9_.\-[\]$/#]{0,120}$/;
const token = (value) => (typeof value === 'string' && CODE.test(value) ? value : null);

const categoryOf = (rule) => {
  if (rule.startsWith('model_transport_call_failed')) return 'transport';
  if (rule.startsWith('runtime_did_not_report_')) return 'identity';
  if (rule === 'this_evaluation_is_frozen_to_another_model') return 'frozen_identity';
  if (rule.startsWith('output_schema')) return 'schema';
  if (PARSE_RULES.has(rule)) return 'parse';
  return 'contract';
};

// The receipt for one refused call. `raw` is accepted so a schema refusal can be described in
// detail, and it is read only through `shapeErrorOf`, which returns the type name and the path and
// nothing else.
export function refusalReceipt({ caseId, attempt, failures, raw = null }) {
  const rules = (Array.isArray(failures) ? failures : []).map((rule) => String(rule));
  if (rules.length === 0) return null;
  const first = rules[0];
  const reason = categoryOf(first);
  const shape = reason === 'schema' ? shapeErrorOf(raw) : null;
  const keyword = shape ? token(shape.keyword) : null;
  return {
    attempt,
    case_id: caseId,
    reason,
    code: reason === 'schema' ? (keyword ? `output_schema:${keyword}` : 'output_schema')
      : token(first.split(':', 1)[0]),
    instance_path: shape ? shape.instance_path : null,
    schema_path: shape ? shape.schema_path : null,
    keyword,
    expected_type: shape ? shape.expected_type : null,
    actual_type: shape ? shape.actual_type : null,
  };
}

// The staging contract's own rule for a case id, reproduced here rather than imported: a receipt
// must never be able to carry an identifier the corpus itself would have refused to stage. The
// contract permits a `user-02` shape as readily as a pseudonymous `live-ddX-013`, so this is a
// floor and not a guarantee — what it does guarantee is that the sidecar is no wider than the
// inputs it describes.
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;

// Fail closed on the way in: a receipt that is not one of the closed shapes is not written at all,
// because a record the reader cannot trust is worse than no record.
export function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'receipt_must_be_an_object';
  if (!REFUSAL_REASONS.includes(receipt.reason)) return `refusal_reason_must_be_one_of:${REFUSAL_REASONS.join('|')}`;
  if (typeof receipt.case_id !== 'string' || !CASE_ID.test(receipt.case_id))
    return 'receipt_case_id_must_match_the_staging_contract_pattern';
  if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1) return 'receipt_attempt_must_be_a_positive_integer';
  const shapes = { code: CODE, instance_path: PATH, schema_path: PATH,
    keyword: NAME, expected_type: NAME, actual_type: NAME };
  for (const [key, shape] of Object.entries(shapes)) {
    const value = receipt[key];
    if (value !== null && (typeof value !== 'string' || !shape.test(value)))
      return `receipt_${key}_must_be_a_${key === 'code' ? 'rule_name' : key.endsWith('_path') ? 'pointer' : 'name'}_or_null`;
  }
  return null;
}

// Append-only. A second attempt at the same case adds a line and leaves the first one standing,
// because the ledger says how many attempts were made and a receipt that overwrote its predecessor
// would make a retry look like the first try.
export const refusalPath = (directory) => path.join(directory, REFUSAL_FILE);
export function recordRefusal(directory, receipt) {
  const invalid = validateReceipt(receipt);
  if (invalid) throw new Error(`Refusing to record a malformed refusal receipt: ${invalid}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(refusalPath(directory), `${JSON.stringify(receipt)}\n`);
  return receipt;
}

// A line that does not parse is reported, not skipped: a sidecar whose damage is invisible would
// let a run look cleaner than the evidence supports. A sidecar that cannot be read at all is
// reported the same way rather than thrown, because a diagnostic is never worth losing a run over.
export const readRefusals = (directory) => {
  const receipts = [];
  const corrupted = [];
  const file = refusalPath(directory);
  if (!fs.existsSync(file)) return { receipts, corrupted };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { receipts, corrupted: [{ line: 0, why: 'refusal_sidecar_could_not_be_read' }] }; }
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const invalid = validateReceipt(parsed);
      if (invalid) corrupted.push({ line: index + 1, why: invalid });
      else receipts.push(parsed);
    } catch { corrupted.push({ line: index + 1, why: 'receipt_line_is_not_json' }); }
  }
  return { receipts, corrupted };
};
