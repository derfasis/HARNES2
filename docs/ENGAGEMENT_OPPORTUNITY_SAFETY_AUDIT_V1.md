# Engagement and Opportunity safety audit v1

Stage 4C extends the Stage 3D audit method to the two write paths that Discovery deliberately
refuses to own: the Engagement loop and the Opportunity review. Production code is not modified by
this stage. A failing invariant is a finding, reported here and fixed in its own patch.

`baseline_sha=ae18741` · `live_proof=false` · `proof_level=integration` · offline only.

## Results

| Invariant | Statement | Result |
| --- | --- | --- |
| E1 | A decision requires the current engagement revision and message evidence from its own conversation. | PASS |
| E2 | ACT requires a typed permission matching person, conversation, channel, and account, each proven separately. | PASS |
| E3 | A suppressed person or a human-owned conversation produces no work, and history is not erased. | PASS |
| E4 | A draft is never a send, and no delivery is ever claimed. | PASS |
| E5 | Request replay returns the identical result and writes nothing; a changed payload under the same id conflicts. | PASS |
| E6 | A closed **or** stopped engagement stays closed across a restart and does not reopen on a new inbound. | PASS |
| O1 | Opportunity review requires the exact fingerprint and revision. | PASS |
| O2 | Approving a card is a review act: non-executable, no contact, no send. | PASS |
| O3 | A decided card cannot be decided twice; a replay returns the identical result and writes nothing. | PASS |
| O4 | Nothing in this audit performs an external call. | PASS |

## How the refusals were checked

The full row content of every table in the schema is captured immediately before and after **each
individual refusal** — never once around a group of them, which would prove only the combined
effect: the stale-revision and missing-evidence decisions in E1, the broken grant in E2, the
suppressed and human-owned cases in E3, the conflicting replay in E5, the closed and stopped cases
in E6, the bad fingerprint, revision, and field set in O1, and the re-decide in O3. Where a refusal
is *supposed* to write something, that something is named and constrained, rather than being waved
through:

- A refused Engagement command writes nothing at all.
- A refused **Opportunity review** writes exactly one thing: an `opportunity.review.denied` event.
  Each refused review is measured on its own, and each may add exactly one denial and change
  nothing else.

## Contract: the denial trail is a durable write, by design

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

**Decided: a refusal is durable.** Keeping the trail is useful and safe — an operator can see that
someone tried to approve something that was not approvable, and the payload is small enough to
carry none of the untrusted text, no grant, and no status mutation. The contract is therefore
fixed as: *the denial trail is durable by design, with exactly `action`, `task_id`, `code`, and
`request_id`, and nothing else.* A refusal that wrote more than that would be a finding.

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

Two of these needed real setup rather than a stronger-looking assertion. Idempotence is proven by
comparing the whole result of a replay against the first result and by taking the snapshot *after*
the first success, so a replay that quietly wrote again would show. And the resurrection question
is answered on the path that actually resurrects: engagement is enabled, the case is closed or
stopped, the process restarts, a genuine new inbound arrives — and no engagement reopens, no
second row appears, and no evaluation task is queued. The closed case is closed while AI-owned, so
the refusal is not masked by a `HUMAN_OWNED` conversation.

Account isolation needed its own setup: on a manual conversation `account_id` is null, so no
mismatch can even be expressed. The audit moves the conversation onto a real channel identity and
binds the grant to a *different* account, so the refusal can only be about the account — and then
re-binds it correctly to show the path opens again.

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
