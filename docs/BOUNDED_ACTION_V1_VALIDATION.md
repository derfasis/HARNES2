# Bounded Action v1 — verification handoff

Base: `12dc7f8d50a6a6a76cd9c8a7f715c2b22d38b218`.
Implementation branch: `codex/bounded-action-v1`.

The owner has since changed the instruction in AGENTS.md. Verification tests are
authorized — local/offline suites, hosted CI, real model/API calls and live
read-only network, Telegram and Browser tests alike. What remains gated is
narrower and is not restated here loosely: production or customer sends, any
weakening of safety defaults, and real outbound messages or actions, each of which
needs its own explicit task-level authorization. The checks below are therefore
**performed results**, not authored intentions.

Baseline at the merged base was **846 Node + 15 Python + build PASS** for
`168179b`, whose tree matches this base. That result did **not** certify the new
Action implementation, and the first run over it found two defects in it.

## Verification result

`npm run verify` on `a524ecd`: **946 Node tests PASS, 0 fail**; **15 Python
tests PASS**; build **PASS — 121 JavaScript/JSON files and 9 Python files**.
`git diff --check`: **PASS**.

No model call, no live network, no Telegram. The two capabilities are local files
and durable tasks, and both are exercised for real; the model-facing paths are
covered by fakes confined to the existing no-tool runtime boundary.

### What the first real run found

Both defects were invisible to a static pass and to syntax compilation.

- A manual Verify could starve a retry for ever. `prepare` selected on
  `verify_requested` and took the latest attempt regardless of which grant it
  belonged to, so a probe aimed at a finished attempt repeated while the grant
  the owner was waiting on was never dispatched. The bit was cleared only on the
  one path that had stopped happening.
- A browser re-read could revive a revoked action. `proposalHash` hashed the
  whole evidence packet; a re-read of an unchanged page confirms the existing
  version rather than producing a new message, so `confirmed_at` moved, the hash
  moved with it, the duplicate check found nothing, and the exact action whose
  grant had been revoked could be proposed and granted again. Identity is now
  what the action says and what it rests on — source, message, version, text —
  and not when the evidence was last confirmed. Staleness keeps its own refusal
  and freshness its own gate.

`tests/actions-liveness-kill.test.mjs` covers both, plus the other half of the
identity rule: the hash must still change when the text changes. All four cases
fail on `fc95b93` and pass on `a524ecd`; that was checked by stashing the fixes
and re-running, not assumed.

A third defect was in a guard test rather than in the layer: the excluded-task-kind
assertion had stopped naming `owner_action`, and its count check shared one `/g`
regex with an `assert.match`, which reaches a global regex through `test()` and
advances `lastIndex` — so the count started mid-string and under-reported by one.

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
Those fixture adaptations ran with the rest of the suite and pass.

## Commands used for the verification run

```powershell
node --test tests/actions.test.mjs tests/actions-ui.test.mjs
node --test tests/actions-liveness-kill.test.mjs
npm run verify
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
is an observation at a timestamp, not a perpetual guarantee. This run was offline
and did not exercise a real provider, a real model, or a live network path; those
paths are permitted by AGENTS.md and were simply not part of this run. Real
outbound effects remain separately gated.
