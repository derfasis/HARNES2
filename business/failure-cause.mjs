const FAILURE_KINDS = new Set(['provider_error', 'timeout', 'invalid_envelope', 'child_exit', 'worker_failure']);
const PROVIDER_ERROR_TYPES = new Set([
  'billing_error', 'connection_error', 'timeout', 'rate_limit', 'auth_error',
  'server_error', 'invalid_request', 'model_not_found', 'unknown',
]);

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

// Keep this contract closed: callers can persist the result without carrying provider text.
export function normalizeFailureCause(candidate, fallbackKind = 'worker_failure') {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const kind = FAILURE_KINDS.has(source.kind) ? source.kind : fallbackKind;
  const providerErrorType = PROVIDER_ERROR_TYPES.has(source.provider_error_type)
    ? source.provider_error_type : null;
  return {
    kind: FAILURE_KINDS.has(kind) ? kind : 'worker_failure',
    http_status: integer(source.http_status, { min: 100, max: 599 }),
    provider_error_type: providerErrorType,
    retryable: source.retryable === true,
    attempt_count: integer(source.attempt_count, { min: 0, max: 1000 }) ?? 0,
    child_exit_code: integer(source.child_exit_code, { min: -255, max: 255 }),
    timed_out: source.timed_out === true,
    stdout_json_valid: source.stdout_json_valid === true,
  };
}

export function failureError(message, cause) {
  const error = new Error(message);
  error.failure_cause = normalizeFailureCause(cause);
  return error;
}
