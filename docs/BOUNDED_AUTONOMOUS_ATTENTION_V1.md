# Bounded Autonomous Attention v1

Canonical base: main@5bfe2f0c6961c615774f36a694e34fdc87c3c02c, PR35 merged.
The acceptance plan below was saved before implementation. Implemented contracts
and verification are recorded afterward. This is not permission to enable
production model billing.

## Actual reason to build

The original pilot now has a real current Russian v2 proposal, not only mocked
tests. However its lasting observer deliberately has zero model authority.
Turning on global audience.modelEnabled would let ordinary discovery reason
for every ready open goal, rather than one explicitly selected goal and finite
attention allowance. A model switch, source read grant and business review are
different decisions. There is no narrow durable goal mandate for unattended
attention today.

Two independent Luna audits agree that goal-scoped inference permission is a
prerequisite for a meaningful autonomous multi-source pilot. One additionally
flags signal selection as the main product quality gap: bounded fair sampling
is not proof of relevance. Preserve that uncertainty; do not pretend a keyword
filter proves relevance or discard resolving/counter context to improve apparent
precision. Strong LLM interpretation remains the semantic decision maker.

## Scenario and boundary

One owner-selected goal and its already admitted public sources -> explicit
finite attention authorization -> script-level currentness, unsupported-content,
dedupe and bounded/fair sampling -> no-tool interpretation -> inert Russian v2
proposals/preview -> owner dashboard review -> next actual observations.

Separate visible states: model configured/ready; source read authority/currentness;
goal inference authority; resource affordability/cap; proposal currentness/review.
No contact, send, business acceptance or Work/action authority comes from any
attention record. All defaults remain off. Test grants are finite verification,
not enduring production permission.

## Reuse rather than new infrastructure

- AudienceLoop canonical exchanges, policy epochs, goal/source scope and v2 output.
- Scheduler public domain rotation and captured-attempt recovery.
- Control Plane process ownership, admission, run ledger and unknown-cost rules.
- Existing SQLite transactions and command receipts; Scout's revision/expiry/
  revocation semantics are a pattern, not a shared source/inference grant.
- Existing explicit focused reassess/retry remains a one-attempt path independent
  of ordinary automatic attention. It must not spend or renew ambient permission.

Likely minimal durable addition: immutable per-goal inference authorization bound
to goal revision/purpose/finite total-attempt cap/expiry, plus an exact run-to-grant
binding. Admission and run creation are one transaction; actual/unknown usage is
settled in the existing run, once. Avoid another queue or duplicate run ledger.
Grant renewal must never reset considered_fingerprint or repurchase unchanged
failed evidence. Resource admission still cannot authorize a capability effect.

Authority validity and remaining admission allowance are separate: the last
admitted run must be allowed to finish when the cap becomes zero. Revocation,
expiry, goal/source change or loss of process ownership withholds late output
while preserving incurred usage. Restart is not authority to retry a running
or failed purchase. Import must not resurrect attention permission.

## Design choices considered before code (settled below)

1. Exact immutable grant contract and UI activation: a global model capability
   kill switch stays independent; opening a goal must never buy model calls.
   Reuse configured provider/runtime readiness. Do not invent a provider system.
2. A failed first ordinary assessment may have no need_id, so focused retry cannot
   recover it. Decide whether that is a prerequisite or belongs in this slice;
   never use grant renewal or synthetic source changes as recovery authority.
3. Bound attempt counts independently of unknown pricing. A null USD ceiling does
   not mean free work; a finite USD ceiling retains fail-closed unknown accounting.
4. Product relevance/attention selection: prioritize structurally without hard
   sales scripts or losing negative/resolving context. A single good live proposal
   does not prove recurring precision, recall or economic value.

## Acceptance before implementation

- Global model capability on + two ready goals: only the expressly granted goal
  can spend; source read permission alone cannot authorize inference.
- Concurrent ticks/restart/duplicate command cannot exceed the exact finite cap;
  blocked readiness before admission consumes no attempt; ambiguous incurred work
  remains charged/unknown, never reclaimable through optimistic recovery.
- Last admitted run can apply with zero remaining allowance; revoked/expired or
  changed authority cannot apply, and usage receipt still persists.
- Revoke/edit/delete/pause/policy epoch change/lost owner/receipt failure/transfer:
  no stale application, no implicit purchase, no pending resurrection; healthy
  neighboring goals and private/source planes retain existing fairness.
- Focused explicit reassessment/retry works independently of ambient grants;
  neither renews ambient allowance or produces business/effect permission.
- Real authenticated UI-to-server controls show all independent block reasons,
  frozen grant/request identities, remaining allowance and unknown spend honestly.
- A finite read-only live pilot uses only current existing source grants, an exact
  goal/model cap and recorded usage, then drains and disables models. No fake owner
  review, persons, conversations, drafts, sends, Work or action rows.

Create a new isolated branch from the actual canonical main, read relevant code
again, settle these domain semantics and add minimal black-box red witnesses
before implementation. Do not change the original observation expiry or consume
old one-shot verification caps. Keep the broad project goal active.

## Settled implementation contract — before code

`audience.attention_grant` is operator-only. Payload: `goal_id`,
`expected_revision`, `expected_scope_fingerprint`, `max_attempts` (1–50),
`expires_at` (future ISO time, at most seven days), and `reason` (1–500 chars).
The goal detail exposes `attention.scope_fingerprint` for the current exact goal
revision, approved watch policy epochs and configured model/provider/output
limit. Model credentials are not part of that scope or response. A configured
model/provider is necessary to bind the mandate; its kill switch and provider
readiness remain independent. Granting does not enable a switch or reserve/spend.

`audience.attention_revoke`: exact `grant_id`, `expected_grant_fingerprint`,
`reason`. Revocation remains available when models are off, evidence changed or
the grant expired. One current grant with remaining allowance per goal; an
explicit new grant after exhaustion/expiry does not resurrect old packets.
Existing in-flight admission is governed by its original immutable grant, not
by which grant is newest. Permission state and remaining allowance are separate.

Migration013 adds only goal inference grants and exact run-to-grant bindings.
Grant cap counts all admitted attempts across dates, including failed,
interrupted and unknown attempts. An admission and its existing run are committed
atomically. The last allowed attempt may apply while remaining allowance is zero;
revoke/expiry/model identity or output-limit change/goal or watch epoch change
withholds results and keeps actual usage. Global/domain ceilings still apply.
Transfer retires grants and pending requests; it preserves historical receipts.

First-pass failure recovery belongs in this scenario: `audience.retry_assessment`
is an explicit one-shot retry for an ordinary failed model assessment, with the
same payload as focused retry (`assessment_id`, frozen attempt fingerprint,
canonical context fingerprint, reason). It never requires, spends or renews an
ambient grant. It cannot be used on focused assessments; the existing focused
command and contract remain intact. A closed `reasoning_retry` packet marker
binds the parent, unchanged source context and one intended turn. The original
failed run must freeze that exact packet. New capture has a distinct deterministic
attempt fingerprint, one child per parent, no considered-state reset. Every source
head must still match the frozen ordinary packet; changed evidence needs a new
assessment, not an invented retry. Captured explicit retries resume once;
running/failed purchases remain terminal. Manual captures do not become model
requests. Operator reason is audit, never model/source evidence.

Reuse the existing Audience processor, grant patterns, Control Plane and run
ledger. Do not add semantic keyword exclusion, a generic queue/grants service,
new provider wiring or changed LLM/business proposal semantics in this increment.
Script filtering already owns structural safety/dedupe/bounding; semantic quality
remains explicitly unproven beyond the actual pilot result.

Ordinary captured/running assessments also have `audience.cancel_assessment`
with the exact assessment ID and frozen basis fingerprint. Closing a request
remains available when models or sources are disabled; it does not reclaim incurred
usage or revoke the entire goal mandate. A retry freezes the configured model tuple
separately from source context; changing it before execution withholds that request.
Transfer preserves auditable grant/run bindings but retires all attention grants.

The model tuple includes provider, API mode, canonical safe base URL, model and
output limit. HTTP is permitted only for loopback. Source withdrawal observed by
an Audience authorization/health check retires that goal watch durably; restoring
the same configuration cannot revive it. Unobserved transient configuration is
not an attested revocation event. Transport outages and stale observation are
temporary freshness failures, not permission epochs. Migration013 is pinned to LF
without changing any historical migration bytes or receipts.

## Implemented lifecycle and reuse

SQLite/AJV, existing Audience canonical projections and v2 proposal contract,
Hermes no-tool turns, shared Control Plane/run accounting and scheduler rotation
are reused. No new dependency, transport, parser, provider adapter, queue or
framework was introduced. `AudienceAttention` owns only this product's per-goal
mandate and exact admission binding; source access remains Audience/Continuity's
authority and resource capacity remains Control Plane's authority.

Grant definition is immutable and fingerprinted; persisted status is active or
revoked. Display state additionally derives expired/stale/exhausted. Admission
and run/assessment binding are one existing SQLite transaction. Every admitted
attempt counts across dates and restarts, including ambiguous/failed work.
Successful empty `needs: []` is a valid model conclusion, not an invented need.
Normal late application and explicit failed-parent recovery both prove the exact
frozen run-to-grant-to-assessment history. The last admitted result can finish at
zero remaining allowance; explicit retry is a separate one-turn operator request
and does not require an expired/revoked ambient mandate to become live again.
Ordinary pre-013 runs without a provable attention binding remain historical and
cannot use this new retry command; focused recovery is unchanged.

Model configuration/switch/readiness, source authority/freshness, goal mandate,
remaining attempts, shared ceilings and proposal review are separate operator
states. Cancellation/revocation does not reclaim incurred usage. Transfer keeps
history, retires grants and pending packets, and preserves historical v12 bundles.
No inferred need or permission is turned into a person, conversation, Work, draft,
action, approval or send by this increment.

## Verification on 2026-10-04

- Minimal black-box tests were red before production code: the old processor
  purchased an ordinary attempt with no per-goal mandate; grant/ordinary-retry
  contracts were absent.
- Local gate: 1,315 Node tests + 15 Python credential-isolation tests + build
  PASS. Of these, 31 new offline tests cover attention/recovery/operator HTTP UI.
  Existing model-test fixtures now explicitly grant their selected goal; no
  blanket permission was added to shared harnesses or negative tests.
- Six isolated guard removals were behaviorally killed by the new tests:
  ungranted admission, run-to-cap binding, late original mandate validity, frozen
  failed-parent packet, current retry source heads, and durable observed source
  withdrawal. No syntax/import error was counted as a kill.
- Additional red-team witness found corrupted parent run/assessment binding was
  accepted by retry; fixed with frozen grant metadata and exact history proof.
  Late binding corruption withholds output while retaining actual/unknown usage.
  Provider/API-mode changes and remote cleartext HTTP are also covered.
- Genuine native read-only pilot at 07:01 UTC: three already admitted Telegram
  sources, existing owner goal, one finite one-attempt grant, one logical Hermes
  turn and one client API request. Runtime reported Gemini3flash; 13,800 input and
  5 output tokens, cost unknown. Hidden upstream retries/version are not attested.
  It assessed three bounded exchanges and returned no new needs. Manual inspection
  found congratulations and good wishes, consistent with the absence of a new
  unresolved running/community question. This does not prove recurring precision,
  recall or sales usefulness.
- One exact durable grant/run/assessment binding, no automatic second purchase,
  and zero persons/conversations/drafts/contact permissions/delivery/approvals/
  Work/action effects. Grant revoked and models disabled after the finite test;
  adapters drained. Original read-only observer authority/expiry was retained.

Remaining limits: inference/source candidate quality is still not benchmarked;
the native no-op receipt cannot prove all opportunities in a source were absent;
observation is bounded and source completeness is unknown. Cost is unknown, not
zero. Operator rendering is tested through actual authenticated endpoints and
the UI module, but a browser visual smoke is not claimed. A native GramJS shutdown
printed an update-loop TIMEOUT after disconnect; the process exited and subsequent
observer recovery was checked separately: all three sources current, models off,
effects zero and the original observation deadline unchanged. No enduring production model
authority, automatic review or sending was enabled.

Next product question: whether repeated bounded observations bring enough useful
work to justify model attention. Use the inspected Russian proposal/no-op history
and owner feedback; do not add scripts, noisy source volumes or automatic effects
to disguise weak relevance. Hosted exact-head verification is required for release.
