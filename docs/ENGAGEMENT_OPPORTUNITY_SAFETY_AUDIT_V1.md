# Engagement and Opportunity safety audit v1

Stage 4C extends the Stage 3D audit method to the two write paths that Discovery deliberately
refuses to own: the Engagement loop and the Opportunity review. Production code is not modified by
this stage. A failing invariant is a finding, reported here and fixed in its own patch.

`baseline_sha=ae18741` · `live_proof=false` · `proof_level=integration` · offline only.

## Results

| Invariant | Statement | Result |
| --- | --- | --- |
| E1 | A decision requires the current engagement revision and real message evidence. | PASS |
| E2 | ACT requires a typed permission matching person, conversation, channel, and account. | PASS |
| E3 | A suppressed person or a human-owned conversation produces no work, and history is not erased. | PASS |
| E4 | A draft is never a send, and no delivery is ever claimed. | PASS |
| E5 | Request replay is idempotent; a changed payload under the same id conflicts. | PASS |
| E6 | A closed or stopped engagement stays closed across a restart. | PASS |
| O1 | Opportunity review requires the exact fingerprint and revision. | PASS |
| O2 | Approving a card is a review act: non-executable, no contact, no send. | PASS |
| O3 | A decided card cannot be decided twice, and replay stays idempotent. | PASS |
| O4 | Nothing in this audit performs an external call. | PASS |

## How the refusals were checked

The full row content of every table in the schema is captured before and after each refusal. Where
a refusal is *supposed* to write something, that something is named and constrained, rather than
being waved through:

- A refused Engagement or Opportunity command writes nothing at all.
- A refused **Opportunity review** writes exactly one thing: an `opportunity.review.denied` event.

## Finding for review: the denial trail is a durable write, by design

The first version of `O1` asserted that a refused review changes nothing. It does not, and the code
says so on purpose: `business/service.mjs` re-records the denial in its own transaction after the
command rolls back, with the comment "Denials survive the rolled-back command, without persisting
untrusted text or grants."

That is a defensible design — an operator wants to know that someone tried to approve something
that was not approvable. The audit now asserts it precisely instead of asserting nothing:

- exactly one denial event per refused review,
- carrying only `action`, `task_id`, `code`, and `request_id`,
- never the untrusted payload, never a grant, never a status change,
- and the review task stays `proposed` with no draft, no permission, and no contact.

**This is a contract question, not a bug.** Should a refusal be durable? The current code says yes
and proves it can be done without leaking untrusted text. If we want a refusal to leave no trace,
that is a small, separate change — and it would cost the operator the ability to see attempted
approvals. The audit records the behaviour; the decision is Dev's.

## Corrections made while writing the audit

Three of my first assertions were wrong about the product, and were corrected against the real
behaviour rather than adjusted to pass:

1. "A refused review changes nothing" — false, and deliberately so. See the finding above.
2. "An approved card's task becomes `done`" — false. Approval freezes the model output and leaves
   the card reviewable; the task stays `proposed` and no review task is closed. This is the safer
   reading, and the audit now asserts it.
3. "An approval returns a status" — false. It returns `review` plus explicit `executable: false`,
   `contact_permission: false`, and `allowed_effects: []`, which is a stronger claim than a status
   string would have been.

## What this audit does not cover

- Whether the reasoning that produced a decision was any good. That is the synthetic contract
  evaluation in `docs/benchmarks/discovery-eval-v0/`, and even that judges discipline, not truth.
- Opportunity projection semantics beyond the review boundary: no router, no model, no draft
  approval chain.
- Delivery truth, because nothing in these paths delivers anything.
- Learning and outcome handling, which have their own tests and were not re-audited here.

## Out of scope

No production code, no new routes, no UI, no model, no network, no Telegram, no scheduler. Stage 4E
(operator write-UI) and 4F (deadline attention) may only build on what this audit found to hold.
