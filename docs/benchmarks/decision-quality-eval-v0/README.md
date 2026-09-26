# Decision quality evaluation v0 — protocol

`proof_level=synthetic_contract_eval` · `live_proof=false` · `model_calls=0`

This directory is the **protocol**, not the measurement. It defines what a case is, what a
reviewer looks at, and what a result looks like. The corpus is empty until real, anonymised source
material exists and the owner explicitly authorises model calls. Nothing here invents "real" cases
to fill a gap.

## Proof levels

- `synthetic_contract_eval` — this protocol and its validator. The corpus is empty.
- `offline_human_eval` — a future real measurement: real anonymised cases, real model output, two
  human reviewers. Offline, isolated from the live business, and still `live_proof=false`.

A report may claim the second only when its corpus carries real provenanced cases and a named
model. It may never claim `live_proof=true` at all in this stage.

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

## The rule that matters most, and its honest limit

A case is only `anonymized_real` if it carries a `provenance_claim_ref` — an opaque internal
identifier naming where the material came from.

That reference is a **claim, not a proof**. Today nothing verifies it: a validator can check that a
string is present and well formed, and that is all. An earlier draft of this document called it
proof, and that was wrong — a corpus that quietly fills itself with plausible-looking inventions
would pass.

So the rule stands, with its limit stated: the reference makes a real case *checkable by a human*
who can look up the origin, and makes a fabricated one *visible when someone does*. Making it
machine-verifiable needs an immutable registry mapping `provenance_claim_ref` to a source digest,
and that registry does not exist yet. Until it does, the honest claim is: this corpus's real-case
count is only as trustworthy as the people who filled it in.

## What the validator will not do

It will not score anything, average anything, or decide whether an output is good. It checks that
the shapes are right, that scores are integers `0..3` or `N/A`, that a real case carries a
well-formed provenance claim, and — most importantly — that **every metric in a report is
recomputed from the per-case results**. `scored_cases`, each axis's `scored`/`na`/`mean`, and every
row of `failed_cases` must match the derivation exactly, duplicates included. A number someone
typed is a number someone typed, no matter how plausible it looks.

The JSON Schemas are a second structural guard: the test suite compiles both with Ajv and feeds
each a valid and a deliberately broken fixture, so a schema with a dangling `$ref` cannot pass by
existing.

`validateEvaluation(corpus, report)` links the two. A report may only claim `offline_human_eval`
if the corpus behind it is non-empty, every case is `anonymized_real` with a provenance claim and
a non-null model output, and the report's case ids match the corpus exactly. A report can never
claim a real measurement on the strength of an empty protocol corpus.

Structure is checkable; quality is not, and a script that pretended otherwise would be the same
failure in a new place.

## Running the validator

```
node docs/benchmarks/decision-quality-eval-v0/validate.mjs
node --test tests/decision-quality-eval.test.mjs
```

A non-zero exit means the benchmark is corrupted, not that the system under test failed. Those are
different failures and the exit code must never be used to blur them.
