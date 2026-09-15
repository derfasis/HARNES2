# Telegram normalization boundary

Implemented on `codex/telegram-public-source-v0`, based on `382b755`, 2026-09-15.
This document supersedes the raw TL field/content rejection policy in earlier
public-source and reconciliation checkpoints. Recovery guarantees remain intact.

```text
Telegram -> pinned GramJS transport / raw ingress
         -> telegram-gramjs-semantic.mjs: small, pure semantic projection
         -> telegram-public-mapper.mjs: scoped source / recovery envelope
         -> telegram-readonly.mjs: atomic durable ingest
         -> source.message -> existing Projection / Router / Consumer
```

## Ownership of the boundary

GramJS `telegram@2.26.22` owns TL decoding, constructors, NewMessage / EditedMessage /
DeletedMessage event builders and custom Message accessors (`rawText`,
`replyToMsgId`, `photo`, `document`). The bridge calls builders synchronously;
it never registers an additional SDK subscriber or invokes network-capable
getSender/getChat/getMessages methods. Raw ingress still runs before async SDK
dispatch, so the existing freshness fence cannot miss a pending mutation.

HARNES2 owns configured account/channel/source scope, typed author identity,
processing permission, native PTS/counts, recovery bounds, immutable receipts,
dedupe, tombstones, revisioned evidence, durable checkpoints, operator recovery
and transport ownership. Recovery envelopes remain v1 for snapshots/positive
counts and v2 for reconciled zero-count edits/deletes. Their strict field checks
validate our small adapter contract, not an arbitrary Telegram TL object.

`message` in the envelope is a detached semantic projection. The business event
contains no PTS; `source.telegram.proof` binds its application revision to native
or recovered provenance. Snapshot watermarks never become invented message PTS.
No new database, migration, parser framework or dependency is introduced.

## Content policy

| SDK observation | Business representation |
| --- | --- |
| Text, ordinary formatting/URL entities, display signature, harmless new fields | Existing `operation: upsert`, exact `rawText`; no authority or personal identity inferred from metadata |
| Text with an empty media object or web preview | Exact visible body only; preview content/hidden link targets are not evidence and are not fetched |
| Media, forwards, via-bot content, outgoing messages, quotes, interactive markup, per-message restrictions/TTL, empty body | `operation: unsupported`, `text: null`, bounded reason and projection fingerprint |
| Ordinary service message with scoped identity/time | Same durable unsupported representation; SDK event builders exclude services, so the bridge explicitly retains their message shell |
| Unresolved topic/story/non-channel reply semantics | Unsupported; do not invent a topic root or cross-peer ancestry |
| Views, forwards, typing, read-content and reaction controls | No evidence mutation; known metadata/participant controls still refresh peer eligibility |
| Missing/contradictory scope or PTS, unknown update semantics, history truncation/clear/migration/global TTL change, decoder faults | Existing integrity/recovery failure; do not pretend these are harmless message content |

Unknown *ordinary fields* on hydrated SDK messages, replies, controls, updates
and difference pages are ignored. There is no `noExtra` / `originalArgs` scan.
Unknown TL constructors that the pinned SDK cannot decode are a different
transport failure. A future SDK upgrade needs a separate compatibility review.

The opaque fingerprint identifies the bounded projection, not all bytes of
uninterpreted media. It hashes the visible body and basic content classification,
using stable SDK photo/document identity where available. Rotating file
references, reaction/view counts and arbitrary TL extensions are not part of
this identity. Raw opaque bodies, media bytes and SDK objects are not persisted
or sent to the model. The existing webpage-only native receipt still hashes
SDK serialization for its transport proof; preview bytes never become evidence.

## Durable unsupported behavior

Unsupported is a current message state, not a dropped event or a deletion.
Its source revision, proof, native/recovery receipt and checkpoint commit in
one existing SQLite transaction. ACK occurs after commit. The same path handles
native new/edit, recovered snapshots, and proven counterless edits.

An opaque edit supersedes prior text and invalidates a dependent review. An
opaque anchor finishes with `SOURCE_MESSAGE_UNSUPPORTED` before model readiness
or billing. If the existing author/thread/ancestor scope includes opaque material,
the anchor finishes with `SOURCE_CONTEXT_UNSUPPORTED`; silently removing that
material would falsely claim complete evidence. Unrelated authors/threads still
work. This is deliberately conservative: a relevant opaque item continues to
block that context until it is replaced/deleted or a later content policy can
represent it. This change does not reinterpret attachments or reopen old finished
anchors automatically.

A later proven text edit can replace unsupported state. A delete removes the
opaque descriptor, retains the message identity and writes the ordinary permanent
tombstone. Neither a restart nor a replay renews evidence age or permits resurrection.

## Compatibility and verification

Plain-text envelope shape, fingerprints and v1/v2 recovery identities are
unchanged. Existing cursors/receipts need no reset or rewrite. Previously latched
sources still require the existing operator-authorized recovery from the same
cursor; this patch does not automatically clear an integrity latch.

The read-only RPC/sender/serialized-queue fence, source/account permissions,
ownership checks, strict business schemas and default disabled settings are
unchanged. Unknown raw fields named `contact_permission` cannot become authority;
such fields injected into our normalized contract are still rejected.

Offline regressions use pinned SDK constructors and binary decoding, real
SQLite/ingest/Scheduler/validators/Consumer, and synthetic transport/model outputs.
They cover neutral extensions, legacy identity, opaque native/snapshot/counterless
application, stale evidence/context, unrelated progress, media-reference churn,
delete/resurrection, replay/restart, collision, transaction failure before ACK,
and existing recovery/fence/ownership checks. No live Telegram or provider calls
are part of this verification; no runtime or live sending setting is enabled.

Verification result: `npm test` passed 357/357; `npm run build` compiled 53
JavaScript/JSON files and 9 Python files. `git diff --check` passed.

Teleproto is not needed to close this boundary and is not installed. The SDK
already supplies the transport and semantic primitives used here. SDK replacement
would not remove HARNES2's durable business/evidence responsibilities.

References: the pinned local `node_modules/telegram` implementation was inspected;
[GramJS event builder](https://github.com/gram-js/gramjs/blob/master/gramjs/events/NewMessage.ts),
[custom Message](https://github.com/gram-js/gramjs/blob/master/gramjs/tl/custom/message.ts)
and [Telegram update semantics](https://core.telegram.org/api/updates) were checked.
