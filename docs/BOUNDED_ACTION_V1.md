# Bounded Action / Execution v1

Implementation base: `main@12dc7f8d50a6a6a76cd9c8a7f715c2b22d38b218`.
Branch: `codex/bounded-action-v1`. Main is not modified or merged by this change.

This layer turns accepted understanding into a narrowly authorized local effect.
Continuity keeps evidence and interpretations; Executive researches questions.
Action adds a separate authority boundary rather than giving either loop write tools.
The previous prepared design was rechecked against the merged main: its tree equals
the owner-verified `168179b` tree. Existing contracts, Hermes pin, transport readers,
source checkpoints, permission/consent and outbound paths remain in place.

## End-to-end behavior

```text
accepted current interpretation + owner goal
  → immutable typed proposal and exact evidence packet
  → explicit owner grant of that hash, capability and target (one attempt, ≤24h)
  → durable prepared attempt
  → final authority/evidence check → dispatch (grant consumed)
  → durable adapter receipt (not proof of success)
  → independent read of the actual result on another pass
  → observed present / absent / mismatch / unavailable
  → owner review, human acknowledgement/resolution, revocation or recovery
```

Both proposals and grants are operator commands. Optionally, the owner can request
one no-tool Hermes proposal: it can select a registered capability or `no_action`.
It cannot authorize, execute, or use a model-produced permission. Model planning is
separately disabled by default and uses the existing global budget/run ledger.
No automatic proposal loop or hidden grant is introduced.

## Capability boundary

| Capability | Exact effect | Independent check |
| --- | --- | --- |
| `brief.publish_local.v1` | Immutable JSON in `data/action-artifacts/<action-id>.json` | Reopen file, compare exact expected bytes and SHA-256 |
| `owner_handoff.create.v1` | One task of kind `owner_action` in existing SQLite | Read task identity, partner, kind, action linkage and immutable payload |

There is no adapter for Telegram/email/browser writes, shell execution, caller paths,
URLs or recipients. Brief contents are the accepted interpretation and only its
referenced current evidence (maximum 32 refs), with source versions, literal quotes,
unknowns and coverage bounds. `epistemic_status` stays `unverified_interpretation`.
A published brief is not a confirmed fact. A created task is not an accepted or
completed task. Owner resolution is an attributed report, not a verified business outcome.
No persons, conversations, consent, drafts, approvals or outbound messages are created.

Human tasks are excluded by kind from Scheduler, `contextFor`, agent work listings
and generic task approve/retry/cancel commands. Their dedicated commands require a
verified, current action. Acknowledge: `proposed → pending`; owner resolution:
`pending → done/cancelled`. No automation consumes that pending state.

## Persistence and invariants

Migration `007-bounded-action.sql` adds only three domain tables:

- `action_proposals`: accepted turn, exact packet, evidence/authority fingerprint,
  immutable proposal hash, revision and operator-visible state.
- `action_grants`: versioned exact authority, expiry, one-attempt limit, consumed or
  retired status. A partial unique index permits one active grant per proposal.
- `action_attempts`: durable preparation, dispatch/receipt and independent verification.
  Unique `grant_id` prevents a grant funding two attempts.

Existing `events` retain audit and every verification observation; existing
`command_receipts` deduplicate operator retries. Semantic proposal hashes also
deduplicate equivalent decisions with different request IDs. Re-proposing an exact
revoked action returns its history, not revived authority. To make a new decision,
review new understanding or author a different proposal explicitly.

Granting and dispatch require the exact Continuity fingerprint, accepted turn,
latest review, source access, source versions and freshness. Authority additionally
binds owner goal/control, watched policy and the fixed capability registry version.
The external read-only fence (`automatic=true`, runtime and live sending false)
is checked again. A pending newer turn, edit, delete, revoke, pause or expired
evidence prevents execution before periodic reconciliation runs.

The proposal/grant/attempt dimensions remain separate. `completed` means that a
local effect was observed, not that a business objective succeeded. Detail returns
current basis separately; a historically completed output can become stale.
Revoking authority cannot undo already published bytes. Late receipts and probes
are recorded without restoring revoked grants or allowing another execution.
When an operator command first discovers stale or revoked scope, that observation
is latched after the rejected command rolls back; reallowing the source cannot revive
that proposal. Denials are audited with IDs/codes, without copying untrusted payloads.

## Recovery and concurrency

| Failure or transition | Behavior |
| --- | --- |
| Crash before dispatch | A prepared attempt may continue only under its original current, unexpired grant |
| Crash after dispatch marker | Startup changes attempt to unknown and schedules a read-only probe; no replay |
| Effect succeeded but receipt transaction failed | Retain unknown; probe actual result on a later pass |
| Even fallback persistence is unavailable | The returned worker remembers its own orphan until storage recovers; restart provides the durable equivalent |
| Probe or probe receipt fails | Unavailable or pending observation; never infer absence from an exception |
| Independent absence | Owner may issue a new exact one-attempt grant; no automatic retry |
| Existing wrong file/task | Mismatch; never overwrite, repair silently, or blindly repeat |
| Revocation during an in-flight operation | Record physical result and revoked authority independently |
| Restart after completion | Queue re-verification; last successful observation is historical, not proof of present bytes |
| Import/export transfer | Preserve history, revoke imported grants, retire imported proposals, cancel pending human handoffs; never transfer executable authority |

The three scheduler loops have separate ownership: observation, reasoning and local
execution. Action maintenance needs no model and continues while execution is off.
Execution requires established reconciliation, then validates its own exact scope.
Read-only verification may run after revocation or while execution is disabled.
One action pass owns at most one execution or verification; durable round-robin
cursors bound selection/maintenance to 20 rows and survive restart.

The source timer also wakes the independent action pass after observation finishes,
without waiting for effects. This avoids timer-phase starvation while preserving
source cadence. Shutdown stops the action timer, prevents new dispatch and drains
an existing pass before closing SQLite. A live `dispatching` attempt is not declared
orphaned just because another pass encounters it.

Briefs use Node's exclusive staging write, file sync and no-replace hard link into
the fixed vault; there is no overwrite fallback. A post-dispatch error is unknown
even if it might have happened before publication. Verification supplies the answer.
Normal completion removes its own staging file; a process killed mid-write may
leave private `.tmp` debris. Such files are never considered results or replayed.
No directory-wide cleanup or retention redesign is introduced.

## Operator/API surface

The **Действия** tab uses the existing authenticated local operator API. It shows
the exact proposal, evidence, target, expiry/attempt limit, grant versions, receipts
and verification. Approval defaults to refusal, freezes the displayed revision/hash
and grants one hour. Stale actions keep revocation and verification controls.
GET/render performs no action command; all source/model text is escaped.

Commands use the existing `/api/commands` envelope and operator token:

| Command | Payload beyond request envelope |
| --- | --- |
| `action.propose` | `thread_id`, `expected_basis_fingerprint`, `reason`, `proposal` |
| `action.request_plan` | `thread_id`, `expected_basis_fingerprint` (opt-in model only) |
| `action.grant`, `action.retry` | `action_id`, `expected_revision`, `proposal_hash`, `expires_at` |
| `action.revoke`, `action.reject` | `action_id`, `expected_revision`, `reason` |
| `action.verify` | `action_id`, `expected_revision` |
| `action.handoff_acknowledge` | `action_id`, `expected_revision`, `note` |
| `action.handoff_resolve` | `action_id`, `expected_revision`, `note`, `outcome: done/declined` |

`GET /api/actions?limit=20&cursor=<id>` and `GET /api/actions/<id>` expose history.
`GET /api/actions/<id>/artifact` verifies bytes before returning the scoped package
and its currentness. Artifacts are never served as public static files.
`POST /api/actions/wake` processes only local execution/verification; it does not
implicitly call a model or fetch sources. It waits for established scheduler
reconciliation; the existing scheduler remains responsible for observation.

Proposal fields are fixed by `contracts/action-proposal.schema.json`:
`capability_id`, `title`, `instructions`, `expected_result`, `due_at`.
Unknown fields are refused at this authority boundary (unlike Telegram raw updates).

Defaults remain safe:

```json
"actions": { "enabled": false, "modelEnabled": false, "maxModelRunsPerDay": 5 }
```

Using local actions requires an explicitly enabled Continuity/automatic observation
configuration and an accepted current turn. `actions.enabled=true` makes the local
capabilities available; it supplies no grant. `modelEnabled` is separately opt-in.
This implementation did not enable any local deployment or live service.

## OSS reuse and limits

Reuse: installed SQLite transactions/unique constraints, AJV, Scheduler, Hermes
no-tool worker, shared run accounting, Node filesystem primitives, existing task
table, command receipts, audit events, local operator UI and strict staged import.
No new package or service is added; upstream Hermes is untouched.

Prior donor review considered [Temporal](https://github.com/temporalio/sdk-typescript)
and [DBOS](https://docs.dbos.dev/typescript/reference/configuration). Those engines
do not supply this domain's evidence/authority proofs; DBOS also adds PostgreSQL.
The local single-process SQLite deployment does not need a second workflow engine.
[MCP tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
are hints, not grants. [Node fs](https://nodejs.org/api/fs.html) provides the narrow
file adapter. Custom code is the domain permission, evidence and recovery boundary.

Deployment assumptions: one service owns a data directory, on an owner-controlled
local filesystem supporting hard links. Symlink/junction roots/vaults and unsafe
artifact files are refused. Concurrent malicious filesystem mutation by the same
OS owner is outside this process boundary. No distributed/hostile shared-filesystem
guarantee is claimed. Process crash recovery is covered by authored acceptance
cases; filesystem power-loss behavior requires platform validation. Completed
effects are re-probed after startup. No external provider/idempotency semantics
have been validated because no external effect capability exists.

See [verification handoff](BOUNDED_ACTION_V1_VALIDATION.md) for what was and was not run.
