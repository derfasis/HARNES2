# Outcome & Attribution v1 — completed observation integrity

This completion branch starts at committed PR #26 head
`14b7f4f795a81f89ba61035a38ae3bd47d297dc2`, which adds coverage to the
owner's supplied `9855eb99a014f56f46389215e17e0c2d3f079ee2` candidate.
Neither is treated as merged main. Main at the start was `8c8889b32bd49cfdf4f3dc32628b1b7883e513bb`.
The original dirty worktrees were preserved. No Control Plane implementation is included.

## Contract

`confirmed delivery → durable observation intent → immutable sent provenance →
bounded observation → candidate → explicit versioned owner review → canonical outcome`.

Observation is not business truth. A reply is an observed association; a booking,
attendance, join or value requires explicit operator evidence. An accepted call
is not attendance. Every response continues to report `causal_credit: not_established`.
There is no detector model, trusted-source promotion shortcut or automatic confirmation.
Unused model configuration and placeholder executable detectors were removed.

The layer is disabled by default. Enabling it does not enable runtime, live Telegram,
contact permission, automatic sending, Action grants or lesson promotion.

## Delivery and recovery

Canonical delivery stores the actual outbound message, sent version/attempt and an
`outcome.delivery_observed` intent in the same SQLite transaction. A derived observer
uses a savepoint. Its partial writes roll back without converting a known delivery
into failure. The intent remains available for bounded retry after a crash.
A failure of the whole provider receipt transaction still follows the existing
`delivery_unknown` contract; no observer retries the send.
Manual recording of an outbound message also produces an intent when enabled.
The original deadline is captured, so a later configuration change cannot extend it.

Separate persistent cursors advance delivery recovery, window inspection and pending
review revalidation. Each tick inspects at most the configured limit in each queue;
window cursor advances for waiting and unknown items too. The work bound is three
bounded phases, not three separate allowances for model or outbound work.
Malformed durable items are quarantined once with a reason; transient storage failures
roll back the pass and retry without advancing cursors. This is a bound on work and
writes, not a hard wall-clock guarantee for a large SQLite backlog.

## Source time

`messages.created_at` is recording time. Nullable `occurred_at` and
`time_basis: source | owner_attested | recorded` retain the origin of event time.
The existing Telegram adapters project provider dates; GramJS and the read-only public
ingestion stack remain the transport implementation. No replacement parser is added.
A queued pre-send inbound cannot become a post-send reply merely because its command
commits after the send. Missing provider dates remain explicitly based on recorded time;
they are not claimed as provider chronology.

Telegram source timestamps have second precision. An inbound sharing the send's source
instant is ambiguous: it establishes neither a reply-after-send nor silence. Even a
coverage attestation does not resolve that ordering ambiguity.
Response lookups stop at both the window deadline and the reconciliation time.
Manual delivery/reconciliation may supply `occurred_at` as owner-attested time;
omitting it does not manufacture the original delivery time.

Timestamp-bearing Telegram ingestion uses a versioned, partner-scoped command identity.
Historical receipts remain unchanged. A replay may fill a previously missing source
timestamp only after validating the existing owned message's external identity, text,
direction and source. It invalidates dependent evidence and adds no inbound task,
person, permission or send. Old operator request IDs with unscoped fingerprints fail
closed; callers must make a fresh, explicitly reviewed request.

## Window and coverage lifecycle

Windows transition from `pending` to `answered`, `expired_unanswered` or
`unknown`. Invalid provenance can become `superseded`.
Unknown is terminal for absence reporting and does not emit repeated audit events.
It remains eligible for late positive evidence with source time inside the original
interval. Late positive evidence also corrects a previously attested absence.

A scalar `continuous` at send time is rejected: it cannot prove a future interval.
The private transports currently provide no durable proof of complete intake.
Without a completed interval proof, expiration becomes unknown with no silence candidate.

An operator may use `outcome.coverage_attest` with `window_id`,
`covered_from`, `covered_through`, `evidence` and
`expected_coverage_event_id` (null for the first proof). It must cover the whole
closed interval and cannot include future time. This produces an auditable
`owner_attested_interval`, not independent transport verification.
`outcome.coverage_revoke` requires the exact current proof event ID and evidence.
It invalidates dependent pending absence observations. Re-attestation produces a new
observation identity; superseded candidates never become pending again.
Restart preserves retrospective owner evidence; transfer discards active silence claims.

## Evidence and review

Migration 009 preserves sent draft version, attempt, decision, engagement and time basis.
Candidate identity is window + detector/version/kind + immutable basis fingerprint.
The fingerprint binds sent and observed messages, delivered version/attempt, action,
immutable decision content, evidence envelope, basis and observed time.
Ordinary later inbound and a decision becoming historically stale do not erase a
delivered historical association. Mutation of its actual basis blocks promotion.

`outcome.candidate_confirm` requires `candidate_id`, `expected_revision`,
`kind` and operator `evidence`; optional fields are `value`, `note`,
`decisionId` and `outcome_id`. An explicitly supplied decision must match the
captured sent provenance. Unknown fields are refused.
`outcome.candidate_reject` requires the reviewed revision and a note.
Both command and direct loop entrypoints are atomic; there is one canonical outcome writer.

Two sends can share one observed reply and therefore have two observation candidates.
They cannot silently create duplicate business results from that same evidence/kind.
The second review must explicitly link the existing `outcome_id`.
That links the observation to the owner-confirmed result; it does not move the result's
canonical decision attribution to the second send. Responses distinguish
`candidate_decision_id` from `outcome_decision_id`.
An owner link to another historical result in the same conversation is explicitly
audited; it is not a detector inference or causal claim.

Conversation stage is a conservative progress projection. Historical qualification
cannot overwrite joined/declined. Recording value does not become a conversation stage.
Result correction/reopening requires a separate explicit workflow; it is not a side
effect of reviewing older observations. STOP, suppression, HUMAN ownership, revoked
permissions and cancelled work survive historical confirmation.

## Metrics, operator surface and transfer

Window lifecycle counts are mutually exclusive. Unknown windows include pending and
coverage/timing-unknown windows once. Unverified coverage is a separate flag count.
Eligible delivered messages include durable intents and historical windows; missing
observations and unknown delivery have their own visible counters. Distinct confirmed
result IDs, not all historical outcomes for a person, form the reported observation results.
The counters describe this opt-in observation cohort, not every send before installation.

Authenticated read APIs enforce exact paths, single recognized query fields, bounded
UUID pagination and supported HTTP methods. The operator surface exposes observation
review separately from confirmed business outcomes. It carries the current revision,
freshness, proof level and coverage counters; it never silently retries a rejected review.

Export/import uses explicit migration-era table and column shapes. Cyclic outcome
references restore with deferred foreign keys and additional semantic scope validation.
Explicit owner outcome links require their corresponding audit when provenance differs.
Transferred absence candidates are superseded, coverage is unverified, and only fresh
positive candidates survive. Execution grants retain the existing transfer revocation.

Migration 008 is not rewritten. The loader additionally recognizes the exact LF/CRLF
byte encodings of published pre-release 008 from `9855eb9`; its receipt remains unchanged.
Migration 009 upgrades both known schemas conservatively. Other checksum changes fail.

## Verification and limits

The initial production-path completion tests reproduced seven failures before the fixes.
Acceptance coverage includes real command-bus approved manual delivery, fake provider
intake/send race with source times, restart without resend, overlapping windows,
bounded progress, true owner/decision attribution, partial-write failpoints, scope replay,
proof revocation/generations, corrupted evidence and old-schema database/import paths.
Functional tests use synthetic/local state and fake transports. They do not prove
Telegram production delivery, private catch-up completeness, outcome truth or causality.
Full gate results are recorded in the completion handoff.

Remaining product limits: no automatic private transport interval proof, no independent
verification of owner outcome evidence, no business-result correction UI, no causal
evaluation, no retention redesign and no durable private Telegram catch-up queue.
Historical timestamps recovered later can invalidate an earlier review; confirmed
operator business facts remain history with an observation correction audit.

## Next architectural boundary

Merge and stabilize this Outcome contract before building on it. The next layer remains
Durable Partner Control Plane v1: shared orchestration over distinct public observation,
private conversation, outcome and local action execution planes. It must replace global
mode exclusion with explicit plane eligibility, health, budgets and authority envelopes,
not fuse public discovery with private contact authority or enable auto-send.
Private intake recovery/health must be represented honestly before enabling coexistence.
