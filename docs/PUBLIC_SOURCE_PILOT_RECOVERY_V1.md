# Public source pilot: durable authority and native recovery

This increment follows Source Scout at `291f61f549fb5d09957c6e56b0fc12e7aecedd5e` on a separate pilot branch. It does not merge canonical main, replace the Workspace/Continuity contracts, or enable Telegram, models, joining, or sending in tracked configuration.

## Actual failure and correction

The first native fitness pilot connected and established current source checkpoints, but its goal watches had already been permanently revoked during startup. `server.start()` reconciles Discovery and Continuity before Telegram verifies its account. The effective source configuration previously called `monitorPolicies()`, whose connection/process fences returned an empty list. A temporary absence of transport therefore looked like removed owner authority.

`SourceScout.monitorAuthorityPolicies()` now projects the durable owner decision independently of transport readiness. It requires the correct partner, active valid campaign/config hash and revision, exact candidate/campaign/account reference, joined admission evidence, an unexpired monitor grant, valid native identity and policy fields, no static-policy overlap, and unambiguous channel authority across accounts. Checkpoints are partner/channel scoped; account filtering must not conceal another valid grant for the same channel. New cross-account admission is refused, and legacy ambiguity withholds the source without rewriting grants or poisoning an unrelated source.

`monitorPolicies()` remains the executable view: it additionally requires enabled Scout, current process ownership and the matching verified account. Reader registry construction uses that view. Disabled Scout does not select dynamic readers for polling, and the native source policy itself refuses dynamic execution while disabled. Pure authority visibility cannot grant an SDK read or ingest.

Live-snapshot freshness independently requires the matching verified native account, a registered healthy reader, a valid current policy/checkpoint, account read-gate health and a recent successful confirmation. A persisted timestamp or a missing reader is insufficient. Sanitized-fixture semantics remain unchanged. The reader observes lost ownership even when another readiness fence fails; regaining ownership does not resurrect its earlier confirmation.

## Native resource and recovery fences

The existing GramJS connection, semantic mapping, native public reader and transactional ingest remain in use. No new parser, client library, Telegram session, queue implementation or migration is introduced.

Each production `GramjsSourceRpc` captures its channel owner, client identity, verified account and client generation. Stable resource ownership is separate from transient connection health: disconnect events must still invalidate a reader epoch, while a replaced client must never receive, invoke, acknowledge or commit through the old reader. Both dynamic and static reader construction pass the owner. Registry reconciliation replaces retired same-policy readers.

The pinned SDK's disconnected/broken connection-state values invalidate freshness even when dispatch occurs after reconnect. Connected keepalives remain suppressed. An ownership/execution failure clears only the reader's in-memory confirmation/finality. It does not reset PTS, integrity latches, receipts, checkpoints or owner authority. A fresh native difference is required before CURRENT returns.

Scout job reconciliation validates durable authority without treating missing/wrong runtime account as revocation. Valid queued/interrupted reads wait; interrupted billable assessments are never automatically requeued. Execution selects the current account before applying a bounded queue limit. A persisted, validated UUID cursor in existing `channel_offsets` rotates reconciliation in pages of at most 30, so work for another account cannot hide a recoverable job indefinitely. Genuine expiry, revocation, revision change and invalid records still retire dependent work.

The already-damaged pilot goal was explicitly closed and replaced through operator commands. Its revoked watches and history remain recorded. There is no automatic watch un-revocation or SQL history repair.

## Verification

Black-box tests use isolated temporary databases and constructed GramJS SDK values, without credentials, network or model calls:

- `scout-continuity-restart.test.mjs`: real server startup before account verification, durable watch/queue preservation, native reconfirmation, missing health, wrong account, lost lease, stale checkpoint/backoff, revoke/expiry/revision and legacy cross-account ambiguity with a healthy neighbor.
- `scout-job-recovery.test.mjs`: bounded durable rotation past foreign-account jobs, interrupted read recovery, assessment non-resurrection, revoked dependencies, invalid cursor and campaign hash corruption with an unaffected neighbor.
- `telegram-source-owner-fence.test.mjs`: same-account client/generation replacement, pending SDK response and queued-commit retirement, disconnect/reconnect, delayed SDK disconnect, replacement registry/static wiring and dynamic execution disable/re-enable.

Five deliberate guard-removal mutations were caught: replacing durable authority with execution projection, accepting absent live health, retiring jobs on transient identity loss, hiding cross-account channel ambiguity, and removing the generation fence. Each edited file was restored byte-for-byte. These probes are additional evidence, not a substitute for the regression gate.

Verification on 2026-10-03: `npm test` **1152/1152**, `npm run test:credentials` **15/15**, `npm run build` **PASS** (172 JavaScript/JSON and 9 Python syntax compilations), and `git diff --check` **PASS**. The full gate ran after restoring the mutation probes and applying the final execution/ownership fences.

The static MTProto file hash pin is advanced only for its owner-capture constructor argument; semantic native kill tests cover the change. Router/projection/worker/old migration pins remain intact.

## Operational pilot boundary

The local fitness pilot retains ten candidates from bounded discovery; it does not present ten candidates as ten monitored sources. Three sources have independently confirmed membership and explicit finite monitor grants. Membership bootstrap, when explicitly authorized, is a separate finite operator operation with durable intent, independent verification and unknown/no-replay semantics; it is not a Scout capability or implicit admission effect.

Pilot records, samples, owner authority, credentials and operational helpers stay outside tracked code. The pilot has no commercial offer selected, private intake allowlist, person/contact creation or external send path enabled. Native recovery evidence may support a bounded no-tool Continuity proposal, but the model cannot accept its own proposal into memory or create owner review. Material/case/action progression remains a separate current-basis owner decision.

The bounded reasoning opt-in is tied to the exact goal, provider/model, finite expiry and global daily run count, checked before provider invocation and before proposal application. Provider price remains unknown; no zero-cost receipt is invented. Runtime lifecycle and recovery remain independent of the owner's Codex usage quota.

## Acceptance and limits

A passing pilot means authorized sources recover to current, the same durable goal survives restart, and current native evidence produces a reviewable model proposal. Review history remains durable; recovery can stale a source-dependent proposal and require a new current proposal. Restart must not approve it, resurrect stale evidence or replay an interrupted billable attempt. It does not prove source-search completeness, commercial relevance, continuous historical coverage, delivery, causal attribution, or pilot usefulness over seven days.

The Scout PR is still stacked above unmerged Workspace work. Integration/rebase must respect that dependency; this verification is not approval to merge main or bypass its convergence/red-team gate.
