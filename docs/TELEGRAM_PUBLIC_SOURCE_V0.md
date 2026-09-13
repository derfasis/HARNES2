# Public Telegram native-proof bridge v0

Recovery follow-up: [Reconciliation v1](TELEGRAM_RECONCILIATION_V1.md) separates
recovered Message snapshots from native event PTS. The v0 verification below is
a historical checkpoint, not the final recovery contract.
The subsequent [GLM gate review](TELEGRAM_PUBLIC_SOURCE_GLM_GATE.md) covers routine
updates, operator-authorized recovery and the final pre-smoke regression.

Base: `42efe153d6a9dd171adce12d5fabaa89f9f94131`.
Branch: `codex/telegram-public-source-v0`.
Implementation checkpoint: `430af97745ab6c93db45250ae6ed9fb0350d5f75`.
Production diff: +358/-13 lines, +345 net LOC (including comments/blank lines).

## Acceptance boundary

**NOT READY for the full live-pilot criterion.** The finished result is an
offline-verified bridge to the actual pinned GramJS transport boundary, not a
claim of reliable unattended Telegram discovery. Main is not merged.

The bridge reuses the existing MTProto owner's credential loader/client slot,
GramJS `telegram@2.26.22`, StringSession, durable source intake, existing Scheduler,
Router/Projection/Consumer, and operator review rows. It adds no dependency,
database, migration, CLI, queue engine, approval, or send path. The private CRM
adapter and frozen Router v1 assets are unchanged. Server startup is NOT wired
to the new factory; automatic/runtime/Telegram/liveSending remain false.

## Proven path

Trusted bootstrap calls `openTelegramPublicReader(service, existingOwner,
{sourceId, username})`, after explicit source/account/processing authorization.
It must receive the sole existing MTProto owner, not a separately constructed
owner sharing its session. The returned reader can be supplied to the existing
Scheduler's `sourceReaders` argument. The model only receives bounded source
data; client, session, access hash and credentials stay in private transport state.

The new integration tests use actual pinned TL constructors and TelegramClient,
with connect/invoke/destroy replaced by synthetic, network-forbidden fixtures.
Production SQLite, Scheduler, Router/Projection validators and Consumer create
an operator-only review card. This is NOT a live Telegram or model smoke.

## RPC and lifecycle boundary

- Fence both client invoke and the SDK's actual sender/serialized request queue.
- Only scoped GetFullChannel/GetChannelDifference, exact username resolution,
  self identity, config/state, ping and MTProto acknowledgement RPCs are allowed.
- Send/DM/edit/delete/join/invite/read-history, DC switching/exported senders,
  arbitrary objects, out-of-scope reads and captured-byte substitution are denied.
- Preserve the SDK's non-RPC queue-clear sentinel and reconnect replay iterator.
- Require an existing loaded auth key; do not perform login or new authorization.
- Capture native updates synchronously before SDK async event dispatch.
- Decoder/security faults close the integrity gate rather than silently skipping.
- Reads/connect have a 30-second deadline; provider failures/FloodWait retain
  cursor and apply bounded per-process backoff without recording raw exceptions.
- Deadline closes freshness immediately. Cleanup cannot make a read wait forever.
  Owner slot stays reserved until confirmed teardown. Late connect requires a
  second teardown; failed/hung teardown quarantines the slot. Close is idempotent,
  and retired callbacks cannot invalidate a replacement reader.

This is an application capability boundary, not a sandbox against arbitrary
hostile JavaScript running inside the same process. MTProto acknowledgements
are transport effects, not message sends or Telegram read-history receipts.

## Native mapping, cutover and durable ACK

Accept only native new/edit/delete channel updates with actual positive
`pts/pts_count`, exact peer-scoped ID and typed user/channel/null author. Preserve
explicit reply/thread/top/foreign-peer ancestry; unresolved links stay unknown.
Reject unsupported media, forwards, quotes, signatures, TTL, entity-bearing text,
service messages and unknown semantics rather than silently stripping them.
Anonymous author is not guessed; channel identity never becomes a CRM person.

The initial GetFullChannel PTS is an explicit empty-history cutover. Subscriber
is installed BEFORE that request. Native updates at/below the baseline are
excluded; above-baseline proof is retained. Bootstrap is always catching_up,
never current. Unsupported ingress during bootstrap durably latches the baseline;
closed bootstrap cannot authorize subsequent processing. Existing baseline is
reused on restart, never advanced by another historical bootstrap.

RAM proof is immutable, deduplicated and bounded to 100 native updates. Overflow
latches and stops capture. Reconciliation unions native proof and otherUpdates,
sorts/checks contiguous PTS coverage, rejects collisions, and requires exact
newMessages snapshots backed by the latest native upsert at/below response PTS.
Source messages/receipts/tombstones/cursor commit in the existing transaction.
Only successful durable commit ACKs/prunes proof; rollback keeps it available.

Current attestation is bound to committing PTS and physical/decoder health.
Ingress immediately revokes freshness before queued SQL invalidation. Mapping
failure revokes prior attestation even through direct reader calls. Ownership
is rechecked inside invalidation transactions; stale cards cannot grant contact.

## Objective recovery blocker

Telegram's [ChannelDifference constructor](https://core.telegram.org/constructor/updates.channelDifference)
contains `new_messages: Vector<Message>`, NOT native per-message PTS/count. Its
overall PTS is a channel watermark, not proof of each message's event version.
Assigning it to recovered messages would invent semantics in the current intake,
which requires every event's native version and contiguous coverage.

Consequently, missed new-message proof after reconnect/restart, gaps, unsupported
channel updates and DifferenceTooLong halt with an integrity latch. Cursor does
not skip the gap. Reconnect succeeds only when sufficient actual native proof
or supported native otherUpdates remains. No lossless offline recovery is claimed.

[Official updates semantics](https://core.telegram.org/api/updates) were checked.
[gotd channel recovery](https://github.com/gotd/td/blob/main/telegram/updates/state_channel.go)
dispatches recovered message snapshots separately and stores difference-level
PTS; it does not establish the event-version proof required by this intake.
No SDK replacement is justified by this contract mismatch alone. A separately
audited reconciliation/snapshot-version contract is needed before unattended use.

## Independent regression and audit

The independent code review found and prompted regression-covered fixes for:
async session loading/error-hook API, SDK clear sentinel, response-watermark
snapshot race, concurrent attestation, bootstrap cancellation/integrity race,
immediate freshness versus queued SQL, buffer overflow, direct mapping failure,
late callbacks, idempotent close, teardown quarantine, and finite read deadlines.

Final offline verification uses the restored project .venv and pinned Hermes,
Ajv 8.17.1 and GramJS 2.26.22; locks/upstream revision are unchanged. SDK's own
internal version string differs from its package version; no upgrade was made.

| Check | Result |
|---|---|
| Complete Node suite | 247/247 |
| Native public-source integration/mapper/fence suite | 46/46 |
| All Telegram intake + existing integration + new public-source tests | 108/108 |
| Router/Projection/Consumer/UI/Pipeline/runtime/general/source regression | 139/139 |
| Actual Python credential/failover tests | 5/5 |
| Build | 51 JavaScript/JSON + 6 Python files |

Focused runs overlap the full suite; do not sum their counts as unique tests.
Final runs have zero failures, cancelled tests, skips and todo. Guards forbid real
network/model IO; fake inference `api_calls` fields are synthetic, not billing.
Positive, injected source text and authority-escalating model output are checked.
Reviews stay non-executable with contact_permission=false, allowed_effects=[],
zero approvals/delivery/tool/outcome/CRM writes. Edits stale old evidence; deletes
tombstone it; duplicate/restart do not repeat completed inference. Lost native
proof is explicitly tested as a BLOCKER, not counted as successful recovery.

## Live and operational conditions

Live Telegram: NOT RUN. Peer: NONE. Real Telegram API calls: 0. Real model calls: 0.
Telegram external effects: 0. Application sends: 0. No local credentials/session
were exported, recorded in test logs, committed, or used to contact Telegram.
Existing credential presence was checked without printing values, but no public
source binding or explicitly approved public/test peer was available.

One process and one existing owner per DB/session remains mandatory. This branch
is NOT multi-process safe; no inter-process lease/singleton layer was added.
Do not run private and public clients concurrently against the same session.

Before genuine live acceptance: resolve native-loss reconciliation, approve a
controlled public/test peer and AI processing, check supported content/ancestry
coverage, apply retention/consent policy, explicitly wire trusted startup, and run
real new/edit/delete/restart/reconnect smoke without writes. An operator's string
processingBasis or a public username is not itself a legal processing permission.
Telegram's [API Terms](https://core.telegram.org/api/terms) and
[Content Licensing/AI Terms](https://telegram.org/tos/content-licensing) restrict
AI use and describe context-specific individual-consent conditions; applicable
authorization must be established separately, not inferred from public access.

Requested Opus `Ресреч.md` was not found in the examined locations. The existing
`TELEGRAM_CLIENT_RESEARCH_2026-09-12.md` and primary sources above were examined
instead; no claim is made to have reviewed the missing attachment.
