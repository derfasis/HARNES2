# Opportunity Projection v0 integration checkpoint

## Commits and base

- Opportunity checkpoint: `2a885506ae0752d6b77ff05ed5edd01c72da4b6f`.
- Frozen Situation Router reference: `a6d5cad`.
- Latest local main: `7754ca8144630c73284d4502e73272ffe6c262b9`.
- origin/main after successful fetch: `22018cc82f9a7f5872d4697d3980bab60a736a81`.
- main is three commits ahead of origin/main and an ancestor of a6d5cad.
  All of main's commits were already present in the checkpoint.
- `git rebase main` returned "Current branch ... is up to date". No conflicts
  occurred and no conflict resolution or history rewriting was required.
- main was not modified; no merge, push or additional model run was performed.

The premise that this checkout's main is newer than a6d5cad was not confirmed.
Rebasing only the Opportunity commit onto main while dropping the Router
commits would remove its required real Router: main does not yet contain v1.
The final main-relative diff therefore includes the existing Router branch
prerequisites, not just Opportunity's 321-line production checkpoint.

## Local regression

There was no committed general regression suite or npm test command on main.
This checkpoint adds an offline suite for the actual HARNES2 business APIs,
not Astra's separate Opportunity store. Full local commands are:

```powershell
npm test
npm run test:credentials
npm run build
```

- Node: 44/44 pass, zero failures, cancellations or skips.
  This includes 17 Opportunity checks and 27 HARNES2 regression checks.
- Python: 5/5 pass against the real Hermes credential pool adapter.
- Build: 36 JavaScript/JSON files and 6 Python files compile successfully.
- Scope: store migrations/rollback/idempotency; inbound deduplication;
  versioned approvals and stale context; suppression and human takeover;
  recovery of unknown delivery; manual receipts versus attendance;
  fact/lesson provenance and isolation; bounded Conversation Brain context;
  tool scopes and stale runs; task review; runtime-disabled queue and unknown
  cost gating; a stubbed worker result; disabled Bot API/MTProto transports;
  credential isolation, healthy-key stability and same-provider failover;
  exports; five tracked frozen Router fixture contexts; Projection isolation.

Test databases use only the existing Store in per-test temporary directories;
they are not a new Opportunity DB. No active business DB is opened.
Node external fetch/socket/child spawning and Python socket connects are
fail-fast guarded. The adapter test substitutes a fake child, and scheduler
tests use stub results, not the actual model worker. No .env is loaded.
Network guards reported zero external attempts. Temporary data is removed.

This is the full current project-local suite, not exhaustive coverage of every
API or a rerun of Hermes upstream tests. UI, live providers and real Telegram
delivery remain deliberately untested. The model smoke result remains the
previous two cases; neither it nor the frozen six-case model control was rerun.

## Integration boundaries

- `git diff a6d5cad -- business/situation-router.mjs
  contracts/situation-router.schema.json benchmarks/situation-router
  scripts/situation_router_worker.py` is empty. Frozen v1 is unchanged.
- Against main, the v1 schema is an addition, not a modification: it did not
  exist there. Opportunity next_action still references its unchanged output.
- service, context, scheduler, channels, tools, store, business migrations,
  Hermes runner and Conversation Brain benchmark/worker files match main.
- Runtime and credential adapter differ from main only by the pre-existing
  tertiary-key support from `b2b75eb`; integration did not change those files.
- Projection has no business tool, consumer, executor or approval command.
  Parsing a valid positive projection changes no business tables and creates
  no AUTOPILOT candidate, even in an existing permitted AUTOPILOT conversation.
- Model output cannot raise contact_permission, allowed_effects, approval or
  recipient authority. Forged grants and private drafts are rejected.
- Existing HARNES2 delivery/AUTOPILOT capabilities were not removed, expanded
  or connected to Projection. Opportunity's allowed_effects remains empty.
- Local effective settings remain runtime.enabled false, telegram.enabled
  false and telegram.liveSending false. They were not changed for regression.
