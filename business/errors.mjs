export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export function ensure(condition, message, status = 400, code) { if (!condition) throw new AppError(message, status, code); }
export function requiredText(value, label, max = 8000) {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}: требуется текст до ${max} символов`);
  return value.trim();
}
export function dateTime(value) {
  ensure(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Дата должна содержать часовой пояс');
  return new Date(value).toISOString();
}
export const now = () => new Date().toISOString();
