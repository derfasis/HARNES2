# FitLine reference knowledge v1

The partner previously had an owner requirement naming PM-International/FitLine and a wellness opportunity rubric, but no source-attributed business terms. `contextFor` loaded both files without distinguishing a researched country example from an applicable offer. The operator panel called this “verified knowledge” and assumed every asset had `facts`, although the rubric has none.

This increment fills a small Germany research reference, not a complete commercial offer or a new knowledge subsystem. The owner's market remains **unknown**. It does not select Germany as the owner's market.

## Sources and scope

The curated catalogue is [partner/knowledge/pm-international.json](../partner/knowledge/pm-international.json). Its German reference was checked on **2026-10-17** against [PM's German distributor rules](https://www.pmebusiness.com/files/regdownload/pmagbde.pdf), March 2026, `PM_DistributorRules_OTHR_2625_DE_P3`. The retrieved PDF's SHA-256 is `80bfed609fb40906f25e4540836c79c9c7d13c746bc9d54301cdd4e36809f638`. Each concise paraphrase identifies its contractual section. The original is authoritative; the Russian summary is an interpretation.

The [German registration page](https://www.pmebusiness.com/registrationv2/?country=de&lang=de) independently exposes the March 2026 rules. Its displayed packages/prices are **not** treated as mandatory joining costs, current prices elsewhere, or a complete cost estimate. No compensation rates or income forecast are supplied. Product efficacy, individual eligibility, legal advice, and the owner's team support are not established by these documents.

Further Internet/Social Media rules and the applicable Income Plan are named by the rules but their full current text was not obtained. Their absence cannot be turned into permission to advertise, recruit, or publish through a particular channel. Read-only research remains distinct from commercial publication.

The catalogue's `checked_at` records manual retrieval, not independent verification or continuous monitoring. `review_after` is a **maximum seven-day maintenance deadline**, not proof that the publisher has made no change before then. Hash syntax validation is not remote byte verification. A source-backed answer still needs a fresh observation and review; a checked-in URL/hash cannot impersonate canonical evidence.

## Consumption boundary

`business/knowledge.mjs` makes two projections of existing JSON assets:

- The operator `/api/state` projection shows available country-specific source metadata and section-level paraphrases. Expired, revoked, future-dated, invalid, or ambiguous duplicate references withhold their body. A bad group does not disable healthy siblings.
- `contextFor` and `partner_get_context` receive **metadata only** for country-specific references. No German contract body, URL or claim text is silently injected into unrelated private conversations. Owner requirements, policy/rubric and unknowns remain separate.

There is no country inference from names, language, profession, chat membership, location, or older questions. There is no new market configuration, schema migration, external tool, model grant, transport or custom HTML parser.

The live check exposed a prerequisite in the existing HTML projection: it removed whole `<form>` subtrees, including the publisher's contractual prose. The reader now reuses **htmlparser2 6.1.0**, already pinned transitively by GramJS and now an explicit dependency, for markup and entity decoding. HARNES keeps only the thin text-selection policy: preserve static prose, discard controls and their contents/attributes plus scripts/templates. The regex stripper and partial entity dictionary were removed. Fetching remains the existing allowlisted, bounded, anonymous GET; there is no submit/POST or additional network capability. A red-before/green-after test covers terms inside a form, nested controls, hidden values, handler/action attributes and German entities.

For a concrete question use the existing path:

`approved public Browser source → durable observation/checkpoint → Continuity interpretation/review → Work material/review → operator reference.attach → current private question context`.

`reference.attach` retains its offer/market/question/hash/expiry/source checks and existing edit/revoke/restart behavior. Material review admits an interpretation, not `VERIFIED_FACT`, person-market evidence, contact permission, draft approval, delivery or causal credit. Country-specific terms are never spread into Scout/Audience/Opportunity/Executive/Work model packets; those contracts remain unchanged. The catalogue is not a shortcut around them.

Continuity currently exposes a **2000-character evidence preview**. A contract clause outside that preview cannot be quoted as if Continuity saw it. During conformance, the operator instead inspected the retained full source event and checked the exact clauses before reviewing the Work material. The model received those as the reviewed excerpt, separately from the short source preview. This is operator-reviewed interpretation, not automatic semantic verification of an arbitrary material or a new excerpt-retrieval capability.

The existing Experience panel now displays “Знания и источники,” source dates/version/hash/locators, country scope, missing terms and limitations. It safely handles policy assets with no `facts`. Source URLs are escaped plain text; source content adds no controls.

## Verification and limits

`tests/partner-knowledge.test.mjs` exercises actual claim-body withholding, date equality, invalid calendars, revocation, duplicate identity, sibling isolation, deterministic loading and compact context. `tests/partner-knowledge-ui.test.mjs` exercises hostile values and hidden stale bodies. Existing reviewed-reference tests continue to cover the question/source/material lifetime and no-authority boundaries.

A finite live conformance run is recorded separately in the local verification report. A successful example demonstrates this route only; it is not an evaluation of all Gemini answers or commercial effectiveness. Defaults remain disabled and no customer communication is part of verification.

To prepare an actual offer still establish the applicable market, current full compensation/social policies, complete costs and the actual team's support/handoff arrangement. Do not substitute an optimistic assumption for any of these facts.
