# Discovery presentation contract v1

Stage 3A defined the business read model. Stage 3B exposes that read model over the existing
loopback HTTP boundary. This document records what an operator may read and what every
consumer of these endpoints must keep saying out loud. There is no UI in this stage, no
authentication subsystem, and no scheduler, model, or transport behaviour.

```
business read model  →  HTTP presentation boundary  →  future UI
```

## Surfaces

| Surface | Route | Content |
| --- | --- | --- |
| List | `GET /api/discovery/reason-states?limit=&cursor=` | Reason-state rows only |
| Detail | `GET /api/discovery/:id` | Allowlisted situation projection |

The literal `reason-states` path is matched before the `:id` path, so it can never be read as
a situation id. Only `GET` is served; `POST`, `PUT`, `PATCH`, and `DELETE` on these paths answer
`405` rather than `404`, because the path exists and the method does not.

## Authorization

`business/server.mjs` is the authorization boundary for these reads: every `/api/*` route other
than `/api/session` requires the loopback `x-partner-token`, and the server additionally refuses
foreign `Host`, foreign `Origin`, and cross-site `Sec-Fetch-Site` headers. The list route passes
`{ kind: 'operator' }` to `service.discoveryReasonStates()`, which rejects any other actor.

The detail route is served by `service.discoveryPresentationDetail(id, { kind: 'operator' })`, an
allowlisted projection that rejects any other actor. `discoveryDetail()` remains the internal read
API: it is **not** an authorization boundary on its own, it takes no actor, and it is no longer
exposed over HTTP. That is stated here rather than hidden behind a second pseudo-auth layer.

Stage 3B deliberately does not change how `/api/session` issues its token. The server is
loopback-only and header-checked; replacing that is a separate decision, not a side effect of a
presentation change.

## Query contract

Only two options exist, and an unknown or repeated option is refused instead of ignored:

- `limit` — integer `1..100`; default `100`.
- `cursor` — a situation id in UUID form; absent means the first page.

Everything else is `400`. Refusing an unknown option matters: a dashboard must never believe it
filtered something the server silently dropped.

Pagination is a keyset over `discovery_situations.id` in ascending order. Coverage is complete and
duplicate-free while the set of live situations does not change between pages. Concurrent new
evidence arriving mid-walk is not snapshot-isolated, and this contract does not pretend otherwise.

## What each surface may say

**List** carries the verdict and nothing else: `situation_id`, `storage_status`, `revision`,
`evidence_fingerprint`, `transition_id`, `decision`, `wait`, `state`, `unlock`, `reason`,
`freshness { fresh, reasons }`, plus `executable: false`, `contact_permission: false`,
`allowed_effects: []`. It never carries source text, evidence rows, or the reasoning payload. The
list is never assembled by walking `discoveryDetail()`.

`state` is `BLOCKED` while the transition still governs the current basis, and `READY` with
`reason: 'DEADLINE_REACHED'` once a `WAIT/deadline` has passed. `unlock` is
`EVIDENCE_CHANGE` for `IGNORE` and for `WAIT/evidence_change`, and `DEADLINE_OR_EVIDENCE_CHANGE`
for `WAIT/deadline`. A transition stops governing the basis as soon as new evidence changes the
evidence fingerprint or a newer assessment moves the situation revision; the row then simply
leaves the surface.

`freshness` is the verdict only. Evidence stays behind the detail surface.

**Detail** is an allowlist, not the internal projection. It carries `situation_id`, `status`,
`storage_status`, `revision`, `evidence_fingerprint`, a `basis` of seven situational fields
(`source_ref`, `subject_ref`, `context_key`, `purpose`, `expires_at`, `created_at`, `updated_at`),
`freshness`, bounded `evidence` rows, assessments with `hypothesis` and `why_now`, opening
proposals, review tasks, and the standing `executable: false`, `contact_permission: false`,
`sent: false`, `allowed_effects: []`.

What the allowlist deliberately withholds: raw event `payload_json`, `partner_id`,
`offer_fingerprint`, `source_kind`, and any transport metadata.

Evidence rows expose the source event id, message id and version, author id, observation time, and
the message text. Every bounded string is capped at 2000 characters and carries its own flag next
to it, so truncation is announced and never silent: `text_truncated` on evidence rows and on
hypothesis and inference text, `quote_truncated` on attributed claims, `reason_truncated` on WHY
NOW, and `text_truncated` / `rationale_truncated` on opening proposals.

Each assessment reports `reasoning_version` and `reasoning_shape`. `structured_v1` is the
structured reasoning written by Stage 1. `legacy_v0_strings` is a pre-Stage-1 assessment that
stored `hypothesis` and `why_now` as two plain strings; those strings are projected verbatim and
their `attributed_claims`, `inferences`, `uncertainty`, and `why_now.evidence_event_ids` are
present but empty, because Stage 1 never recorded them and the projection will not invent them.

The internal `discoveryDetail()` still carries the full durable projection, and Stage 3C does not
change it.

Reading it must never be presented as any of the following:

- A hypothesis is an `unverified_proposal`, never a verified fact.
- Evidence is a recorded observation, never a verified truth. A quote proves that someone said
  something, not that the claim holds.
- An opening proposal is a proposal, not a permission, not a draft, and not a sent message.
- Stale, revoked, or expired reasons are shown, not hidden or silently repaired. Reading never
  repairs, expires, or unlocks anything.
- Storage status and logical status may differ. `STOP` is stored as `DISMISSED` and reported as
  `STOPPED`, with `storage_status` alongside.

## Non-goals

No UI, no auth subsystem, no scheduler, no model, runtime, Telegram, or live transport, no new
database table, and no change to any existing detail payload. If a real leak is found in the
detail payload, narrowing it is its own minimal change with its own review.

proof_level=integration; live_proof=false.
