# Discovery synthetic contract evaluation v0 — report

`proof_level=synthetic_contract_eval` · `live_proof=false` · baseline `0f0d965`

Discipline of the reasoning structure and of the policy limits, on synthetic cases. The truth,
the usefulness, and the quality of any hypothesis were **not** evaluated and cannot be evaluated
without a model run, which this stage does not do.

## Result

| Measure | Value |
| --- | --- |
| Cases | 24 |
| Well-formed fixtures accepted by the real contract path | 24 / 24 |
| Deliberately bad fixtures caught | 24 / 24 |
| Caught by production | 8 |
| Caught by the scorer's own checks | 16 |

Codes raised by the scorer: `UNSUPPORTED_PERMISSION_INFERENCE` (16), `URGENCY_OVERRIDE` (4).

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

## What this run does not prove

- That a hypothesis is true, useful, or well written.
- That the lexicon catches a paraphrase. The authority and urgency checks are a small declared
  word list, not semantics.
- Anything about a model's reasoning: no model is involved at any point.
- That contradiction handling across messages is correct. That belongs to the safety audit.

## Provenance

Produced by `node scripts/discovery-eval-v0.mjs` against `corpus.json`. The same input yields the
same verdict: the corpus is fixed data and the scorer reads no clock, no network, and no model.
