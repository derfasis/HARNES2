# Scoped Audience Model Activation v1

Status: implemented; local verification and a bounded real-provider conformance check completed. Canonical base: `ac66e140e4076c5ee30e7e65fd0524f9806eec57`. No native model pilot has been activated by this milestone. Main integration requires the exact-head hosted gate as well.

## Product result and gap

An operator can choose an immutable model profile and grant finite ordinary Audience attention to one existing goal from the dashboard. The selected job uses that profile while global model settings and other model-plane switches remain unchanged. The result is still an unverified, evidence-backed proposal requiring the existing reviews. This does not provide source onboarding, private conversation activation or longitudinal resolution tracking.

Currently `AudienceAttention.modelScope`, `audience-reasoning.prepare`, `Scheduler.reasonTick` and `HermesAdapter.run` depend on global runtime configuration. Filling those settings to unlock one goal also makes other configured public inference paths ready. A goal grant alone cannot select an independent model. The next product step therefore needs explicit scoped activation, not a general dashboard config editor.

## Boundary and records

- Profiles are immutable metadata: provider/API mode, endpoint, model, output limit and optional declared token prices. No secrets, secret names, filesystem paths, tools or send permissions. Editing means creating a new profile; revocation is terminal.
- V1 profiles use only the existing `custom` OpenAI-compatible transport (including CLIProxyAPI). Other Hermes provider modes are not advertised without evidence that they honor the same endpoint/credential boundary.
- Endpoint authority is server-side: the existing configured runtime endpoint and explicit `modelProfiles.allowedBaseUrls` form the allowlist. The dashboard cannot redirect installed credentials to arbitrary hosts. Revoking/changing this policy blocks dependent jobs. Defaults have no extra allowed endpoint.
- Existing finite Audience grants bind the profile ID and definition hash in their canonical fingerprint. A small separate binding table preserves historical grant definitions and attempt accounting. Profile existence is never a grant.
- Admission, attempt consumption, frozen run creation and existing CP ticket binding remain one SQLite transaction. The frozen model configuration and profile/grant binding must agree before dispatch and before application. The last admitted attempt may finish; restart never refunds or automatically repeats it.
- Only ordinary Audience jobs may use the new scoped authority. Manual captured packets remain manual. Focused reassessment/retry paths retain their existing global activation requirements and cannot borrow another profile grant.
- Existing source permissions, currentness, goal revision, shared CP ownership/concurrency/reservations, global/Audience budgets and unknown-cost latch remain mandatory. Profile prices apply only to that profile's job and never turn unknown cost into zero.
- The Hermes no-tools worker and credential-isolated environment are reused. No second queue/runtime, parser, provider client or generic framework is built; custom code covers HARNES-specific evidence/authority/operator rules. SQLite, AJV, existing DOM helpers, scheduler and Hermes are the OSS/reused infrastructure.
- Export/import preserves metadata and history but revokes active profile/grant authority at transfer. Historical schema catalogues through migration 013 remain accepted.

## Lifecycle

Trusted installed endpoint/key readiness → operator creates available profile (zero calls) → operator previews goal/source/model/cap/expiry → explicit finite grant → scheduler admits only that goal → exact immutable model sent through Hermes → usage/receipt retained → independent currentness/authority validation → proposal or withheld result → existing owner review. Profile or grant revoke, stale evidence, expiry, lost process ownership, unknown budget or malformed binding fail closed. No new contact, person, conversation, Work acceptance, material approval or send.

## Acceptance and kill tests, before release

1. Profile create/list/revoke are operator-only even on replay; malformed/secret-bearing fields and non-allowlisted endpoints fail. Creation changes no global flag and creates no run.
2. With global runtime/model settings and Audience model switch off, one explicit profile grant spends one ordinary Audience turn for goal A; goal B, legacy grants, focused captures and eligible-looking other-plane work make no provider call.
3. Exact selected provider/model/endpoint/output bound and declared prices reach the frozen run and actual Hermes envelope. Global config mutation cannot retarget it.
4. No key, CP disabled/owner loss, stale/revoked source/policy, expired/revoked/tampered profile/grant/binding and exhausted caps block dispatch or late application. Usage remains retained on withheld results.
5. Global/domain financial/run budgets, unknown-cost stop and CP capacity block before spending; profile creation/grant does not override them.
6. Restart preserves cap/receipt and cannot resurrect profile/grant; transfer retains history without executable authority; pre-014 bundles still import.
7. Dashboard displays endpoint readiness, immutable model identity, bound grant and limits without secrets or false promises of no billing. Review/material/contact/send boundaries remain separate.
8. Own focused mutation probes, full Node/Python/build/diff gate and exact-head hosted CI before main integration. Any finite real model check uses isolated synthetic data and separate test authority, never a reset of the native pilot cap.

## Scope deliberately retained

Longitudinal partial-answer tracking and day-two Workspace reassessment remain real next gaps. This milestone does not claim to resolve them. The native observer remains read-only, model-free and governed by its original finite deadline. Automatic PC shutdown was cancelled by the owner; do not rearm it without a new explicit instruction.

## Operator setup

This is activation for an already-installed read-only Audience setup, not a switch from every disabled default. The existing Audience feature, permitted sources, Control Plane and automatic public boundary must already be configured. Install the provider credential in the existing local environment. Approve destinations at server startup, for example `modelProfiles.allowedBaseUrls: ["http://127.0.0.1:8318/v1"]` for an existing local CLIProxyAPI. An empty allowlist plus an empty global runtime endpoint permits no new profile destination.

Leave `runtime.enabled: false`, `runtime.model: ""`, `runtime.baseUrl: ""` and `audience.modelEnabled: false`. In the Audience goal, create a metadata-only `custom` profile, inspect source readiness/budgets, then explicitly choose it in a finite attention grant. No enduring global setting is enabled by these commands. The grant may permit a billed model turn at the next scheduler pass. It does not guarantee exactly one upstream HTTP request: the pinned worker may make its one bounded empty-response retry. Reported provider calls/usage may remain unknown.

With a financial limit configured, an earlier unknown-cost run still blocks admission. A profile does not reset that ledger or override the global/domain cap. Model profile rate fields are declared estimates, not an attested price or a hard real-world billing ceiling. The native observer used during engineering deliberately removes model credentials; creating a profile does not circumvent that read-only pilot.

## Independent review findings

- A completed decision could remain visually current after its persisted profile/grant proof changed. Read-time assessment validation now checks the historical run/grant/profile binding, selected model configuration and bound receipt metadata.
- Merely hiding that review was insufficient: the derived need could still be accepted and promoted to Work. Need admission authenticity now validates the same historical grant/profile proof before owner acceptance, Work or material import. It remains separate from source freshness and from review-only rationale. An unrelated corrupt audit summary cannot rewrite a valid need's evidence basis; a revoked profile does not invalidate genuine prior work.
- The first UI projection expected a flat profile binding while the canonical grant uses `model_profile`. The UI now reads the canonical ID/hash and does not mislabel a scoped grant as a global model.
- A generic dashboard notice incorrectly implied that all model calls were off when the global switch was off. It now distinguishes the global switch from finite scoped authority and makes the possibility of billing explicit. A canonical-binding UI test covers this state.
- Arbitrary Hermes provider identifiers were wider than the verified endpoint boundary. New profiles are restricted to the existing `custom` transport. No upstream or credential adapter was changed.
- A corrupt prior need proof could abort goal-detail construction and roll back the rotating admission cursor, starving a healthy neighboring goal. Domain errors now withhold only that goal and let the durable cursor advance. A two-goal test corrupts A's completed proof while A still has an unused attempt, then proves that exactly one call can reach healthy B without accepting A. Unexpected non-domain exceptions still abort the pass rather than being hidden.

The accepted alternative was not a mutable global configuration editor or a second runtime. The implementation removes global-config dependence for this ordinary Audience path while retaining legacy behavior for explicitly enabled legacy paths.

## Verification

The focused acceptance suite was first run red against the missing scoped admission/dispatch path. The final gates and release SHA are recorded in the release handoff; the existing hosted Windows `verify` workflow is unchanged and must succeed on the committed head before integration.

Final local gate on 2026-10-04: `npm test` **1,399/1,399 PASS**; `npm run test:credentials` **15/15 PASS**; `npm run build` **217 JavaScript/JSON and 9 Python files PASS**. The release diff must also pass `git diff --check`. The baseline had 1,364 Node tests; the 35 added tests cover admission, runtime envelopes, review/Work authenticity, restart/revocation/transfer, neighboring-goal isolation and the operator surface. These results do not prove native recommendation usefulness.

Four focused mutation probes ran in an isolated copy with no credentials, native data or network calls. Their positive baseline passed 61 tests. Each intended semantic assertion caught removal of its corresponding protection: endpoint allowlisting, assessment history authority validation, derived-need admission validation, and frozen-profile Hermes dispatch. All four copied modules were restored to their saved pristine hashes. This is evidence for those four boundaries, not exhaustive mutation coverage.

The installed Gemini/CLIProxyAPI route was tested once on a new isolated synthetic volunteer-briefing store. One reported API call used 5,473 input and 1,431 output tokens and produced a current, schema-valid, evidence-backed proposal with one need. The proposal identified an unassigned route reviewer and unknown checklist version; it did not turn an old map update into proof of a completed route check. The served alias was `gemini-3-flash`; an independently attested upstream version was not available. Cost remained unknown. Global runtime, Audience model, scheduler and sending switches stayed off; no persons, conversations, drafts, approvals, deliveries, contact permissions, tasks, Work cases/materials or actions were created. The finite grant and profile were revoked afterward.

An earlier isolated setup attempt was blocked by Control Plane public-slot capacity before a run, assessment, attempt or provider call existed. Its cap/store were retained and not reset; the single successful call used separate named test authority after a public-capacity preflight. Neither attempt altered the native observer, its source authority or its exhausted model cap.

Remaining limits: this is not all-off onboarding, does not activate focused/retry/private planes, and does not implement day-two resolution tracking. No native UI billing activation or longitudinal useful-result claim is made. The finite read-only native observer continues on its previous verified release until its existing deadline. Declared token prices remain estimates, unexpected exceptions fail closed, and the previously observed Telegram same-PTS delete mismatch has no proven root cause from the retained evidence.
