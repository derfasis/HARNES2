# Source assessment: attribution and reply context v3

Base: canonical `main@782e55ba5fcdf211f22877b4c6e8a6ab4f6e7583`.

A bounded real public-group audit contained a first-person supplement purchase
and seller-authenticity question. The model correctly found that discussion,
but promoted a peer's "official" seller claim and a product listing into
verified distributor status. It also combined a nearby reply with a missing,
different parent into that opportunity. All referenced messages existed: JSON,
schema and reference membership validation cannot prove those semantic claims.

The v3 instructions explicitly keep participant/retailer authenticity, status,
safety and efficacy claims attributed and unverified. Public message content
cannot verify itself by claiming authority. Marketplace/brand/product links do
not verify a seller or establish fit with the owner's offer. Each discussion
uses its own group and known reply ancestry; an orphan reply cannot prove
another discussion's subject, resolution or buying intent. A clear first-person
question remains useful source evidence even when surrounding claims are
unverified. Source consideration is still advisory, not customer qualification.

The existing `scoutSignals` projection already preserves missing-parent edges
and `context_incomplete`, withholding opaque/cyclic ancestry. It is reused
unchanged. The AJV output schema, controlled Hermes worker, strict references,
durable receipts, source/account/grant checks and operator surfaces are also
unchanged. There is no keyword filter, model-output rewriting, new schema,
transport parser or automatic retry.

`SCOUT_EVALUATOR_VERSION` advances from `scout-assessment-v2` to
`scout-assessment-v3`. Existing version checks make v2 queued work stale before
model invocation and make persisted v2 advice unusable for a new review or
admission after restart. Old receipts are not rewritten. Independently issued
owner monitoring grants retain their own authority, as before; invalidating
advice does not revoke an already explicit grant or reset its checkpoint.

Focused offline tests exercise this version transition, persisted review and
admission after restart, and the real packet shape: own purchase question,
unverified peer response, and a separate orphan reply. Canned outputs test the
packet and durable boundaries, not model accuracy. The v2 baseline is explicitly
used in the negative cases so a missing version bump cannot yield false green.

Private finite real-model diagnostics keep the exact sealed input/context,
sample digest and prior output hash. Only system instructions change. The
targeted before/after pair retained the own question, removed the orphan
reference, and labeled official-seller status and offer/geography fit unknown.
An exact production-prompt check is recorded separately in its finite ledger;
source samples and raw outputs remain private, outside Git. One sample does not
establish precision, repeated source quality or sustained monitoring. Provider
alias equality does not establish identical upstream model routing; observed
before/after behavior alone is not causal attribution.

The model may still overstate relevance in free text. Schema-valid prose is not
independently verified knowledge. Owner review, visible evidence and uncertainty
remain necessary. No person, conversation, membership, contact permission, draft,
send or causal credit is created by an assessment or this upgrade. Production
model/sending defaults and the finite live pilot's deadline are unchanged.

In the exact production-prompt probe, the model also described a nearby product
listing as a link to the seller mentioned by the peer. That merchant association
was not established in the packet. This remains a concrete semantic limitation,
not a fully solved case or a reason to rewrite the saved model output. The
owner-facing factual description keeps the peer claim and the listing separate.
