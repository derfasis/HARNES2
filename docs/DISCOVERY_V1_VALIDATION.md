# Discovery v1 validation — 2026-09-24

Checked in `codex/discovery-intelligence-v1`, based on canonical main `7b5846e94915248b8628ec899643fdb2b308409b`, with candidate `0cde893...` explicitly cherry-picked as `4ef915742199fe82038d92e9db37cc78dd0e212f`. `origin/main` was fetched and confirmed unchanged at the canonical SHA before delivery.

| Check | Result |
|---|---|
| `npm test` | **479 passed, 0 failed, 0 skipped**, 0 cancelled |
| `node --test tests/discovery*.test.mjs` | **39 passed**, subset of the full 479 |
| `npm run test:engagement:isolated` | **49 passed**, additional dependency-limited invocation; not added to the 479 total |
| `npm run test:credentials` | **8 Python tests passed** |
| `npm run build` | **75 JavaScript/JSON + 9 Python files** syntax/asset checks passed |
| Discovery corpus validation / blind context export | **15 synthetic episodes, 31 checkpoints**; 10 positive, 15 negative, 2 uncertain, 4 insufficient-evidence |
| `git diff --check` | Passed |

Node v24.18.1, Windows; pinned installed dependencies. No live model request or Telegram access was used. New core tests prohibit network connections/fetch/child workers; HTTP tests only launch a disposable loopback server with scheduler/model/Telegram disabled. Manual delivery in an acceptance fixture is a simulated existing-business event, not an external send.

## Executed invariants

- Consecutive observations coalesce into one durable revision; WAIT/IGNORE survive restart and are not mistaken for successful opportunities. New evidence may lead to REVIEW using an injected deterministic response.
- Evidence spans/versions/source/author, exact offer version, authority, required ancestry and WHY NOW are checked. Fabrication, ungrounded opening, extra send fields and tool-shaped output are rejected. Busy authors have bounded optional history rather than a lifetime capacity veto.
- Old optional opaque content does not poison a later independent message. Required opaque/missing/deleted/cyclic ancestry cannot ground REVIEW. Edit/delete and in-flight changes invalidate decisions before another scheduler tick can authorize them.
- Catch-up retains analyzed output across restart; reconciliation with unchanged evidence finalizes without another inference. Integrity remains a hard block. Semantic change invalidates old output even while source transport is unavailable.
- Daily budgets, read-only fence, bounded retries, non-sliding batch deadline and expiry are exercised. No hidden live sending/model mode is enabled.
- Approval creates no permission, person, private message, verified fact or draft. Transfer needs exact current binding, real inbound and independent typed account/channel reply grant; suppression, foreign inbound, expired permission and human ownership reject transfer.
- Responsibility passes once to the existing Engagement. ACT, human draft edit, manual-delivery fixture and a linked observed outcome lead to a scoped Discovery assessment. Attribution is human_assisted where appropriate, never causal success by assumption.
- STOP/transfer/forget tombstones prevent rediscovery of that purpose after changed policy. Forget during inference removes derived context and ignores the late response while retaining cost accounting. Expiry also applies during standalone export.
- Later-created need cannot be labelled missed-existing-evidence. Reviewed lessons remain inactive candidates. Forget removes lesson/review prose, including its event copies.
- Prefix evaluation separates negative/uncertain/insufficient labels, counts missing/invalid positives against recall, measures detection delay and cannot score future evidence as earlier support.
- Export/import round-trips current Discovery rows and accepts checksum-verified 2/3/4/5 migration prefixes into new staging directories with valid foreign keys. Existing migration files remain unchanged.
- Authenticated API and escaped operator UI expose the journal without adding Discovery tools to the agent or send actions to its review screen.

Existing Telegram normalization, joined-source/accessHash, recovery, permissions, runtime isolation, Engagement and delivery regression suites are part of the full 479. Changes to old tests update only migration inventory expectations/legacy bundle construction, the Store inventory blob pin, and the explicit optional Discovery mock for the dependency-limited Engagement suite.

## Not proven

These tests establish state transitions and evidence/authority boundaries with deterministic model-shaped fixtures. They do **not** establish that a real model recognizes accumulated opportunities, interprets sarcasm/quoted intent correctly, proposes useful openings, or has acceptable recall on DDX. The corpus is small and hand-authored; gold answers are not independent live adjudication. Structural default evaluation therefore reports `precision:null`, `recall:null`, `model_quality_measured:false`, `live_proof:false`.

No causal business uplift, actual recipient response, legal/contact basis in real deployments, provider-side retention deletion or scale beyond the bounded pilot has been demonstrated. Source-ledger retention and backup deletion remain separate from derived Discovery forgetting. The operator list currently returns the latest 200 situations; a larger pilot will need pagination and operator-load measurement.

The original worktree's five pre-existing CLIProxy files were checked against their saved SHA-256 manifest: all unchanged. Its uncommitted work remains intact. Portable patch/archive manifests and detailed logs are delivered separately from tracked source so local secrets/data are excluded.
