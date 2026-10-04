-- Immutable metadata-only model choices; credentials remain process-local.
CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('available','revoked')),
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK((status='available' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX model_profiles_partner ON model_profiles(partner_id,status);

-- One selected immutable profile for each finite Audience grant. History is retained.
CREATE TABLE audience_attention_models (
  grant_id TEXT PRIMARY KEY REFERENCES audience_attention_grants(id),
  model_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
  definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64)
);
