# Scout Intent Search v1 — implementation and acceptance plan

Baseline: `main@4e856f360d7912c3ee517bd2c28beec0d5b6809a`.
Branch: `codex/scout-intent-search-v1`. This document starts as a plan; a release
report must distinguish implemented and verified behavior from this specification.

## Why this increment

Live probes proved per-peer GramJS `messages.Search` on public groups without
joining. They also disproved treating generic business-chat names, matching words,
or unverified research summaries as qualified demand. The working implementation
currently exists only in ignored laboratory helpers. The next useful product
boundary is an operator-visible query, its actual returned messages, and a
separately authorized interpretation/material, with honest selection limits.

This is an extension of Source Scout, not a new parser, scheduler, CRM, sender,
source checkpoint, Audience exchange, or Work intake. Inert suggested wording is
inspectable research material; it does not become an approved business draft.

## Reuse and explicit boundaries

- Reuse pinned `telegram@2.26.22`, `TelegramScoutRpc.#invoke`, existing semantic
  projection, account read gate/backoff, Scout jobs/calls, process ownership,
  Control Plane admission, scoped model profiles/requests, Hermes no-tool worker,
  operator command receipts, export/import and authenticated UI.
- `scout.search` remains username/community discovery. `scout.audit` remains
  bounded chronological history. Query responses never enter `scout_samples` or
  satisfy monitor admission, source coverage, native PTS, contact, or send checks.
- Keep existing SQL job categories. Add closed, validated cursor variants for
  `search/message_query_v1` and `assessment/query_intent_v1`. Association with the
  durable query/model request is checked as well as the discriminant. Unknown or
  corrupted variants must fail closed, never fall back to username discovery.
  This avoids rebuilding the deployed jobs table and all its FK dependants merely
  to add another read-only search capability.
- New immutable query/receipt/proposal records are necessary product state.
  Existing history/sample/model contracts keep their meaning and evaluator version.

## Operator flow and command contracts

All commands below are operator-only and require the active exact campaign
revision, current verified account, Control Plane ownership and audit grant.

1. `scout.register {campaign_id, revision, reference}` resolves one explicit public
   username/reference into a candidate, without automatic history/discussion reads.
   Existing `scout.seed` behavior remains unchanged.
2. `scout.query_messages {campaign_id, revision, candidate_ids, queries,
   window_days, limit}` freezes at most 20 source/query pairs. Candidate IDs are
   unique (1..10), query strings unique (1..10) and members of the campaign's frozen
   query list; window is 1..30 days and result limit 1..100. Each job returns one
   bounded page. No global/private search, joins, Stars, or new client.
3. Inspect request/attempt status, exact source/query/window, native publication and
   edit clocks, observation time, supported text or opaque reason, and selection
   limits. A zero result or under-limit page does not prove absence/completeness.
4. `scout.request_query_assessment {campaign_id, revision, receipt_id,
   expected_receipt_digest, model_profile_id, expected_model_profile_hash,
   purpose, expires_at}` authorizes one finite no-tool interpretation of the exact
   immutable receipt through the existing scoped profile system. Global model
   switches stay off. Expiry, read grant, receipt, profile and process are checked
   before dispatch and after completion. No hidden retry after an unknown call.
5. `scout.review_query {campaign_id, revision, proposal_id, decision, note}`
   records a current proposed interpretation/material as approved or rejected for
   inspection. This is neither source truth nor draft/send/contact approval.
   Existing `scout.revoke_assessment` also revokes scoped query assessment requests.

## Persistence and identity

Migration 021 adds three tables, exported via `SCOUT_QUERY_TABLES`:

- `scout_message_queries`: immutable exact request definition/hash, partner,
  campaign/revision, grant, candidate, account/native source, query/window/limit,
  job association, creation clock and observed source epoch floor.
- `scout_query_receipts`: append-only successful page receipts, exact request,
  reserved call association, local source event high-water mark captured before
  reading, actual returned/projected/omitted rows, query selection coverage,
  acquisition clocks, messages and digest. This local event fence is not Telegram
  PTS or proof of continuous coverage. Failed/unknown attempts remain in
  `scout_calls` and are visible even without a successful receipt.
- `scout_query_proposals`: immutable model output/run/request/receipt binding,
  with separately mutable review state/note. Receipt invalidation withholds it.

Use existing `scout_model_requests` with a closed version-2 query-receipt basis,
not fake history sample IDs. Keep version 1 history requests byte-compatible.
The shared reasoning clock dispatches the two variants fairly in existing job
order; there is no independent background inference engine.

Requests, receipt definitions and proposal output have SQL immutability guards.
Validate digests and closed definitions before using persisted records. Keep
access hashes/sessions/provider keys out of all durable/exported records.

## Interpretation contract

The new `scout-query-intent-v1` model contract selects an included message ID and
reports interpretation/classification, missing context, unknowns, and optional
inert public-reply wording. The server attaches the full literal source body as
`quoted_text` from the supported frozen packet; the model cannot generate that
field. Persisted/reviewed quotes are revalidated against the receipt, so changing
the output hash alone cannot make a paraphrase into evidence. Provider offers,
quoted/third-person requests, replies without necessary context, refusals and
unknown authors cannot silently turn into self-authored business intent.

`current_intent` and `offer_fit` remain `unknown`; `contact_permission` is false.
Requested and reported provider identity/cost stay observable and unknown where
not proven. Source selection does not measure representative community quality.
No tools, person profiles, demographics/health/hardship targeting, causal credit,
conversation, normal business draft, approval, action or send is created.

Prepare a bounded packet of complete supported messages (do not silently truncate
away negation). Excluded/oversize/opaque/missing-context rows are counted as such.
Deterministic screening may omit exact repetition/unsupported ancestry; it is not
keyword-based sales qualification. The UI separates literal source text from
model paraphrase and labels suggested wording as inert material.

## Failure, stale state and transfer

- One bounded page per source clock tick. Resolve/query share existing gates and
  conservative `scout_calls` reservations. Monitor work keeps its reserved
  capacity and higher read priority. FLOOD_WAIT remains account health after
  revoke and across restart; no Store/budget reset to bypass it.
- Check exact account/client generation, peer, campaign/revision, grant, current
  job owner and frozen request before queued read and after every await. Discard
  stale response content. Wrong peer/date/shape/limits cannot advance a request.
- Commit successful receipt, call settlement and job completion atomically. A
  persistence failure leaves unknown/interrupted state; no model consumes an
  in-memory response. Restarted reads use a new charged attempt, at most three
  attempts per query request. A spent model request never resurrects.
- Edit/delete/source epoch/revoke/pause/revision/account/profile/expiry changes
  stale dependent interpretations and block review/new inference. Historical
  bytes remain inspectable, with currentness derived again at point of use.
- Freshness means bounded acquisition age plus known local revision checks, not
  complete edit/delete coverage of an unmonitored source or still-open intent.
- Import keeps receipt history, revokes grants/model requests, retires pending
  jobs/proposals and never grants model/contact/send authority. Freeze schema-20
  and earlier input catalogues before adding the schema-21 tables.

## Acceptance before release

First add black-box tests proving registration performs no sampling; exact
source/query result retrieval persists a typed query receipt and no history sample;
changing the topic invalidates pending work; wrong peer/malformed results and
mid-flight revoke fail closed; model call requires a separate exact grant and
cannot create contacts/drafts/sends. Verify immutable records, empty/opaque/capped
coverage, stale edit/delete/equal-clock/source epoch, persistence failure,
unknown/restart attempt accounting and transfer without resurrection.

SDK tests must prove `Api.messages.Search` with the selected `InputPeerChannel`,
query, dates/limit and no broad fallback/join; newer ordinary TL fields stay
harmless through the existing mapper. UI tests must prove escaped literal text,
scope/unknown labels, separate cost-bearing model authorization and stale review
controls. Include a finite native read/model conformance check through configured
credentials when implementation is ready; do not silently enable live effects.

Then run isolated acceptance/recovery/transfer/UI tests, existing convergence gate,
`npm test`, `npm run test:credentials`, `npm run build`, `git diff --check`, own
red-team, and exact-head hosted CI before any permitted integration. Green tests
do not prove a useful recommendation or a real recruitment conversion.
