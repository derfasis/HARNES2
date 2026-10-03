# Telegram reconciliation evidence v1

Baseline: `main@4c823e616d10fad2b12d4cccea0841b17a621073`.

The live public observer repeatedly refused a channel difference with
`same_pts_delete_mismatch`. The failed candidate page rolled back and left its
source blocked at PTS 111282. Its older diagnostic named the branch, but did not
record the update kinds, target sets or page boundaries needed to distinguish a
real contradiction from an overly broad identity assumption.

## Boundary

This increment changes diagnostic evidence, not page admission. A recovered
zero-count deletion still must satisfy the existing reconciliation checks. A
watermark alone is not proof that two updates refer to the same event; equally,
protocol documentation alone is not proof that this particular refused page was
consistent. No integrity check is removed without actual evidence.

Reuse the pinned GramJS transport/semantic projection, existing channel reader,
SQLite transaction, integrity latch, scoped receipts and explicit same-cursor
recovery. No new client, parser, workflow engine, migration or permission type.

## Acceptance plan

Before changing production semantics, prove:

- A refused page still rolls back message revisions, tombstones, update receipts,
  reconciliation proof and cursor progress. The source remains blocked after
  restart; inference and outbound work remain unavailable.
- The diagnostic records the exact page boundaries and positive-count versus
  recovered update comparison that caused the failure. Equal/partial/disjoint
  target relationships are explicit; different sets beyond the sample still
  have different full-set SHA256 values.
- Target samples and canonical-state descriptions are bounded to 16 IDs each.
  Canonical descriptions are read after rollback, never from tentative writes.
- No message body, raw TL object, session, credential, access hash or foreign
  extension property enters the diagnostic.
- A diagnostic failure cannot replace the original integrity exception or
  report a successful page. Successful pages and unrelated older failures do
  not inherit a previous failed comparison.

## Durable diagnostic

The existing `source.telegram.integrity_conflict` audit event gains optional
`diagnostic_version: 1` only for `same_pts_delete_mismatch`:

- `page`: contract, from/to PTS, pre-page durable cursor, response kind/final,
  positive-count update count, recovered count and snapshot count.
- `comparison`: the interval-bearing update and recovered deletion's kind,
  PTS/count, full target count, sorted full-set SHA256, first 16 numeric IDs,
  relationship and intersection count.
- `durable_targets`: up to 16 scoped message IDs, canonical source event/version,
  operation and durable tombstone presence after rollback.

The field `comparison.native` means the existing positive-count update lane;
the narrowed page does not prove whether that update arrived from a socket or
`other_updates`. Do not invent that provenance from this label. Missing canonical
message state remains null, not proof of deletion or nonexistence on Telegram.
This is a bounded structural diagnostic, not a replay payload or proof that
recovery is safe. Its sorted samples are examples, not the full target sets.

The diagnostic is attached non-enumerably to the specific refusal and published
best effort after rollback. Publication is fenced by current reader ownership.
It changes no successful checkpoint, model budget or authority.

## Operational recovery

A finite real recovery check must first drain the existing observer normally and
confirm its process has exited. Reuse its original store and current monitor
grants, account and single connection; do not copy authority into a second live
store or run simultaneous sessions. Request the existing operator-authorized
`retry_same_cursor` against the exact blocked checkpoint fingerprint, then make
one bounded difference attempt. No reset, rebaseline, TooLong acceptance, new
join, contact, send or model activation is permitted. Record whether the attempt
committed or was refused and whether it actually reproduced the original
comparison. A recovery that succeeds after losing the volatile native buffer
does not establish that the original comparison was safe.

Resume the already authorized observer with its original finite expiry and
unchanged no-model/no-send controls. Report its actual running code version.
No quota-based computer shutdown is authorized.

## Verification

Focused tests: 8 new black-box tests plus 159 existing public Telegram tests
passed. Independent scratch-only red-team killed all three mutations: omitting
the diagnostic; recording tentative target state before rollback; replacing the
original conflict with a diagnostic persistence error. Review also found and
fixed sampling starvation: the durable sample now reserves slots for both lanes.

Full local gate: 1218 Node tests, 15 Python credential-isolation tests, build and
`git diff --check` passed. No migration, provider, workflow, default permission or
outbound configuration was changed. Hosted CI must verify the exact committed
head before main integration.

### Actual finite read-only recovery, 2026-10-03

The prior observer PID 34432 drained normally at 20:08:00 UTC. Its original
store, account and three existing monitor grants were reused without copying,
resetting or extending authority. An explicit delegated operator recovery
request (event 894) bound the exact blocked checkpoint at PTS 111282. One
difference attempt at 20:08:31 UTC committed PTS 111303/current using the unchanged
admission rules. The finite process then drained and closed its single client.
Model-run count stayed 7; new model runs and all persons, conversations, drafts,
contact permissions, delivery attempts, Work cases/materials and Action proposals
were zero. Private local artifacts are ignored under `.cache/live-recovery/`.

The original comparison did **not** reproduce: the two older conflict events
still have their original minimal fields, and restarting loses the uncommitted
native buffer. This recovery proves same-cursor recovery works; it does not prove
that the original mismatch was safe or that recurrence has been fixed. Therefore
no whole-set or target-level admission check was relaxed. The resumed observer
can record a future recurrence precisely with this increment and retains its
original expiry of 2026-10-04 16:33:42.846 UTC, zero model authority and no sending.

Live target-state admission changes, if justified by actual diagnostics, remain a
separate engineering decision with specific conflicting and healthy kill-cases.
