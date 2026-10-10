# Demand Radar v0 — source-first acquisition spike (OFFLINE)

This is **not** a deployed lead finder, scorer, Telegram/Reddit integration, model prompt, or permission grant. It is a bounded way to test a *candidate-retrieval route* on a separately permitted, frozen Scout-style historical sample.

## Why
The product goal is to notice first-person business **problems** before the author necessarily asks for a specific MLM program:
- Customers ask a service professional about goods they cannot currently supply.
- A business cannot increase revenue by adding more service hours.
- A seller considers low-inventory/non-exclusive ways to serve existing customers.
- An independent professional compares distribution options or ways to monetize product recommendations.

These are **themes for possible discovery**, not assertions that any author needs FitLine, wants MLM, can legally sell a product, or consented to contact. Never use family status, debt, age, medical vulnerability or distress as recruitment signals.

## Interface
`probeDemandCandidates({ mission, sample })` accepts:
- Versioned `mission.id / mission.revision` and **owner-approved** `families: [{id, contains_any: [literal RU/UA phrases]}]`.
- A separately access-admitted, **frozen** Scout-shaped historical sample: `status:'sealed'`, `source_ref`, `digest`, `coverage`, `messages[{message_id,author_ref,date,text,reply_to,unsupported}]`.
- No network/model access. The helper **does not verify the caller-supplied sample digest or platform content permissions**. Those are admission requirements outside this isolated probe.

It returns all candidate messages **with unmodified original text**, source-scoped author identifier, original publication date, reply/missing-ancestry context, matched family and literal, duplicate references, and same-author nearby message references. It also preserves **all unmatched readable messages** for independent false-negative review, omitted unsupported records, declared coverage, and explicit NOT_ASSESSED/UNKNOWN fields.

Literal phrases are deliberately **high-recall candidates only**; no semantic intent, role, currentness or offer-fit is inferred. A vendor quoting a customer's request can be routed as a candidate, but **must not be labeled own demand** without independent author/context verification. `observed_at:null` is deliberate; a sealed Scout history is not a newly observed canonical `source.message`.

## Run tests
```sh
node --test tests/demand-radar-candidate-probe.test.mjs
```
4 synthetic offline tests: own business question in RU/UA, explicit refusal preserved, vendor quotation, later same-author cancellation, duplicate, missing parent, empty-result semantics, malformed/unsealed input.

## What this does NOT measure
- Frequency of demand among all monthly posts, relevance precision, own-request recall, or active opportunity count.
- Commercial/verified FitLine fit, source authorization, real platform availability, or Gemini fidelity.
- New contact/Person/Conversation/Discovery promotion, send/draft/watch grant.

Next: independently audited permitted RU+UA frames and query-route ledger (separate from bounded-sample density); separately frozen native Gemini Stage0 fidelity; only then consider using existing Scout/Discovery interfaces with verified offer-term revisions.

## OSS research references, no dependencies imported
- [subscope](https://github.com/dancolta/subscope): bounded collection + candidate/authority separation and useful empty-result reporting. MIT. Its RSS access, rate/scoring assumptions and licensing do not transfer automatically.
- [reddit-idea-scout](https://github.com/huxm-git/reddit-idea-scout): source-first pain-point review pattern.
- [opportunity-radar](https://github.com/hunterr198/opportunity-radar): broad multi-source reference, **not** a replacement runtime.

Tracked task: [#49](https://github.com/derfasis/HARNES2/issues/49). Production code is untouched.
