# Audience Reasoning Recovery v1

## Acceptance before code

The original live focused model attempt failed with a provider timeout. Its
current unchanged context remains locked against automatic repurchase, even
after the provider is available again. A deliberate operator request must be
able to authorize one new no-tool reasoning attempt without resetting that
historical attempt or pretending new evidence arrived.

Reuse Audience assessments, commands/receipts, canonical source validation,
existing model switches, Control Plane budget/admission, Hermes and SQLite.
This is a domain recovery operation, not a new generic queue, grants framework,
workflow engine or provider adapter. No migration should be needed.

### Contract

`audience.retry_reassessment` is operator-only. Payload:

- `assessment_id`: the exact failed/interrupted focused model assessment;
- `expected_basis_fingerprint`: its immutable attempt fingerprint;
- `expected_context_fingerprint`: its unchanged canonical context fingerprint;
- `reason`: explicit owner explanation, 1–500 characters.

The prior assessment must have a corresponding failed/interrupted Audience run,
matching partner, goal, assessment ID and frozen packet. Prior successful output
is not retry authority. Stale/revoked source or target, changed context and
disabled model/Control Plane block the request, including receipt replay.

One parent can have only one authorized child. Its deterministic attempt
fingerprint includes the parent assessment ID and immutable fingerprint. The
source context fingerprint remains separate and unchanged. A child packet has
a closed optional `retry_of` marker containing `assessment_id` and
`basis_fingerprint`; the operator reason is audit, not source evidence.

The original record and usage remain immutable. Failed children require another
deliberate request for that child's ID; ticks, toggles, receipt replay and restart
are never such a request. Global/per-domain budget and unknown pricing rules
remain independent prerequisites. One logical no-tool attempt retains Hermes'
existing bounded empty-response retry behavior; it is not a promise of exactly
one upstream HTTP call or of free execution.

Assessment presentation exposes a closed prior-run receipt and retry state.
The UI explains unknown prior cost and the new potential charge, requests a
reason and submits frozen fingerprints. It cannot accept the need, approve
material, create Work/contact, send, or alter provider configuration. Existing
assessment cancellation binds to the child's immutable attempt fingerprint.

Budget preflight is a read-only extraction of existing Control Plane ledger
rules, reused by admission and by new retry capture. Capture reserves no slot;
execution rechecks budgets, process ownership and capacity independently. A
same-ID receipt may acknowledge its existing child after that child used the
last budget slot: acknowledgment creates no purchase or reservation. Current
source, target and model authority still gate replay. A new request never uses
that acknowledgment to create another child.

### Kill tests

1. Without explicit retry, an unchanged failed context is not purchased again.
2. A current failed focused attempt can create exactly one linked child; normal
   reassessment remains locked and duplicate requests cannot create another.
3. Agent/channel callers cannot create or replay the operator request. Source,
   target and context freshness are rechecked before replay and model purchase.
4. A completed result, forged/missing prior run, mismatched frozen packet or
   corrupted parent cannot supply retry authority.
5. Captured child can resume once after recovery; running child becomes
   interrupted. Cancellation/late stale completion withholds output but retains
   incurred usage. No reset, clone or pending resurrection after transfer.
6. Prior unknown cost and daily/plane budgets remain blocking when configured;
   retry does not turn unknown into zero. Focused retries do not consume ordinary
   discovery or starve a healthy goal after invalidation.
7. A real authenticated UI-to-server request produces the linked child and can
   cancel it after context changes/models are disabled, with all effect counts
   unchanged. Returning valid output may only revise the frozen need and create
   an inert preview; owner review and all effect grants remain separate.

## Verification

Acceptance is recorded before production code. Implementation and gate results
will be recorded here after black-box witnesses are run red and then green.

The pre-code acceptance run had 1 passing and 10 failing witnesses for the
missing explicit retry operation. Focused implementation tests then exposed a
real pre-write budget gap: unknown prior USD under a configured dollar ceiling
could capture a child before later execution denied it. Shared ledger preflight
now rejects the request without inserting a child. Test-fixture errors (SQLite
row prototypes, foreign-key deletion and packet-marker placement) were corrected
without weakening production guards.

Implementation preserves old assessments and runs; a closed optional marker in
the existing v1 reassessment envelope provides lineage. No migration, new queue,
provider integration or generic retry-authority framework was introduced. A
runtime/configured cost estimate retains its provenance; absent pricing stays
unknown and never becomes zero. Existing ordinary discovery remains separate.

Local full verification on `44d4801` passes 1,284 Node tests, 15 Python credential
isolation tests and build. Five independent copied-snapshot mutations were
killed: removing frozen-parent proof, replay freshness, child source-head
freshness, child lineage validation or pre-write budget admission each makes
its semantic witness fail. Exact-head hosted status
and any finite provider verification are recorded in the release handoff; a
green local gate alone does not prove live provider availability or usefulness
of the proposal. Browser rendering remains unverified: UI witnesses exercise
the actual view logic through authenticated loopback endpoints.

Hosted Windows verification on `44d4801` passed (run `37158782067`). A finite
native check subsequently reopened the original three-source pilot with its
existing grants and unchanged expiry. The historical failed assessment was
now stale, so preflight refused before child capture, cap reservation or model
purchase. No old attempt was reset and no fresh evidence was invented to make
a retry pass. This is a live refusal witness, not a claim of successful provider
execution or useful model output. Successful retry/application behavior is
proved by the offline runtime and authenticated UI witnesses.
