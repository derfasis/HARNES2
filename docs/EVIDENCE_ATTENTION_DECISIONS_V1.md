# Evidence-backed Attention Decisions v1

Base: `main@dfbb8802a584e7508356ed9a1262492564d4e95f`.

## Problem and acceptance before implementation

The finite native pilot used 13,800 reported input tokens to return `{"needs":[]}` for three selected exchanges. No explanation was recorded. Its serialized Hermes user context was 27,786 UTF-8 bytes; 11,918 bytes came from withheld exchange bodies and assessment history that the model must not use as current evidence. Token cost remains unknown. These are measurements of this recorded sample, not a claim about general savings or usefulness.

Keep the durable canonical packet. Give the existing no-tool Hermes turn a separate, versioned model projection containing every selected exchange and its exact evidence, all relevant clocks, bounded historical hypothesis memory, and honest omission/coverage counts. Omit operator history, withheld source text, and redundant service metadata. Do not introduce a keyword classifier, parser, runtime, queue, or provider. Existing AJV, SQLite, Hermes and Control Plane remain the plumbing.

New model attempts must return a versioned `decision_review` even when there are no needs. It covers each supplied exchange exactly once, cites its actual event IDs and exact quotes, explains the choice, and records unknowns. Its scope is the supplied packet only. It is an unverified interpretation, never evidence of resolution, causal success, contact permission or owner review. Needs retain their existing selected evidence/context dependencies. Review is stored in the existing assessment output and bound to the closed run receipt; no schema migration is needed. Historical/manual outputs remain readable without invented explanations.

Black-box acceptance first:

- A valid empty model result closes as `no_need_proposed`, with inspectable reasons and exact citations, consumes one admitted attempt, and cannot rebill after restart.
- Missing, duplicate, omitted or foreign exchanges, foreign event IDs and altered quotes fail closed. A valid neighboring positive case passes.
- Edit/delete/revoke and late completion with stale authority still prevent dependent work. Persisted review corruption is shown as invalid, not a verified decision; its unrelated sibling need does not gain or lose authority.
- Prompt projection preserves all selected supporting/counter/resolving texts and separate published/updated/observed clocks. Withheld text/history do not reach the model. Canonical durable packet stays unchanged.
- Manual and historical empty results explicitly say rationale was not recorded. No automatic owner acceptance, Work creation, person, conversation, draft, grant renewal or send follows a decision review.
- Operator UI escapes source/model text, labels packet-only interpretation and unknown resolution, distinguishes current/stale/invalid/historical, and exposes usage without treating unknown cost as free.

After focused acceptance: relevant existing convergence/recovery tests, full Node regression, Python credential isolation, build, diff check, copied guard-removal probes, and finite real-provider conformance. Native observation stays read-only; synthetic provider fixtures must be labeled synthetic. Do not repurchase the consumed native pilot cap or extend its source grants.

## Implemented boundary

`audience-decisions.mjs` contains the product-specific prompt projection and decision-to-evidence bindings. Each new model run freezes contract/projection version 1 and its input fingerprint while retaining the full canonical packet. Apply checks the unchanged live run and packet, current evidence, original authority and Control Plane ticket before validating output. The existing transaction/savepoint makes the review and any proposed needs atomic with the closed receipt. The receipt fingerprints the complete output; read-time proof binds it back to the exact run, assessment, goal and packet. Missing, corrupt or downgraded modern records fail closed. A corrupt interpretation does not rewrite an independent need's selected evidence basis.

An ordinary valid empty result now closes as `no_need_proposed`; a focused empty result keeps `no_revision_proposed` and does not revise or resolve its target. Old/manual records can omit review and explicitly display `not_recorded`. Historical model contracts remain readable; new run admission always requires the modern review. Existing explicit retry, finite attention grants, shared resource budgets, fair rotation and restart fences remain in use. No new table, migration, scheduler, parser, provider or effect capability was added.

The operator panel shows exact quotations and clocks, per-exchange reasons, limited coverage, unknown resolution and attempt usage. Invalid interpretation payloads are hidden, including in raw output details. Current/stale labels must agree with server freshness. Exclusion counts describe only the bounded canonical sample; total missing history/backlog remains unknown. Focused packets' nested exclusion lists follow the same rule.

Trusted instructions now appear only in the no-tool worker's system prompt, rather than also in its user JSON. The existing runtime blob pin was updated for this reviewed envelope change; transport, tool, credential and send tests remain in place. Existing model fakes were upgraded separately from manual proposal fixtures, including malformed-need cases, so the old quote/context/freshness guards are still exercised.

The existing synthetic conformance CLI now acquires one finite test-only goal grant, accepts a valid explained no-op, revokes the grant, disables model reasoning on exit, and retains its isolated SQLite receipts and usage. Its existing cumulative attempt cap is preserved. It never enables native Telegram, customer contact or production sending.

## Evidence gathered

- New black-box acceptance was red before integration. Final decision cases cover modern mandatory review, each exchange exactly once, bound references/quotes, disposition consistency, stale edit/delete/source withdrawal, live contract downgrade, transfer, receipt corruption, no resurrection after restart, historical empty results and independent need basis preservation.
- Five guard removals in copied snapshots were killed by behavioral assertions after successful syntax checks and fake-provider callbacks: mandatory review, complete exchange coverage, event membership, exact quotations and the closed output fingerprint. Source snapshots and original files were preserved.
- Final local `npm run verify`: **1,355 Node tests + 15 Python credential-isolation tests + build — PASS**. `git diff --check` also passed. This includes 24 decision acceptance cases, 12 operator UI cases, two projection cases and two copied offline CLI cases. The CLI cases prove finite grant closure and durable history-cap refusal; their fake provider does not claim a real transport or model call.
- A read-only reconstruction of the recorded native packet, using a donor prompt matching its recorded fingerprint, measures 27,656 UTF-8 bytes of old user context versus 8,573 before the final small prompt clarification. The canonical packet remains 18,258 bytes and the model projection 4,205 bytes; all selected source evidence is identical. Provider framing/tokenization is excluded. The earlier 27,786-byte audit used slightly different context framing. Neither reconstruction proves a token/cost saving percentage.
- Real Gemini conformance used isolated **synthetic** stores, not the native pilot or its consumed cap. The negative sample covered three greetings, a question with a resolving reply, and an injection attempt: one logical turn/client API call, 5,967 input + 687 output tokens, no need, all five exchanges explained.
- The first positive sample produced an inert useful checklist: one call, 5,713 input + 1,505 output tokens. Inspection found an unwanted suggestion to contact participants despite the stated internal-only objective. General instructions were clarified rather than adding a topic-specific classifier or relaxing authority.
- A fresh finite positive verification after that clarification produced an internal-only checklist with one call, 5,799 input + 1,373 output tokens. Evidence `[5]`, counterevidence `[7]` and context `[9]` all remain in the **server-derived preview basis**. The model's displayed citation subset cannot narrow that dependency basis. It proposed one need for review; nothing was accepted, drafted, transferred to Work or executed.
- All three successful provider receipts report Gemini 3 Flash and unknown cost. Client API counts are observed; upstream retries/version are not attested. Each test grant was revoked, switches disabled and Control Plane ownership released. An earlier private test-driver setup failed; its original consumed cap was retained and missing usage stays unknown. Async test commands and failure-record preservation were fixed before a separate fresh cap was used. This was a test-driver failure, not a product migration or transport fix.

## Remaining limits and release

References and exact quotes prove grounding, not the truth or usefulness of the model's interpretation. One corrected positive preview still failed to explicitly preserve the open role “who checks the route?” and added a runner roster as an unknown rather than a fact. Owner review remains necessary. These few synthetic cases are conformance evidence, not recurring accuracy, recall, causal attribution, audience completeness or sales success. No browser visual smoke is claimed; UI behavior is tested through its actual module and operator interfaces.

The existing three-source native observer retains its original deadline and read-only/no-model authority. This milestone does not renew source grants or silently buy unattended model turns. Normal integration is authorized only after local full regression, credential isolation, build, diff check and hosted verification of the exact release head; no protection bypass or force push is permitted. Branch: `codex/evidence-attention-decisions-v1`. Exact release SHA and hosted run are recorded in the private release handoff after verification.
