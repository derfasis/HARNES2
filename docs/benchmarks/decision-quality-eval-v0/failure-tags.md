# Failure tags

Tags are recorded **in addition to** the rubric axes, never instead of them. A tag says what kind
of thing went wrong; an axis says how badly. Together they let a recurring failure be spotted once
it has appeared three times, without inflating the rubric into a seventh and eighth axis.

| Tag | Meaning |
| --- | --- |
| `invented_fact` | States something no evidence supports |
| `unsupported_permission` | Reads consent, contact, or authority that was never given |
| `missed_opportunity` | A real, useful signal went unaddressed |
| `overclaim` | Claims more certainty or scope than the evidence allows |
| `wrong_intent` | Misreads what the person wants |
| `premature_action` | Proposes or takes a step that should wait |

## Rules

- A tag must name a defect, not a style preference. "Too wordy" is not a tag.
- A tag may be recorded on a case whose axes scored `2` or `3`. The axes judge quality; the tag
  records the kind of failure, which is what accumulates.
- An empty tag list is a normal, valid result. It is not a claim that nothing went wrong — it is a
  claim that nothing went wrong *in a way worth naming*.
