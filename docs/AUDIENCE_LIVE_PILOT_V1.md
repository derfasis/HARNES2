# Audience live pilot: product verification

Canonical baseline: `e5288221e34383bf0fe4230835c98dc4dffa0dcb` (verified Audience + Workspace + Scout). Work is isolated on `codex/audience-live-pilot-v1`; existing primary-workspace changes are preserved.

## Chosen next step

Prove one useful real scenario before adding another framework: existing explicitly admitted public sources → bounded native observation → current Audience hypothesis with exact quotes → inspectable proposed material. The owner must be able to judge the evidence and usefulness in the dashboard. Synthetic conformance and a green suite do not establish product value.

Existing config-based model opt-ins are not per-goal billing grants. This pilot therefore uses finite test activation, preserves production defaults, leaves customer/contact/send authority absent, and records returned usage with unknown cost kept unknown. No old quota or PC shutdown monitor is restarted.

## Evidence and work log

- 2026-10-03: Revalidated canonical main and clean integrated Audience worktree. Previous turn made authoritative progress: `main@e528822`, 1,182 Node + 15 Python + build locally and exact-head hosted CI.
- Created this separate worktree from actual `origin/main`; reused installed Node/Python dependencies and the pinned Hermes checkout without copying credentials.
- Independent read-only product audit confirms the existing Audience → reviewed need → Continuity → Workspace material state machines already exist. The gap is real usefulness/activation proof, not another missing workflow engine.
- Existing pilot state is being inspected through read-only SQLite. Runtime PID recorded by the prior pilot is absent; old stop/quota records are not authority to start a new automated loop.
- Native startup initially stopped before any Telegram or model call: the applied `011-source-scout.sql` receipt differed from the new checkout. Independent audit proved the deployed mixed LF/CRLF bytes exactly match the unchanged historical SQL after canonicalization. Added only a version-specific pinned checksum compatibility rule; no migration SQL, stored receipt, workflow, authority or send boundary was changed.
- An immutable deployed-byte fixture (`-text`) and four black-box tests were added first and failed on the old matcher. All four now pass; 27 combined migration/Outcome-transfer/frozen-boundary checks pass. An independent scratch mutation removing compatibility fails the real upgrade acceptance test.
- Upgraded a consistent backup of the real pilot database three times: all original receipts and all Scout row fields remain identical (1 campaign, 65 candidates, 5 grants, 127 jobs, 68 samples, 0 assessments, 319 calls), with no foreign-key violations. The original database was untouched by this backup-only audit.

## Scope and evidence standards

Only still-current explicit monitor grants may support native reads; a retained candidate is not monitoring authority. No joining, private intake, external message, owner-approval fabrication or causal claim is allowed. Work against the same logical partner's live state after process ownership is proven; do not clone a database and treat copied grants as live authority.

Read activation and model activation are separate finite phases. A zero-result, stale packet, malformed model response or unknown outcome is recorded as such. Source timestamps, observation timestamps, coverage/lag, exact evidence versions and model usage must remain inspectable. Any code change must be motivated by an observed failure/friction, covered by a meaningful regression and verified before release.

## Current result

- All three existing monitor sources were confirmed through the native GramJS connection. Two had already been integrity-blocked in the previous pilot at `same_pts_delete_mismatch`. One explicitly delegated `source.reconcile` request per blocked source, bound to its exact checkpoint, allowed a validated same-cursor recovery. No cursor reset, rebaseline, new source/contact authority or relaxed delete reconciliation was used. The old incidents remain unclassified because their diagnostic receipts did not preserve the two delete sets.
- The initial one-source Audience goal had no supported exchange. It was paused through the operator command, retained for audit, and replaced by one goal scoped to the three existing monitor grants. Source completeness remains unknown.
- Native reconciliation produced eight eligible exchanges and four withheld exchanges, with no models, persons, conversations, drafts, contact permissions or deliveries created. The successful second reasoning packet contained five eligible exchanges from one source; this is not evidence of broad coverage of all three communities.
- The first finite Hermes attempt failed because the pilot helper treated YAML single quotes as part of the local proxy key. A read-only `/v1/models` probe exposed HTTP 401; after fixing the local helper, the same probe returned 200. The failed assessment/reservation was retained and not repurchased. One additional explicit bounded test used the next unconsidered packet; no production retry/considered-batch guard was bypassed.
- Real `gemini-3-flash` produced one proposed, unverified need: an organizer requests a volunteer timekeeper for the next community run. Durable support is event `262`, source `telegram:channel:1206867203`. Provider-returned served identity was `gemini-3-flash`; usage was 8,547 input + 242 output tokens. Hermes reported one API call; underlying HTTP/provider retries were not independently measured. Cost is unknown. The two pilot reservations comprise one failed local-authentication attempt and one successful model turn.
- No owner review, accepted business belief, work link, material/draft, contact permission or external send was fabricated. This proves a real evidence-backed lead card, not an owner-ready material or business outcome.
- Independent read-only quality review found relevant countercontext in event `610`: a volunteer-roster check, posted at 07:44:21Z and edited at 11:34:57Z. The model did not reference it. That does not prove the timekeeper role is filled, but it prevents claiming the requirement is demonstrably unresolved. The model correctly preserves missing event date/time and possible responses as unknowns.
- Timestamp review found that event `610` was ingested at 16:15Z despite older creation/edit times. Current evidence packets expose observation time without the canonical post/edit times; transport freshness is not proof of a newly posted request. The timekeeper quote itself was observed approximately 34 seconds after posting. No freshness semantics were changed to hide this distinction.
- The actual operator server serves the dashboard at `http://127.0.0.1:8790`. Authenticated Audience goal/need APIs returned the proposed card, exact quote, current scoped evidence, `contact_permission:false` and no allowed effects. This verifies server/API inspectability; it is not a rendered-browser test.
- Started a separately bounded read-only observation process against the same logical partner/database and existing monitor grants. It uses the existing scheduler, reader registry, durable cadence and read budgets. All model switches and live sending are off, model credentials are removed from its child environment, private allowlists are empty, and the local activation expires at 2026-10-04T16:33:42.846Z. No startup/login autorun or production config change was made. Individual sources can become lagging or blocked; a budget/transport failure is not current evidence.

Local release gate: **1,186 Node tests + 15 Python tests + build PASS**; `git diff --check` passes. The combined focused migration/Outcome-transfer/frozen-boundary suite passes 27/27. Hosted verification and integration are pending at this document revision.

Private verification packets, receipts, consistent backups and process controls stay in ignored `.cache/real-audience-pilot`; public community text and credentials are not committed. The read observer has no quota-based poweroff logic.

## Next architectural decision from actual evidence

Before another infrastructure layer, complete the owner-facing attention loop: distinguish post/edit/observation time; confront a proposed need with related available countercontext; make uncertainty and the proposed material inspectable before a separate owner decision. Preserve the existing Audience, Continuity, Workspace and Action authority transitions. A single good quote and a green suite do not prove relevance, unresolved need, or a useful finished material.

Current practical handoff: inspect the Audience card for the volunteer timekeeper, compare it with the volunteer-list discussion, then decide whether preparing anything would help. No review or contact decision has been made on the owner's behalf.
