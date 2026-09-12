# Opportunity Consumer / Review Pipeline v0

## Decision before implementation

The product gap is that the read-only Projection and frozen Router can describe
an opening, but nothing in the product retains their result for an operator.
The next slice is an operator-only, non-executable review task containing an
immutable reference to the public snapshot, active offer and validated result.
It is more useful now than another planner, collector or delivery adapter:
those would either duplicate Router semantics or expand live authority before
there is a reviewable consumer.

Reuse the existing Store, transaction/exclusive command path, command receipts,
events, task dedupe key, operator API/session and Tasks UI. Keep the Router,
Projection validators, Conversation Brain and credential adapters unchanged.
Add snapshot registration and result consumption as operator commands, a
read-only review detail endpoint, freshness checks, and non-execution guards.

New capability: HARNES2 can retain a validated Opportunity/Router result as a
source-backed operator review task, without granting contact or execution.

## Storage and trust

No new table or migration. Immutable `opportunity.snapshot` and
`opportunity.candidate` records live in existing `events`. A typed
`opportunity_review` row in existing `tasks` points to the candidate event.
It is not an executable job or a draft. Generic task approval/retry and the
scheduler must exclude this kind. Planning/Conversation Brain contexts must
not receive these review tasks or public source text as work instructions.
Only task cancellation is available. No candidate approval command exists.

The operator registers a latest-version public snapshot and imports the one
Router response computed for the returned context. This slice does not call a
model or invent one. Source rights and the active offer come from local
configuration, never a model response. Source text is untrusted data. Semantic
classification is still Router's responsibility, not a new keyword classifier.
Validation proves exact provenance and structural safety, not semantic truth.

The review contains the source-scoped author ID, not a guessed CRM person.
An optional operator-supplied conversation link is explicitly labelled an
operator assertion, not a verified cross-platform identity. Without it,
suppression and ownership are unknown and no contact is possible. With it,
suppression, ownership and conversation revision are checked on consumption
and every review read. Permission is never copied, created or inferred.

## Freshness and duplicates

Snapshot content hashes include ALL supplied messages, authors, versions,
ancestry, text and source identity, not just selected positive spans. The offer
hash covers its full text, criteria and exclusions, not merely its version.
Capture timestamps establish observation age, not message age or live access.
Every new registered snapshot for the same source invalidates previous capture
IDs conservatively, even if it concerns another thread. Identical content
recaptures reuse the latest capture. Message version rollback and changed
content under the same version are rejected against prior registered sources.

Deduplication binds partner, content, goal/channel policy and CRM link. Retries
return the original task even after dismissal, never create a new approval.
A genuine changed snapshot/offer creates a new key. Existing command receipts
retain historical responses; only the detail endpoint reports current freshness.

Fresh means consistent with the latest snapshot registered by the operator and
within the configured TTL, NOT proof that an external message has not changed.
No collector or external read is introduced. New input must be registered when
source content changes. A stale card stays visible with reasons and cannot run.

## Environment limitations

Implementation is being prepared locally from exact base
`d48a8498e74e6ff07dc720d682c132e0648717b3`. All 89 tracked blobs and the base tree
were hash-verified through public read tools. The local base commit object was
accepted only after its exact Git SHA matched. This is a shallow local checkout.

This environment has neither GitHub push tools/credentials nor network domains
available to Computer. Node baseline cannot load `ajv`; Python baseline cannot
load the pinned upstream Hermes `agent.credential_pool`. Package installation
is unavailable. Do not interpret authored tests or syntax checks as passing
regression. Until full real dependency tests and auditor branch publication
succeed, the merge recommendation is NOT READY.

## Operator workflow

Keep `runtime.enabled`, `telegram.enabled` and `telegram.liveSending` false.
Configure the existing local configuration file, not a model output:

```json
{
  "opportunity": {
    "allowedSourceRefs": ["fixture://opportunity-projection-v0"],
    "activeOffer": {
      "id": "synthetic-wellness-partnership",
      "version": "synthetic-v0",
      "text": "Информационное знакомство с форматом wellness-партнёрства, без обещаний дохода и свойств продуктов.",
      "criteria": ["Автор сам просит разобраться в формате wellness-партнёрства"],
      "exclusions": ["Не считать рекламу или чужие цитаты намерением автора", "Не использовать финансовую или медицинскую уязвимость"]
    },
    "goalText": "Assess usefulness of the active offer for operator review only.",
    "allowedChannels": ["public"],
    "maxAgeSeconds": 86400
  }
}
```

This is an invented example offer, not a factual product claim. A real source
requires a real processing allowance and actual observation timestamp. Do not
change timestamps on old real snapshots just to bypass freshness checks.

In the existing Tasks UI:

1. Import an Opportunity input JSON via **Импортировать snapshot**. Optional
   CRM linking is an operator assertion, never automatic identity matching.
2. Open **Контекст Router** for the saved capture. It contains the unchanged
   Projection instructions/schema plus the configured caller goal. No model
   call occurs when opening it. After restart the latest 20 captures remain
   accessible here; older captures can be retrieved by their ID.
3. Use one result produced for that exact context by the existing audited
   no-tool Router path, or a clearly labelled hand-authored offline fixture.
   The consumer neither starts the runtime nor proves a model produced JSON.
4. **Сохранить результат Router** validates that result against the registered
   source, unchanged Projection/Router contracts and current policy. The
   capture must still be current and within its observation TTL.
5. **Разобрать** opens the source-scoped author, optional asserted CRM link,
   offer, hypothesis, exact evidence/versions, contradictions, unknowns,
   Router proposal, coverage, freshness and dedupe identity. **Отменить** only
   dismisses the task. There is no approve/send/execute action.

The same workflow is available through the existing operator-token API:

- `POST /api/commands`: `opportunity.capture`, payload `{snapshot, conversation_id?}`.
- `GET /api/opportunity-captures/{capture_id}`: context and CURRENT freshness.
- `POST /api/commands`: `opportunity.consume`, payload `{capture_id, output}`.
- `GET /api/opportunities/{task_id}`: the complete CURRENT review package.
- Existing `task.cancel`: dismissal only.

Use the existing request ID and operator session mechanism. These commands
and detail endpoints are not exposed to MCP/agent/channel actors. A command
receipt is historical, so do not use a replayed receipt as proof of freshness.

## Explicit non-goals and limitations

No additional DB, Store, migration, scheduler, retry loop, outcome ledger,
approval system, collectors, CLI, replay framework, reviewer voting or second
semantic decision engine. No public author is automatically created as a CRM
contact. WAIT is retained for review, not scheduled; IGNORE remains auditable;
HANDOFF is an operator review card, not an external contact or ownership change.
PUBLIC_REPLY is a proposal inside JSON, never a `drafts` row. DM is rejected
entirely, preserving the public-only v0 boundary even if its text asks for DM.

Semantic evidence kinds and omitted contradictions are not machine-proven.
All outputs remain explicitly pending operator verification. The test responses
are invented model-shaped JSON, not observed model decisions. Model provenance,
automatic execution of a Router turn and real browser interaction tests are
outside the implemented path. No key or runtime configuration was enabled.

Expiry is intentionally terminal for an unchanged capture in v0: repeating
identical data does not renew the original observation age or resurrect a
cancelled candidate. A same-content explicit revalidation workflow is not yet
implemented. New snapshots conservatively invalidate all earlier captures for
the same source, rather than determining whether the changed thread matters.
Version checks scan existing JSON events and are suitable for a bounded pilot,
not a demonstrated high-throughput source ingestion system. Events retain
full snapshots; source retention/deletion policy remains operator-owned.

## Self-audit

- Avoided the tempting second source DB and durable approval subsystem. Task
  metadata references existing audit events; export/import already includes
  both tables. No schema/version change is needed.
- Integration hazard: normal `review` tasks can be approved into `pending`
  and scheduled. The dedicated, non-executable kind has explicit guards in
  generic task approval/retry and the scheduler, even for a corrupted pending
  row. This extends the existing task mechanism, not a parallel queue.
- Integration hazard: `contextFor` and `partner_list_work` expose proposed
  tasks to the model. Both now exclude this kind. Untrusted public source and
  generated proposal text never become executable task instructions.
- Reserved dedupe prefixes cannot be poisoned through ordinary task creation.
  Transaction rollback includes candidate record, task, command event and
  receipt. The first valid result wins for the same semantic identity.
- Exact spans and source author/version checks use the unchanged validators.
  Extra grants, approved review, changed recipients and DM fail validation.
  The consumer additionally rejects an active reply without a hypothesis.
- Full message/offer hashes and source-generation checks handle text changes
  beyond the selected positive evidence. CRM revision/suppression/ownership
  and source-policy revocation are rechecked on every read/consume.
- UI uses the existing escaping function for every source, output and JSON
  field. The read-only modal contains no approval or send controls.
- Kept the core module free of model, transport, browser and shell calls.
  No framework, hidden background work or billing was added.
- No existing production bug was patched outside these integration guards.

## Verification checkpoint

Observed locally on Node 24.16.0 / Python 3.14.6:

- Dependency-free UI/static/hash suite: 9 passed, 0 failed, 0 skipped.
  This includes escaping, task affordances, source guard assertions and
  exact base Git blob hashes for the frozen modules/assets.
- Build: 38 JavaScript/JSON and 6 Python files syntax-compiled successfully.
  A temporary ignored `.venv` was made with `python -m venv --without-pip`.
  This is syntax compilation, not a working Hermes installation.
- The full consumer integration suite is authored against the real HARNES2
  Store, service, validators and tools; it cannot load in this environment
  because `ajv` is absent. Existing Node suites have the same baseline failure.
- Python baseline: 5 errors, all because upstream `agent.credential_pool`
  from the pinned Hermes checkout is absent. It was not replaced with a fake.
- No dependencies were installed, validators replaced or tests skipped to
  manufacture a green report. Full regression is not certified.
- Model calls: 0. No model or actual provider credentials were configured.
- `npm run build` completed, but npm attempted a registry network request;
  `registry.npmjs.org:443` was denied by the environment allowlist. Subsequent
  checks use `node scripts/build.mjs` directly. There was no live outreach or
  successful registry access. Do not report zero outbound attempts.

Full logs and exact final command results accompany the delivery artifacts.
The code is a local, unverified integration candidate, not a shipped slice.

Final command results (these are module-loading failures, not green suites):

| Command | Observed result |
| --- | --- |
| `node --test 'tests/*.test.mjs'` | 9 passed; 3 test files failed to load `ajv`; 0 skipped |
| `python -m unittest discover -s tests -p 'test_*.py'` | 5 tests attempted; 5 missing-Hermes errors |
| `node --test 'tests/opportunity-consumer*.test.mjs'` | 9 passed; consumer integration file failed to load; 0 skipped |
| `node --test tests/opportunity-consumer-ui.test.mjs` | 9/9 passed; 0 skipped |
| `node scripts/build.mjs` | Exit 0; 38 JavaScript/JSON, 6 Python files |
| `git diff BASE --check` | Exit 0 |

All ten requested behavioural cases are represented in 23 authored consumer
integration tests. None of those 23 tests has executed successfully here;
module loading stops before registration. The nine successful tests are UI
rendering, static guards and exact-hash checks, not the ten-case acceptance
suite. No end-to-end candidate example can honestly be called observed yet.
