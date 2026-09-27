# Partner Continuity v1 — persistent work, not another channel

Baseline: `b2606526aa8fb074b1eff157df89938832a3fda0`.
Branch: `codex/partner-continuity-v1`. Scope authorized by the owner on 2026-09-27.

## Architectural decision

The next missing unit is a **working question that outlives a source snapshot**.
Discovery owns a bounded public situation; Engagement owns a permitted conversation.
Neither owns the partner's continuing investigation across allowed sources. The daily
planner sees tasks and contacts, but has no evidence-backed record of what an ongoing
question has learned, what remains uncertain, or why it needs attention again.

Continuity owns that record. Example: “Understand whether the offer's time requirements
fit the questions we keep receiving.” A configured web page and a public Telegram
source can inform that question without asserting that their authors are one person.

```
operator objective + explicit source scope
  → durable watch cursors → bounded observation window
  → coalesced attention (change / source health / deadline)
  → current evidence + prior understanding + unresolved questions
  → no-tool model proposal → operator review
  → versioned understanding + next observation condition → repeat
```

This is a business layer over SQLite, the existing Scheduler, source ingestion,
and the existing no-tool Hermes adapter. It is not a replacement for Discovery,
Engagement, source checkpoints, approval, or delivery. It never consumes or creates
Discovery/Opportunity approvals. No inferred cross-channel identity is introduced.

## Reuse decision before implementation

Reviewed [LangGraph persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx),
[Graphiti](https://github.com/getzep/graphiti), and
[SQLite transactions](https://www.sqlite.org/lang_transaction.html).
LangGraph supplies execution checkpoints; Graphiti supplies temporal graph memory.
Our immediate gap is the product contract for authorized working questions and
evidence-dependent interpretations. Adding another execution engine or graph store
would not define that contract. Reuse the installed SQLite transactions/FKs,
existing event log, Scheduler, AJV, Hermes no-tool worker and export/import instead.
No new transport, parser, queue framework, vector store, or dependency is needed.

## Invariants fixed before code

1. Only the operator creates a thread, sets its objective/success condition, selects
   sources, pauses/closes it, or accepts an interpretation. Source text cannot do so.
2. Watches start at the current source watermark. Earlier evidence is included only
   by explicit operator-selected event IDs; it is labelled historical context.
3. Source events remain canonical and immutable. Continuity stores references and
   a bounded recent window; its own cursor advances atomically with its projection.
   It never advances transport/Discovery/Opportunity cursors.
4. Quotes mean “this source said this”. Hypotheses, counterevidence and unknowns
   remain separate. Reviewed interpretation is still unverified interpretation.
5. A reasoning packet binds objective revision, source scope, observed versions,
   current source health and the accepted memory version. Pending unprocessed source
   changes, edit/delete, revoke, expiry and policy/basis changes invalidate its use.
   Restart rechecks those dependencies using the transport's actual contract.
   Reads do not repair state or grant authority.
6. Revocation observed by maintenance is terminal for that watch. Reallow does not
   revive it. Mission/offer changes pause the old thread; accepting a new basis
   requires a new thread. A temporary reconnect can only restore unchanged evidence.
7. Old memory remains auditable but stale dependent text is withheld from new model
   context. Missing/expired/revoked evidence is an unknown, not a conclusion.
8. One pending need for attention per thread; event bursts coalesce. Quiet ticks,
   repeated pages, receipts, and restarts do not manufacture new decisions.
9. Reconciliation has bounded thread/watch/event pages and durable fair cursors.
   One busy or unavailable source must not starve other questions.
10. Model output is a proposal only. Acceptance may update this thread's understanding,
    ask its owner a question, set a future attention time, or close this work item.
    It never creates contact permission, person, conversation, draft, send, identity,
    confirmed fact, lesson activation, or Engagement ownership change.
11. New inference is separately opt-in, uses no tools and shares existing run/cost
    accounting. A failed/interrupted attempt is not retried just because a tick ran.
    Capture and completion both recheck the evidence basis; provider failure text is
    not persisted. Startup recovers interrupted attempts without silently re-billing.
12. All new durable data participates in export/import; older bundles still restore.

## Boundaries and deliberate limits

Source association is explicit, not keyword relevance or fuzzy person matching.
The model reasons about relevance, contradictions and useful next questions; code
checks references, freshness, budgets, scopes and allowed state changes. No sales
script or scoring heuristic chooses the semantic conclusion.

A working question is not a new kind of contact consent or a global truth graph.
Accepted memory is local to that question. A proposed owner question is not a sent
message. Closing a question is not a recorded business conversion or person STOP.

The observation window is bounded; durable source history and reasoning episodes
remain in the canonical database. This slice does not change source retention or
the baseline's source capacity. Large deployments still require a separate capacity/
retention decision. No learning activation or self-modifying policy is added.

## Validation

`proof_level=integration` with synthetic inputs; `live_proof=false` for this new layer.
The browser's prior live smoke is not proof of this layer's cognitive quality.

Final verification on the implementation based on `b260652`:

| Check | Result |
|---|---|
| `node --test tests/continuity.test.mjs tests/discovery-convergence-gate.test.mjs` | 39 passed: 25 continuity acceptance tests plus 14 convergence tests |
| `node --test tests/discovery-convergence-gate.test.mjs` | 14 passed independently; gate file unchanged |
| `npm test` | 782 passed; 0 failed, cancelled or skipped |
| `npm run test:credentials` | 15 passed |
| `npm run build` | 101 JavaScript/JSON and 9 Python files compiled |
| `git diff --check` and staged equivalent | Clean |

The acceptance suite upgrades a real schema-4 SQLite database to schema 5 and
checks preservation of the old rows and foreign-key integrity. It also exercises
export/restore separately. Model responses are test doubles; no provider calls,
live Telegram/browser reads, or sends were made for this layer. Feature and model
flags remain disabled by default. Production/local data and configuration were
not changed. Verification logs are local ignored artifacts under `.cache/continuity/`.

## What was implemented

- `ContinuityLoop`: enroll a question, bounded source projection, accepted memory,
  current decision packet, coalesced attention, capture/propose/review, owner input,
  pause/resume/close. Evidence is revalidated even before reconciliation catches up.
- Scheduler integration: bounded maintenance every tick; optional no-tool reasoning
  for one eligible question per tick. A projection/reasoning failure is exposed in
  `scheduler.continuity` and does not prevent the existing source pipeline running.
- Reused `HermesAdapter.decide` and its existing worker with a small question-level
  reasoning prompt and strict AJV output contract. No new SDK, tools or provider path.
- Four additive tables in migration 005, existing immutable audit events and existing
  channel-offset storage for fair sweep/reasoning cursors. An expression index supports
  source-watermark queries. Old migrations and source/transport code are unchanged.
- Authenticated operator HTTP API and existing command receipts. No UI redesign.
- Export/import of threads, references, accepted turns and cursors; schema 2/3/4
  bundles remain accepted with empty new tables. No active database was migrated here.

`runs.model` remains the configured model name. A served model identity is recorded
only when the existing worker returns a valid `model_identity`; otherwise it stays
null with an explicit reason. Prompt and contract fingerprints, producer, packet,
proposal, operator review, run and usage remain distinct attribution records.
None of them claims a business outcome or model effectiveness.

### Memory and freshness details

The working window keeps eight latest items per source, with at most four explicit
sources per question. Its incompleteness and text truncation are exposed in the
packet. Accepted understanding may retain up to 32 distinct supporting event IDs
outside that window. Still-current support is supplied separately as `memory_evidence`
so the model can actually cite it again; a summary alone is never evidence.

Source age for Telegram and fixture signals uses the original intake timestamp.
A browser document can remain useful after an unchanged re-read: a current browser
checkpoint confirms its existing version, and its confirmation time controls that
reference's age. This does not insert a new observation, modify the source event, or
claim a new public signal. Browser receipt TTL is still enforced by the shared
transport boundary. Unlike a Telegram stream, a recent stateless HTTP receipt is not
invalid merely because the process restarted. After expiry it requires a real new
confirmation. No transport semantics were changed for Continuity.

`memory.current` means its cited support is currently usable for this working
question; it never means independently verified truth. Contradictions in new evidence
are deliberately a reasoning question for the model/operator. If a cited dependency
is stale, **the entire accepted interpretation is withheld** from new model context
until a new reviewed interpretation replaces it. The original episode remains
available to the authenticated owner for audit. This conservative v1 rule avoids
laundering unsupported memory; finer per-claim invalidation can be evaluated later.

Owner notes are separately labelled guidance, never source facts or permission.
The five most recent notes are presented, with that bound declared. All notes remain
in the event log. Changing objective/success criteria requires a new work item; a
note does not silently rewrite the original mandate.

### Progress, budgets and failure

There can be at most 100 non-closed questions. A default sweep visits ten questions,
at most four watches each and twenty source events per watch. Caller limits are
validated (maximum twenty questions/fifty events per watch). Projection writes and
its cursor advance share one transaction. Round-robin cursors are durable, including
when the first question has a hot source or a source is unavailable.

One attempt is allowed per question revision. Bursts, source-state changes and owner
input update one pending attention record. A deadline fires once; quiet ticks do not
renew it. An existing capture or pending proposal blocks another attempt. The no-tool
model does not approve its proposal. Rejection acknowledges only the unchanged basis;
it cannot consume a new, not-yet-projected observation or expiry. A stale proposal
can be rejected but cannot be accepted.

Model failures, invalid output and interrupted attempts do not retry on their own.
The owner can provide a new note or explicitly pause/resume to request reconsideration.
Real new observations can also create a new revision. All inference shares the
existing `runs` daily count/cost limit; unknown cost is not free. This is the baseline's
accounting gate, not a new hard provider spending cap. A call already in flight may
still incur cost after pause/close; its result must pass completion checks and cannot
be accepted against a changed basis.

Provider exception text, invalid raw output and tool transcripts are not stored.
A failure while writing the proposal rolls back the whole result transaction and
marks the attempt interrupted where the database permits it; restart is the fallback.

## Operator API / runbook

Defaults are `continuity.enabled=false` and `continuity.modelEnabled=false`.
For deterministic observation and manual review, set only `continuity.enabled=true`
in the feature checkout's local configuration. Existing authorized sources and their
read-only setup remain prerequisites. This implementation did not change local
configuration, enable credentials, or connect to live sources.

Separately setting `continuity.modelEnabled=true` authorizes automatic no-tool
reasoning on the enrolled open questions, subject to existing model readiness/budget.
The existing read-only boundary still requires `opportunity.automatic=true`,
`runtime.enabled=false` and `telegram.liveSending=false`. The independent existing
Opportunity pipeline keeps its previous behavior. Never set modelEnabled merely to
view the new state. No model is needed for any manual command below.

Use the existing local operator session/token and `POST /api/commands` envelope:

```json
{
  "request_id": "a-new-unique-request-id",
  "action": "continuity.open",
  "payload": {
    "title": "Understand the time requirement",
    "objective": "Compare stated requirements with the public questions we receive.",
    "success_condition": "The owner can see current support, contradictions and unknowns.",
    "source_ids": ["browser:configured-offer", "telegram:channel:123"],
    "max_age_seconds": 604800
  }
}
```

Source IDs must already be authorized; this command cannot add a URL or join a chat.
By default only later source events enter the window. Optional
`initial_evidence_event_ids` explicitly selects current historical context (at most
eight per source); an overfull selection is rejected, not silently truncated.

| Route/command | Contract |
|---|---|
| `GET /api/continuity/threads?limit=20&cursor=<id>` | Bounded list, feature flags and available source references |
| `GET /api/continuity/threads/<id>` | Goal, evidence, retained support, memory, attention, latest turn, current basis fingerprint |
| `GET /api/continuity/turns/<id>` | Original timestamped packet, proposal/producer/review, current `reviewable` verdict |
| `continuity.capture` | `thread_id`, `expected_revision`, `expected_basis_fingerprint`; returns `turn_id` |
| `continuity.propose` | `turn_id`, `output` matching `contracts/continuity-proposal.schema.json`; operator-recorded proposal |
| `continuity.review` | `turn_id`, `expected_basis_fingerprint`, `decision: accept/reject`, `note` |
| `continuity.note` | `thread_id`, `expected_revision`, `text`; owner clarification and new attention |
| `continuity.pause/resume/close` | `thread_id`, `expected_revision`, `reason` |

When optional inference is enabled, Scheduler captures and proposes itself; only
review remains manual. An `ask_owner` proposal is visible in the accepted
interpretation; answer it with `continuity.note`. An accepted `observe` may set a
future ISO timestamp. An accepted `close` closes this question only. Commands are
operator-only and not added to MCP or agent tools.

The original packet's `ready` flag is a historical snapshot, not current approval
authority. Use the turn's current `reviewable` field and the command's mandatory
server revalidation. No read result authorizes contact.

## Review targets for GLM

The acceptance suite includes a real child-process crash, SQLite rollback faults,
the actual Scheduler and HTTP composition, source changes during a fake model call,
both transport adapters with synthetic data, TTL/revoke/offer changes, strict output
rejection, retained evidence outside the window, and export/restore. Existing gates
run unchanged except version-count/legacy-bundle fixtures needed for migration 005
and Store's deliberate hash pin (table export plus interrupted-turn recovery).

Particularly useful adversarial extensions:

- semantic memory laundering despite structurally valid citations;
- relevant evidence lost by the bounded recent window before interpretation;
- very noisy sources causing new revisions and exhausting the shared inference budget;
- source authorization changed and restored between maintenance observations;
- an owner accepting a plausible but incorrect conclusion;
- real provider refusals, malformed JSON and partial/incomplete browser content.

The implementation does not prove reasoning quality, prompt-injection immunity,
business impact, or unrestricted long-term scale. It adds an inspectable durable
loop on which those can be evaluated. Live cognition was not exercised here.
