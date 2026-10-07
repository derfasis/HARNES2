# First Contact Review v1

The next useful product step is a reviewable first response to one supported public
question. It is not a person score, a lead qualification claim, a contact grant or
an outreach runtime. SourceScout still discovers/audits sources; Audience interprets
authorized durable observations using its existing bounded model admission. A Scout
history sample is not silently injected as monitored Audience evidence.

## One path through the existing partner

Authorized public observation → Audience assessment → proposed need and exact
response preview → owner accepts the hypothesis → owner separately reviews the
response → existing Continuity/Work material workflow → separately authorized
local Action/human handoff. Delivery and outcomes are observed separately.

The Audience card shows the participant's exact quoted message, source/message
references, what the response can actually help with, channel reasoning, unknowns,
the exact proposed text and its current review. A public question is not permission
to DM. A product question is not business intent. Fit remains unknown. Approval
does not move contact stage or manufacture an Outcome: this review's own outcome
is always `not_observed`.

## Minimal contract and storage

Existing proposal v2 accepts an optional `first_contact` object, version 1:

```json
{
  "version": 1,
  "target_event_id": "17",
  "target_quote": "Where can I find the worksheet?",
  "channel": "public_reply",
  "help": "Clarify which session the person means before finding the right resource.",
  "channel_reason": "The question is public; posting rules and permission still require separate review."
}
```

`public_reply` requires a known source author reference, a positive evidence event,
its exact quote and a cited `material_preview` with `prepare_material`. The target
cannot be borrowed from counterevidence or contextual peer recommendations.
`none` recommends holding and may have no response preview. Generic internal briefs
omit `first_contact` and preserve their existing workflow.

The text has one home: `material_preview.content`. The proposal SHA binds the typed
recommendation, full preview and all supporting/counter/context dependencies. Source
and author/message references come from the frozen evidence, not model inventions.
An author reference is not a verified human or recipient identity. Exact quotations
prove provenance; they do not prove the model interpreted the request correctly.

No migration or new queue/table is needed. The exact proposal already lives in
`audience_needs` and its immutable assessment. The operator review uses the existing
transactionally committed `events` and `command_receipts`; both must agree on the
request fingerprint and inert result. Exports carry audit history, not renewed
source/model/contact authority.

## Review lifecycle

| State | Meaning |
| --- | --- |
| not_proposed | No typed response, or the model recommends holding |
| pending | Current proposed public response, not yet reviewed |
| approved | Owner reviewed the exact text/channel suggestion for this accepted need |
| rejected | Owner rejected the pending suggestion or withdrew its approval |
| stale | The inherited source/evidence/goal basis is no longer current |
| invalid | A persisted review or its matching receipt failed integrity checks |

`audience.review_first_contact` is operator-only and binds `need_id`,
`expected_revision`, `expected_basis_fingerprint`, `expected_proposal_sha256`,
`decision` (`approve`/`reject`) and a review note. Approval requires an accepted
current need and a pending public response. Rejection is terminal for that proposal;
a fresh command cannot revive it. A revised need requires new review. Exact replay
is idempotent only while that same review is still the current decision; replaying
an approval after withdrawal fails before returning the old receipt.

Internal Continuity/Work investigation may start without response approval. Importing
the typed public response requires its separate approval; withdrawing it subsequently
blocks its dependent Work/material/Action path. Work material review, Action grants
and verification remain independent. There is no executable public-send capability
added here. The eventual recipient response cannot be observed before an actual
authorized interaction; no response record is created by material review or handoff.

## Failure and recovery

Edit/delete/revoke, new relevant evidence, observation expiry and goal changes use
existing Audience freshness/epochs; review cannot override them. Restart reconstructs
state from the same bound proposal, operator event and receipt without inference or
new grants. Missing/corrupt receipts fail closed. A staging import preserves the old
decision event as history while existing import fences retire its current source
basis. A reviewed draft is still not delivery, and silence remains unknown.

## Quality limits and verification

The no-tool prompt asks for concrete help or a missing clarification, and permits
holding/no need. It forbids promising comparisons, official-seller checks, earnings,
medical outcomes or AI capabilities without supporting facts. This is model guidance
and owner review, not a deterministic semantic-truth proof. There is no calibrated
anti-block percentage, causal credit, prediction of retention or guaranteed FitLine
qualification. The owner offer/country/prices/delivery may still need verification.

Offline kill tests cover separate approvals, exact target/quote/author bindings,
counter/context targets, stale edit/delete/revoke/expiry after restart, foreign
partner and agent denial, corrupt/missing receipts, old receipt replay after
withdrawal, post-import material/Action denial, transfer history, and no new contact
effects. Injected model tests prove receipt/usage handling for positive and empty
results; they do not establish real-world conversion or recommendation quality.

Run `node --test tests/first-contact-review*.test.mjs`, then `npm test`,
`npm run test:credentials`, `npm run build` and `git diff --check`.

### Verification of this implementation

Against canonical `main@0e903b2c0fc5ce927e40cae7476a4f7d3aa02cf7`:

- 24 focused tests (18 business/recovery/model-path tests and 6 UI tests).
- Full regression: 1,598 Node tests, 25 Python tests and build passed; no skipped Node tests.
- Five deliberately removed guards were independently caught: positive-target binding,
  event/receipt agreement, superseded approval replay, preview import approval and
  post-import withdrawal. The first target mutation initially survived a confounded
  negative fixture. A valid complete exchange with a peer counterevidence target now
  proves that specific guard rather than failing an unrelated schema check.
- Three finite actual configured Gemini/Hermes invocations used synthetic isolated
  questions and recorded 16,940 input + 3,443 output tokens. Pricing, quota percentage
  and proxy-internal retry count remain unknown. No live customer/source qualification
  or Telegram interaction is claimed by these checks.
- The seller-verification example exposed unsupported regulatory advice. Tightening
  the prompt reduced it, but the revised answer still contained unsupported general
  verification language. In the real browser UI smoke, the underlying need was
  accepted and that exact answer was separately rejected. All seven inspected
  person/conversation/draft/contact/delivery/action/outcome tables remained empty.

Recommendation quality is therefore an explicit remaining product risk. A correct
review/receipt does not certify factual advice or prove recruitment value. Test-only
model activation and the isolated UI server were stopped; deployed pilot authority
and production defaults were not renewed by this implementation.

The existing need-followthrough API test also now handles the narrow Windows case
where `listen(0)` chooses a port forbidden by Fetch: up to three allocations before
any test state is seeded, retrying only Fetch's `bad port` error. Actual API failures
still fail the test; no production listener, workflow or regression gate changed.
