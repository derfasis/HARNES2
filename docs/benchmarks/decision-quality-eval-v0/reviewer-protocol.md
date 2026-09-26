# Reviewer protocol

Quality is measured by people, so the way people are used has to be fixed before any scoring
starts, not after the numbers look wrong.

## Two independent reviewers

Every scored case is read by two reviewers working independently. They may read the rubric, the
case, and the protocol. They may not discuss the case before both have submitted their scores.

## When a third reviewer adjudicates

A third adjudicator is added when either condition holds:

- **Any** axis where the two scores differ at all, including a one-point gap.
- One reviewer records `N/A` while the other records `0..3`.

Any difference needs a third person. Leaving room for an "obvious" small gap would leave the rule
undefined exactly where two tired reviewers are most tempted to skip it.

The adjudicator sees both scorings, the rubric, and the case, and records a `final_axes` score for
**all six axes** plus a one-line reason. The reason is part of the report: an adjudication without
a stated reason is itself a finding about the rubric being unclear.

An adjudication never replaces the two original scorings — it is recorded **in addition** to them,
so a report always shows the disagreement it resolved.

The published score is never a free choice. Where both reviewers gave the same score, that score is
what the report carries. Where they differed, the report carries exactly what the adjudicator
wrote, and the validator refuses anything else: two reviewers scoring `1` cannot publish `3`. A case with no adjudication and a
disagreement is an incomplete case, not a resolved one, and the validator refuses it.

## Order of operations

1. Reviewers score independently.
2. Scores are compared mechanically.
3. Only then may anyone discuss a case.

Discussing first is not a shortcut, it is the thing that makes the second reviewer worthless.

## What a reviewer may not do

- May not consult the model's own confidence or self-assessment. It is the thing under test.
- May not use the failure tags as a shortcut to the axes, or the axes as a shortcut to the tags.
- May not rescore after seeing the aggregate result of any other case.
