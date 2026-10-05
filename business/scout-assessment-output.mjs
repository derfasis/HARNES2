import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { normalizeFailureCause } from './failure-cause.mjs';

export const SCOUT_ASSESSMENT_CONTRACT = readJson(path.join(ROOT, 'contracts/scout-assessment.schema.json'));
const validate = new Ajv({ strict: true }).compile(SCOUT_ASSESSMENT_CONTRACT);
const stages = Object.freeze({
  SCOUT_MODEL_INCOMPLETE: 'model',
  SCOUT_TOOLS_FORBIDDEN: 'envelope',
  SCOUT_OUTPUT_NOT_TEXT: 'format',
  SCOUT_OUTPUT_TOO_LARGE: 'format',
  SCOUT_JSON_MARKDOWN_FENCE: 'format',
  SCOUT_JSON_INVALID: 'format',
  SCOUT_SCHEMA_INVALID: 'schema',
  SCOUT_EVIDENCE_INVALID: 'evidence',
  SCOUT_EVIDENCE_REQUIRED: 'evidence',
});
const schemaKeywords = new Set(['type', 'required', 'additionalProperties', 'enum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']);

// Diagnostics contain only closed codes/keywords, never output, JSON keys, AJV
// params or provider text. Apply the same boundary when reading persisted data.
export function scoutAssessmentDiagnostic(value) {
  if (!value || typeof value.code !== 'string' || !Object.hasOwn(stages, value.code)
    || value.stage !== stages[value.code]) return null;
  const diagnostic = { stage: value.stage, code: value.code };
  if (value.code === 'SCOUT_SCHEMA_INVALID' && Array.isArray(value.schema_keywords)) {
    diagnostic.schema_keywords = [...new Set(value.schema_keywords.filter(k => schemaKeywords.has(k)))].slice(0, 8);
  }
  if (value.code === 'SCOUT_MODEL_INCOMPLETE') {
    diagnostic.failure_cause = normalizeFailureCause(value.failure_cause);
  }
  return diagnostic;
}

export function scoutAssessmentOutput(result, groups) {
  const reject = (code, reason = 'SCOUT_OUTPUT_INVALID', extra = {}) => ({
    output: null, reason, diagnostic: scoutAssessmentDiagnostic({ stage: stages[code], code, ...extra }),
  });
  if (result?.completed !== true || result.error) {
    return reject('SCOUT_MODEL_INCOMPLETE', 'SCOUT_OUTPUT_INVALID', { failure_cause: result?.failure_cause });
  }
  const tools = result.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length)
    || result.messages != null && (!Array.isArray(result.messages)
      || result.messages.some(m => m?.role === 'tool'
        || m?.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.length)
        || m?.function_call != null));
  if (tools) return reject('SCOUT_TOOLS_FORBIDDEN');
  if (typeof result.final_response !== 'string') return reject('SCOUT_OUTPUT_NOT_TEXT');
  if (Buffer.byteLength(result.final_response) > 24000) return reject('SCOUT_OUTPUT_TOO_LARGE');
  let output;
  try { output = JSON.parse(result.final_response); }
  catch {
    return reject(/^\s*```/.test(result.final_response) ? 'SCOUT_JSON_MARKDOWN_FENCE' : 'SCOUT_JSON_INVALID');
  }
  if (!validate(output)) {
    return reject('SCOUT_SCHEMA_INVALID', 'SCOUT_OUTPUT_INVALID', { schema_keywords: validate.errors.map(e => e.keyword) });
  }
  const refs = new Set(groups.flatMap(group => group.evidence_refs));
  if (![...output.evidence_refs, ...output.opportunities.flatMap(o => o.evidence_refs)].every(ref => refs.has(ref))) {
    return reject('SCOUT_EVIDENCE_INVALID', 'SCOUT_EVIDENCE_INVALID');
  }
  if (output.recommendation === 'consider' && output.evidence_refs.length === 0) {
    return reject('SCOUT_EVIDENCE_REQUIRED', 'SCOUT_EVIDENCE_REQUIRED');
  }
  return { output, reason: null, diagnostic: null };
}
