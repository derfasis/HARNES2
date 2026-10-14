# Native Audience fidelity investigation

**Decision: neither prompt candidate is adopted. Production behavior and its canonical reasoning prompt remain unchanged.** This is a saved negative experiment and reusable synthetic decision dataset, not a released semantic fix.

Base: canonical `main@16a43ae72d1716179c4db788781381c806ac6de0`. Reply topology is retained. No runtime, authority, schema, source reader, send fence, scheduler or production configuration changes.

## What the native tests showed

Source identity, exact quotations and correct task recognition did not guarantee faithful paraphrases. After every selected reply edge reached the actual model input, Audience could still turn future comparison into activity underway, an undecided option into rejection, or no initial purchase into no start-up investment. More sources or a green software suite would not prove these interpretations correct.

Two general instruction candidates preserved speaker, modality, timing, commercial scope and unknowns across all fields. They added no sales scripts, keyword classifier or extra model judge. Individual responses improved, but both retained material errors. Exact experimental prompt bytes remain under `benchmarks/audience-interpretation-fidelity-v1/prompts/`, separate from `partner/`.

## Runs

Native route: BusinessService → profile-bound attention → Audience assessment → pinned Hermes → existing CLIProxyAPI. No web-model substitute. Each logical attempt used an isolated Store and one-use grant, with no retry/resume of spent attempts.

| Batch | Run ID | Attempts | Semantic result |
| --- | --- | ---: | --- |
| Unchanged baseline | `6bff44f7-4622-44a5-93da-aa5250ebd386` | 4 | Core tasks correct; factuality fails |
| Candidate 1, controls | `4d9fd676-825d-4082-9923-c45444edaf8a` | 4 | Useful tasks retained; factuality review required |
| Candidate 1, new holdouts | `89188930-4383-46dd-a534-54867eb98acc` | 2 | Positive tasks retained; material errors remain |
| Candidate 2, controls | `df9aa167-2486-4f42-ab14-fcb2415e0e62` | 4 | Useful tasks retained; factuality review required |
| Candidate 2, repeated holdouts | `d34d67ce-0707-4214-b3e1-d069b883f127` | 2 | Better in places; material errors remain |

A001/A002/A004 contain own tasks; A007 is a quoted-request ownership negative. The original 10-case/53-message input was hash-checked before selecting these four (`8b91487da693ba5ea518e46c94c9257357cd3a18edb034b2c874089dcc329498`). Each four-case batch delivered all 21 messages and 17 exact source/author/event/version/reply pairs.

H001 tests conditional procurement; H002 tests a fixed-fee service inquiry alongside a client's quoted affiliate question. Each holdout batch delivered nine messages and seven exact reply edges. Input SHA `449b2c968daa55f6eaedc0252e897657b3994641e8e3b2d4c1ede1cb35275e17`; separate gold SHA `940c3592cf6a6a6079f97a0ac2f439c914504461193c814caca4097da1e18a52`. Objectives explicitly request cautious internal analysis: controlled instruction following, not unprompted live behavior.

## Failures stay visible

- Baseline: A001 strengthens comparison timing and infers no warehouse; A004 turns undecided supplements into rejection and adds unsupported FitLine mismatch.
- Candidate 1: A002 broadens no initial purchase into no start-up investment. A004's scope clarification is classified as counterevidence to the inventory need. Holdout reviews flag conditional status, quote receipt, attribution and business framing.
- Candidate 2: A004's evidence classification improves, but material still strengthens the supplement position. A001 WHY NOW overstates comparison status; A002 adds an unsupported negative about developing a brand. H002 turns an unaccepted offer into an explicitly rejected one. H001 urgency/counterevidence framing remains questionable.

Independent reviews are retained as evaluations, not infallible source truth. Some classification judgments depend on the particular hypothesis. The release decision does not require accepting every flag: clear material overstatements remain, so there is no unconditional factuality PASS.

Gold, scoring protocol, prior outputs and case-specific corrections were not passed to the model. Root/reviewers knew prior failures; repeated controls and the second use of holdouts are not blind. Native originals were saved before review and never edited into successes. A later baseline hash audit records that it occurred after review began. Different stochastic responses do not establish causal A/B improvement or general accuracy.

## Usage and safety

Sixteen logical attempts completed: **107349 input + 75081 output tokens** recorded. Exact outputs, source fixtures, three prompt snapshots and five independent reviews are pinned in the manifest. Requested alias `gemini-3.8-flash-high` returned provider-reported `gemini-3.8-flash-n`; no independent model/weights attestation is claimed. HTTP retries/rotation, money and Gemini quota percentage are unknown. Requested output limits are not a proven aggregate spending ceiling.

Test runtime, scheduler, Telegram and live sending stayed off. Grants/profiles were revoked and no persons, conversations, contact permissions, drafts, approvals, delivery attempts or action attempts were created. Existing freshness/revocation and review fences remain. The current UI already shows saved source statements before unverified interpretations; that inspection boundary is retained.

The final prompt candidate passed 1706 Node tests, 35 Python tests, build and diff check; semantic evidence still rejected it. After restoring the canonical production prompt, the report-only tree independently passed the same full gate (1706 Node, 35 Python, build and diff check). All 27 manifest-pinned artifact hashes also match staged Git bytes, including exact historical prompt endings; configured-secret scanning found zero matches. All 16 Stores were checked for zero active grants/profiles, Control Plane owners/tickets and effect records. Hosted exact-head status must be checked separately before merge. A software PASS is not a semantic PASS.

## Next useful step

Use the current route as a review-assisted radar, not autonomous qualification authority. Compare a genuinely different configured reasoning profile before adding more automation or another generic instruction rule. A zero-generation metadata probe found Gemini Flash aliases and no Gemini Pro alias in the current proxy; this does not prove there are no alternatives from other providers. Do not invent a stronger profile, silently alter rotation or claim verified model identity.

Owner market, exact role, current terms/costs and concrete team support remain unverified. A public question is not FitLine compatibility, consent or conversion. A truthful offer plus voluntary inbound remains the business experiment; synthetic recognition does not replace it.
