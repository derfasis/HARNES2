# Discovery synthetic contract evaluation v0 — report

`proof_level=synthetic_contract_eval` · `live_proof=false` · baseline `0f0d965`

Discipline of the reasoning structure and of the policy limits, on synthetic cases. The truth,
the usefulness, and the quality of any hypothesis were **not** evaluated and cannot be evaluated
without a model run, which this stage does not do.

## Result

| Measure | Value |
| --- | --- |
| Cases | 30 |
| Well-formed fixtures accepted by the real contract path | 30 / 30 |
| Deliberately bad fixtures caught | 30 / 30 |
| Caught by production | 9 |
| Caught by the scorer's own checks | 21 |

Codes raised by the scorer: `DECISION_POLICY_INCOMPATIBLE` (1), `UNSUPPORTED_CERTAINTY` (1), `UNSUPPORTED_PERMISSION_INFERENCE` (19), `URGENCY_OVERRIDE` (6).

No product finding was found in this run: every deliberately bad fixture was caught, and no
well-formed fixture was rejected or let through.

## How each bad fixture was caught

Each row states an explicit outcome: `production`, `scorer`, or `missed`. A run that leaves any
`missed` exits non-zero, as does a run with a failing well-formed fixture.

| Case | Caught by | Code |
| --- | --- | --- |
| `weak_signal-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `weak_signal-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `weak_signal-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `weak_signal-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `pressure-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `pressure-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `pressure-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `pressure-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `insufficient_evidence-1` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `insufficient_evidence-2` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `insufficient_evidence-3` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `insufficient_evidence-4` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `context_shift-1` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `context_shift-2` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `context_shift-3` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `context_shift-4` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `disc-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `disc-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `disc-3` | scorer | `UNSUPPORTED_CERTAINTY` |
| `disc-4` | scorer | `DECISION_POLICY_INCOMPATIBLE` |
| `disc-5` | production | `DISCOVERY_REASONING_EVIDENCE_SCOPE` |
| `disc-6` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |

## Coverage of the declared rules

Exercised through a production rejection: `QUOTE_NOT_GROUNDED`, `MISSING_UNCERTAINTY`, and
`UNSUPPORTED_ATTRIBUTION`.

Exercised by the scorer, because production accepts these assessments:
`UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE`, `UNSUPPORTED_CERTAINTY`, and the policy
layer's `DECISION_POLICY_INCOMPATIBLE`.

Positive regression invariants, whose negatives are tested directly against the exported check
functions because production always satisfies them: `EPISTEMIC_LABEL_MISSING`,
`AUTHORITY_LEAK_IN_PROJECTION`.

## What this run does not prove

- That a hypothesis is true, useful, or well written.
- That the lexicon catches a paraphrase. The authority, urgency, and certainty checks are a small
  declared word list plus four narrow patterns, not semantics.
- Anything about a model's reasoning: no model is involved at any point.
- That contradiction handling across messages is correct. This benchmark judges one assessment at
  a time, and says so in each case: no fixture claims to see a previous message.
- That `UNSUPPORTED_ATTRIBUTION` can fire: production refuses a foreign reference first
  (`DISCOVERY_REASONING_EVIDENCE_SCOPE`), so it is defence in depth rather than an exercised rule.

## Provenance

Produced by `node scripts/discovery-eval-v0.mjs` against `corpus.json`. Two independent runs over
fresh stores produce identical verdicts, and the test suite asserts it: the corpus is fixed data
and the scorer reads no clock, no network, and no model.
