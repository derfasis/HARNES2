# Partner Workspace v1 + Work Core + Control Plane

Baseline: canonical `main@4ab8be309d11c93b9df73161fc07c6c029f35aee`, after Outcome PR #26.
Implementation branch: `codex/partner-workspace-v1`. Main is not modified.
The preserved [acceptance plan](PARTNER_WORKSPACE_V1_ACCEPTANCE_PLAN.md) is the prebuild scope;
its earlier SHAs and unexecuted status are historical, not the verification status of this implementation.

## Product result

A goal can become an ongoing public workcase: current source evidence → reviewed interpretation →
immutable ready material → material review → proposed local action → separate owner grant →
receipt → independent local verification → bounded observation → renewed understanding next day.
The same goal and case survive restart. Opening the Workspace, reviewing material or observing a
source never creates a person, conversation, contact permission, private draft or delivery.

The material is the actual ready text, not instructions asking another agent to write it later.
Model preparation uses the existing no-tool Hermes worker only after configuration and an explicit
`work.request_material`. With models disabled, the operator can complete the same lifecycle manually.
This is not evidence that a model has found a commercially valuable opportunity or produced good content.

## Three responsibilities

| Owner | Responsibility | What it does not own |
| --- | --- | --- |
| Workspace | Authenticated loopback UI, bounded projections, explicit operator choices | Admission, source truth, effect authority |
| Work Core | Cases, immutable material versions/reviews, links to actions, public observation expectations | Contact identity, research authority, private Outcome truth |
| Control Plane | Process ownership, per-plane model admission, reservations, scoped run tickets, stale completion/recovery | Owner grants, material approval, contact permissions |

Continuity owns durable goals and interpretation memory. Executive owns bounded research grants and
conclusions. Engagement owns private attention and permissions. Action owns proposals, grants,
attempts, receipts and verification. Outcome owns private delivery-based observation and attribution.
Their state machines remain separate; Workspace links them rather than replacing them.

Public identity is not promoted into a contact. Existing `discovery.transfer` keeps its exact identity,
real inbound and typed reply-grant checks. A public workcase does not need that transfer.

## Durable records and lifecycle

Migration `010-partner-workspace.sql` adds six tables; historical migrations 001–009 stay unchanged.

| Record | Durable content and transitions |
| --- | --- |
| `work_cases` | Continuity thread/accepted turn, frozen evidence packet and basis fingerprint, current material/action links, revision; `open → stale → open` through explicit fresh review/rebind, or `closed` |
| `work_materials` | Exact UTF-8 content, SHA-256, evidence refs, turn/basis, producer/run, monotonic version; `proposed → approved/rejected`, then `superseded/stale` as appropriate |
| `work_material_requests` | Explicit per-case/basis request, captured revision/packet, bound run and result; `pending → running → completed/failed/stale/interrupted` |
| `work_expectations` | Verified local action, one public source, question, observation deadline, durable event cursor and bounded observations; `pending → evidence_observed/unknown/revoked` |
| `control_tickets` | Resource reservation, plane/operation, process owner, bound run, expiry, status, historical estimated reservation |
| `control_owners` | Partner process lease, owner ID, PID, short expiry |

An SQL trigger prevents changing material content/provenance/hash in place. Review changes only review
fields/status. At most 50 versions are supported per case; this is an explicit v1 bound, not silent pruning.
Each command uses the existing transactional command receipt/idempotency key. Case mutations require
the displayed revision. Opening the same accepted turn returns the existing case.

Material review and action receipts are not Continuity notes. They do not change the accepted basis
and therefore cannot create a self-invalidating review cycle. Actual source changes still retire derived work.

`next_move` is a deterministic projection of current domain state, not another model or executable plan:
prepare/review material, prepare action, request owner grant, execute/verify, define expectation,
continue observing, review changed evidence or request recovery. A model can propose content; it cannot
select an effect, approve it, grant authority, create a contact or write through tools in this path.

## Commands, envelopes and operator flow

All `work.*` commands are operator-only and have closed payload fields:

1. `work.goal`: explicit title/objective/success condition, allowlisted source IDs and evidence age.
2. `continuity.capture/propose/review`: reuse current snapshot and the existing reviewed-interpretation contract.
3. `work.open`: exact accepted thread/basis; freezes an Action-compatible evidence packet.
4. `work.material` or `work.request_material`: actual content with existing evidence refs, or explicit opt-in inference request.
5. `work.review`: exact case revision, material ID and hash, approve/reject plus owner note.
6. `work.prepare_action`: proposal only, `material.export_local.v1` or `owner_handoff.create.v1`.
7. Existing `action.grant`: separate exact proposal hash/revision, expiry and single-attempt authority.
8. Local Action loop and independent verifier; `work.expect` only after current verified completion.
9. New source evidence makes old interpretation/material stale. Review the new Continuity turn, then
   `work.refresh` with the current accepted basis; the case and goal IDs remain unchanged.
10. `work.close`: retires dependent active work. `action.revoke/verify/retry` remain existing owner controls.

`contracts/work-material.schema.json` is the closed model output: title, ready content and cited durable
event IDs. The Action proposal contract adds an optional material reference required only for local
material export. Old brief/handoff canonical proposal hashes remain unchanged.

`material.export_local.v1` resolves an approved immutable material before snapshotting the proposal.
Grant and dispatch revalidate that snapshot, current case/turn/basis and exact bytes/hash. The existing
fixed local artifact vault writes a JSON envelope containing the ready content and provenance; it
does not accept arbitrary paths. The existing independent reader/verifier checks exact artifact bytes.
Human handoff creates only the existing human-owned task, pointing at the reviewed material ID/hash.
Task completion does not prove external publication, customer response or causal contribution.

Authenticated read routes: `GET /api/workspace` (limit/cursor),
`GET /api/workspace/cases/:uuid`; existing `/api/commands`, Continuity and Action routes are reused.
The UI shows source statements, reviewed interpretations, content/reviews, grants, receipt/verification
and expectations separately. Untrusted text is assigned through DOM `textContent`; no remote scripts,
HTML rendering of source instructions or new browser write surface is added.

## Coexistence and scheduling

The old global exclusion `opportunity.automatic` versus `runtime.enabled` is replaced only when
Control Plane is enabled. Config, source-ingestion, server startup, Hermes runtime, tool boundaries and
direct agent service mutations agree on this rule. With CP disabled, the prior exclusion remains.
CP v1 rejects `telegram.liveSending:true`. Source policies, allowlists and transport freshness are unchanged.

Independent clocks drive source/reconciliation, public reasoning, private reasoning, material reasoning,
local Action and process heartbeat. The source pass does no model inference. It advances transport,
Continuity, Executive, Action, Work and Outcome reconciliation while another plane awaits a model.
Public Continuity/Opportunity/Executive/Action planning remain sequential within their existing plane.
Private and material reasoning do not wait for that plane. This is bounded admission, not a general job engine.

Control Plane has at most one active model run per plane, 2–4 total slots and a reserved private slot.
Model-enabled Workspace requires at least three slots so a busy public plane cannot starve material
preparation. A transaction reserves capacity before preparation; binding the real run occurs in the same
transaction as its domain run creation. `runs` remains the billing/provenance ledger. Idle admissions
leave no artificial durable job. Unknown cost blocks budgeted work; it is not zero or automatic retry authority.
Reservation USD is an admission estimate, not a provider-enforced hard billing cap.

Hermes and business tools recheck the ticket's process/plane/run/conversation scope and currentness.
Public/material decisions are no-tool calls. Unscoped MCP writes cannot bypass CP. Legacy private
autopilot hooks never run for a CP-admitted run, even if CP is disabled while its answer is pending.
Neither capabilities metadata nor a resource ticket creates an owner/contact grant.

## Recovery, revocation and failure semantics

- Startup takes the loopback port and checks/acquires process ownership **before** durable recovery.
  A second launch cannot interrupt the live instance even on another port or with CP disabled.
  A confirmed dead PID permits immediate recovery of an unexpired lease. Heartbeat runs independently
  of model waiting; expired/replaced owners cannot apply outputs or dispatch new local actions.
- Restart interrupts in-flight tickets and material requests. It does not replay a request, consume another
  grant, resend a private draft or repeat unknown local dispatch. Existing Action recovery independently
  inspects effects when an attempt/receipt is interrupted. Known output and historical material remain inspectable.
- Late model completion rechecks Workspace/model switches, ticket/process, request still running,
  case revision, accepted basis, source evidence, schema and refs. Obsolete output is discarded;
  usage remains recorded. Closing/staling a request cannot be overwritten into a successful/failed replacement request.
- Source edit/delete/revoke/age prevents dependent review/grant/dispatch. Reallowing a source does not
  recreate a grant; refreshed work needs a newly accepted basis and reviewed material.
- Work reconciliation uses a durable round-robin case cursor, bounded cases/events and at most 20
  retained observations. Static evidence text/refs and interpretation are checked against their durable
  domain owners; a corrupted material request is retired before inference without poisoning neighbours. Invalid persisted time/cursor/JSON quarantines that case, retires active material/
  authority and leaves healthy neighbours progressing. Operator reads with corrupt projections fail closed.
- Public expectations describe source changes after a verified **local** action. They do not claim that
  the action caused a change or that a person responded. Deadline without evidence becomes `unknown`
  with `COVERAGE_NOT_ESTABLISHED`; pre-deadline durable backlog drains in bounded pages before
  settlement, post-deadline observations cannot satisfy the expectation, and a new action needs its own
  expectation. Replacing an expectation explicitly retires the previous active expectation. It does not create a private Outcome window or continuous-coverage proof.
- Private MTProto callback intake uses a bounded serialized queue. Message write, receipt and observed
  cursor commit together. Failure/overflow latches a durable gap that later success cannot clear. Startup
  coverage stays unverified: the observed cursor is not proof of historical replay. Stop drains admitted callbacks.
- Shutdown stops all clocks, retires tickets and drains source/public/private/work/action/channel work
  before releasing the lease and closing SQLite.
- Schema-10 transfer preserves work/material history, marks work stale, interrupts requests/tickets,
  clears owners, revokes Action grants and invalidates private pending approvals. Existing sent/unknown
  delivery truth remains history. Historical schema-2–9 imports keep their own explicit table catalogues.

## Opt-in configuration

Defaults keep Workspace, CP, model runtime, Telegram and live sending disabled. Nothing in this
implementation edits local secrets, starts a model or turns on a transport. For an explicitly configured
source, merge these settings into your own `config/local.json`:

```json
{
  "workspace": { "enabled": true, "modelEnabled": false },
  "controlPlane": { "enabled": true, "maxConcurrent": 3, "reservationUsd": 0.25 },
  "continuity": { "enabled": true, "modelEnabled": false },
  "actions": { "enabled": true, "modelEnabled": false, "maxModelRunsPerDay": 5 },
  "opportunity": { "automatic": true, "allowedSourceRefs": ["YOUR_EXISTING_ALLOWLISTED_SOURCE"] },
  "telegram": { "liveSending": false }
}
```

This fragment is not a complete source policy: configure the existing Browser/Telegram source,
active offer, freshness/cadence and allowlist through their documented contracts. Inference still
requires explicit model switches/readiness/budget; transport connection is separately configured.
Default-disabled public Opportunity inference may remain waiting for model readiness while manual
Workspace work is available. Existing private conversations require their own identity and permission.

## Verification and handoff

The new suites exercise real temporary SQLite, `BusinessService`, actual scheduler/server composition,
deferred valid fake model outputs, abrupt child-process death, local artifact publication and independent
read/verification. They include current-state positive controls. No real provider/model, customer contact,
Telegram session or external publication is used by this verification.

Focused suites: `node --test tests/workspace*.test.mjs tests/discovery-convergence-gate.test.mjs`.
Full gate: `npm test`, `npm run test:credentials`, `npm run build`, `git diff --check`.

Verified on 2026-10-02: **45 new Workspace tests + 14 existing convergence tests = 59/59**;
full **1083/1083 Node**, **15/15 Python**, build **149 JavaScript/JSON + 9 Python files**;
`git diff --check` passes. **13/13 deliberate guard-removal probes** fail on the expected behavioural
assertions. The actual loopback UI was used to create a new immutable version, review it, propose
and separately grant a local export, execute it and verify it. These are synthetic/local checks,
not live model, transport or business-result validation. Hosted CI is not claimed here.

Self red-team found and fixed: late output after Workspace disable, stale request overwritten by completion,
unexpired dead-process lease blocking restart, insufficient slots starving material reasoning, false volatile
private cursor after commit failure, corrupt persisted expectation starving healthy work, CP-disable
fallthrough into legacy autopilot and CP-disabled duplicate startup touching a live owner's DB.

A deliberately removed-guard probe tests kill-switch, request CAS, material approval, corrupt deadline,
dead-process reclaim, private-slot reservation, historical-ticket autopilot isolation and duplicate-owner
startup, static evidence integrity, corrupt request isolation, action/expectation binding, observation
deadline and bounded backlog. Original files are restored after each probe. An initially false-green kill-test supplied invalid
evidence refs; a valid unchanged positive control exposed it and the fixture was corrected. Mutation
failure must be an assertion of domain behaviour, not merely a crash or schema rejection.

Remaining limits for the next review: no live model quality/business pilot in this gate; public expectations
are association only; private MTProto historical catchup is not implemented/proven; admission estimates
cannot cap provider charges; public reasoning stages are still sequential; one material request per basis
has no automatic retry; same-case material history is bounded to 50 versions; process ownership is local
SQLite/single-host rather than distributed fencing. Social publication/contact capabilities are absent.

The next useful step is an adversarial review of this exact branch, followed by one owner-configured
read-only pilot with a real goal/source. New outbound/platform adapters should wait until that scenario
proves material usefulness and day-two continuity with these boundaries intact.
