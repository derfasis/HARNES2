# Normalization integration verification

Base: current `origin/main` at
`fd75edaf74c78562e0b309f7b4bc1d6a1f0ba030`, re-fetched after verification.
Branch: `codex/telegram-normalization-main`.
Original normalization: `2fd75216f53e3206abd83ad8f5fa8211c2340ff7`, replayed
as `a59b533` on main without conflicts. The final context adjustment and this
report are committed together above that replay.

## Main changes retained

| Commit | Retained change |
| --- | --- |
| `58c138e` | Operator opportunity dashboard/review and stale-approval checks |
| `a733378` | Explicit read-only joined Telegram reader |
| `e5cacfd` | Required real local accessHash and exact peer-RPC hash checks |
| `85ddd0e` | Fitness/wellness partnership offer |
| `fd75eda` | GitHub-first engineering guidance |

All 15 files changed on main outside the overlapping Telegram test file were
compared with `origin/main` and are identical, including the transport fence,
joined-reader factory, reader membership/hash revalidation, service, server,
operator-review implementation, UI, configuration-independent offer and guidance.
All main Telegram test additions were retained and passed in the combined suite.

The approved semantic bridge, mapper, durable Telegram ingest and opportunity
pipeline match `2fd7521` exactly. The only further production adjustment is
context selection in `business/source-ingestion.mjs`. No dependency/schema,
runtime configuration, checkpoint reset, auto recovery or sending change was made.

## Context policy verified

The current anchor and its known explicit reply ancestry are mandatory. An
opaque anchor or ancestor still prevents inference. Supplemental author/topic
history excludes opaque items and replies depending on them; neither becomes
synthetic text or evidence. Missing/cross-peer references remain unresolved.

Eight source regressions cover old same-author media across restart, same-topic
media and dependent replies, opaque anchors/direct/transitive ancestry, required
opaque ancestry beyond the inclusion depth, required evidence becoming opaque,
optional evidence becoming opaque, changes to excluded media versus restoration
to text, and unresolved cross-peer links. Existing snapshot/receipt/freshness
tests remain active.

An additional combined regression uses the actual joined-reader factory with a
synthetic SDK transport: exact hash lookup -> opaque photo and dependent reply ->
independent formatted text -> one operator review -> non-executable approval ->
opaque edit makes approval stale -> another independent question -> restart ->
changed peer hash blocks further progress without changing the checkpoint.
RPC captures verify exact hashes and absence of dialog/username fallback.

## Complete verification result

| Command | Result |
| --- | --- |
| `npm test` | **388 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo** |
| `npm run test:credentials` | **8 Python tests passed**, unittest `OK` |
| `npm run build` | **Passed**: 55 JavaScript/JSON files and 9 Python files compiled |
| `git diff --check` | **Passed** |
| `git merge-base --is-ancestor origin/main HEAD` | **Passed** on the freshly fetched `fd75eda` base |

The integrated baseline before the context adjustment passed 379/379 Node tests;
the final full suite includes all nine added regressions. Tests use isolated
SQLite stores and synthetic transport/provider implementations. No live Telegram
or external model calls were made. The existing raw-ingress, PTS, reconciliation,
rollback/ACK, ownership, accessHash, membership, serialized sender fence, operator
approval and stale-evidence regressions are included in the full Node result.

Verification ran in an isolated worktree with the existing pinned dependencies.
The five pre-existing CLIProxyAPI edits in the original workspace were checked
against their backup hashes and remain byte-for-byte intact, outside this branch.
