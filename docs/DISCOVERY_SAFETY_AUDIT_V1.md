# Discovery safety audit v1

Stage 3D is a test-only audit. No production file is modified by this stage, and every check
below either passes on the current code or is reported as a finding. Findings are not fixed in
this branch; a finding produces a separate fix proposal for review.

`baseline_sha=6076fde` · `live_proof=false` · `proof_level=integration` · offline only: no model,
network, Telegram, or scheduler run.

## Results

| Invariant | Statement | Test | Result |
| --- | --- | --- | --- |
| A1 | No CANDIDATE, review task, WAIT, IGNORE, STOP, or TRANSFER is reachable without a durable assessment behind it. | `A1 …` | PASS |
| B | Each reason decision leaves exactly one immutable `discovery.reason.transitioned` on the current assessment, fingerprint, and revision pair; a replayed request creates none. | `B …` | PASS |
| C | IGNORE and `WAIT/evidence_change` unlock only on new evidence; `WAIT/deadline` unlocks on the deadline or on new evidence. A restart is not an unlock. | `C …`, `C2 …` | PASS |
| D | STOP changes no person, conversation, message, fact, permission, engagement, draft, approval, delivery, outcome, lesson, or run state. | `D …` | PASS |
| E | Neither presentation surface exposes an internal field name, checked by field name. | `E …` | PASS |
| F | Both HTTP reads change no user table at all, existing rows included, across every table in the schema. | `F …` | PASS |
| G | Transfer fails one missing prerequisite at a time, each failure leaving the full snapshot unchanged. | `G …` | PASS |
| H | Actor boundaries hold: `discovery.observe` is system-only, the rest operator-only. | `H …` | PASS |
| I | Stale authority never returns through edit, delete, revoke, expiry, or restart. | `I …` | PASS |
| I2 | A superseded assessment loses its authority even on unchanged evidence. | `I2 …` | PASS |
| I3 | An approval that is later superseded cannot be transferred, until the new assessment is approved. | `I3 …` | PASS |
| I4 | A revoked source does not regain authority after a restart and a re-allow. | `I4 …` | PASS |

## How each invariant was checked

**A1.** A freshly observed situation is `OBSERVING` with no assessment, which is the correct
intake state and is not a violation. What must hold is that no *decision* state is reachable
from it: a reason request with no assessment behind it is refused with
`DISCOVERY_REASON_ASSESSMENT_STALE`, no review task exists, and no transition is written.

**B.** One `discovery.reason` request is replayed under the same `request_id`. Exactly one
transition survives, and it names the current assessment id, the current evidence fingerprint,
and `result_revision === basis_revision + 1` equal to the current situation revision.

**C.** Unlock conditions are read back from the reason-state surface rather than inferred from
code, and a restart is exercised explicitly. A re-assessment on the same evidence is refused
with `DISCOVERY_REASON_IGNORED` or `DISCOVERY_REASON_WAITING` until the named condition happens.
All three wait shapes are covered separately: `evidence_change` blocks until new evidence,
a future `deadline` blocks across a restart and is retired by new evidence even before the
deadline, and `C2` shows a reached deadline reported as `READY` / `DEADLINE_REACHED` — after
which the situation may be re-assessed, which produces a new review task rather than an approval.

**D.** The full row content of every user table is captured before and after `STOP`. One task
change is expected and allowed: `STOP` cancels its own proposed `discovery_review` task, which
is the agreed Stage 2 behaviour. No other task appears, changes, or disappears.

**E.** Field names are collected recursively from both presentation payloads and compared against
a denylist of internal names (`payload_json`, `partner_id`, `offer_fingerprint`, `source_kind`,
`source`, `raw`, `transferred_engagement_id`, `conversation_id`). The test then confirms the
internal read model still carries the very names the surface hides, so the allowlist is doing
real work rather than describing an already-empty projection. This is a field-name check, not a
word search over operator-visible text.

**F.** Both HTTP GETs are exercised against a running loopback server with `fetch` and
`spawn` stubbed to fail loudly. The table list is discovered from `sqlite_master` at run time
rather than hand-written, minus SQLite's FTS shadow tables, and the test fails if fewer than 30
tables are covered. Every table is snapshotted by full row content before and after, so a read
that modified an existing row would fail. An earlier hand-written subset that omitted real
tables was rejected in review; this is the corrected form.

**G.** Transfer is walked prerequisite by prerequisite, and after **every** rejection the full
schema snapshot is compared: no approved review, an author binding for the wrong person, a
missing real inbound message, a missing typed reply grant, a suppressed person, a conversation
the AI no longer owns, and a conversation bound to an unrelated person. The typed grant is then
corrupted one scope field at a time — `person_id`, `conversation_id`, `channel`, and `account_id`
— and each corruption must produce `typed_permission_required` with the snapshot unchanged. The
account case runs on a conversation that actually has a channel identity, and the grant is moved
onto that same channel and bound to a *different* account, so the only field that can explain the
refusal is the account. The same grant on the matching account is then accepted, which is what
makes the refusal meaningful rather than incidental. With every
prerequisite intact the transfer enters the existing Engagement boundary and still reports
`contact_permission_created: false`, `drafts_created: 0`, and `sends_started: false`.

**H.** Every Discovery entry point is called as an `agent` and as a `system`. Observe is
system-only in both directions; assess, reason, review, transfer, the reason-state read, and the
presentation detail all refuse anything that is not an operator. The internal `discoveryDetail()`
is deliberately left without an actor, and the test says so rather than leaving it untested.

**I.** Edit, delete, revoke, and expiry each close the same three doors — approve, reason, and
transfer — and no transition is written. The approve door is always attempted, whatever the task
status: a task that was already cancelled must be refused as well, and the test may not skip the
door just because no proposed task remains. The transfer probe uses a real person, conversation,
inbound message, and grant, so the refusal it observes is the Discovery-level one rather than an
earlier conversation lookup. After a restart the path is still refused and still writes nothing. `I2` covers the
agreed supersession case: a newer assessment on the *same* evidence cancels the earlier review
task, refuses a reason decision that names the old assessment, refuses approval of the cancelled
task, and writes no transition — while the current assessment keeps its own authority. `I3`
covers the harder case: an approval that was already granted, then superseded by a newer
assessment on the same evidence, can no longer be transferred; approving the new assessment
restores the path. `I4` closes the revocation loop: the source is revoked and the real
maintenance path runs, the process restarts, the source is allowed again — and the old situation
still cannot be approved, reasoned, or transferred. Only genuinely new evidence from the
re-allowed source may open a new situation. The audit asserts
*usability*, not a status label: a situation whose TTL has passed is refused either way, and
asserting that the row reads `STALE` would have been a claim about maintenance timing, not about
authority.

## Claims corrected during the audit

Three initial formulations were wrong and were corrected against the real, already-agreed
behaviour rather than against an assumption:

1. "No situation exists without an assessment" is false — `OBSERVING` with no assessment is the
   normal intake state. The invariant is about decision states, not existence.
2. "STOP changes no task state" was too strong — it cancels its own proposed review, by design.
3. "A stale situation reads `STALE` after restart" conflated authority with a maintenance label.
   The audit asserts that authority does not come back, which is the property that matters.

## Findings

None. Every agreed invariant holds on `main@6076fde`. Should a future change break one, the
failing test is the finding, and the fix is a separate proposal — this branch stays test-only.

## Out of scope

No production code, no new commands, tables, routes, or UI. Stage 3E (a read-only UI) may only
draw the frozen Stage 3B/3C projections.
