# Discovery Astra Convergence Plan v1

- **Status:** plan-only; no Astra, production, UI, evaluation, or runtime changes
- **Baseline:** `main@23195c2c2bd0ce45142264999dc668cf9fef3d9d`
- **Plan branch:** `codex/discovery-astra-convergence-plan-v1`
- **Scope:** requirements, semantic mapping, and migration gates only
- **Explicit non-goal:** do not merge or cherry-pick the Astra implementation branch

## 1. Purpose

The Astra branch contains a valuable intelligence layer: hypotheses, `WHY NOW`,
reasoning states, review presentation, evaluation, and learning candidates. The
main branch now contains a durable Discovery boundary whose safety properties
must not regress.

This plan defines how the two ideas can be compared and, only after separate
approval, transferred into new implementation slices. It does not decide that
Astra is correct, complete, or ready for production.

## 2. Source-of-truth rule

`main@23195c2` is the canonical product baseline. The Astra branch is a donor of
ideas and semantics only.

- No Astra commit is merged or cherry-picked into `main` by this plan.
- No Astra state, table, prompt, UI, or evaluation artifact is copied implicitly.
- Every candidate component is classified explicitly as `reuse`, `adapt`,
  `reject`, or `owner decision` in the conflict matrix below.
- Existing main invariants win when an Astra behavior conflicts with them.
- Every later implementation slice gets its own branch, review, and acceptance
  gate. Passing this plan is not implementation approval.

## 3. Fixed baseline and evidence

The baseline is already merged and frozen:

```text
main = 23195c2c2bd0ce45142264999dc668cf9fef3d9d
```

Verified on the baseline before this plan:

- convergence gate: `14/14`
- full Node regression: `505/505`
- Python credential/failover: `8/8`
- build: `65 JavaScript/JSON files`, `9 Python files`
- `git diff --check`: clean
- worktrees: clean

No model, Hermes runtime, Telegram transport, or live delivery was executed.

## 4. Boundaries that Astra must preserve

The following are non-negotiable properties of the baseline. They are not
features to redesign during convergence.

| Boundary | Required property |
|---|---|
| Evidence | source truth is durable; stale, edited, deleted, revoked, or superseded evidence cannot silently revive |
| Provenance | offer and purpose basis are fixed at intake; old evidence is not reinterpreted under a later basis |
| Authority | Discovery creates no person, conversation, permission, draft, approval, delivery, or outbound effect |
| Transfer | exact author binding, person/conversation, real inbound, and typed reply grant are required |
| Engagement | transfer reuses a suitable live Engagement or opens the ordinary Persistent Engagement boundary |
| Human review | the model proposes; an operator authorizes; a stale review may be rejected but not approved |
| Recovery | reconciliation and maintenance are bounded, idempotent, restart-safe, and fairly progressive |
| Evaluation | synthetic evaluation is not live proof and never changes runtime authority automatically |
| Learning | a lesson is a candidate; it does not silently become a strategy |
| UI | review presentation cannot imply contact permission or hide a stale/revoked reason |

## 5. Proof levels

Every proposed acceptance claim must state its proof level.

| Level | Meaning | Allowed claim |
|---|---|---|
| `synthetic` | deterministic offline fixture or unit contract | “the boundary behaves this way in the fixture” |
| `integration` | several real business components wired together without live transport | “the components preserve this durable transition” |
| `live_proof=false` | planned, simulated, or not yet executed in production | “not yet proven in live operation” |

No plan or evaluation report may call a result `live proof`, business impact,
conversion, or effectiveness evidence unless a separate owner-approved live
review exists. Synthetic and integration results must not be used to authorize
sends, permissions, or runtime policy.

## 6. Astra component decomposition

### 6.1 Hypothesis and `WHY NOW`

**Purpose:** describe a bounded opportunity and why it deserves attention now.

**Required semantics:**

- separate observed fact, attributed claim, hypothesis, and inference;
- keep `WHY NOW` tied to durable evidence and current source state;
- represent uncertainty explicitly rather than manufacturing certainty;
- never convert a hypothesis into consent, permission, or a contact decision.

**Convergence questions:**

- Which fields are durable observations versus model proposals?
- How is freshness proven after restart or source revocation?
- What makes a hypothesis stale when new evidence arrives?
- Does the opening proposal remain a proposal until operator approval?

### 6.2 Reasoning contract: `WAIT`, `IGNORE`, `REVIEW`, `STOP`

**Purpose:** make the decision vocabulary explicit and testable.

| State | Meaning | May authorize contact? | Required evidence |
|---|---|---:|---|
| `WAIT` | a named future event or time is required | no | event, deadline, and current state |
| `IGNORE` | this signal is consumed without a new action | no | reason and bounded scope |
| `REVIEW` | an operator must inspect a proposal | no | current evidence, hypothesis, `WHY NOW`, proposed opening |
| `STOP` | the current matter is deliberately ended or suppressed | no | explicit operator decision and durable state |

`STOP` and `IGNORE` must not be conflated: one ends a matter, the other
consumes a signal. A model may propose a state; only the agreed human boundary
may authorize a state change.

### 6.3 Review UI

**Purpose:** make the reasoning legible without implying authority.

Required review-card content:

- current evidence and freshness;
- hypothesis, uncertainty, and `WHY NOW`;
- proposed next state and why it is not yet authorized;
- explicit statement that no contact permission or send was created;
- stale, revoked, superseded, or expired reason when applicable;
- operator actions and their exact scope.

The UI must never:

- render a draft, permission, or send as if Discovery created it;
- hide unknown delivery, ownership, or attendance state;
- allow a generic task action to execute a `discovery_review` card.

### 6.4 Evaluation corpus and scorer

**Purpose:** measure reasoning quality without granting authority.

The evaluation artifact may contain synthetic examples, labels, and scorer
criteria. It must be separate from runtime prompt, policy, permission, and
delivery state.

Every report must include:

```text
proof_level=synthetic|integration
live_proof=false
baseline_sha=<main sha>
```

A scorer may compare hypotheses or state transitions. It may not create a
person, grant permission, activate a lesson, or change a runtime decision.

### 6.5 Candidate lessons and learning

**Purpose:** preserve useful experience without silently changing behavior.

A lesson is a candidate with evidence links, applicability, limitations, and
`runtime_use=false`. Activation requires an explicit operator review and a
conversation-scoped strategy. Evaluation evidence is not runtime authority.

## 7. Conflict matrix

This is the required decision record before any implementation slice.

| Astra component | Baseline owner | Decision | Rationale | Minimum proof before code |
|---|---|---|---|---|
| Hypothesis object | Durable Discovery evidence | `adapt` | Preserve durable source truth; keep model hypothesis separate | synthetic provenance and freshness contract |
| `WHY NOW` | Freshness/staleness rules | `adapt` | Make timing explainable and restart-safe | integration test after edit, revoke, and restart |
| `WAIT` | Engagement waits and scheduler | `adapt` | Reuse durable wait semantics; never authorize contact | synthetic state transition matrix |
| `IGNORE` | Review/task consumption | `adapt` | Keep signal consumption distinct from stopping a matter | idempotency and replay contract |
| `REVIEW` | `discovery_review` and operator approval | `reuse` semantics / `adapt` presentation | Existing human gate is canonical | current convergence gate remains green |
| `STOP` | person suppression and engagement closure | `owner decision` | Final scope and side effects need owner policy | explicit owner decision recorded first |
| Review UI | `public/app.js` queue boundary | `adapt` | Add visibility without implying permission | static UI contract plus integration fixture |
| Evaluation corpus/scorer | No runtime authority | `reject` as runtime input; `adapt` as offline evidence | Synthetic quality is not live proof or policy | `live_proof=false` report schema |
| Lessons/learning | candidate lessons and operator review | `adapt` | Preserve candidate-only status and evidence links | no automatic strategy mutation |
| Astra persistence/tables | main Durable Discovery schema | `reject` initially | Avoid competing `discovery_situations` state machines | owner-approved schema decision if ever needed |
| Astra prompt/runtime wiring | Hermes/runtime boundary | `owner decision` | Model calls, credentials, and live behavior are out of scope | explicit rollout approval |

## 8. Migration order and gates

Each stage is a separate reviewable slice. A later stage does not start merely
because an earlier stage was implemented.

### Stage 0 — Freeze and inventory

- Keep `main@23195c2` frozen.
- Record the current gate results and baseline SHA.
- Inventory Astra components and classify each row in the conflict matrix.

**Exit gate:** Dev review of the inventory; no code change.

### Stage 1 — Hypothesis and `WHY NOW` contract

- Define durable fields and freshness/staleness transitions.
- Keep model proposals separate from source truth.
- Write black-box acceptance tests before implementation.

**Exit gate:** provenance, restart, edit, delete, and revoke tests pass; no
contact effect exists.

### Stage 2 — Reasoning contract

- Specify `WAIT`, `IGNORE`, `REVIEW`, and `STOP` transitions.
- Define operator-only state changes and idempotent replay.
- Decide `STOP` versus `IGNORE` with the owner before coding `STOP`.

**Exit gate:** state transition matrix, replay contract, and existing main
regression all green.

### Stage 3 — Review presentation

- Define card fields, stale/revoked reasons, and no-permission wording.
- Keep generic task execution excluded from review cards.
- Prove UI state from durable database fixtures, not screenshots alone.

**Exit gate:** UI contract and integration fixture reviewed; no live transport.

### Stage 4 — Evaluation

- Build synthetic corpus and scorer in a separate evaluation boundary.
- Add proof-level metadata and baseline SHA to every report.
- Prove that evaluation cannot mutate runtime authority.

**Exit gate:** `live_proof=false` is machine-checkable; no runtime diff.

### Stage 5 — Candidate learning

- Define evidence-linked lessons and operator review.
- Prove lessons remain `runtime_use=false` until explicitly activated.
- Prove counterexamples and limitations survive review.

**Exit gate:** candidate-only learning contract and regression coverage.

### Stage 6 — Implementation and rollout decision

Only after Stages 0–5 are reviewed may the owner authorize a separate
implementation branch. That decision must specify model/runtime enablement,
credentials, telemetry, retention, rollback, and live-send authority separately.

## 9. Acceptance and rollback rules

For every future slice:

1. State the baseline SHA and the exact conflict-matrix row being implemented.
2. Add the smallest black-box acceptance test first.
3. Run the isolated convergence gate before the full regression suite.
4. Keep `main` frozen until the slice has its own review.
5. Preserve source truth, approvals, suppression, ownership, and unknown state.
6. Record proof level for every result.

Rollback is branch-local until a later owner decision:

- drop or revert the feature branch;
- keep the merged baseline untouched;
- remove no durable baseline data;
- do not use a failed Astra experiment to justify live sending.

A red gate is a stop signal, not permission to weaken the invariant.

## 10. Owner-only decisions before code

The following remain undecided and must not be inferred by the plan:

- exact retention and physical-cleanup window for derived Discovery data;
- final `STOP` versus `IGNORE` semantics and side effects;
- exactly which operator confirmation is required for each `REVIEW` action;
- which source, evidence, and uncertainty fields may appear in a review card;
- model/runtime enablement, credentials, budget, and live-send authority;
- whether Astra persistence is ever needed beyond the canonical main schema.

## 11. Definition of done for this plan

This artifact is done when:

- the source-of-truth rule is explicit;
- every Astra component has a `reuse`/`adapt`/`reject`/`owner decision` row;
- proof levels are defined and cannot be confused with live proof;
- migration stages have separate exit gates;
- owner-only decisions are listed and unresolved;
- the branch contains only this markdown file;
- Dev has reviewed the plan;
- no production, Astra, UI, evaluation, test, model, or runtime change exists.

Until the owner approves a later implementation stage, this plan is the only
permitted Astra-related change.
