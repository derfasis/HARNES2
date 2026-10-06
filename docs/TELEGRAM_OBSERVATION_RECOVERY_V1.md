# Telegram observation recovery v1

This operator flow continues an already joined, currently monitored Telegram source after a latched checkpoint integrity failure. It does not create a new source grant, join a channel, run discovery, contact participants, send messages, or invoke a model.

## Operator flow

The Scout card offers **«Продолжить с нового наблюдения»** only when the campaign is active, the source is joined, its monitor grant is current, and the server marks the source recovery-eligible for the integrity reconciliation latch. A pending authorization is shown with an explicit cancellation control.

Opening the form re-reads the campaign and binds the decision to the fresh checkpoint fingerprint. The operator must acknowledge that the historical gap is unknown, provide a reason, and choose an expiry in the future no more than one hour away. The initial expiry is 30 minutes. The UI submits a bounded **source.rebaseline** request; it never changes a checkpoint itself. A pending request can be cancelled with **source.rebaseline_cancel** and a reason.

## Recovery and evidence semantics

The native Telegram worker may cut over only for the supported GramJS **TooLong** dialog-PTS condition. The cutover starts a new observation epoch from the current PTS with empty history; it does not claim that the gap was recovered or complete. Existing facts and source evidence remain available for audit, but are stale for current conclusions. The epoch remains non-current until a later forward poll succeeds and proves progress.

The pinned GramJS `Api.updates.ChannelDifferenceTooLong` and `Api.Dialog` provide
the semantic projection: the new cursor is the matching channel's `dialog.pts`,
not `GetFullChannel.pts` and not a guessed field. Its bundled latest messages do
not recover the lost interval and are deliberately not ingested. See the
[Telegram constructor contract](https://core.telegram.org/constructor/updates.channelDifferenceTooLong).

Migration 017 adds `source_observation_epochs`. Each bounded chain records the
exact prior checkpoint, read policy, finite operator authorization, empty baseline,
and atomic receipt. The baseline event ID is the common observation floor.
`sourceRows()` supplies current business evidence above that floor;
`sourceHistoryRows()` retains canonical version, author and tombstone guards.
Continuity policy hashes include the observation identity; Audience watches need
explicit renewal after the change. Old accepted memory, inflight reasoning and
Scout samples/approvals cannot become current just because a new poll succeeds.
Existing monitor grants remain distinct read authority; a cutover grants nothing.

Restart selects the baseline matching the durable checkpoint. A crash before
commit retains the original pending finite authorization; a crash after commit
cannot create another epoch. Receipt failure rolls back the whole transition.
Cancellation, expiry, revocation and native callbacks during awaited reads fence
late completions. Imported epochs remain audit evidence, with unresolved recovery
authorization revoked. Exact historical catalogs remain supported; stripping the
new migration/table while retaining epoch markers is rejected.

Keep these states distinct in the dashboard and stored records:

- **Unknown gap:** messages missed between the old checkpoint and the new baseline cannot be established.
- **New epoch:** a fresh observation baseline exists, with **history_complete: false**.
- **Current observation:** established only after a successful forward poll in the new epoch.
- **Old evidence:** retained with its provenance and history, but not represented as current.

Expiry, cancellation, checkpoint mismatch, ineligible source state, worker failure, or an unsupported Telegram error must leave the checkpoint and prior evidence unchanged. An accepted operator authorization is not proof that cutover ran; a cutover is not proof that a forward poll succeeded.

## Acceptance checks

Verify the card’s eligibility and pending-cancellation controls, fresh fingerprint binding, required acknowledgement and reason, one-hour maximum expiry, and escaped source text in the rendered UI. Exercise the command path and worker failure/restart cases with bounded fixtures. Confirm that tests never enable production Telegram, model billing, or message sending. Passing UI checks alone does not establish native cutover or recovery correctness.

The focused suites are `telegram-rebaseline-{core,native,scout,transfer,ui}.test.mjs`.
They cover real SQLite/BusinessService commands, pinned SDK objects, late callbacks,
stale accepted memory, unknown ancestry, rollback, neighbor progress, operator DOM,
and actual child-process staging imports. A local mutation probe removed five
independent guards (current floor, epoch checksum, Scout floor, native TL check,
callback epoch fence); every mutation was caught by its focused semantic test.

No universal Telegram parser, replacement transport, queue or inference engine was
introduced. GramJS, the existing RPC gates, SQLite transactions, Source Registry,
Scheduler, current source ingestion and existing UI primitives are reused.
