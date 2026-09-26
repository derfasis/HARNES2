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

`validateEvaluation(corpus, report)` links the two, and the report is a **projection** of the corpus
rather than a second source of truth. A report may only claim `offline_human_eval` if the corpus is
itself `offline_human_eval`, is non-empty, every case is `anonymized_real` with a provenance claim
and a non-null model output, and the case ids match exactly. The corpus also freezes the
**generation identity** — model id, model version, prompt reference, and a prompt digest — and the
report's `model` block must match it. Without that, a benchmark cannot honestly be attributed to a
model, and `prompt_id` alone is a free string rather than a reference.

The report's reviews, adjudication, and final axes must equal the corpus's own, compared by
reviewer id so ordering cannot hide a substitution. In other words: the corpus says what happened,
the report says the same thing, and the validator refuses a report that says something else.

Structure is checkable; quality is not, and a script that pretended otherwise would be the same
failure in a new place.

## How a case is actually built

The pipeline has two stages, and conflating them is the mistake the protocol exists to prevent:

```
permitted source → generation/input.json → model output → two human reviews → final 4D0 corpus + report
```

`generation/input.json` is a **staging** artefact. A case there has no scores, no reviewers, no
adjudication, no final axes, and no failure tags — because nobody has reviewed it yet. It carries
only anonymised evidence and the metadata the frozen prompt needs: `situation_id`, `subject`,
per-message `source_event_id` and `author_id`, the offer, the goal, and the known unknowns. The
staged input is validated by its own schema.

The 4D0 corpus is the **finished** artefact, assembled only after two real people have scored the
case. Its contract is not relaxed to make generation easier.

The prompt and the input contract are checked against each other: if the prompt names an
identifier the input does not carry, the model would have to invent it, and the preflight refuses.

## Two permissions, not one

Calling a model and sending real third-party text out of this machine are different permissions.
The first is a single explicit environment flag. The second needs an `egress_authorisation_ref` on
the staged input, and it is required the moment a case is `anonymized_real` — a sanitized fixture
needs no such reference, because nothing real leaves the machine. The call ceiling is hard at 24
and is not a budget this repository can raise.

## Running generation

`generation/run.mjs` is the execution phase: plan, call, validate, store. The model call is
**injected** — the runner knows how to reach no provider, and with no transport supplied it refuses.
That keeps the transport a separate, reviewable decision and lets the pipeline be exercised end to
end against a stub.

A model output is stored only if it satisfies `generation/output.schema.json` **and** quotes the
input verbatim. Each evidence span is resolved against the *one* message its `source_event_id`
names, and its `author_id`, `version`, and text must belong to that same message — checking them
independently would let a span borrow an id from one message, an author from another, and a text
from a third. The decision and the draft channel are one claim and cannot disagree, and the channel
must be one the situation permits.

Generation is only accepted with a **runtime-reported** identity: the transport returns the model id
and version the runtime actually gave, alongside the raw text. Filling those in by hand afterwards
is exactly what the finished-corpus contract forbids, so a call that cannot state its identity is
refused rather than annotated later.

A refused output is written nowhere, so a later run cannot mistake a malformed generation for a
finished one. The staged input is immutable, so completion lives in the stored outputs: a rerun
reads them, finds every case done, and makes no call at all.

Four outcomes, four exit codes: `2` refused at the gate, `1` invalid input, `3` nothing to do, `0`
generated.

## Running the validator

```
node docs/benchmarks/decision-quality-eval-v0/validate.mjs
node --test tests/decision-quality-eval.test.mjs
```

A non-zero exit means the benchmark is corrupted, not that the system under test failed. Those are
different failures and the exit code must never be used to blur them.
