# Native blind replay capture — 2026-10-11

These are **actual model outputs for researcher-authored synthetic discussions**,
not Telegram customer data or identified leads. All 14 runs traversed the existing
HARNES Audience → pinned Hermes → bounded gateway → owner-configured local proxy.
Each cell consumed a fresh one-forward reservation; no automatic replay, fallback,
production activation, contact or send occurred.

- `results.json`: allowlisted portable source packets, exact outputs, native
  receipts, usage, check results and SHA256 links to immutable local reports.
  Raw provider responses, private configuration and credential data are excluded.
- `frozen-manifests.json`: both pre-call frozen manifests and separate gold.
- `repolab-inputs.json`, `repolab-gold.json`: exact pre-existing synthetic RepoLab
  fixture bytes. Their expected SHA256 values are retained in the frozen manifest.
- `semantic-review.json`: separate post-run root judgments and limitations.
  Original outputs keep `NOT_REVIEWED`; their ledgers and reports were not rewritten.

The original four source/gold fixtures also remain in
`benchmarks/commercial-task-fidelity-v1/`. Canonical arm A was used in every call.
Gold was not included in the model context. No tuning occurred between calls.
The objectives of the two groups differ; **this is not an A/B experiment**.
Currentness of an ingestion basis does not verify a person's continuing intent.

Requested model: `gemini-3.7-flash-high`. Reported model in all 14 responses:
`gemini-3.8-flash-n`. These labels do not attest model weights or provider origin.
Reported usage: 89,419 input + 51,745 output = 141,164 tokens. Billing, reasoning
token breakdown, internal upstream retries and subscription percentage are unknown.

Outcome: transport/contract 14/14 PASS; RepoLab stated-intent classification
TP=4, TN=6, FP=0, FN=0 on ten intentionally constructed cases. Strict semantic
fidelity **10 PASS / 4 FAIL**. Do not present this as market precision or readiness
for automatic outreach. See `docs/NATIVE_AUDIENCE_BLIND_REPLAY_2026-10-11.md`.
