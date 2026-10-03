# Situation Continuity v1

## Product acceptance before implementation

An observed need can be reconsidered tomorrow using its current canonical source
exchanges together with a bounded, fairly selected sample of new exchanges. The
old interpretation is hypothesis memory, never fresh source evidence. A focused
assessment proposes a revision of that need and an inert material preview; it
does not accept the need, approve material, open work, grant contact or execute.

Reuse Audience assessments/needs, SQLite, AJV, the existing no-tool Hermes turn,
Control Plane admission and usage receipts. No additional parser, identity
resolver, workflow engine, vector store or generic storage subsystem is needed.

Acceptance and kill cases:

1. Day-one evidence and day-two separate root updates are both visible with their
   original source clocks. References bind to canonical events, not old quotes.
2. The focused result can only revise its frozen target. Empty output leaves the
   need unchanged and never claims that the situation was resolved.
3. New unrelated exchanges remain available to ordinary discovery. A focused
   request never advances the discovery cursor or marks those exchanges read.
4. Edit, delete, source revoke, target review/revision, or a new source event
   after capture invalidates the dependent attempt before purchase/application.
5. A captured explicit request survives restart only while its basis is current.
   Running attempts recover interrupted, never automatically repurchased.
   Cancel blocks late completion while actual model usage is still recorded.
6. A bad queued request cannot starve a healthy neighboring goal. Legacy manual
   captures never become automatic model requests.
7. Context can be inspected with models off. Requesting a model attempt requires
   the existing explicit model configuration and Control Plane admission.
8. Old interpretations are compact unverified memory. Full historical previews,
   quotations and context reviews do not inflate the next model packet.
9. All necessary prior exchanges must fit. Capacity/omissions are visible; no
   silently dropping necessary context, claiming complete history or contact.
10. Model output, owner review, Work approval and Action authority remain distinct.

The operator requests one immutable focused attempt. Its snapshot includes the
target revision/fingerprint, canonical exchange basis, and watched-source event
heads. A changed snapshot requires a new explicit request, not a tick retry.
The maximum remains eight exchanges and 32 members per exchange. Selection and
history completeness remain bounded/unknown. Unsupported necessary ancestry
continues to block; an unrelated opaque leaf is not fabricated evidence.

## Domain and runtime contracts

`GET /api/audience/needs/:id/context` requires the ordinary operator session token
and is pure: it creates no request, cursor, run, review or authority. It returns
the need revision/fingerprint, focused context fingerprint, canonical exchanges,
prior/new IDs, source heads, compact historical hypothesis, pending request and
bounded coverage. Models can stay off while the owner inspects this context.

`audience.reassess` takes `need_id`, `expected_revision`,
`expected_basis_fingerprint`, `expected_context_fingerprint`. Existing Audience
model configuration and Control Plane must permit requesting a model attempt.
The service revalidates the request before receipt replay. The durable captured
assessment contains the typed `audience-reassessment.schema.json` marker.

Sampling rereads all necessary previous selected exchanges at their canonical
versions. New context is sampled from changes after the previous assessment's
recorded source heads, including exchanges already consumed by ordinary
discovery. Selection is bounded, latest first within each source, fair across
sources, with exact-content deduplication. Legacy packets without source heads
have an explicitly unknown history window; they are never labelled precise new
observations. Missing prior ancestry, expired/revoked authority and full prior
context capacity block rather than silently dropping necessary context.

The focused request uses existing assessment states:
`captured → running → proposed | stale | invalid | interrupted`.
The unique purpose/context fingerprint prevents silently purchasing the same
attempt again. The scheduler resumes only explicitly model-requested focused
captures; legacy operator captures remain manual. Ordinary fresh automatic
discovery retains its existing separately configured authority and fair cursor.

Before a run and before applying its result, check canonical basis, frozen target
revision/fingerprint, watched-source event heads, packet source content and
unverified hypothesis memory. A newly committed root can invalidate a focused
snapshot even after projection reconciliation. Invalid requests are withheld
individually so a healthy neighboring goal can proceed. `audience.cancel_reassessment`
takes assessment ID and exact basis fingerprint, marks pending/running requests
interrupted, and blocks late output. Actual model usage still gets a receipt.

A nonempty result may revise only the target, returns v2 full context accounting,
and resets it to proposed with a new revision. Existing Work/Action scope checks
then reject old reviewed revisions; their independent approval paths are reused.
An empty result is `no_revision_proposed`, a completed model receipt with no
changed need. It does not resolve a problem or prove an outcome. Focused work
never marks new exchanges considered or advances the ordinary discovery cursor.

No migration is necessary: the durable immutable packet lives in the existing
assessment record and the need revision in its existing projection. No transport,
upstream Hermes, permission, send, Outcome or Action contract was replaced.

## Limits

This is bounded source context, not full semantic search or an identity graph.
Omitted sampled exchanges and withheld scopes are visible; wider history remains
unknown. Busy sources can invalidate an in-flight focused snapshot; this trades
throughput for honest currentness, and no automatic retry is bought. Eight
necessary prior scopes leave no room for new context, so the operator sees a
capacity refusal. Model classifications and material remain unverified.

## Verification status

Acceptance was recorded before code; the first acceptance run failed at the
missing API. Final local gate: **1255 Node tests, 15 Python credential-isolation
tests, build and diff check PASS**. The build checks 196 JavaScript/JSON and nine
Python files locally. Existing full regression and transport/authority gates are
included, not just the focused new tests.

Independent scratch mutation checks: baseline 16/16 PASS and six of six removed
guards killed: watched-source head race, target revision race, target-only
output, ordinary discovery consumption, stale receipt replay and packet source
text corruption. The four initially missing guard witnesses were promoted to
tracked regression tests. Additional runtime tests cover restart, interruption,
cancel/late usage, source revoke, healthy-goal fairness, empty results and context
already consumed by ordinary discovery. Authenticated API tests exercise the
real server, strict queries, pure GET and disabled/enabled request gates.

A finite check on the original three-source business store recovered all three
existing readers and obtained current checkpoints. Its one requested no-tool
Gemini turn failed with a classified provider timeout: the old need remained
v1/proposed, no owner review occurred and effect counts did not change. No
automatic retry was purchased. The first bootstrap helper pass had failed before
any model call because it ignored the registry's two-reader-per-pass bound; the
continuation drove the next existing bounded pass and retained the same unspent
one-turn cap. The proxy was subsequently found unavailable and restored with the
owner's existing wrapper; its authenticated model list advertised the configured
Gemini model. This does not by itself prove upstream model readiness or the
historical timeout's exact cause.

Two separate one-turn historical-fixture checks with the restored real
Gemini/CLIProxy/Hermes path returned valid v2 target revisions, each with an inert
material preview and supporting/related context accounting. They copied source
text/clocks into a labelled sanitized fixture, never native grants or sessions.
The second check verified the profile's Russian owner language after the first
revealed English output: runtime now supplies and records that presentation
preference. It returned an 818-byte Russian clarification, retaining ambiguity
and unknown resolution. Recorded usage: 6048/756 and 6180/754 input/output tokens,
one API call each; cost remains unknown. All contact, conversation, draft,
approval, Work and Action effect counts stayed zero. These fixture results did
not revise or review the original business need.

Classified worker failure causes and bounded API-call counts are now stored in
Audience run receipts through the existing closed failure-cause normalizer,
without provider response bodies. Tests cover both returned and thrown failures,
unknown cost and no repeat purchase.

Private local verification artifacts stay ignored under `.cache/`; no source
texts, credentials or native authority were exported into this document. The
hosted exact-head gate remains to be recorded in the release handoff. Product
usefulness is not inferred from green tests or these limited fixture checks.
