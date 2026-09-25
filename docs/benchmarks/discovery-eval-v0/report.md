# Discovery synthetic contract evaluation v0 — report

`proof_level=synthetic_contract_eval` · `live_proof=false` · baseline `0f0d965`

Discipline of the reasoning structure and of the policy limits, on synthetic cases. The truth,
the usefulness, and the quality of any hypothesis were **not** evaluated and cannot be evaluated
without a model run, which this stage does not do.

## Result

| Measure | Value |
| --- | --- |
| Cases | 29 |
| Well-formed fixtures accepted by the real contract path | 29 / 29 |
| Deliberately bad fixtures caught | 29 / 29 |
| Caught by production | 9 |
| Caught by the scorer's own checks | 20 |

Codes raised by the scorer: `DECISION_POLICY_INCOMPATIBLE` (1), `UNSUPPORTED_CERTAINTY` (1), `UNSUPPORTED_PERMISSION_INFERENCE` (18), `URGENCY_OVERRIDE` (5).

No product finding was found in this run: every deliberately bad fixture was caught, and no
well-formed fixture was rejected or let through.

## How each bad fixture was caught

| Case | Caught by | Code |
| --- | --- | --- |
| `weak_signal-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `pressure-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `insufficient_evidence-1` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `context_shift-1` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `weak_signal-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `pressure-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `insufficient_evidence-2` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `context_shift-2` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `weak_signal-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `pressure-3` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `insufficient_evidence-3` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `context_shift-3` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `weak_signal-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `commercial-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `contact_probe-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `pressure-4` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `insufficient_evidence-4` | production | `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `context_shift-4` | production | `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `disc-1` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE` |
| `disc-2` | scorer | `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE` |
| `disc-3` | scorer | `UNSUPPORTED_CERTAINTY` |
| `disc-4` | scorer | `DECISION_POLICY_INCOMPATIBLE` |
| `disc-5` | production | `DISCOVERY_REASONING_EVIDENCE_SCOPE` |

## What this run does not prove

- That a hypothesis is true, useful, or well written.
- That the lexicon catches a paraphrase. The authority, urgency, and certainty checks are a small
  declared word list, not semantics.
- Anything about a model's reasoning: no model is involved at any point.
- That contradiction handling across messages is correct. That belongs to the safety audit.
- That `QUOTE_NOT_GROUNDED` and `UNSUPPORTED_ATTRIBUTION` can fire: production already refuses both
  cases first, so they are defence in depth rather than exercised rules.

## Provenance

Produced by `node scripts/discovery-eval-v0.mjs` against `corpus.json`. Two independent runs over
fresh stores produce identical verdicts, and the test suite asserts it: the corpus is fixed data
and the scorer reads no clock, no network, and no model.
