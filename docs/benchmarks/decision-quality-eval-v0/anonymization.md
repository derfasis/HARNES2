# Anonymisation rules

Anonymisation exists to protect people, not to make cases unusable. Stripping every detail strips
the signal a reviewer is supposed to judge.

## Remove or replace

- Personal names and handles → `[PERSON_A]`, `[PERSON_B]`, stable within one case.
- External account, channel, and message identifiers → `[ACCOUNT_1]`, `[MESSAGE_3]`.
- Contact details, addresses, and links → `[REDACTED]`.
- Exact sums, dates, and places, **only when they carry no decision-relevant meaning** — see below.

## Preserve

- Message order, turn count, and who said what.
- Tone, register, and the presence or absence of a request.
- Length, and whether something is vague or specific.
- The relationship between facts: who refers to whom, what contradicts what.

## Replace, do not delete, when the detail changes the answer

```
€18 000        → [HIGH_VALUE_AMOUNT]
вчера в 18:30  → [RECENT, SAME_DAY]
Берлин         → [MAJOR_EU_CITY]
```

If a reviewer could not notice the difference between the original and the replacement, the case
was over-anonymised and the signal is gone. If a reviewer could identify the person, it was
under-anonymised.

## Never

- Never put a real name, handle, or raw message id into a case, even temporarily.
- Never claim `anonymized_real` without a `provenance_claim_ref`: an opaque pointer to the
  internal origin of the material, so a human can check the claim. It is a claim, not a proof —
  nothing verifies it mechanically, and this document must not imply otherwise.
