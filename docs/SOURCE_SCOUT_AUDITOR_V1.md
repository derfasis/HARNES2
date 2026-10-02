# Source Scout + Auditor v1

Owner-controlled Telegram community selection by topic, over the existing MTProto
account. This is a candidate catalogue and bounded audit, followed by a separate
monitor admission. It is not a second Discovery, CRM, Telegram parser or sender.

## Product path

1. Create a campaign: topic, audience, language, geography and up to ten queries.
2. Explicitly grant bounded search/history access for that campaign revision and
   verified Telegram account. Creating a campaign does not start network work.
3. Add known `@username`/public links/channel IDs, or explicitly queue search.
   Channels may produce linked discussion-group candidates. Neither search nor a
   discussion relation grants membership, contact or monitoring permission.
4. Automatically sample the resulting candidates under that audit grant: at most
   seven days and 500 native messages by default, in pages of at most 100.
5. Inspect objective counts and bounded conversation excerpts. Exact repeats,
   unsupported content and reply ancestry are handled by deterministic code.
   No keyword-based sales qualification, bot/person classifier or invented quality
   score exists. Unknown authors are not collapsed as if they were one person.
6. Optional semantic assessment requires model configuration **and** an explicit
   assessment request. It receives the screened sample, closed JSON contract and
   no tools. Its recommendation and possible opportunities are hypotheses.
7. Review an assessment, or manually inspect the sample and record a rationale.
   Issue a separate, expiring **monitor** grant for an already joined native peer.
8. The existing public reader establishes its native baseline and proves CURRENT
   through channel differences. New source messages enter existing durable
   ingestion, Discovery/Opportunity and owner review; Continuity and Workspace
   can select these dynamically authorized sources.

The initial useful portfolio is 15–30 candidates and 5–10 admitted communities.
That is an operator workflow, not a claim that search finds the best communities.
Changing a campaign's topic increments its revision and retires its audit/monitor
grants, pending work and old assessments. Creating another campaign keeps both
topics independent. Raw sealed samples can be reused for the same account/native
channel under the new campaign's audit authority; semantic assessments cannot.

## Reused components

- Pinned GramJS `telegram@2.26.22`: SDK TL classes, username search/resolution,
  linked discussion metadata and paged history. No new client, Telethon, provider,
  Telegram schema allowlist or hand-written protocol parser.
- Existing semantic projection `mapTelegramMessage`: ordinary extra TL fields
  remain harmless; protected/media/service/unsupported content remains opaque.
- Existing public reader: native PTS, checkpoints, deduplication, reconciliation,
  source evidence and transport health. Historical audit pages never call ingest
  or establish a checkpoint and never stand in for continuous coverage.
- Existing SQLite, command receipts, AJV, Hermes no-tool worker, shared run-cost
  ledger, Control Plane admission and authenticated operator UI.

GitHub-first donor review: [GramJS](https://github.com/gram-js/gramjs),
[tgtrigger](https://github.com/A1exZabr/tgtrigger),
[telegram-search](https://github.com/groupultra/telegram-search).
The latter applications introduce another runtime/storage/search stack; tgtrigger
also forwards messages. None is needed for this narrow bridge. A future SDK fork
replacement belongs behind the adapter and must undergo separate validation.

Telegram API references: [contacts.search](https://core.telegram.org/method/contacts.search),
[messages.getHistory](https://core.telegram.org/method/messages.getHistory),
[discussion groups](https://core.telegram.org/api/discussion).
Search is an incomplete username-based candidate mechanism. There is no general
map of all Telegram communities, hidden join, member crawl or paid Stars search.

## Durable state and clocks

Migration `011-source-scout.sql` adds seven tables:

| Record | Meaning |
| --- | --- |
| `scout_campaigns` | Revisioned topic and acquisition scope |
| `scout_candidates` | Campaign relation to account/channel identity; observed username/title/provenance |
| `scout_grants` | Separate audit and monitor authority, expiry, revision, exact catch-up acknowledgement |
| `scout_jobs` | Bounded search/resolve/history/assessment workflow and resumable cursor |
| `scout_samples` | Immutable sealed historical messages, digest, acquisition window and local event fence |
| `scout_assessments` | Campaign/sample/evaluator-bound advisory result and owner review |
| `scout_calls` | Conservative audit read reservations and durable result/unknown receipts |

Sample identity includes account, native source, requested window, source event
cursor, messages and terminal sample reason. Assessment identity additionally
includes campaign revision/topic hash and evaluator version. Sealed content has
SQLite immutability triggers. Access hashes and sessions are never written to
these tables or exported. The SDK/session and temporary peer cache own them.

`ScoutRuntime` reads one bounded page per tick. `processScoutAssessment` is a
separate clock and public-plane no-tool operation. A slow model cannot hold source
polling. Neither module embeds another scheduler or independent job engine.
Monitor readers remain in the existing source clock and source contracts.

`effectiveSourceConfig` projects current monitor grants into the existing source
policy shape at every authority check. No JSON configuration is rewritten. Source
revoke/expiry/topic revision removes this authority immediately; reader cleanup
follows on the bounded reconciliation pass. Missing reader != successful monitoring.

## Read budgets and honest lag

These are distinct resources:

- Account-wide logical SDK read admissions: default 10,000/day UTC; at most
  1,000 per source. Search/audit may use the first 20% of global capacity, retaining
  80% for monitor work. Pending reads prioritize monitor, audit, then search.
- Audit content bound: default 500 native rows, including rows the semantic mapper
  omits. MessageEmpty cannot cause an unlimited backfill. Candidate capacity is 30
  by default. Campaign/job/grant history also has explicit hard limits.
- Model runs: default five Scout assessments/day, also subject to the existing
  global run/cost admission. Unknown cost is never zero.

The shared account read gate persists admissions and `FLOOD_WAIT`, including long
manual-wait failures, in `channel_offsets`. It applies to Scout and public monitor
reads. The opt-in SDK client disables its hidden flood sleeps/request retries so
the owner account gate can observe these failures. Authentication and pre-existing
private SDK reads are not a wire-wide quota meter. SDK convenience resolution may
perform more than one wire call; audit reservations are conservative. This is not
a financial/provider billing guarantee.

With Scout enabled, the existing monitor loop selects at most two Telegram
sources per pass with a persisted 120-second cadence; bootstrap starts at most
two readers per pass and also persists its fair cursor. Browser cadence is kept.
The UI reports account request usage, retry deadline and queued work. Existing
source checkpoints expose confirmed time/currentness; lag exceeding freshness
withholds downstream reasoning. Exhausting a budget never means “nothing happened.”

## Authority, freshness and failure semantics

- Username is a locator. Account + channel ID is identity. After restart, dynamic
  public peers re-resolve that locator and must match the admitted native ID and
  joined state. Username reassignment cannot move a grant to a new channel.
- A numeric joined peer without a known session-cache entity/public username is
  unavailable, not permission to enumerate dialogs or invent an access hash.
- Audit permission != monitor permission != contact permission. Every Scout
  mutation is operator-only. There is no agent effect tool, autojoin, send or
  person/conversation/draft creation.
- Grant/process/account/client identity is checked before queued reads and after
  every network await before applying results. Stale callbacks cannot write over
  a successor process. Invalid pages fail without advancing their cursor.
- `finished_at` is the end of a **bounded non-atomic history acquisition**, not
  “fresh through this time.” Unmonitored edit/delete completeness is unknown.
  A local source event cursor captured before the first read invalidates sampled
  messages if later observed edits/deletes arrive, even with equal timestamps.
  Acquisition age is bounded separately. Historical bytes remain visible.
- All known opaque ancestry is omitted from semantic evidence. An independent
  normal message by the same author remains eligible. Missing context stays
  explicitly incomplete. Model references must belong to the exact selected packet.
- Model receipt persistence failure latches reasoning, preserves interrupted/
  unknown state and never automatically re-bills the request.
- Startup marks running read jobs interrupted and started receipts unknown.
  Reads may resume the same cursor only with still-current audit authority.
  Interrupted model jobs require another explicit request. Backoff/counters survive.
- Revocation cannot be blocked by a corrupt checkpoint. The grant is retired,
  unhealthy old state remains quarantined and no cursor is silently repaired.

### Re-admission and the revoked interval

First admission creates a fresh native baseline. With an existing checkpoint,
re-admission is denied unless the owner explicitly acknowledges **historical
catch-up** from the exact current `catchup_from_pts`, whole-checkpoint
`expected_checkpoint_fingerprint`, and `accept_historical_gap: true`. The UI
presents an unchecked checkbox naming that PTS and the interval without the
former grant. Any checkpoint change after presentation refuses admission before
network work (`SCOUT_CHECKPOINT_CHANGED`), even if PTS stayed the same. The exact
acknowledgement is part of the immutable monitor grant, surviving restart.

That grant permits catch-up from the stored cursor. Source/account/channel and
the historical grant policy must match. PTS and baseline hash are preserved; the
authority policy hash changes and CURRENT is withheld until a new difference
proof. The integrity latch survives. Audit history cannot repair it. A new fresh
cutover for an already established source is deliberately not offered in v1.
There is no silent reading of a revoked interval under a vague renewal.
The reader checks its captured exact policy at commit and failure callbacks;
revocation/replacement does not wait for the registry's next rotation. Restart
under the same active, unexpired immutable grant may resume its own checkpoint;
a different grant always requires the acknowledgement contract above.

## Export/import

Schema 11 exports the catalogue and immutable historical samples/assessments.
Import revokes all active Scout grants, stales dependent jobs/assessments, marks
started reads unknown and drops local monitor/start cadence. Existing workspace
transfer rules keep transport freshness and execution authority unproven.
Known read cooldown/counters remain keyed to the exact partner/account and cannot
authorize another account. New audit/monitor authority and native resolution are
required. Historical schema 2–10 catalogues exclude Scout tables explicitly.

## Operator setup and API

No live configuration or credentials were changed by this implementation.
Defaults: Scout, its model, runtime, Telegram and Control Plane remain disabled;
liveSending remains false. Use the project's existing protected MTProto account
setup; do not put a session/API key into tracked files.

For audit-only operation, explicitly configure `telegram.transport: "mtproto"`,
`telegram.enabled: true`, `controlPlane.enabled: true`, `scout.enabled: true`,
`scout.modelEnabled: false`, and leave liveSending false. Public automatic
reasoning does not need to be enabled for catalogue/audit work.

Monitoring additionally needs the existing `opportunity.automatic` ingestion
boundary. That is also the existing public reasoning opt-in if model credentials
are configured: **runtime.enabled false alone does not disable no-tool public
reasoning**. Keep model credentials/provider unconfigured for a read-only pilot
without model authorization; do not silently copy another live configuration.
Optional Scout assessment needs separate modelEnabled plus an explicit request.

UI: **Источники**. Read endpoints require the existing operator token:
`GET /api/scout` returns a compact campaign catalogue/read-gate status;
`GET /api/scout/campaigns/:id` returns bounded detail and historical evidence.
Commands use the existing `/api/commands` with idempotent request IDs:

`scout.create`, `scout.revise`, `scout.pause`, `scout.authorize`, `scout.seed`,
`scout.search`, `scout.audit`, `scout.request_assessment`, `scout.review`,
`scout.admit`, `scout.revoke`.

Campaign commands require the exact revision. Audit/monitor grants expire within
30 days. Admission names exact candidate/sample/optional approved assessment;
manual review records its rationale in the purpose. Existing checkpoints require
an exact `catchup_from_pts`, `expected_checkpoint_fingerprint` and explicit
`accept_historical_gap`. Admission is capped at 100 active monitor grants per
partner so an accepted grant cannot be hidden outside the bounded projection.
Commands never mutate read-only source truth directly.

See [verification and integration handoff](SOURCE_SCOUT_AUDITOR_V1_VALIDATION.md).
