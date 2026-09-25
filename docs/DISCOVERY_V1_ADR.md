# Discovery v1 — canonical ADR

This is the map. It says what Discovery is, where authority ends, and what is forbidden, in one
place. It does not replace the stage documents: those stay as the evidence of how each decision
was reached and reviewed.

`status=accepted` · `baseline_sha=a928bca` · `proof_level=integration` · `live_proof=false`

## What Discovery is

Discovery is the durable, offline-first record of "something might be worth understanding here".
It watches sanitized public sources, groups what it saw into a **situation**, and asks an operator
or a reviewed reasoning step to judge it. It never contacts anyone, never sends anything, and
never treats its own output as a fact.

The unit of work is the **situation**, keyed by source, subject, and conversational context, with
a bounded evidence set and a TTL. Evidence is what a source actually said, recorded immutably.
Everything else is interpretation, and interpretation is labelled as such.

## Lifecycle

```
        observe                assess                  reason                review              transfer
source ────────▶ OBSERVING ──────────▶ OBSERVING ──────────▶ OBSERVING ─────▶ CANDIDATE ────────▶ TRANSFERRED
                   │                     │                     │                 │
                   │ edit/delete/revoke  │ superseded           │ WAIT   IGNORE    │ approve
                   │ /expiry             ▼                     ▼                 ▼
                   └──▶ STALE        new assessment        OBSERVING         DISMISSED
```

Statuses are exactly `OBSERVING`, `CANDIDATE`, `DISMISSED`, `STALE`, `TRANSFERRED`, enforced by a
database `CHECK` constraint. The live index covers only `OBSERVING` and `CANDIDATE`; closed
situations stay durable for audit and never re-enter on their own.

`STOP` is the operator's decision to close one situation. It is **stored** as `DISMISSED` and
**reported** as `STOPPED`, with `storage_status` beside the logical status so the two are never
confused. This is a storage choice, not a second concept: the database vocabulary is older than
the operator vocabulary, and no migration was performed.

## Authority boundary

Discovery is evidence and attention. It is never authority to act.

- Reading and reasoning are operator-only. `discovery.observe` is system-only.
- Every decision command requires the exact current situation `revision` **and** the exact current
  `evidence_fingerprint`. A stale caller is refused, not repaired.
- A decision additionally requires a specific `assessment_id` that is still the latest one.
- A proposed review is cancelled whenever the basis it belonged to is replaced.
- Replaying one `request_id` is idempotent; changing the payload under the same `request_id` is a
  conflict.

Decisions available to an operator, and exactly what each one means:

| Decision | Effect | Unlock condition |
| --- | --- | --- |
| `WAIT` / `evidence_change` | situation stays live, review cancelled | new evidence |
| `WAIT` / `deadline` | situation stays live, review cancelled | the deadline, or new evidence |
| `IGNORE` | this signal is not interesting; situation stays live | new evidence |
| `STOP` | this situation is closed, permanently | none — new evidence creates a *new* situation |

`IGNORE` does not ban a person, close an engagement, revoke a source, or create suppression.
`STOP` does not either. Both act on one Discovery situation and nothing else. `REVIEW` is not a
decision value: review remains the separate `discovery.review` path over a `CANDIDATE` assessment.

## Reasoning contract

An assessment is an **unverified proposal**, always. It carries a hypothesis with attributed
claims, inferences, and stated uncertainty, plus a `why_now` rationale, and it is bound to the
evidence it was derived from. Freshness is recomputed from durable source state and applies to
both the hypothesis and `why_now`; it is never read back from a stored model assertion.

Pre-Stage-1 assessments stored two plain strings. They remain readable and are projected as
`legacy_v0_strings`, with their unrecorded claims, inferences, and uncertainty left empty rather
than invented.

A situation cannot be re-assessed on the same evidence after `IGNORE`, and cannot be re-assessed
at all while a `WAIT` is still blocked. A reached deadline unblocks *reassessment* and creates a
new review task; it never approves anything by itself.

## Transfer boundary

Transfer is the only path from Discovery into the Engagement world, and it is deliberately
narrow. It requires, in order and each one alone failing closed:

1. a `CANDIDATE` situation with an approved review,
2. an author binding matching the evidence's source, author, and conversation,
3. a real inbound message in that conversation,
4. a current typed reply permission matching person, conversation, channel, **and** account,
5. a person who is not suppressed and a conversation the AI still owns.

Every rejected attempt leaves the database byte-identical. A successful transfer reports
`contact_permission_created: false`, `drafts_created: 0`, and `sends_started: false`; it creates
engagement attention, nothing else. Discovery never creates a person, a permission, a draft, or a
send.

## Stale, revoke, and expiry semantics

An edit, a delete, a source revocation, or a passed TTL makes the basis unusable immediately.
Editing evidence does not silently refresh the assessment; revoking a source does not revive an
old situation even after a restart and a re-allow; a restart never restores authority. A situation
past its TTL is refused whether or not a maintenance pass has relabelled the row — the audit
asserts usability, not a status label.

## Presentation contract

The internal read model is not the presentation surface. Operators see an allowlisted projection:
situational basis, freshness, bounded evidence, assessments with their epistemic labels, opening
proposals, and review tasks — with `executable: false`, `contact_permission: false`,
`sent: false`, and `allowed_effects: []` standing. Raw event payloads, partner identifiers, offer
fingerprints, and transport metadata are never exposed. Every bounded string is capped at 2000
characters and carries an explicit truncation flag, so shortening is announced rather than silent.

`BLOCKED` and `READY` are reason-state vocabulary. `READY` means the reason-state condition is met
— nothing more. It is not a permission and not contact authority, and the interface must not
translate it into "you may act now".

## Forbidden

- No contact, draft, send, or permission created by Discovery.
- No suppression, ownership change, or source revocation as a side effect of a Discovery decision.
- No automatic reason, assessment, transfer, or contact triggered by a deadline.
- No presenting a hypothesis as a fact, a quote as a verified truth, or a proposal as a permission.
- No reading a stale basis as authority, and no silent repair of stale state by reading.
- No secrets in tracked configuration, logs, or exports.

## Proof levels

Everything in this ADR is proven at `proof_level=integration` with `live_proof=false`: offline
synthetic fixtures, deterministic timestamps, no model call, no network, no Telegram, no scheduler
tick, and no live transport. Live proof does not exist for Discovery today and must not be implied
by any of these documents.

## Where the evidence lives

| Question | Document |
| --- | --- |
| Why the situation model exists | `DISCOVERY_SITUATION_V1.md` |
| Which invariants were agreed and closed | `DISCOVERY_CONVERGENCE_MATRIX_V1.md` |
| Why reasoning is structured and evidence-bound | `DISCOVERY_ASTRA_STAGE1.md` |
| What operators may read, and what stays hidden | `DISCOVERY_PRESENTATION_CONTRACT_V1.md` |
| Which safety invariants were audited, and how | `DISCOVERY_SAFETY_AUDIT_V1.md` |
| What the review loop covers end to end | `review-smoke.md` |
