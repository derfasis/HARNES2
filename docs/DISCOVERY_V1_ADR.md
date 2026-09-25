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

Review and reason are **alternative branches** after an assessment, not successive stages: taking
a reason cancels any review task that was proposed for the same basis.

```
                    ┌── assess ──▶ review approve ──▶ CANDIDATE ──▶ transfer ──▶ TRANSFERRED
                    │                     │
  source ─▶ observe │                     └── review reject ──▶ DISMISSED
              │     │                     (alternative branch)
              ▼     └── reason WAIT / IGNORE ──▶ OBSERVING
          OBSERVING          reason STOP ──▶ DISMISSED

  edit / delete / revoke / expiry  ──▶  STALE   (while active; nothing here comes back)

  terminal states (DISMISSED, TRANSFERRED, STALE) stay as they are — a later edit or
  revocation does not relabel them, and a STALE situation is never resurrected.

```

Statuses are exactly `OBSERVING`, `CANDIDATE`, `DISMISSED`, `STALE`, `TRANSFERRED`, enforced by a
database `CHECK` constraint. The live index covers only `OBSERVING` and `CANDIDATE`; closed
situations stay durable for audit and never re-enter on their own.

`STOP` is the operator's decision to close one situation. It is **stored** as `DISMISSED` and
**reported** as `STOPPED`, with `storage_status` beside the logical status so the two are never
confused. This is a storage choice, not a second concept: the database vocabulary is older than
the operator vocabulary, and no migration was performed.

## Authority boundary

Discovery is evidence and attention. It is never authority to act. What each entry point actually
demands, in the terms the code uses:

| Entry point | Actor | Binding demanded |
| --- | --- | --- |
| `discovery.observe` | system only | context and purpose |
| `discovery.assess` | operator | current `revision` + current `evidence_fingerprint` |
| `discovery.reason` | operator | the above **plus** the id of the still-latest assessment |
| `discovery.review` | operator | current `revision` + current `evidence_fingerprint`; binds to its assessment through the review task, not through a caller-supplied id |
| `discovery.transfer` | operator | no revision or fingerprint argument at all; it is bound to the situation by being fresh, being `CANDIDATE`, and carrying an approved review |
| reason-state read, presentation detail | operator | actor only |
| internal `discoveryDetail()` | none | it is an internal read API, not an authorization boundary, and is not exposed over HTTP |

The asymmetry is deliberate. Commands that *bind a basis* must name it exactly, so a stale caller is
refused rather than repaired. A command that *re-derives its basis* from durable state — transfer —
does not need the caller to repeat it, but it must clear every prerequisite below.

Replaying one `request_id` is idempotent; changing the payload under the same `request_id` is a
conflict.

Decisions available to an operator, and exactly what each one means:

| Decision | Effect | Unlock condition |
| --- | --- | --- |
| `WAIT` / `evidence_change` | situation stays live, proposed review cancelled | new evidence |
| `WAIT` / `deadline` | situation stays live, proposed review cancelled | the deadline, or new evidence |
| `IGNORE` | this signal is not interesting; situation stays live | new evidence |
| `STOP` | this situation is closed, permanently | none — new evidence creates a *new* situation |

`IGNORE` does not ban a person, close an engagement, revoke a source, or create suppression.
`STOP` does not either. Both act on one Discovery situation and nothing else. `REVIEW` is not a
decision value: review stays on its own branch, over a `CANDIDATE` assessment.

## Reasoning contract

An assessment is an **unverified proposal**, always. It carries a hypothesis with attributed
claims, inferences, and stated uncertainty, plus a `why_now` rationale, and it is bound to the
evidence it was derived from. Freshness is recomputed from durable source state and applies to
both the hypothesis and `why_now`; it is never read back from a stored model assertion.

Pre-Stage-1 assessments stored two plain strings. They remain readable and are projected as
`legacy_v0_strings`, with their unrecorded claims, inferences, and uncertainty left empty rather
than invented.

A situation cannot be re-assessed on the same evidence after `IGNORE`, and cannot be re-assessed
at all while a `WAIT` is still blocked. A reached deadline only removes that gate: it makes
reassessment possible again. A new review task appears only if that reassessment is actually
performed with decision `CANDIDATE`. The deadline itself never creates a task and never approves
anything.

## Transfer boundary

Transfer is the only path from Discovery into the Engagement world, and it is deliberately
narrow. It re-derives its basis from durable state and requires all of the following, each one
failing closed on its own:

1. the situation is fresh and not already transferred,
2. its status is `CANDIDATE` and an approved review exists,
3. the conversation is real, the person is not suppressed, and the conversation is still AI-owned,
4. an author binding matches the evidence's source, author, and that conversation,
5. a real inbound message exists in that conversation,
6. a current typed reply permission matches person, conversation, channel, **and** account.

A rejection for a missing prerequisite, with the offer and purpose unchanged, leaves the database
byte-identical — that exact scope is what the safety audit proves. The claim does not extend to a
rejection taken while the configuration itself changed: the command layer runs offer invalidation
first, and that maintenance pass may legitimately mark other situations `STALE` before the transfer
itself is refused. That write is a configuration consequence, not a side effect of the transfer.

A successful transfer reports
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

## Attention, not automation

A reached deadline is already reported as `READY` by the reason-state surface; no operator action
is needed for that state to exist. What does not exist is a wake-up: nothing notices it while
nobody is looking, and no deadline ever produces a decision on its own. That gap is deliberate and
recorded, not an oversight. Closing it, if it is ever closed, must produce a durable attention
signal for an operator — never an automatic reason, assessment, transfer, or contact.

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
