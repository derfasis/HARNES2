# Telegram public-source pre-smoke GLM gate

Date: 2026-09-13. Branch: `codex/telegram-public-source-v0`.
Pre-change HEAD: `6370c350bf7f2d943e57f998781f68f0359a8505`.
Main remains `42efe153d6a9dd171adce12d5fabaa89f9f94131`; no merge into main.
This review independently checked GLM F1-F8 against production code, pinned
GramJS 2.26.22 TL definitions and official Telegram semantics. GLM's suggested
tests/changes were not accepted automatically.

## Findings and disposition

| Finding | Verdict | Checked behavior and action |
|---|---|---|
| F1 | CONFIRMED | Routine scoped controls used to latch permanently. Exact known Views/Forwards/Typing/ReadContents are now non-semantic controls. ChannelTooLong requests catch-up with an optional PTS hint, NEVER a cursor assignment. Channel/Participant invalidate metadata and require full public-peer/TTL revalidation. Unknown classes, malformed controls and invented fields still latch. |
| F2 | CONFIRMED | WebPage has real PTS/count and now supplies a native metadata-only receipt/fingerprint in the same transaction as the cursor. No preview content, source revision, evidence refresh or extra inference. GLM's classification of Forwards/ReadContents as PTS-bearing is FALSE POSITIVE for the pinned and official schemas. Entity/media-bearing message exclusion remains DESIGN CHOICE; this is still a plaintext slice, not arbitrary channel coverage. |
| F3 | CONFIRMED | Previously no supported exit from INTEGRITY. Existing operator command plumbing now accepts `source.reconcile`: one attempt at the exact blocked checkpoint, no reset/unlatch. A fresh reader revalidates public identity/TTL, then only a valid typed page from the same durable cursor can commit recovery. Conflict/TooLong/rollback keeps the latch and consumes a failed attempt. |
| F4 | DESIGN CHOICE | Official server PTS is a continuation cursor, but this conservative subset refuses unexplained advances without snapshots or contiguous native proof. Error is now explicitly `TELEGRAM_UNSUPPORTED_WATERMARK_ADVANCE`; the old cursor and latch remain. No claim that this is Telegram corruption or full-client recovery semantics. |
| F5 | CONFIRMED | Valid future TL timestamps now return `TELEGRAM_CLOCK_SKEW` and stay retryable/catching_up with unchanged cursor. No future data is accepted. After clocks agree the same recovered snapshot can commit. Malformed/out-of-range timestamps still fail closed. |
| F6 | CONFIRMED | Scheduler now isolates individual reader exceptions and continues other sources. Failed sources stay non-current; existing freshness checks exclude them from inference. Tick reports sanitized `source_read_failed`, never provider secrets. Ordinary runtime/Conversation Brain path is unchanged. |
| F7 | DESIGN CHOICE | Coverage proves an interval, not the ordering/content of every individual event. A late native mutation with differing current material state remains unsupported and latched. Exact compatible late new/edit events DO obtain historical receipts; GLM's dead-code claim is FALSE POSITIVE, covered by positive regression. |
| F8 | DESIGN CHOICE | Combined unique native/server update budget remains 100 and overflow latches. Server polling `timeout` is not scheduled; the existing fixed tick remains. FloodWait/backoff is process-local and visible through reader status, not durable or restart-proof. These are explicit bounded-smoke limitations, not claims of unattended production readiness. |

F1 control semantics follow the official
[ChannelTooLong](https://core.telegram.org/constructor/updateChannelTooLong) and
[Channel metadata invalidation](https://core.telegram.org/constructor/updateChannel)
contracts. TooLong hints are not `ChannelDifferenceTooLong` history-gap responses.
F2 proof follows official [WebPage PTS/count](https://core.telegram.org/constructor/updateChannelWebPage);
[Forwards](https://core.telegram.org/constructor/updateChannelMessageForwards) and
[ReadContents](https://core.telegram.org/constructor/updateChannelReadMessagesContents)
carry no channel PTS/count. The independently checked pinned TL definitions, not
newer unsupported fields, define this mapper's accepted wire shape.
F4/F7 use the conservative [reconciliation v1 contract](TELEGRAM_RECONCILIATION_V1.md),
not extra guarantees attributed to Telegram or gotd.

## Operator recovery runbook

1. Investigate the latch. A real unresolved gap, unsupported content or
   `ChannelDifferenceTooLong` cannot be repaired by changing a cursor or bootstrap.
2. Close the old reader and await confirmed teardown of its sole owner. Do not
   start another process/client against the same DB/session. Hung teardown remains
   quarantined. Establish processing/peer authorization separately.
3. Through the existing trusted operator/service command boundary, obtain the
   current `sourceCheckpoint(service, sourceId)` and its `digest(state)`. Submit:

```js
await service.command('source.reconcile', {
  source_id: sourceId,
  checkpoint_fingerprint: digest(state),
  reason: 'Investigated transient mapping fault; retry unchanged cursor once.'
}, uniqueRequestId, {kind: 'operator'});
```

Use the existing application service instance, not a new CLI or database edit.
The generic owner-only `/api/commands` boundary also accepts this command envelope.
Do not include secrets in the operator reason. The command is disabled unless the
existing read-only automatic-source policy has been explicitly configured.
It performs no network/model call, creates no approval, and leaves the checkpoint
blocked with `contact_permission:false` and `allowed_effects:[]`.

4. Open a fresh fenced reader with the same existing owner and exact approved
   source/username. It captures the latest unconsumed authorization. Restart also
   revalidates full-peer metadata before any difference, so a prior unsafe TTL or
   private-peer state cannot be forgotten. No new GetFullChannel baseline is saved.
5. Poll one bounded typed page from the unchanged durable cursor. Source data,
   receipts/proofs, checkpoint and successful authorization completion commit in
   one transaction; ACK follows. Partial pages remain catching_up. Freshness also
   requires final response, healthy reader and no pending/hinted higher watermark.
6. On failed validation/read, retain the latch/old cursor. A new operator decision
   and fresh reader are required for another attempt. A newer request supersedes
   an older token; consumed tokens cannot fall back to earlier requests. Process
   crash before commit leaves durable state/token unchanged and safely retryable.

Authorization permits only a validated reconciliation attempt, never contact,
messages, live execution, history reset or bypassing unsupported content.

## Verification

Final offline production tree, 2026-09-13:

| Check | Result |
|---|---|
| Complete Node suite (`npm test`) | 304/304 |
| Telegram intake + original 8 real-stack integration scenarios + public bridge | 165/165 |
| Public bridge/reconciliation/GLM focused suite | 103/103 |
| Router/Projection/Consumer/UI/Auto Pipeline/runtime/general/source regression | 139/139 |
| Project .venv Python credential/failover tests | 5/5 |
| Build | 51 JavaScript/JSON + 6 Python files |

Focused counts overlap the full suite; do not sum them as unique tests.
Zero failures, skips, cancellations or TODOs. 28 additional GLM gate tests cover
known controls, unknown fields, public/TTL changes across restart/recovery,
metadata PTS/gaps/rollback/duplicates, operator scope/token/transaction failures,
future timestamps and failed/retired source isolation. Network/model/send guards
remain active; decision responses and Telegram connect/invoke are synthetic.
Relative to the pre-change HEAD, no versions, database schema, Router v1
contract/schema, Projection/Consumer, Conversation Brain, private Telegram adapter
or ordinary runtime behavior changed. The existing pre-gate volatile transport
health checks in source ingestion/pipeline remain intact.

## Gate verdict

**READY FOR LIVE SMOKE**, ONLY for an explicitly authorized controlled plaintext
public test peer with one DB/session process/owner, bounded volume and a trusted
read-only bootstrap. No live Telegram/model calls were performed for this gate.
Automatic/runtime/telegram.enabled/telegram.liveSending remain false in tracked
and effective configuration. No source binding or background startup was added.

This is NOT unattended production/multi-process readiness: entity/media/service
messages, unsupported scoped updates, differing covered historical mutations,
opaque empty cursor advances and DifferenceTooLong still stop the source.
FloodWait restart persistence and provider-directed polling remain future work.
The next live gate needs separate owner authorization; offline green does not
authorize it. Review cards remain non-executable, non-approving and send-free.
