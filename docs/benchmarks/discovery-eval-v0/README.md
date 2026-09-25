# Discovery synthetic contract evaluation v0

`proof_level=synthetic_contract_eval` · `live_proof=false`

This evaluation measures **discipline**, not intelligence. It does not judge whether a hypothesis
is true, useful, well written, or good. It checks that a reasoning output obeys the contract the
system already claims: grounded quotes, real references, stated uncertainty, no invented
authority, no letting pressure override the verdict, and a decision the case policy allows.

No model runs here. There is nothing to ask for an opinion, and nothing here should be read as
evidence that the reasoning is *right*.

## What runs

```
node scripts/discovery-eval-v0.mjs                    # machine-readable verdict, non-zero on failure
node scripts/discovery-eval-v0.mjs --corpus=<path>    # run against another corpus file
node --test tests/discovery-eval.test.mjs
```

Each fixture is executed through the real `discovery.assess` command against a temporary store.
That is the point: a finding means the production contract accepted an assessment that still
violates a rule, not that a script disliked a sentence.

## The corpus

`corpus.json` holds 30 cases: six classes of four variants each, plus six `discriminator` cases.
Five of them make the scorer's own checks fire; one (`foreign_ref`) proves production refuses a
foreign evidence reference before the scorer ever sees it.

Every case is written as one coherent unit. The good fixture describes **its own** source text: a
fixture claiming a source "asks for a third party" when the source text does not contain such a
request would make the whole benchmark incoherent, and an incoherent benchmark is worse than none.

| Class | What it probes |
| --- | --- |
| `weak_signal` | vague interest, no decision to make |
| `commercial` | a direct commercial question, where `CANDIDATE` is legitimate |
| `contact_probe` | "write to him for me", "contact me now" — a request for someone else's authority |
| `pressure` | money, deadlines, threats, urgency |
| `insufficient_evidence` | contradiction, hearsay, a source that denies the offer exists |
| `context_shift` | a signal that changed meaning, or a decision shared between two people |

Every case carries one `good` fixture and one `bad` fixture. The good fixture must survive the
real command path and satisfy every check. The bad fixture must be caught — and the two are not
allowed to be mirror images, or the benchmark would prove nothing.

## The two layers of checks

**Hard contract** — violations are defects regardless of the case:

| Code | Meaning |
| --- | --- |
| `QUOTE_NOT_GROUNDED` | the attributed quote is not the source's own words |
| `UNSUPPORTED_ATTRIBUTION` | a reference in claims, inferences, or WHY NOW points at evidence that does not exist |
| `MISSING_UNCERTAINTY` | an empty uncertainty list |
| `UNSUPPORTED_PERMISSION_INFERENCE` | the text asserts permission, consent, or a promise |
| `URGENCY_OVERRIDE` | pressure was allowed to drive the verdict |
| `UNSUPPORTED_CERTAINTY` | an unverified claim is stated as fact |
| `EPISTEMIC_LABEL_MISSING` | the projection dropped `unverified_proposal` |
| `AUTHORITY_LEAK_IN_PROJECTION` | the non-authority markers are missing |

The eight hard-contract rules fall into three groups, and the split is stated rather than blurred:

- **Exercised through a production rejection**: `QUOTE_NOT_GROUNDED`, `MISSING_UNCERTAINTY`, and
  `UNSUPPORTED_ATTRIBUTION` — production refuses all three first, so the corpus demonstrates the
  refusal, and the scorer's own copies of these rules are defence in depth.
- **Exercised by the scorer**: `UNSUPPORTED_PERMISSION_INFERENCE`, `URGENCY_OVERRIDE`, and
  `UNSUPPORTED_CERTAINTY` — production accepts these assessments, so only the scorer can object.
- **Positive regression invariants**: `EPISTEMIC_LABEL_MISSING` and `AUTHORITY_LEAK_IN_PROJECTION` —
  production always satisfies them today, no fixture can violate them, and their negatives are
  tested directly against the exported check functions.

`DECISION_POLICY_INCOMPATIBLE` is not a hard-contract rule at all. It is the policy layer, and it is
discriminated by a fixture like the scorer rules.

**Policy expectation** — each case lists the decisions it tolerates, and that is a *set*, not one
gold answer. A case that allows `OBSERVE|DISMISS|CANDIDATE` is not saying `CANDIDATE` is wrong; it
is saying no one of the three is privileged. Writing a single gold answer would encode the corpus
author's taste as truth.

## The bad fixtures, and why there are different kinds

| Kind | How it must be caught |
| --- | --- |
| `ungrounded` | production refuses it: `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `no_uncertainty` | production refuses it: `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `foreign_ref` | production refuses it: `DISCOVERY_REASONING_EVIDENCE_SCOPE` |
| `authority` | production accepts it, the scorer must catch `UNSUPPORTED_PERMISSION_INFERENCE` |
| `urgency` | production accepts it, the scorer must catch `URGENCY_OVERRIDE` |
| `urgency_in_opening` | the promise hides in the opening proposal text |
| `authority_in_rationale` | the promise hides in the proposal rationale and constraints |
| `certainty` | production accepts it, the scorer must catch `UNSUPPORTED_CERTAINTY` |
| `policy` | production accepts it, the scorer must catch `DECISION_POLICY_INCOMPATIBLE` |

A fixture that production refuses is caught for a different reason than one the scorer has to
judge, and the split is asserted: the corpus proves production still refuses hard-contract abuse,
and proves the scorer carries its own share on top of it.

The split matters. If every bad fixture were caught by production, the scorer would be a rubber
stamp that never runs. The test asserts that a healthy share of cases is caught by the scorer
itself *and* that production still refuses the hard-contract abuse. Every case reports an explicit
outcome — `production`, `scorer`, or `missed` — and a run with any `missed` exits non-zero.

## Known limits

- The authority, urgency, and certainty checks are a small, declared **lexicon** with word-boundary
  matching, plus four narrow patterns for inflected forms such as "разрешение ... получено". They
  catch stated authority, urgency, and certainty; they cannot catch a clever paraphrase. A case
  that slipped past would be a benchmark gap, not a proof of safety.
- The scan covers every field the model authored — hypothesis, inferences, uncertainty, WHY NOW,
  and an opening proposal's text, rationale, and constraints. The source's own quote is never
  scanned, because the source is not the model.
- `UNSUPPORTED_ATTRIBUTION` and `QUOTE_NOT_GROUNDED` are second lines of defence: production
  already refuses both, so the corpus proves that refusal, not that the scorer catches them. They
  stay because a future change could open that gap, and a check that only exists in the test suite
  is not a check.
- The scorer judges one assessment at a time. Contradiction handling across two messages is
  covered by the safety audit, not here.
- Nothing here runs a model, so nothing here measures a model.
- `live_proof` is false and must stay false until someone does the live work and says so.

## When something fails

A failing **good** fixture is a product finding: the contract accepted or rejected something it
should not have. It is reported in `report.md` and fixed in its own patch, never silently inside a
benchmark change. A broken **scorer or corpus** is a benchmark bug and is fixed in the same branch,
because a benchmark that cannot be trusted is worse than no benchmark.
