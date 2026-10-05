# Source assessment conformance v2

Base: canonical `main@181c51bd5838040015a162aa62846893b7bae4bb`.

## Problem and change

A finite fitness search produced six accepted assessments and four generic
`SCOUT_OUTPUT_INVALID` failures. A separate diagnostic replay reproduced one
Markdown-fenced response. Original rejected response bytes were not retained:
the replay does **not** establish the cause of all four historical failures.
Gemini also interpreted a list of related topics as mandatory simultaneous
requirements, excluding a relevant running community.

The evaluator is now `scout-assessment-v2`. Its rubric distinguishes related
interests from explicit requirements/exclusions. It does not hard-code fitness
exceptions or turn every owner conjunction into OR. Missing sampled evidence
should yield uncertainty/defer, not an invented categorical mismatch. Campaign
queries are search hints, not proof that the returned community is relevant.
No bot/human classification or invented spam percentages/thresholds are added.

The output instruction requires exactly one raw JSON object, including required
fields and message references. The existing v1 JSON schema and AJV remain the
contract. Markdown stripping, JSON repair, default filling and automatic paid
retries are deliberately absent. Prompt compliance remains a model behavior;
the business gate independently checks completion, tool traces, 24000 UTF-8
bytes, strict JSON, schema, references and positive evidence for `consider`.
Malformed nested tool-call traces are withheld too.

## Durable, safe failure explanations

`runs.result_json.diagnostic` uses closed stage/code pairs. It distinguishes
model failure, forbidden tool traces, non-text/oversize/fenced/invalid JSON,
schema mismatch, unavailable references and missing positive evidence. Only
allowlisted AJV keywords and the existing normalized provider-failure contract
can accompany those codes. Raw responses, provider text, exception messages,
AJV params, instance paths and invalid property values are not persisted here.

The campaign jobs API projects this field through the same closed sanitizer;
malformed/corrupt/unknown diagnostics become null. The existing Scout jobs
surface shows fixed Russian explanations. Rendering cannot enqueue a retry.
Generic public reason codes remain stable. Source/grant/ownership checks run
before output diagnosis, so retired authority is not misreported as a JSON
failure. Token usage remains charged on rejected and retired completions;
missing usage/cost stays unknown. Receipt persistence faults retain the existing
latch and explicit-retry recovery policy.

Each new run freezes campaign configuration plus instruction/contract digests
beside sample/topic/revision/evaluator provenance. Historical assessments retain
their immutable version. Version-1 pending jobs are made stale before billing;
reconciliation also retires them with billing disabled; corrupt cursors do not
block healthy neighbors. Old advice cannot silently qualify as a version-2 admission basis. Independent
explicit owner monitor grants continue across this evaluator upgrade, including
after restart. No migration, transport change or monitor-authority rewrite is
needed. `hermes-scout-v1` still names the unchanged runtime protocol.

## Real conformance check and limits

Five finite, separate diagnostics used the configured loopback CLIProxyAPI and
existing Hermes no-tool worker, requesting `gemini-3.7-flash-high`:

- Three frozen historical packets: `parkrunpetergof`, `runcht`, and FitStars.
  All returned raw JSON passing the unchanged schema/evidence gate, with
  `consider`. These are archival diagnostics, **not** fresh assessments or
  newly admitted monitored sources.
- Synthetic paired control: related training interests yielded `consider`;
  an explicit exclusion of running-only communities yielded `unsuitable`.
  Both controls passed. They are synthetic, not evidence of customer demand.

Five adapter runs/five observed API calls: **34543 input + 1474 output tokens**.
Pricing and served model identity were unavailable and remain unknown; the
requested alias is not proof of the served model. No people, conversations,
drafts, delivery attempts, contact permissions, Scout assessments/jobs/calls/
grants, public source-message events or remaining control owners were created.
Workers and the proxy owned by this verification were closed.

This small check shows conformance improvement on selected examples, not a
reliability rate or validated commercial quality. Existing production defaults,
deployment activation fences and the owner's pinned launch profile are intact.
In particular, this does not claim native automatic Scout billing activation.

## Quota transparency

Search and the earlier six-call debrief recorded 140397 input + 7509 output
tokens. Including this five-call check: **174940 input + 8983 output tokens**.
CLIProxy's cached auth metadata contained no Gemini quota fractions. The native
quota endpoint refused all seven enabled Antigravity credentials with HTTP 403;
quota telemetry failure is not evidence that model inference failed. No usable
before snapshot or denominator exists, so percentage consumed is **unknown**.
Token counts are not a percentage of either Gemini's quota or the owner's Codex
subscription. No auth identifiers/credentials or provider response bodies are
included in this report.

## Acceptance and release

Focused black-box tests cover valid JSON controls; provider failures; forbidden
and malformed tool traces; UTF-8 byte limits using schema-valid oversized JSON;
fenced/invalid JSON; safe schema diagnostics; false/missing references; restart
without retry; revoked authority during inference; version retirement; immutable
historical advice with independent monitor continuation; and corrupt persisted
diagnostic projection. UI tests cover fixed explanations, escaping, prototype
keys, absence of raw provider data and zero write commands on rendering.

Release requires focused tests/red-team, `npm test`, `npm run test:credentials`,
`npm run build`, `git diff --check`, and the protected hosted Windows CI on the
exact commit. Verification results are recorded after those checks complete.

Local final verification: **1540/1540 Node tests, 25/25 Python tests, build
246 JavaScript/JSON + 11 Python files, diff check — PASS**. Focused conformance
and UI: 22/22. Independent review found the billing-disabled queue retirement
gap described above; it was fixed and covered with a healthy-neighbor control.
Deliberately removing each of nine boundaries made the focused suite fail:
strict fenced-JSON handling, byte cap, schema, sampled refs, positive evidence,
tool traces, provider redaction, pre-billing evaluator check and offline cursor
retirement. All mutations were restored before the final full gate. The matching
live instruction digest was checked after restoration. Hosted CI remains an
exact-commit release check, not a claim made from these local results.
