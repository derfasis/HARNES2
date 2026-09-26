# Decision quality evaluation v0 — protocol

`proof_level=synthetic_contract_eval` · `live_proof=false` · `model_calls=0`

This directory is the **protocol**, not the measurement. It defines what a case is, what a
reviewer looks at, and what a result looks like. The corpus is empty until real, anonymised source
material exists and the owner explicitly authorises model calls. Nothing here invents "real" cases
to fill a gap.

## What this stage does and does not measure

Stage 4B measured **discipline**: whether a reasoning output is grounded, states its uncertainty,
and invents no authority. Those are structural properties, checkable by a script.

This protocol measures **quality**: whether a judgement is any good. That cannot be decided by a
script, and it cannot be decided without a model run and a human reviewer. So 4D0 prepares the
instrument and stops. It does **not** measure the truth of the world — only the quality of a
conclusion relative to the evidence provided and, where they exist, gold annotations.

## Files

| File | What it is |
| --- | --- |
| `rubric.md` | The six axes, their levels, and the written anchors for each level |
| `failure-tags.md` | The failure vocabulary used in addition to the axes, never instead of them |
| `anonymization.md` | What may be removed, what must be preserved, and why |
| `reviewer-protocol.md` | How many reviewers, when a third adjudicates, and what may not happen first |
| `corpus.schema.json` | The structure every case must satisfy |
| `report.schema.json` | The structure every result must satisfy |
| `corpus.json` | The cases. Empty today, and that is the honest state |
| `validate.mjs` | A small deterministic validator. It checks structure, never quality |

## The one rule that matters most

A case is only `anonymized_real` if it carries a `provenance_ref` — an opaque internal identifier
that proves the case came from a real source. Not a raw message, not a person's name, not a
screenshot. Without that reference the validator refuses the case, because a corpus that quietly
fills itself with plausible-looking inventions is worse than an empty one.

## What the validator will not do

It will not score anything, average anything, or decide whether an output is good. It checks that
the shapes are right, that scores are integers `0..3` or `N/A`, that a real case is provenanced,
and that no aggregate magic number is hiding in a report. Structure is checkable; quality is not,
and a script that pretended otherwise would be the same failure in a new place.

## Running the validator

```
node docs/benchmarks/decision-quality-eval-v0/validate.mjs
node --test tests/decision-quality-eval.test.mjs
```

A non-zero exit means the benchmark is corrupted, not that the system under test failed. Those are
different failures and the exit code must never be used to blur them.
