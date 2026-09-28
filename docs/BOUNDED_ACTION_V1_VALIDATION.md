# Bounded Action v1 — verification handoff

Base: `12dc7f8d50a6a6a76cd9c8a7f715c2b22d38b218`.
Implementation branch: `codex/bounded-action-v1`.

The owner-reported baseline gate was **846 Node + 15 Python + build PASS** for
`168179b`, whose tree matches this merged base. That result does **not** certify
the new Action implementation.

The latest user-provided AGENTS.md instruction prohibits running tests or contacting
models, while allowing `npm run build`. Therefore no functional, regression, UI,
live or model test was run for this implementation. Tests below are authored
acceptance cases, **not passing results**. Syntax compilation and `git diff --check`
are the performed checks; their exact final results are reported in the handoff.
The branch is an implementation candidate awaiting verification and red-team, not
a new approved safe baseline.

Build result: **PASS — 120 JavaScript/JSON files and 9 Python files syntax compiled**.
`git diff --check`: **PASS**. Functional tests and model calls: **not run**.

## Added acceptance coverage

`tests/actions.test.mjs` uses real BusinessService commands, temporary SQLite,
real local adapters, child-process crashes, staged import and actual local server
wiring. Fake models are confined to the existing no-tool runtime boundary.

- No grant → no attempt; exact hash/revision/expiry, actor and partner scope.
- Duplicate request/proposal and concurrent runtime ownership.
- Edit/delete/source revoke, owner note/pause, ageing, feature disable/restart.
- Read-only runtime/Telegram fence parity despite an earlier grant.
- Receipt separated from actual file/task observation.
- Existing mismatching file, vault junction, absent/unavailable distinction.
- Crash before/after effect, no replay, explicit absence-based retry.
- Receipt transaction failure, fallback persistence outage, verifier receipt failure.
- In-flight revoke, continuing observation, late physical result with retired grant.
- Persistent bounded maintenance/execution cursors and queue fairness.
- Human-only work excluded from generic commands and model context.
- Acknowledgement/resolution distinct from verified business success.
- v6/v7 migration/transfer: no imported executable grants or artifact assumption.
- Authenticated server surface, action-only wake, shutdown drain.
- Optional model: proposal only, invalid/tool-bearing/stale result rejection,
  shared budget/unknown billing and usage accounting.

`tests/actions-ui.test.mjs` checks source escaping, refusal by default, frozen
review hash/revision, stale controls, current Continuity basis and artifact API use.

Existing migration/legacy-bundle assertions were advanced from schema 6 to 7.
The Store blob pin was updated only for Action tables and startup recovery; the
source/router/transport/Hermes pins and convergence assertions remain unchanged.
Those fixture adaptations have not been executed under the current instruction.

## Commands for the next authorized verification run

```powershell
node --test tests/actions.test.mjs tests/actions-ui.test.mjs
node --test tests/discovery-convergence-gate.test.mjs tests/continuity.test.mjs tests/executive.test.mjs tests/scheduler-decouple-kill.test.mjs
npm test
npm run test:credentials
npm run build
git diff --check
```

Priority red-team targets: actual NTFS hard-link/no-replace behavior; kill during
partial staging write and after final publication; DB unavailable through receipt
and fallback; revocation during filesystem I/O; source transport health latches;
timer phase starvation and shutdown drain; shared-directory misuse; imported
receipts without artifacts; stale probe versus newer grant; model result persistence
failure; API/UI agreement on historical verification versus current evidence.

Known limits: source changes conservatively require a new reviewed basis; .tmp
debris after process death is retained rather than broadly deleted; verification
is an observation at a timestamp, not a perpetual guarantee; no remote provider
effects or hosted model calls have been exercised. Do not merge or enable based
only on syntax compilation.
