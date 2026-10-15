# Scout Intent Search v1 — verification and handoff

Base: canonical `main@4e856f360d7912c3ee517bd2c28beec0d5b6809a`.
Implementation branch: `codex/scout-intent-search-v1`.

## Result

Scout can now register a public source without automatically reading history,
search selected sources with exact frozen campaign queries, persist a typed bounded
page, and separately authorize one profile-bound interpretation. The operator can
inspect source text, inference, uncertainty, optional inert wording and review.
This does not create a person, private conversation, business draft, sending
approval, source checkpoint or contact permission. Runtime/send defaults stay off.

GramJS's existing typed `messages.Search`, current connected client, semantic
mapper and account read gate are reused. No Telegram parser, new transport,
global/paid search, queue engine or alternate source-ingestion path was added.
HARNES owns immutable query/receipt bindings, grants, currentness, job recovery,
one-shot model authority and operator review. Historical samples remain separate.

The model selects a supported message ID and supplies an interpretation. Code
attaches the **full exact source body** as `quoted_text`. Recomputing a corrupted
proposal's hash cannot validate a fabricated quote. This separates source truth
from model text and avoids making evidence fidelity depend on LLM transcription.

## Automated gate

- `npm test`: **1761/1761** Node tests, no skips or failures.
- `npm run test:credentials`: **35/35** Python tests.
- `npm run build`: **PASS**, 285 JS/JSON and 12 Python files compiled.
- `git diff --check`: **PASS** before commit.

Tests were first added RED for registration, typed query acquisition and topic
revision, before the read implementation. Focused checks include the pinned SDK
request, public peer/account/client-generation validation, bounded counts, empty
and opaque pages, no source ingestion, no outbound effects, immutable records,
unknown read recovery with a three-attempt cap, and receipt commit failure.

Other kill cases cover revoke/revise during await; malformed/null/mode-stripped
cursors with no discovery/history fallback; corrupted-job isolation; future
evidence cursors; wrong call operation; account/profile/expiry/edit/delete changes;
no paid-request resurrection; actual worker packet/prompt/contract tampering;
missing/opaque parent context; generated quote injection; hash-recomputed persisted
quote corruption; one-time inert review; exact v20/v21 and earlier transfer catalogues.
Older upgrade tests retain their historical prefixes and verify migration to 21.
The old worker, credentials, Router/Projection, send paths and SQL pins stay fixed;
the runtime pin documents the tested stronger input-binding extension.

Independent review found and closed several real gaps: an opaque parent could be
mistaken for visible context; account switching could leave a misleading current
badge; a future cursor and mutable call operation needed validation; and a missing
query association plus stripped cursor mode could fall through to ordinary search.
Null JSON cursors now retire only the corrupt job. Closed diagnostics distinguish
format/schema/evidence/model failures without persisting provider output.

## Native/model checks, 2026-10-15

Native tests reused the existing lab database and durable account budget/backoff;
no counters, PTS or evidence history were reset. They used explicitly bounded
public `biznes_chat` and `wildberries_marketplace_help` reads, without joining,
history downloads, sends, private intake or public server startup.

The first acquisition retrieved **10 messages** across the two sources: one and
nine respectively. Later tests reacquired a bounded page under fresh authority
after closing each earlier grant. Across the complete new-layer test sequence the
existing account counter advanced **42 → 58** (16 gated reads), with all failed
attempts and immutable page receipts retained. Test-only finite allocations were
declared before each successor; no FloodWait was observed or bypassed. Production
configuration was not changed. Connection/session setup is separate from this
account-gated read count.

The first lab checker incorrectly expected a registration lookup to consume a
per-source counter; its failed report is preserved. Another lab configuration
used invalid one-slot Control Plane limits and correctly prevented reasoning.
The default unknown-cost latch also correctly refused a later model admission.
Subsequent finite verification used validated Control Plane settings and explicitly
accepted unknown pricing in the **test process only**, with a separate exact
generation/output bound. Unknown cost was never rewritten as zero or success.

There were **three actual generation POSTs** through the native Hermes worker and
configured CLIProxyAPI, not Gemini's website. The first failed output format and
the second failed evidence validation; neither produced a proposal. After the
ID-only/source-projected quote contract, the final call produced a durable proposal:

| Property | Final successful call |
| --- | --- |
| Requested alias | `gemini-3-flash` |
| Provider-reported identity/version | `gemini-3-flash` / `gemini-3-flash` |
| Worker generation POSTs | 1 |
| Input/output tokens | 5169 / 1382 |
| Included interpretations | 9 |
| Unknown/duplicate message IDs | 0 / 0 |
| Model-generated source quotes | 0 |
| Exact source quotes verified independently | 9 / 9 |
| Pricing and hidden proxy retries | unknown |

Provider identity is a reported response field, not proof of the model weights.
All three real calls total **15415 input / 4530 output tokens**; this is not an
account/subscription percentage. Every model/read grant was revoked, profiles
revoked, campaigns paused, clients stopped and process ownership released after
verification. Source-message ingestion and customer-facing effect counts stayed 0.
The current successful proposal is historical after that deliberate cleanup.
Live owner approval and an authenticated browser session were not exercised;
review/UI boundaries were exercised by automated operator/API tests.

## Semantic limits

Independent reading of the nine real source bodies found four explicit supplier
search statements, including a vague one. They are not proven recruitment leads.
Advertising was separated from demand. Three replies lack parents. One first-person
operational reply was weakly classified as third-party context, and one suggested
answer made an unsupported claim about marketplace procedures. That wording requires
verification or replacement before use; a nicotine-related request is outside the
recruitment scenario and is not a target for outreach. None establishes FitLine fit,
present need or permission to contact. The purpose of this check was transport,
evidence and model-contract conformance, not a measured conversion or quality score.

Currentness means acquisition age, current authority/epoch and known local edits or
deletes. It cannot prove that an unmonitored remote message has not changed. Queries
are biased selections, never full source coverage or audience-quality measurements.
Interpretation and wording remain advisory and fallible. No automatic sending or
promotion into Work/First Contact was added.

Private test manifests, ledgers, receipts, failed attempts and independent review
are gitignored under `.cache/scout-query-live-v1/`; credentials were not printed,
tracked or forwarded. The final successful local run is
`source-projection-run-73802392-17fa-4c20-8ecc-e2bcb00132be`.

The web Dev conversation could not be accessed with the available tool catalog.
Handoff delivery there remains **UNSENT**; the independent reviews above were
delegated Luna reviews, not a claimed discussion with Dev. Hosted exact-head CI
is checked separately before any release integration.
