# Telegram read-only source intake v0: implementation decision

Base: 1809a2ca646a5b70969c37f37077fa38deb29d1b (main observed 2026-09-12).

## Existing primitives

SQLite Store.transaction / events / channel_offsets; source.ingest immutable versions;
Auto Opportunity scheduler, no-tool Projection/Router, Consumer, non-executable review tasks.
Private Telegram adapters also exist but create CRM conversations and have send methods.
Those adapters MUST NOT be reused for public source ingestion.

## Actual gap

No durable public-source transport handoff, pts ordering/gap recovery boundary, native
Telegram author/reply/edit/delete normalization, or transport freshness gate. Enabling
legacy telegram.enabled would violate the automatic pipeline's read-only boundary.

## Chosen slice

A bounded, channel/supergroup-only, read-only Telegram difference intake with an injected
readDifference transport. Reuse existing events and channel_offsets, ingestSource in the
same synchronous transaction as native-update receipts and the channel checkpoint.
Native pts is the source version, not edit_date or arrival order. Bootstrap requires an
explicit approved baseline; historical backfill is intentionally not inferred from gaps.
Gaps, disconnect/restart, partial recovery, stale observation and conflicts block analysis.
No new DB, queue, agent, scheduler or send path. Deterministic offline transport fixtures
are tests, NOT live evidence. A real MTProto client/difference mapper is not implemented
or claimed unless it can be genuinely verified.

## Why this slice

Node 24 and real SQLite are available. No Telegram/model credentials are configured;
Computer egress has no approved domains; ajv and telegram dependencies are absent and
package installation is not allowed. Exact source was acquired via the web tool and all
99 blobs, root tree and original commit were SHA-verified. The original base is a shallow
boundary (its parents are not downloaded); incremental bundle will require that base.
A new network client here would be untested scaffolding. A durable, tested handoff and
normalizer reaches the real integration boundary without changing the existing brain.

## Non-goals / gates

No Telegram send, DM, email, browser posting, auto approval, AUTOPILOT, joins, read receipts,
entity discovery, media downloads, hidden client startup, or real model calls. No raw
MTProto implementation. No infinite channel history or retroactive decision replay.
Live deployment requires explicit processing authorization/consent review, retention and
session protection, pinned client audit, and real failure/reconnect/edit/delete tests.
