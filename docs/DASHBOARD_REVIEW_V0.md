# Dashboard review v0 (Task #19)

## Gate status

TASK #11d = **PENDING**, not PASS. The requested clean live NEW -> model -> card
on free/gpt-5.6-luna after Task #12 was blocked by the missing former
Apinex/Luna credential. Offline regression, separate component checks and
provider-specific disposable artifacts are not a substitute for that gate.
Task #19 does not contact a model or Telegram and does not close #11d.

## Existing dashboard and storage

Reuse `public/app.js`, the Tasks screen, existing detail dialog and stylesheet.
Cards remain `tasks.kind=opportunity_review` pointing to immutable candidate and
snapshot events in the existing Store. No new DB schema, migration, dependency,
collector, queue/executor, permission or send path is introduced.

`GET /api/opportunities?status=pending&limit=50&offset=0` is operator-token scoped
and independently paginated; generic `/api/state`'s 300-task limit cannot hide
review cards. Statuses: pending, approved, rejected, cancelled, all. Details at
`GET /api/opportunities/:id` expose the typed `opportunity-review-v0` extension:
`review`, `review_history`, `review_denials`. The Router/Projection output and
its original review=pending/authorization=none are unchanged.

## Human review commands

Use the existing `/api/commands` operator boundary, request IDs, receipts,
exclusive synchronous transaction and events. Every review command requires
`task_id`, the candidate `fingerprint`, and the viewed `expected_revision`.

- `opportunity.review.edit`: text (max 4096), optional reason (max 2000).
  Preserve the original AI draft; increment human draft and review revisions,
  set pending, clear previous human approval. Editing a rejected card reopens
  review only. There must already be a model draft; target/channel cannot change.
- `opportunity.review.approve`: pending, available card only; revalidate source,
  offer, policy, age, linked suppression/ownership and versions. Bind human
  approval to the draft revision and fingerprint. Change review-state only.
- `opportunity.review.reject`: optional reason; retain a rejected decision and
  all source/model/human versions. No job or inference is created.

The task itself stays proposed, never pending/approved as an executor job.
Cancelled tasks cannot be reviewed. Stale approved reviews expose effective
status stale, not refreshed evidence. Corrections/rejections remain possible
with stale evidence, but approval cannot pass. Human text is untrusted display
data, never a new source proof or executable instruction.

Commands reject unknown fields/grants, forged fingerprints, stale revisions,
agent/channel actors and invalid transitions. Receipts make retry/double-click
idempotent. Success events record request ID, actor, time, input and versioned
result; edits retain old/new text. Sanitized denial events survive rollback,
without retaining rejected text, grants or raw exceptions. Card histories are
bounded to 100 decisions and 30 denial entries; complete events remain in Store.

## Authority and verification

Approve is NOT permission to send. `contact_permission=false`,
`allowed_effects=[]`, `executable=false`; no drafts, approvals, delivery attempts,
agent jobs or Telegram requests are created. Existing scheduler/context/tool
exclusions and generic task.approve prohibition stay unchanged.

Run focused consumer/UI/API/source integration and full Node regression,
Python credential/diagnostics and offline Hermes empty-retry regression, plus
build. UI acceptance uses invented snapshots and hand-authored model-shaped
outputs only, not model/live E2E claims.

Dashboard startup defaults to that checkout's `data/partner.sqlite` using the
same existing Store. `start({directory,config})` supports an explicit isolated
working directory for API tests/preview; connection metadata follows that DB
directory. Do not open/copy the old forensic DB or promote a disposable live
smoke DB to production. Preview uses a fresh isolated DB and no credentials.
This slice retains the existing one-process-per-DB limitation.

## Task #19 offline results

- Full Node suite: 356/356, 0 failures, 0 skips.
- Focused Consumer/UI/operator API/Telegram fixture integration: 57/57.
- Python credential/diagnostics: 8/8; real Hermes offline empty-retry: 2/2.
- Build: 53 JavaScript/JSON files and 9 Python files compiled.
- Existing Dashboard at desktop 1440x1000 and mobile 390x844: rendered,
  no body/modal horizontal overflow; browser Edit -> Approve -> Reject passed,
  no page errors. Synthetic preview returned to pending after verification.
- Preview DB: one review-card, zero runs/drafts/approvals/delivery attempts/
  tool calls/executable tasks. No live Telegram/model request was made.

These results verify review plumbing/safety, not semantic model accuracy or
TASK #11d, which remains PENDING.
