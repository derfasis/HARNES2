# Verified Partner Activation v1 — pre-build architecture and acceptance

Canonical base: `main@bef266fa341e008b499a56b616f28f09f00a138d` (PR39 merged).
Branch: `codex/verified-partner-activation-v1`. This is a product prerequisite,
not another inference/permission engine. The overall project goal remains active.

## Evidence and decision

The normal batch launcher in the owner's primary checkout resolves its own
directory, currently dirty `2fd7521`. The verified main is a separate clean
worktree. `/health` reports a constant version; `/api/state.release` still names
old Engagement validation. A responsive dashboard therefore proves neither the
running release nor the intended partner database. A fresh worktree also starts
with empty/default state and every product capability disabled.

Scout already supplies expiring source-monitor grants, dynamic source policies,
bounded polling and durable checkpoints. Audience already has selected-source
goals, immutable profiles, finite attention, one-shot follow-up and independent
review. The native database is at schema013, its three monitor grants are valid
until October9, its observer stopped at the original deadline, and its sole
attention grant is revoked. Stale transport is not expired source authority.
There is no justification to invent another parser, observer or source grant.

The next milestone is one verifiable local installation and native public pilot:
correct release + explicit state/config/credential references -> truthful
readiness -> existing source admission/observation -> existing finite model
authority -> inspectable proposed material. Source-watch epoch renewal is a
later known prerequisite; it must not be hidden by automatically regranting a
source or replacing an existing goal.

## Minimal architecture

- Reuse Git for code identity, existing PowerShell/Node launcher, Node SQLite
  backup API, Store migrations/recovery, CP ownership, SDK/GramJS and all domain
  state machines. No process manager, generic lock library, config editor, new
  queue, deployment daemon or schema migration. Proper-lockfile was reviewed;
  automatic stale-lock takeover is insufficient proof that an old owner died,
  so existing PID-aware CP ownership remains authoritative.
- A strict local deployment profile names full code SHA/root, existing or new
  partner data directory, exact config file/hash, credential-file reference or
  null, partner ID, finite expiry and capability mode. Credentials remain in
  process memory and their existing files; no copying of ignored `.env`, data,
  config or secrets from a coding checkout. Profile metadata is not a source,
  model, contact, action or send grant.
- Managed bootstrap verifies code/root/cleanliness, config bytes, safe default
  fences, expiry and state compatibility before Store/recovery/network. Existing
  state requires a consistent backup before migration. Reject unknown schema,
  an active existing process and ambiguous ownership; no optimistic takeover.
- `loadConfig` gains an explicit local-file option while retaining its default.
  Code/assets/dependencies remain under the release root; SQLite/config/secrets
  use explicit paths. Existing Hermes per-run scratch remains ignored.
- The server records a fresh instance nonce, PID, actual port, code identity,
  deployment identity and state in its private service receipt. `/health` and
  authenticated state expose matching identity without secrets. Unmanaged or
  dirty code must not claim verified deployment or hosted CI success.
- Modes are `read_only` and `scoped_reasoning`. Managed global model flags,
  ordinary runtime, private intake and live sending stay off. Read-only mode
  additionally blocks all model admission through CP, even if an old scoped
  grant exists. Scoped reasoning only opens capability availability; existing
  explicit finite profile grants/requests and freshness/budgets still authorize
  actual calls. A mode is never a grant.
- Finite expiry/stop closes admission first, drains existing loops/receipts and
  stops the server/channel. Restart cannot extend expiry, reset consumed attempts,
  manufacture currentness or silently renew source/model authority.
- Managed start/stop verify the actual bound process and instance receipt; a
  reused PID, unrelated server, wrong root/port/nonce or stale receipt is refused.
  The existing legacy launch path remains available but reports its real identity.
- A dashboard readiness card explains installation, source connection/freshness,
  independent model capability/authority and no-outbound state. It does not mutate
  config, grant permissions or trigger calls. Scout offers an explicit handoff
  from an active admitted source into the existing Audience goal form; opening
  that form creates neither a goal nor inference authority.

## Acceptance and kill cases before code

1. Wrong SHA/root, dirty code, changed config bytes, malformed/expired profile,
   unsafe outbound/global-model/private settings or unknown schema fail before
   database creation/migration/recovery, credential loading or network effects.
2. A correct sealed profile resolves explicit data/config/credential references;
   it never uses release-root `.env`/local config/data as fallback. No secret value
   appears in identity, diagnostics, receipt, UI or exported deployment metadata.
3. Actual server health/session/authenticated state agree with the private receipt
   on PID/nonce/port/code/deployment; an unrelated or reused process cannot satisfy
   a start/stop identity check. Duplicate startup cannot recover a live store.
4. Read-only activation + valid old finite inference grant makes zero model calls.
   Scoped capability alone also makes zero calls. Explicit current finite model
   grant permits only its existing goal/profile/bounds; contact/send remain false.
5. Expiry/stop/restart cannot rearm activation or consumed requests. Late output
   is withheld but incurred/unknown usage and attempts remain durable. Source
   currentness is re-established by the real reader, never copied from a receipt.
6. Cold defaults show exact missing prerequisites, no fabricated ready source/model
   and zero source/grant/model effects. Inspectable status never self-attests CI.
7. Scout handoff uses a live exact monitor authority/source and requires an explicit
   goal-form save. Expired/revoked source is unavailable; no model/Work/contact
   permission inherits from handoff. Existing goals/reviews remain unchanged.
8. Consistent backup + normal013->015 migration preserve native IDs, grants,
   checkpoints/history and consumed attempts. Import remains a different operation
   with its existing authority-revocation boundary.
9. Bounded real read-only verification uses only current native source grants,
   one process/account, new finite test activation and recorded usage. It neither
   renews the old observer deadline nor claims source coverage, pricing or owner
   acceptance. Any model check needs a separately recorded finite test request.

Before integration: isolated acceptance/kill tests, full Node/Python/build gate,
diff check, exact-head hosted Windows gate, native verification and honest limits.
No automatic PC shutdown: that instruction is cancelled.

## OSS references

- https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- https://github.com/moxystudio/node-proper-lockfile

## Implementation and verification

Implemented in the isolated branch; integration and native activation are not yet
claimed. `business/deployment.mjs` and its strict profile schema verify the selected
Git root/SHA, clean code, exact external config bytes, safety fences and existing
state before opening Store. The CLI inspection path is read-only and does not
import the server, load credentials, create state or perform a backup.

The private activation marker is deliberately versioned before release. Its nine
fields are `version`, `id`, `code_sha`, `expires_at`, `phase`, `stop_reason`,
`instance_id`, `pid`, `profile_fingerprint`. The fingerprint binds code, state
and credential references, partner, config hash, mode and frozen expiry; it does
not contain credential values. A changed same-ID profile cannot reactivate a dead
active marker. Stopped/expired markers refuse; a matching active dead process can
recover its existing state with the original deadline and consumed domain attempts.
There is no compatibility acceptance for the earlier unpublished marker shape.
Private receipt bytes are flushed through Node's file API before atomic rename;
the two receipt files are not represented as a single transactional SQLite write.

`scripts/deployment.ps1` verifies the Node process command, private receipt and
actual `/health` nonce/port/code/profile identity before reuse or operator stop.
It never kills an unrelated process and never imports release-root `.env`.
The normal launcher accepts an explicit `-Profile` and the separate batch entry
requires that path. Existing unmanaged startup remains available and is labelled
unverified rather than claiming historical CI/model validation.

Control Plane blocks all model admission in read-only mode and blocks completion
after stop/expiry. Shutdown closes admission before draining existing scheduler
loops, preserves incurred usage, then closes channel and state. The source loop
does not admit another source poll after an in-flight poll drains past stop.
If durable stop-marker persistence fails, the in-memory admission fence stays
closed; the live process retains ownership until stop can be durably retried.
Storage failure is never a successful stop or fresh restart proof.

Dashboard readiness is read-only and distinguishes installation, reader counts,
per-goal freshness and model capability from grants. Scout-to-Audience opens the
existing goal form, freezes the exact monitor binding and revalidates it at Save;
revocation while the form is open produces no command.

### Operator launch contract

The installation profile is private local metadata, outside tracked configuration.
It supplies: `version:1`, a new UUID `id`, `label`, absolute `code_root`, exact
40-character `code_sha`, absolute `data_directory`, `config_file`, its SHA256,
`credentials_file` (absolute or null), `partner_id`, finite UTC `expires_at` (at
most seven days), `mode` (`read_only` or `scoped_reasoning`) and `state` (`existing`
or `new`). State/config/credential targets stay outside the release root. A new
state directory is empty; a crash restart under its exact matching active marker
uses the existing-state checks and SQLite backup, not a second empty installation.

```powershell
node scripts/run-deployment.mjs --inspect D:\HARNES2-deployments\partner\profile.json
powershell -NoProfile -File scripts/start.ps1 -Profile D:\HARNES2-deployments\partner\profile.json
powershell -NoProfile -File scripts/stop.ps1 -Profile D:\HARNES2-deployments\partner\profile.json
```

All global model flags and ordinary runtime remain disabled with blank runtime
model/endpoint; public automatic ingestion and Control Plane are enabled, private
allowed chats are empty and live sending is false. Configure the permitted model
profile endpoint separately. Scoped capability requires the existing explicit
finite goal/profile grant or one-shot follow-up before any actual call.

### Evidence so far

- First full regression exposed old UI harness failures from a new static import;
  readiness now follows the existing dynamic module initialization before refresh.
- Independent lifecycle tests exposed an always-denied managed completion path;
  the phase contract was corrected and a healthy scoped completion positive
  control added alongside expiry/late-output tests.
- Independent profile audit found that an active crash marker could silently
  change mode/config under the same ID; the versioned fingerprint closes it.
- Clean temporary Git fixtures exercise the actual verifier/CLI and PowerShell
  launcher; fixtures never weaken clean-code or owner checks.
- Combined local gate: 1507/1507 Node tests, 25/25 Python tests and build PASS
  (238 JavaScript/JSON, 11 Python files); `git diff --check` PASS. There are no
  skipped/cancelled Node tests. Hosted exact-head/native results remain pending.
- Fourteen lifecycle tests include healthy scoped completion, read-only denial,
  expiry with usage/consumed attempt persistence, no next-source poll after stop,
  durable same-ID stop, duplicate ownership and startup receipt rollback. The real
  authenticated stop endpoint also survives an injected marker failure, reports
  stopping, refuses other work and accepts a nonce-bound durable retry. Final
  stopped-receipt failure propagates without leaking SQLite or process ownership.
- The actual PowerShell launcher test uses a clean temporary Git release, starts
  the real server, reuses its exact nonce, rejects changed config/mode/partner and
  forged nonce/port, drains stop and refuses same-ID restart. It calls no provider.
- Prepared config/identity are deeply frozen; activation identity/mode/expiry/
  fingerprint cannot be reassigned. Managed composition checks the branded
  prepared activation, state path, partner, mode, fingerprint and config object;
  direct internal fixtures remain explicitly unverified.
- A separate Luna read-only code audit found no additional concrete blocker. It
  did not execute tests or claim native/runtime proof. Stop is explicitly an
  accepted asynchronous request, not a completed/persisted stop confirmation.

The native preflight independently confirmed schema013, three still-active source
monitor grants (expiry October9), no Control Plane owner and a revoked model grant.
Its historical transport confirmations from 16:32UTC are stale; no model/source
authority was renewed and no native migration or connection has yet occurred.

### Limits retained

This release is not an automatic installer/updater, source grant renewer or
model authority engine. A finite activation expiring must be explicitly replaced;
source-watch renewal across a new Scout grant epoch remains a known separate
product gap. Clean-code verification is at launch/inspection, not a cryptographic
monitor of ongoing owner filesystem edits. Native source coverage, model pricing,
useful opportunities, causal outcome credit and owner acceptance are not inferred
from a healthy process or green tests. No PC shutdown instruction remains active.
