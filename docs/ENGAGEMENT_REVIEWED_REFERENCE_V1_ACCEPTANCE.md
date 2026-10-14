# Reviewed research references in private Engagement v1

Baseline: `main@a9c2ad9e823ae8e12951a43498a582fecfd7f758`. Isolated branch: `codex/engagement-reviewed-reference-v1`.

Native Telegram + Hermes now completes a real owner-controlled inbound→pending-draft cycle. Its business context still contains static `needs_owner_materials` knowledge: Executive/Continuity/Work source-backed research cannot inform private Engagement. This increment connects existing owners of state; it introduces no new parser, provider, queue, research framework, customer-send capability, or market activation.

## Contract and authority

- Reuse current, approved Work material and its accepted Continuity/Executive evidence lineage. A reviewed interpretation remains an interpretation, not VERIFIED_FACT. Preserve source-event IDs, versions, text/provenance, capture times and currentness.
- An operator `reference.attach` explicitly authorizes reading one exact material excerpt for one latest inbound question in one managed Engagement. Required payload: `engagement_id`, `expected_revision`, `material_id`, `material_sha256`, `question_message_id`, `offer_id`, `market` (two uppercase ISO country letters), `excerpt` (exact material substring, 1–8000 characters), `expires_at` (future, at most 7 days), `note`. The market is the reference's intended answer scope, not a verified person/owner market. Require offer matches configured active offer. Up to four current attachments with the same offer/market/question.
- `reference.revoke`: `engagement_id`, `expected_revision`, `reference_id`, `reason`. No model/channel authority for either command. No permission, approval, delivery, conversation/person, or outbound record created by attachment.
- Durable reference pins engagement/partner, exact question ID, material/version/hash, Work/thread/turn/basis, source lineage, scope, excerpt, deadline and operator receipt. Terminal stale/revoked states do not resurrect when sources recover. A new attachment requires a new operator command.
- Fresh private context exposes only current bounded references, clearly labelled `reviewed_interpretation_not_verified_fact`, with underlying observations distinct. Unavailable references expose only status/reason; do not leak obsolete content. A changed question withdraws old references rather than poisoning all future replies.
- The agent may cite `{type:'reference',id}` in HYPOTHESIS/decision evidence. CLAIM still requires exact inbound quotation; VERIFIED_FACT stays operator-only. All supplied current references are frozen run dependencies even if the model omits them from its evidence list.
- Revalidate before agent writes/completion and draft review/execution; source edit/delete/revoke, reference revoke/expiry, new inbound, material edit/review change, scope change or corruption blocks stale dependent work. A source health gap is unknown, never fresh coverage.
- Scheduler reconciliation is bounded, cursor-based and isolates corrupt rows. It needs no model call. Existing engagement decisions, typed contact permissions, approvals and deliveries remain their own state machines.
- Restart never replays model/send. Export/import retains historical references but withdraws reference-reading authority on transfer. Legacy snapshots remain importable.
- UI lets the operator inspect available approved material, attach an excerpt and declared market to the current question, inspect source/limitations, and revoke. Display data authority separately from contact/send permission.

## Acceptance / kill cases (tests precede production code)

1. Valid reviewed material appears only in the exact intended question/context; zero effects or permission writes. Wrong partner/question/material/hash/offer/market, arbitrary excerpt and unreviewed material are rejected atomically.
2. Agent/channel cannot attach, revoke, approve or grant authority. No new execution tool appears in managed scope.
3. Primary source observation and research interpretation remain separate; model cannot promote either into a verified person fact. References never enter legacy person facts.
4. Edit/delete/revoke or stale/retrying/gap source, expired reference, superseded material or corrupted persisted packet makes the basis unusable without requiring a timer.
5. A late run cannot ACT/record belief after a dependency changed; native usage remains durable. Approval/send validation blocks a dependent draft before transport. New permission does not revive it.
6. A later inbound cannot reuse a previous question's authority; it can still be evaluated with unavailable references withheld. No permanent author/thread poisoning.
7. Restart retains history but no extra inference/outbound. Transfer restores records without active reading/contact/send authority.
8. Bounded reconciliation reaches quiet records despite corrupt/noisy neighbors, and does not block source observation/reasoning planes.
9. UI/API expose honest provenance, scope, uncertainty and separate permissions; escaping/source injection cannot mint authority.
10. One finite real-model conformance check after offline gate: source-backed Germany test only, owner market unchanged, pending draft/HANDOFF, no customer send, original output retained and reviewed independently.

Gate: focused reference/Engagement/Work/transfer kills; full Node suite; credential-isolation Python suite; build; diff check; own red-team. Integration only after real blockers resolved and required hosted gate passes. Preserve primary dirty checkout and prior spent test ledgers.
