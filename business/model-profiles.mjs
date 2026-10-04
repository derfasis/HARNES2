// Immutable, metadata-only model definitions. This module stores no credentials and
// cannot admit a run or grant inference authority.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { AppError, now } from './errors.mjs';
import { digest } from './source-ingestion.mjs';

const schema = readJson(path.join(ROOT, 'contracts/model-profile.schema.json'));
const validatePayload = new Ajv({ strict: true, allowUnionTypes: true }).compile(schema);
const fail = code => { throw new AppError(code, code === 'MODEL_PROFILE_NOT_FOUND' ? 404 : 409, code); };
const check = (condition, code) => { if (!condition) fail(code); };
const ownKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const PAYLOAD_KEYS = ['label','provider','api_mode','base_url','model','max_output_tokens',
  'input_usd_per_million','output_usd_per_million'];
const DEFINITION_KEYS = ['version','id','partner_id',...PAYLOAD_KEYS,'created_at'];
const HASH = /^[a-f0-9]{64}$/;
const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]']);

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:','http:'].includes(url.protocol) || url.protocol === 'http:' && !LOOPBACK.has(url.hostname)
    || url.username || url.password || url.search || url.hash) return null;
  return url.href;
}

function configProjection(definition) {
  return {
    provider: definition.provider,
    apiMode: definition.api_mode,
    baseUrl: definition.base_url,
    model: definition.model,
    maxOutputTokens: definition.max_output_tokens,
    inputUsdPerMillion: definition.input_usd_per_million,
    outputUsdPerMillion: definition.output_usd_per_million,
  };
}

export class ModelProfiles {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }

  allowedBaseUrls() {
    const configured = [this.service.config.runtime?.baseUrl,
      ...(Array.isArray(this.service.config.modelProfiles?.allowedBaseUrls)
        ? this.service.config.modelProfiles.allowedBaseUrls : [])];
    return [...new Set(configured.map(normalizeEndpoint).filter(Boolean))];
  }

  endpointAllowed(baseUrl) { return this.allowedBaseUrls().includes(baseUrl); }

  canonicalPayload(payload) {
    check(ownKeys(payload, PAYLOAD_KEYS) && validatePayload(payload), 'MODEL_PROFILE_INVALID');
    const label = payload.label.trim(), model = payload.model.trim();
    const baseUrl = normalizeEndpoint(payload.base_url);
    check(label.length > 0 && model.length > 0 && baseUrl, 'MODEL_PROFILE_INVALID');
    check(this.endpointAllowed(baseUrl), 'MODEL_PROFILE_ENDPOINT_NOT_ALLOWED');
    return { label, provider: payload.provider, api_mode: payload.api_mode, base_url: baseUrl,
      model, max_output_tokens: payload.max_output_tokens,
      input_usd_per_million: payload.input_usd_per_million,
      output_usd_per_million: payload.output_usd_per_million };
  }

  checkedRow(profileId) {
    const row = this.db.get('SELECT * FROM model_profiles WHERE id=? AND partner_id=?', profileId, this.partnerId);
    if (!row) fail('MODEL_PROFILE_NOT_FOUND');
    let definition;
    try { definition = JSON.parse(row.definition_json); } catch { fail('MODEL_PROFILE_INVALID'); }
    check(ownKeys(definition, DEFINITION_KEYS) && definition.version === 1
      && definition.id === row.id && definition.partner_id === row.partner_id
      && typeof definition.created_at === 'string' && Number.isFinite(Date.parse(definition.created_at)), 'MODEL_PROFILE_INVALID');
    const payload = {};
    for (const key of PAYLOAD_KEYS) payload[key] = definition[key];
    check(validatePayload(payload) && payload.label.trim() === payload.label && payload.model.trim() === payload.model
      && normalizeEndpoint(payload.base_url) === payload.base_url && HASH.test(row.definition_hash)
      && digest(definition) === row.definition_hash, 'MODEL_PROFILE_INVALID');
    check(['available','revoked'].includes(row.status)
      && (row.status === 'available' ? row.revoked_at === null && row.revocation_reason === null
        : typeof row.revoked_at === 'string' && Number.isFinite(Date.parse(row.revoked_at))
          && typeof row.revocation_reason === 'string' && row.revocation_reason.trim().length > 0), 'MODEL_PROFILE_INVALID');
    return { row, definition };
  }

  create(payload) {
    let normalized;
    try { normalized = this.canonicalPayload(payload); }
    catch (error) {
      if (error instanceof AppError) throw error;
      fail('MODEL_PROFILE_INVALID');
    }
    check(this.db.get('SELECT COUNT(*) n FROM model_profiles WHERE partner_id=?', this.partnerId).n < 100,
      'MODEL_PROFILE_CAPACITY');
    const definition = { version: 1, id: id(), partner_id: this.partnerId, ...normalized, created_at: now() };
    const definitionHash = digest(definition);
    this.db.run("INSERT INTO model_profiles(id,partner_id,definition_json,definition_hash,status,revoked_at,revocation_reason) VALUES(?,?,?,?,'available',NULL,NULL)",
      definition.id, this.partnerId, JSON.stringify(definition), definitionHash);
    return { id: definition.id, profile_id: definition.id, label: definition.label, definition_hash: definitionHash,
      state: 'available', model_config: configProjection(definition), block_reasons: [] };
  }

  get(profileId) {
    const { row, definition } = this.checkedRow(profileId);
    const blocks = [];
    if (row.status === 'revoked') blocks.push('MODEL_PROFILE_REVOKED');
    if (!this.endpointAllowed(definition.base_url)) blocks.push('MODEL_PROFILE_ENDPOINT_NOT_ALLOWED');
    if (!process.env.PARTNER_MODEL_API_KEY?.trim()) blocks.push('MODEL_PROFILE_CREDENTIAL_NOT_READY');
    return { id: row.id, partner_id: row.partner_id, definition, definition_hash: row.definition_hash,
      state: row.status, revoked_at: row.revoked_at, revocation_reason: row.revocation_reason,
      model_config: configProjection(definition), block_reasons: blocks };
  }

  resolve(profileId, { historical = false } = {}) {
    check(typeof historical === 'boolean', 'MODEL_PROFILE_INVALID');
    const { row, definition } = this.checkedRow(profileId);
    if (!historical) {
      check(row.status === 'available', 'MODEL_PROFILE_REVOKED');
      check(this.endpointAllowed(definition.base_url), 'MODEL_PROFILE_ENDPOINT_NOT_ALLOWED');
    }
    return { profile_id: row.id, definition_hash: row.definition_hash,
      model_config: { ...this.service.config.runtime, ...configProjection(definition) } };
  }

  revoke(payload) {
    check(ownKeys(payload, ['profile_id','expected_definition_hash','reason']), 'MODEL_PROFILE_INVALID');
    const { profile_id: profileId, expected_definition_hash: expectedHash, reason } = payload;
    check(typeof profileId === 'string' && HASH.test(expectedHash ?? '')
      && typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 500,
    'MODEL_PROFILE_INVALID');
    const { row } = this.checkedRow(profileId);
    check(row.definition_hash === expectedHash, 'MODEL_PROFILE_STALE');
    if (row.status !== 'revoked') this.db.run("UPDATE model_profiles SET status='revoked',revoked_at=?,revocation_reason=? WHERE id=? AND status='available'",
      now(), reason.trim(), profileId);
    return this.get(profileId);
  }

  list() {
    const rows = this.db.all('SELECT id FROM model_profiles WHERE partner_id=? ORDER BY rowid DESC LIMIT 100', this.partnerId);
    const profiles = rows.map(({ id: profileId }) => {
      let item;
      try { item = this.get(profileId); }
      catch (error) {
        if (!(error instanceof AppError)) throw error;
        // One corrupt profile must be inspectable without hiding healthy neighbors.
        return { id: profileId, label: 'Invalid persisted profile', state: 'invalid',
          definition_hash: null, model_config: null, block_reasons: [error.code] };
      }
      return { id: item.id, label: item.definition.label, definition_hash: item.definition_hash,
        state: item.state, model_config: item.model_config, block_reasons: item.block_reasons };
    });
    return { profiles, allowed_base_urls: this.allowedBaseUrls(),
      credential_ready: typeof process.env.PARTNER_MODEL_API_KEY === 'string' && process.env.PARTNER_MODEL_API_KEY.trim().length > 0 };
  }
}
