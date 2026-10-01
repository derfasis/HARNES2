# Outcome & Attribution v1: merge-readiness verification

Branch: `codex/outcome-merge-ready-v1`.
Parent: `7f6a5283d107dadf1ea9665af918d4433c0d0205`, the verified head of PR #26.
Canonical main remains `8c8889b32bd49cfdf4f3dc32628b1b7883e513bb`.
This is an additive fast-forward candidate for the Outcome branch. Main and the
unrelated worktrees were preserved. Partner Workspace was not started.

## Scope

Production modules, migrations, permissions, send boundaries and the hosted workflow
are unchanged. This pass closes test-quality gaps on top of the existing completion.
The historical SQL fixture added by the parent is preserved byte-for-byte in Git.

- Historical LF bytes must hash to
  `9bf883d940a6a174c88a1e68ecde384966b14632813f616322beafbae154498e`.
- The one accepted Windows CRLF representation must hash to
  `a255f1b438928fd000279ed19b87b57ba3881512d32d613f292e99ecae640a64`.
- Raw bytes are checked before normalization, so mixed endings cannot conceal a
  damaged fixture. Both database cases derive from these same pinned bytes; the
  executed CRLF SQL is independently hashed. Neither historical case reads Git
  history or derives old SQL from production migration 008.
- Both historical database cases prove migration 009 actually ran and preserve
  the original migration receipt. Unknown receipts and modified current SQL fail.

## Guard acceptance and adversarial verification

| Contract | Black-box evidence |
| --- | --- |
| Coverage cannot be asserted by `observeSent` | Existing and unobserved outbound windows reject fake continuous coverage without creating a proof; an explicit operator `outcome.coverage_attest` command creates a valid persisted interval proof; other actors are refused. |
| Opening deadline must be strictly later | Earlier and equal deadlines fail with `OUTCOME_WINDOW_TIME_INVALID` without window/event writes; a later deadline succeeds. |
| Corrupt persisted intervals fail closed | Earlier and equal closing times are quarantined with the exact error, produce no candidate and do not starve a healthy neighboring conversation under `limit: 1`. Closing/reopening SQLite and running recovery do not resurrect the bad window or duplicate the healthy candidate. |
| Resolved windows cannot be attested again | Answered, expired-unanswered and quarantined/superseded states reject with `OUTCOME_WINDOW_RESOLVED` without proof/state writes. Pending and unknown states succeed. The expired control supplies the exact current proof id, so another stale-review guard cannot conceal a failure. |
| Fixture normalization cannot hide corruption | Exact LF/CRLF variants pass; mixed endings, changed SQL and an appended newline fail. |

Seven isolated mutations were killed by semantic assertions, not syntax errors:
removing each of the four requested production guards, weakening each time-order
comparison from `>` to `>=`, and removing the raw fixture checksum guard.
The original bytes were restored after every probe. Mutation probes and local
gate logs are retained under the ignored `.cache/outcome-verification/` directory.
The probe is a local verification artifact, not another production subsystem.

## Gate on this tree

| Check | Result |
| --- | --- |
| Focused guard/transfer tests | 19 / 19 PASS, including a run with Git unavailable in `PATH` |
| `npm test` | 1038 / 1038 Node PASS; no skips, failures or cancellations |
| `npm run test:credentials` | 15 / 15 Python PASS |
| `npm run build` | PASS; 132 JavaScript/JSON and 9 Python files |
| `git diff --check` | PASS |
| Targeted mutations | 7 / 7 KILLED |

Hosted Windows CI was independently confirmed successful on the parent `7f6a528`.
The existing workflow runs on pull requests; this separate candidate branch does
not itself trigger that workflow. Its exact SHA still needs the normal PR gate
after fast-forward integration. No workflow changes or extra pull request were made.

## Merge assessment and limits

No additional production merge blocker was found in the changed surfaces.
All evidence above is functional/local; no live send or application model was used.
No implicit contact authority, outbound default, public-ingestion behavior or
Outcome semantics changed. Association still does not establish causal credit.
The existing limits in [the completion handoff](OUTCOME_ATTRIBUTION_V1_COMPLETION.md)
remain: transports do not automatically prove a complete private-message interval,
owner evidence is not independently verified, and live operation is not established
by these tests. Normal hosted PR verification remains the final integration check.
