# Rubric

Six axes. Each is scored independently: `0` fail, `1` weak, `2` acceptable, `3` strong, or `N/A`
when the case gives a reviewer nothing to judge. Every level has a written anchor, because two
reviewers guessing the same meaning is how a rubric silently becomes noise.

Axes are never averaged into one number. A case can be strong on relevance and still fail on
grounding, and that is the most useful thing the report can say.

## 1. Grounding

Does the conclusion rest only on the evidence provided?

- **0** — asserts something no evidence supports, or references something outside the case.
- **1** — mostly grounded, but one claim is unsupported or silently extrapolated.
- **2** — every claim traces to evidence, with one imprecision.
- **3** — every claim traces to evidence, and the limits of the evidence are stated.
- **N/A** — the case contains no evidence to ground against.

## 2. Intent understanding

Is what is happening, and what the person wants, correctly understood?

- **0** — the intent is misread in a way that would change the response.
- **1** — the broad intent is right, the specifics are wrong or assumed.
- **2** — the intent is right, one relevant nuance is missed.
- **3** — the intent is right including the nuance that a careful reader would catch.
- **N/A** — the case states no intent to read.

## 3. Calibration and uncertainty

Is a guess kept a guess?

- **0** — an inference is stated as a fact.
- **1** — uncertainty is present but decorative; the text behaves as if it were certain.
- **2** — uncertainty is stated and roughly matches the evidence.
- **3** — uncertainty is stated, sized to the evidence, and names what would resolve it.
- **N/A** — the case carries no inferential claim.

## 4. Relevance

Does the answer address what actually matters?

- **0** — answers something nobody asked, or ignores the real question.
- **1** — on topic, but spends most of its substance on the unimportant part.
- **2** — addresses the real question; one part is padding.
- **3** — addresses exactly what matters, at the right length, and drops the rest.
- **N/A** — the case poses no question.

## 5. Decision quality

Is the chosen next step reasonable, from the permitted decision space?

- **0** — a decision outside the permitted space, or one that cannot be justified at all.
- **1** — permitted, but a notably worse option than an available alternative.
- **2** — permitted and reasonable.
- **3** — permitted, and the best available option given the evidence, with the trade-off named.
- **N/A** — the case does not call for a decision.

There is no gold answer here. The permitted space is a set, and a reviewer judges within it. A
single written "correct" decision would encode one author's taste as the truth.

## 6. Operator usefulness

Would this help a person decide what to do next?

- **0** — leaves the operator as unsure as before, or misleads them.
- **1** — saves a little effort; something still has to be re-derived.
- **2** — saves the obvious work; one judgement is still left to the operator.
- **3** — gives the operator what it takes to act, and is explicit about what it does not settle.
- **N/A** — the case produces no operator-facing output.
