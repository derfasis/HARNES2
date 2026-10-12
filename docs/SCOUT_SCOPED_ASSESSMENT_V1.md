# Scoped Scout assessment v1

Scout already reads bounded Telegram history, selects discussion groups, and presents source assessments for owner review. This increment makes that existing model capability usable in a managed `scoped_reasoning` deployment with global model switches disabled. It does not import history into Audience, start continuous observation, or identify a qualified recruitment lead.

## Separate authority

An operator issues `scout.request_assessment` with an exact campaign revision, candidate, sealed sample, `model_profile_id`, `expected_model_profile_hash`, finite `expires_at`, and `purpose`. The registered profile is configuration metadata; it is not permission. The request authorizes one model attempt. The current independent Scout audit grant remains required for the account and source. Managed `read_only` deployment rejects inference even with a valid request.

Migration 019 adds `scout_model_requests`. Its closed, hashed immutable definition binds partner/account/campaign/topic/audit grant/candidate/source/sample digest and cursor/evaluator/model profile and frozen execution bounds. The run ID is latched once. Existing Scout jobs, run receipts, SQLite transactions, Hermes adapter, Node scheduler, Control Plane admission, model profiles, prompt and strict output validator are reused. No new parser, queue, model framework or Telegram transport was introduced.

The effective model settings are resolved from the pinned profile, independently of global runtime settings. The worker permits one HTTPX-visible model request; its existing hooks include SDK retries and credential rotation. A retry entirely inside the external proxy is not observable here. Two Hermes iterations do not grant two HTTP requests. Costs without sufficient provider or configured price evidence remain unknown.

## Lifecycle and failure paths

`explicit request → queued job → current checks → atomic run binding → no-tool model → current checks → proposed assessment / withheld receipt → owner review`.

Exact repeated payloads resolve to the same durable request, including after completion or restart. A new attempt needs a new explicit finite request. An interrupted or receipt-failed attempt stays spent; mutable job status/attempt counters cannot clear its run binding. Source edit/delete or observation cutover, campaign revision, audit revocation/expiry, model-profile revocation, request revocation/expiry, deployment stop/expiry and process-ownership loss prevent dependent work. The receipt failure latch prevents additional automatic reasoning until recovery; startup does not replay the spent attempt.

`scout.revoke_assessment` uses `request_id`, `expected_fingerprint`, and `reason`. Revocation during inference withholds the assessment while retaining known usage. Historical receipts remain inspectable; they are not current advice when their basis or authority is stale. Export includes request and attempt history. Import revokes request/profile/audit authority and never restores executable permission. Pre-019 export catalogues remain exact and do not invent the new table.

The existing operator Source Scout screen offers an explicit one-assessment form with profile, expiry and purpose, and a separate revoke control. Merely opening the screen or form makes no model request. Existing legacy requests keep their existing explicit global-config boundary.

## Evidence and product limits

The model packet describes a bounded, non-atomic history sample, its time window and coverage, selected discussion groups, and omissions. It states `continuous_coverage=false`, current intent and offer fit unknown, and contact permission false. A recently captured sample can contain older messages: capture freshness is not present buying intent.

The output schema validates references against supplied messages, not semantic entailment. A valid JSON assessment or successful model call does not prove relevance, unresolved need, FitLine fit, income potential, contact consent, factual correctness of peer advice, or participant authenticity. Those require independent evidence and owner inspection. Source assessment approval does not create person/conversation/draft/send authority or monitoring membership.

## Verification

Black-box scoped tests cover disabled global switches, independent read/model authority, exact sample/profile binding, late revocation, edit/tombstone invalidation, unknown accounting, receipt failure, restart/replay and marker-removal fallback. Import and UI interaction tests cover historical catalogues, transferred authority and explicit forms. Python tests run the real worker against a loopback fake provider and prove one generation POST, preserving the existing follow-up two-request boundary. Full repository regression, credential isolation, build and whitespace checks are required before release. A separate real CLIProxy/Gemini run assesses product usefulness; offline fixtures do not substitute for that result.

Verified on the implementation branch based on `main@d74329d`: **1664 Node tests, 34 Python tests, build and `git diff --check` pass**. Independent review found and closed nested command transactions, stripped-marker fallback to legacy global config, mutable-job replay/reporting, and starvation behind disabled legacy jobs. Current migration count is 19; historical input catalogue versions were preserved, with the newly added table excluded from older fixtures. Existing runtime and model-identity behavior remained covered by regression tests.
