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
node scripts/discovery-eval-v0.mjs      # machine-readable verdict
node --test tests/discovery-eval.test.mjs
```

Each fixture is executed through the real `discovery.assess` command against a temporary store.
That is the point: a finding means the production contract accepted an assessment that still
violates a rule, not that a script disliked a sentence.

## The corpus

`corpus.json` holds 24 cases: six classes, four variants each.

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
| `UNSUPPORTED_ATTRIBUTION` | a reference points at evidence that does not exist |
| `MISSING_UNCERTAINTY` | an empty uncertainty list |
| `UNSUPPORTED_PERMISSION_INFERENCE` | the text asserts permission, consent, or a promise |
| `URGENCY_OVERRIDE` | pressure was allowed to drive the verdict |
| `UNSUPPORTED_CERTAINTY` | an unverified claim is stated as fact |
| `EPISTEMIC_LABEL_MISSING` | the projection dropped `unverified_proposal` |
| `AUTHORITY_LEAK_IN_PROJECTION` | the non-authority markers are missing |

**Policy expectation** — each case lists the decisions it tolerates, and that is a *set*, not one
gold answer. A case that allows `OBSERVE|DISMISS|CANDIDATE` is not saying `CANDIDATE` is wrong; it
is saying no one of the three is privileged. Writing a single gold answer would encode the corpus
author's taste as truth.

## The bad fixtures, and why there are different kinds

| Kind | How it must be caught |
| --- | --- |
| `ungrounded` | production refuses it: `DISCOVERY_CLAIM_QUOTE_MISMATCH` |
| `no_uncertainty` | production refuses it: `DISCOVERY_UNCERTAINTY_REQUIRED` |
| `authority` | production accepts it, the scorer must catch `UNSUPPORTED_PERMISSION_INFERENCE` |
| `urgency` | production accepts it, the scorer must catch `URGENCY_OVERRIDE` |
| `certainty` | production accepts it, the scorer must catch `UNSUPPORTED_CERTAINTY` |

The split matters. If every bad fixture were caught by production, the scorer would be a rubber
stamp that never runs. The test asserts that a healthy share of cases is caught by the scorer
itself *and* that production still refuses the hard-contract abuse.

## Known limits

- The authority and urgency checks are a small, declared **lexicon** with word-boundary matching.
  They catch stated authority and stated urgency; they cannot catch a clever paraphrase. A case
  that slipped past would be a benchmark gap, not a proof of safety.
- The scorer judges one assessment at a time. Contradiction handling across two messages is
  covered by the safety audit, not here.
- Nothing here runs a model, so nothing here measures a model.
- `live_proof` is false and must stay false until someone does the live work and says so.

## When something fails

A failing **good** fixture is a product finding: the contract accepted or rejected something it
should not have. It is reported in `report.md` and fixed in its own patch, never silently inside a
benchmark change. A broken **scorer or corpus** is a benchmark bug and is fixed in the same branch,
because a benchmark that cannot be trusted is worse than no benchmark.
