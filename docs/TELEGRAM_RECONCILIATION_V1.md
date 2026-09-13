# Telegram recovery / reconciliation v1

Checkpoint base: `6370c350bf7f2d943e57f998781f68f0359a8505` on
`codex/telegram-public-source-v0`. Main is not merged. No live Telegram or model
calls are part of this slice.

## Contract and proof

`scoped getChannelDifference -> bounded native events + Message snapshots ->
atomic source/proof/receipt/checkpoint commit -> existing operator-only pipeline`.

The public mapper emits an explicit `telegram-reconciliation-v1` extension of
the adapter envelope. The existing native-only v0 envelope remains supported;
its strict contiguous PTS validation is not used to invent snapshot events.
No database schema, Router schema, Projection or Consumer contract changes.

Native source mutations have `source.telegram.proof` records with
`kind: native_event`, genuine `pts`, genuine `pts_count`, and the associated
`source_event_id`. Recovered mutations have `kind: reconciled_snapshot`, scoped
message identity, `from_pts`, channel `watermark_pts`, deterministic recovery
`batch_id`, content fingerprint and `source_event_id`. They have NO `pts` or
`pts_count`. Bootstrap context has an explicit context-only basis, not interval
coverage, and is marked finished without inference.

`source.message.version` is an opaque application evidence revision. New
snapshots start at 1; changed snapshots increment the prior revision. Native
mutations allocate `max(native_pts, previous_revision + 1)` to retain native-only
checkpoint compatibility. Transport ordering uses genuine PTS, never this local
number. The existing integer bound fails closed on revision overflow.

`source.telegram.reconciliation` uses existing events, not a new outcomes ledger.
It records the request scope, old cursor, returned watermark, constructor kind,
server final status, normalized server-response fingerprint, snapshot fingerprint
and batch identity. Server response identity is independent of buffered live
events. Additional native receipts remain independently fingerprinted. Neutral
entity/view metadata is not represented as semantic content.

## Why the watermark can advance

The request is bound to the exact durable cursor and configured account/channel,
with `channelMessagesFilterEmpty`, `limit: 100` and `force: false`. The pinned
actual TL response is mapped completely within the supported text slice.
Unsupported messages, unknown scoped updates and conflicting native PTS fail
closed. The response's channel PTS is a server-issued continuation cursor, not
evidence of an individual snapshot event or an inferred snapshot event count.

A normal difference containing snapshots supplies reconciliation coverage for
the requested interval even without a contiguous set of individual native
events. Without snapshots this slice still requires contiguous native proof;
an unexplained watermark jump is rejected, including an opaque empty advance.
This is a deliberate conservative supported-subset restriction.

### Zero-count difference edit/delete extension

The controlled live smoke exposed `UpdateEditChannelMessage(pts=8, pts_count=0)`
in `other_updates`, returned for durable cursor 7. Zero is preserved; it is not
replaced by one or treated as a contiguous event interval. Official Telegram
updates semantics permits zero counts; TDLib processes channel difference
material updates before setting the response's continuation PTS.

`telegram-reconciliation-v2` explicitly adds `recovered_updates` for supported
zero-count edits/deletes from the actual scoped normal difference. Ordinary
positive-count pages keep v1 unchanged. The native-only v0 envelope remains
strict and cannot use zero to skip a native gap. Zero-count new-message/WebPage
variants remain unsupported in this narrow slice.

Live zero-count ingress is bounded and invalidates health for reconciliation,
not a permanent malformed-data latch. It cannot advance a cursor or mutate a
source on its own. The server delta must contain the exact compatible update
(or a previously verified receipt); omitted/conflicting proof still latches.

A v2 mutation has `kind: reconciled_event`, its genuine `pts` and `pts_count: 0`,
plus `from_pts`, `watermark_pts` and `batch_id`. These PTS fields are real TL
fields, NOT claimed event-interval coverage. The existing recovery batch proves
the applied server delta; source versions, receipts, batch and cursor remain one
atomic commit. With no snapshots, an advancing terminal watermark must match
the last positive-count event or a fresh returned zero-count update. Historical
zero-count updates alone cannot justify a new gap/advance.

Zero-count receipts use `(source, pts, kind, scoped target)` plus an exact
content fingerprint, since distinct messages may share one PTS. Positive-count
receipts keep their existing per-PTS collision checks. Conflicting same-target
updates at one watermark fail closed. Redelivery, batch retry and restart do
not allocate another source revision/inference/card. An identical-material
zero-count update only receives a receipt; it does not renew evidence age or
reclassify native-origin evidence. Explicit supported edits/deletes supersede
prior snapshot/native material state, and ordinary later native mutations work
without Consumer/Router changes.

All public identity/content/ancestry/time validation, unknown-update rejection,
DifferenceTooLong handling and operator-only fingerprinted INTEGRITY recovery
remain intact. No DB migration, queue, sender capability or Router schema change.

References: [Telegram update counters](https://core.telegram.org/api/updates),
[channel difference continuation PTS](https://core.telegram.org/constructor/updates.channelDifference),
[TDLib channel difference application](https://github.com/tdlib/td/blob/master/td/telegram/MessagesManager.cpp).

All returned supported messages, proofs, native receipts, recovery receipt and
cursor are committed in ONE existing synchronous transaction. ACK follows the
durable commit. Failure before commit rolls them all back. Retry/restart uses
the old cursor; failure after commit before ACK uses the committed cursor.
Non-final pages commit bounded progress, but do not permit inference.

This proves durable application of the supported server delta, NOT a lossless
native-event archive. It cannot reconstruct intermediate edits or events no
longer retained by Telegram. `DifferenceTooLong` is explicitly latched with the
old cursor; no history fetch, reset or implicit bootstrap hides that gap.

## Replacement, conflict and duplicates

- Identical snapshots keep the source event, revision and original evidence age.
  They cannot relabel a native-origin revision as snapshot-origin.
  Legacy records without typed origin remain unknown-origin; no legacy migration
  or guessed native proof promotes them to snapshot-origin.
- A changed snapshot-origin revision needs a newer watermark, explicit edit
  date, stable author/creation identity and non-regressing update time. Same-second
  edits are ordered by reconciliation coverage, not by invented timestamps.
- Changed native-backed content needs a matching genuine native mutation in
  the new interval. A snapshot without that proof is rejected.
- Native upserts in the response/buffer are ordered by genuine PTS. A snapshot
  must match the latest same-ID native mutation in the new interval. A native
  delete overlapping a snapshot is a conflict, never resurrection.
- Later native edits/deletes supersede the snapshot with a new local revision.
  Existing event/context identity checks make old evidence stale.
- A late native event already covered by a durable batch needs full event-interval
  coverage, known scoped membership and exact compatible material state/proof.
  It gains a historical receipt, not a new source revision or inference. Unknown
  membership, differing content, conflicting receipt or unproven delete fails
  closed. Coverage endpoint alone is insufficient.
- An exact historical batch may verify/append compatible historical receipts,
  but cannot reconfirm transport or change current source state.

## Freshness and safety

Snapshot freshness means latest durable supported material state, with a recent
final scoped difference and a currently healthy reader. It does not mean the
message was created at reconciliation time or is proven unchanged forever.
Evidence capture age is NOT renewed by retry. Restart/disconnect, later ingress,
pending native updates beyond the response watermark, mapping faults and reader
retirement invalidate health. Existing source freshness and Consumer checks
apply unchanged, including the post-model freshness check.

Message identity is always `(source_id / channel peer, message_id)`; names never
prove authorship. Source text remains untrusted data. Reviews remain proposed,
non-executable and non-approvable, with `contact_permission: false` and
`allowed_effects: []`. The sender/invoke fence still rejects writes, joins and
read receipts, and now rejects `force: true` difference requests.

One process owns the DB/session. This branch is NOT multi-process safe and adds
no lease/singleton framework. Runtime, Telegram and automatic processing remain
disabled in tracked and effective configuration.

## Reference semantics

- [Official updates and gap recovery](https://core.telegram.org/api/updates):
  use the returned cursor for continuation; TooLong is not interval recovery.
- [Official channelDifference constructor](https://core.telegram.org/constructor/updates.channelDifference):
  Message snapshots and native Update vectors are separate; PTS belongs to the response.
- [Official getChannelDifference](https://core.telegram.org/method/updates.getChannelDifference):
  a scoped request carries the local cursor; `force: true` may skip updates.
- [gotd channel recovery](https://github.com/gotd/td/blob/main/telegram/updates/state_channel.go):
  process native updates and snapshots separately, then persist returned channel PTS.

The interpretation and conservative conflict rules above are HARNES2 design
choices, not additional guarantees attributed to Telegram or gotd.

## Offline verification

Reconciliation checkpoint before the subsequent GLM gate fixes:
2026-09-13: full Node suite 276/276; all Telegram intake/real-stack tests 137/137;
Router/Projection/Consumer/automatic pipeline/general regression 139/139;
public bridge/recovery focused tests 75/75 (29 new recovery/boundary tests);
Python credential/failover 5/5; build checks 51 JavaScript/JSON and 6 Python files.
Zero failures, skips, cancellations or TODOs. Actual external Telegram/model
calls and sends: zero. Synthetic decision responses are not semantic model validation.

Verdict: **READY FOR LIVE SMOKE**, limited to the supported read-only contract,
not unattended production monitoring. Ambiguous native/snapshot conflicts and
unaccounted empty watermark jumps intentionally still stop ingestion.

Next gate: explicitly authorized read-only live smoke on a controlled public test
peer, with relevant processing consent, one DB/session owner and sends fenced.
No production monitoring, historical backfill or live execution approval follows
from offline green tests.

The final [GLM gate review](TELEGRAM_PUBLIC_SOURCE_GLM_GATE.md) adds routine-update
handling, same-cursor operator retry and restart metadata revalidation. It records
304/304 full Node tests, 165/165 Telegram tests and the remaining live conditions.
