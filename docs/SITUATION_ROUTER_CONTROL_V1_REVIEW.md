# Situation Router control v1 review

## Run

| Field | Value |
| --- | --- |
| Control | `situation-router-control-v1` |
| Started | `2026-09-11T15:15:04.395Z` |
| Finished | `2026-09-11T15:17:56.201Z` |
| Model | `custom / free/gpt-5.6-luna` |
| Cases | 6 |
| Completed | 6 |
| Errors | 0 |
| Exact decision matches | 5/6 |

The run used the frozen `control-v1.json` manifest exactly once. Expected
decisions and control case IDs were absent from the model prompt. Retries,
Telegram, live sending, business mutations and effect tools were disabled.
Runtime was returned to disabled immediately after the run.

The ignored raw report is:
`data/benchmarks/situation-router/situation-router-20260911151504.json`.

## Results

| Control case | Expected | Actual | Result | Assessment |
| --- | --- | --- | --- | --- |
| `reject-unrelated-generic-solicitation` | `IGNORE` | `IGNORE` | PASS | The previous false active move disappeared. |
| `wait-on-unknown-owner-fit` | `WAIT` | `WAIT` | PASS | Unknown fit no longer produced a cautious outreach draft. |
| `positive-public-reply` | `PUBLIC_REPLY` | `PUBLIC_REPLY` | PASS | A relevant explicit public question still received a public draft. |
| `positive-wait` | `WAIT` | `WAIT` | PASS | Deferred, ambiguous interest did not trigger contact. |
| `positive-dm` | `DM` | `DM` | PASS | Explicit private-contact permission still produced a DM draft. |
| `positive-handoff` | `HANDOFF` | `PUBLIC_REPLY` | FAIL | The router asked for more details publicly instead of escalating the explicit owner-level decision. |

## Three checks

1. **Generic solicitation boundary: PASS.** Both regression cases avoided
   `PUBLIC_REPLY` and `DM`.
2. **Positive active routes: PARTIAL.** `PUBLIC_REPLY` and `DM` passed;
   `HANDOFF` failed.
3. **Over-caution regression: PASS.** The router still selected active public
   and private routes when permission and relevance were explicit.

## Failure detail

The failed handoff result proposed a public clarification draft and implied
that the organization was ready to consider the proposal. That is weaker than
the expected owner handoff: the request explicitly required a person with
decision authority, while the router had no evidence that it could speak for
that person or collect terms on their behalf. The output remained pending and
was not sent, so this is a decision-policy failure rather than a delivery or
approval breach.

## Verdict

**NO-GO for the full 20-case rerun.** The stricter active-move threshold fixed
the two known solicitation regressions without making the router uniformly
passive, but the explicit positive `HANDOFF` control must pass before spending
another full benchmark. No further prompt or policy changes were made as part
of this review.
