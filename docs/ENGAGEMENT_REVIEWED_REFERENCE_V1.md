# Reviewed references: source-backed material in private conversations

The native Telegram pilot reached a pending Gemini draft, but private conversation context could not read an Executive/Workspace research result. This layer lets an operator attach an exact approved Work material excerpt to one current inbound question. It reuses Work's versioned review, Continuity's source/evidence freshness and existing private Control Plane/Engagement contracts; no parser, framework, provider, or outbound capability was added.

## Operator workflow

1. Observe allowed sources and create/accept a Continuity or Executive result. Accepted research is still an interpretation, not an independently verified fact.
2. Prepare and approve a Work material against that current source lineage.
3. Open the existing managed private Engagement. In its research-reference section select the approved material, the current inbound question, an exact excerpt (at most 8,000 characters), explicit two-letter market label, expiry (at most seven days), and admission note. The offer must match configured active offer; country is never inferred or added to the person/profile.
4. The next permitted private model run receives the reviewed excerpt and underlying source observations separately. It may cite a `reference` evidence ID in its decision/HYPOTHESIS. `CLAIM` still quotes inbound; models cannot create `VERIFIED_FACT`.
5. Inspect the pending draft/handoff, source IDs/versions, primary URL when available, capture/publication dates and uncertainty. Reference admission is separate from contact permission, draft approval and send. Nothing is sent by adding a reference or running inference.
6. Revoke the reference or let it expire. A new question needs a new explicit attachment; the prior question's authority is not silently reused. Future normal replies remain possible with obsolete material withheld.

Runtime/Telegram/sending defaults remain disabled. Reference admission requires the existing Engagement, Workspace and Control Plane features enabled; research/model authority stays in its existing domain. Reference data cannot approve a draft, grant contact, change ownership, schedule a call or earn causal credit.

## Durable boundaries

Migration `020-engagement-reviewed-references.sql` adds `engagement_references` at the end of the transfer catalogue. It stores immutable question/Engagement/partner, approved material/hash/version, Work/thread/turn/basis, declared offer/market, exact excerpt, deadline and packet checksum, with active/stale/revoked/quarantined lifecycle. No published SQL migration was rewritten.

`reference.attach` and `reference.revoke` are operator-only, transactional, idempotent commands. Current reading authority is capped at four references with one offer/market per question, separately from bounded presentation history. Expired/unusable references are withdrawn before new admission. Revoked/stale records cannot resurrect; a fresh reference is a new operator command and ID.

The excerpt remains `reviewed_interpretation_not_verified_fact`. Underlying source observations remain attributed statements, with their exact source-event ID/message/version, text/truncation and capture/publication metadata. Neither source authorship nor operator review independently verifies the commercial meaning of a document. Declared market applicability is not a proof of the person's country or owner-specific terms. Missing terms stay unknown; models must not apply one market's conditions to another or follow instructions embedded in source text.

Private context revalidates source and material currentness when read. Every supplied reference is a frozen run dependency even if omitted from the model's explicit evidence list. Agent writes, model completion and draft review/execution revalidate those pins; late completion is cancelled with usage retained. Dependent beliefs and counterevidence are withheld immediately and marked stale by reconciliation. Source edits/deletes/revokes/gaps, superseded material, expiry, altered scope, corrupt packet or later inbound block obsolete use.

Bounded source-loop reconciliation persists a cursor, isolates malformed records, invalidates dependent decisions/drafts and coalesces reconsideration without invoking a model. Disabled features withhold content; they do not establish source health. Restart rechecks the original domains' freshness, preserves history and never replays model/send. Transfer validates exact schema/columns/source bindings and retains historical provenance while revoking every reference-reading grant. Old schema-2 through schema-19 bundles remain exact historical catalogues, not hybrid snapshots containing later tables.

## API and review surface

- `GET /api/engagement/references?engagement_id=...`: current excerpts and source observations, plus unavailable status/reason without obsolete content.
- `GET /api/engagement/reference-materials?engagement_id=...`: bounded current approved material choices and the current inbound/offer pins.
- `POST /api/commands`: `reference.attach` / `reference.revoke`; required payload is documented in [the acceptance plan](ENGAGEMENT_REVIEWED_REFERENCE_V1_ACCEPTANCE.md).

Both reads require the existing operator token, exact single query parameter and partner scope. Managed model tools gain only a new evidence type; no permission, approval, attachment or send tool is exposed. Primary links are protocol checked and escaped; source content/labels are escaped. UI clears unavailable material and rejects late responses for another selected Engagement.

## Proof and practical limits

The initial black-box tests failed on the actual old code: unknown `reference.attach` and missing context envelope. Acceptance/kills cover question/actor/partner/market/material scope, revocation, live expiry at native send validation, source edits/gaps, held model completion with retained usage, source-retry non-resurrection, belief/counterevidence staleness, corrupted-neighbor isolation, bounded history/capacity/reconciliation, disabled restart, exact legacy/new transfer and native authenticated HTTP/UI behavior.

Real source quality and a human's voluntary interest are separate product questions. A market-specific material must actually be sourced and reviewed; attachment cannot manufacture that evidence. This layer does not choose the owner's market, assert prices/income/health properties, parse unsupported PDF sources, automatically initiate research for every message, or enable customer sending. Automatic reuse across later questions would require a separately reviewed future policy; v1 grants reading for the exact current question.
