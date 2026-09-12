# Opportunity Consumer / Review Pipeline v0

## Decision before implementation

The product gap is that the read-only Projection and frozen Router can describe
an opening, but nothing in the product retains their result for an operator.
The next slice is an operator-only, non-executable review task containing an
immutable reference to the public snapshot, active offer and validated result.
It is more useful now than another planner, collector or delivery adapter:
those would either duplicate Router semantics or expand live authority before
there is a reviewable consumer.

Reuse the existing Store, transaction/exclusive command path, command receipts,
events, task dedupe key, operator API/session and Tasks UI. Keep the Router,
Projection validators, Conversation Brain and credential adapters unchanged.
Add snapshot registration and result consumption as operator commands, a
read-only review detail endpoint, freshness checks, and non-execution guards.

New capability: HARNES2 can retain a validated Opportunity/Router result as a
source-backed operator review task, without granting contact or execution.

## Storage and trust

No new table or migration. Immutable `opportunity.snapshot` and
`opportunity.candidate` records live in existing `events`. A typed
`opportunity_review` row in existing `tasks` points to the candidate event.
It is not an executable job or a draft. Generic task approval/retry and the
scheduler must exclude this kind. Planning/Conversation Brain contexts must
not receive these review tasks or public source text as work instructions.
Only task cancellation is available. No candidate approval command exists.

The operator registers a latest-version public snapshot and imports the one
Router response computed for the returned context. This slice does not call a
model or invent one. Source rights and the active offer come from local
configuration, never a model response. Source text is untrusted data. Semantic
classification is still Router's responsibility, not a new keyword classifier.
Validation proves exact provenance and structural safety, not semantic truth.

The review contains the source-scoped author ID, not a guessed CRM person.
An optional operator-supplied conversation link is explicitly labelled an
operator assertion, not a verified cross-platform identity. Without it,
suppression and ownership are unknown and no contact is possible. With it,
suppression, ownership and conversation revision are checked on consumption
and every review read. Permission is never copied, created or inferred.

## Freshness and duplicates

Snapshot content hashes include ALL supplied messages, authors, versions,
ancestry, text and source identity, not just selected positive spans. The offer
hash covers its full text, criteria and exclusions, not merely its version.
Capture timestamps establish observation age, not message age or live access.
Every new registered snapshot for the same source invalidates previous capture
IDs conservatively, even if it concerns another thread. Identical content
recaptures reuse the latest capture. Message version rollback and changed
content under the same version are rejected against prior registered sources.

Deduplication binds partner, content, goal/channel policy and CRM link. Retries
return the original task even after dismissal, never create a new approval.
A genuine changed snapshot/offer creates a new key. Existing command receipts
retain historical responses; only the detail endpoint reports current freshness.

Fresh means consistent with the latest snapshot registered by the operator and
within the configured TTL, NOT proof that an external message has not changed.
No collector or external read is introduced. New input must be registered when
source content changes. A stale card stays visible with reasons and cannot run.

## Environment limitations

Implementation is being prepared locally from exact base
`d48a8498e74e6ff07dc720d682c132e0648717b3`. All 89 tracked blobs and the base tree
were hash-verified through public read tools. The local base commit object was
accepted only after its exact Git SHA matched. This is a shallow local checkout.

This environment has neither GitHub push tools/credentials nor network domains
available to Computer. Node baseline cannot load `ajv`; Python baseline cannot
load the pinned upstream Hermes `agent.credential_pool`. Package installation
is unavailable. Do not interpret authored tests or syntax checks as passing
regression. Until full real dependency tests and auditor branch publication
succeed, the merge recommendation is NOT READY.
