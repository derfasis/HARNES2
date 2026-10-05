# Next product milestone: Source Authority Continuity v1

Reconnaissance base: checked and merged main
`56b354cc551d92b680134c554c0af258edf1bde6` (PR40).
The initial plan was saved before implementation at `7146035`. Source renewal is
now implemented on the same isolated branch; verification is recorded below.
The product objective remains unfinished; native recommendation usefulness remains unproven.

## Saved continuation boundary — 2026-10-04

At this saved boundary the isolated branch `codex/source-authority-continuity-v1`
was based on the exact merged main above and changed documentation only.
No renewal command, migration, runtime behavior, UI or new acceptance test had
been implemented at that boundary. The preceding green gate was not this layer's gate.

The preceding Verified Partner Activation release is complete: PR40 merged at
the exact base SHA above. Local and hosted gates passed 1510 Node tests and
25 Python tests plus build. Hosted run37229990138 completed successfully on
that exact SHA. Its finite native read-only verification observed three current
readers, made no model/contact/send effects, and was explicitly stopped.

The private owner launcher remains unstarted. Existing grants and activation
deadlines have not been renewed. Resume here with common source/evidence epoch
review and black-box RED acceptance before implementation. The previous release's
green gate is not evidence that source renewal has been implemented or is safe.

## Product gap confirmed in code

An owner's ongoing goal can lose its only source when a finite Scout monitor
permission expires. A new explicit Scout admission can restore the reader, with
gap acknowledgement and retained PTS. The same Audience goal stays bound to its
old monitor epoch and cannot continue; today the UI offers creation of another goal.

- `business/scout.mjs`: `admit`, checkpoint gap acknowledgement and
  `rebindMonitorCheckpoint` preserve PTS while clearing confirmation and marking
  catching-up / coverage-not-established.
- `business/audience.mjs`: `policyHash` includes live Scout grant IDs/revision/expiry;
  `watchAuthority` permanently revokes the old `(goal_id,source_ref)` watch on mismatch.
  Only `open` inserts watches. No owner rebind/resume-source command exists.
- `business/migrations/012-audience-intelligence.sql`: one current watch row per goal/source.
- `business/audience-attention.mjs`: attention binds exact watch hashes; an old
  grant must never authorize changed source scope.
- `business/audience-current-events.mjs`: `currentBasisState` verifies frozen
  policies, exact events/lineage, goal revision and current watch authority.
- `business/audience-followup.mjs`: `history` deliberately refuses old source
  policy/withdrawal. Watch renewal alone does NOT make prior need follow-up current.
- Existing `audience-acceptance.test.mjs` has separate negative tests: monitor
  reissue cannot revive an old watch, and source revoke/reallow/restart cannot
  revive an accepted need. Preserve both tests unchanged.

## Chosen direction

Let the owner explicitly continue an existing goal under a new currently valid
source epoch. Keep revoked bindings as history, acknowledge the observation gap,
and require fresh support/new model authority/review for any new conclusion.
Never turn re-admission into automatic resurrection of an old hypothesis, Work,
material, Action, Outcome conclusion or consumed/pending model request.

Reuse Scout admission/checkpoint rebinding, source readers, normalized ingest,
Audience reconciliation/fairness, CP, existing model profiles and review machines.
No new parser, generic scheduler, queue, provider/runtime, auto-join or auto-send.
Existing source/permission state machines remain authoritative.

## Accepted architecture

1. Read-only renewal preview binds the exact goal/watch, current permitted source
   policy + monitor grant epoch, durable source head/checkpoint and known gap.
   Preview is not authority, ingestion or inference.
2. One operator-only, idempotent explicit renewal command acknowledges that exact
   preview; changes/revoke/expiry between preview and commit refuse atomically.
3. Preserve an immutable watch transition/epoch record rather than erasing the
   old binding. Keep the current watch as a projection. Use existing event audit
   where it proves the required record; add only the schema genuinely needed for
   replay-proof binding/transfer. Goal identity/objective/history survive.
4. Do not merely overwrite `policy_hash` or reset its cursor to0. Explicitly choose
   and freeze a monotonic observation boundary for the new epoch. Old cached
   exchanges/confirmation cannot silently become fresh evidence under new authority.
   New evidence must arrive under the new epoch, or be independently revalidated
   with a durable bounded source receipt. Reinspection needs its own existing read
   permission, bounded SDK call and honest coverage; no synthetic confirmation.
5. Separately bind new watch authority versus old source evidence. Static source
   reallow with an identical policy hash is a kill case too: old provenance must
   not become live by hash equality. Retire dependent old pending work before the
   new binding is visible; do not auto-grant ordinary attention/follow-up.
6. Start with safe new observation/goal continuation. Historical need memory is
   retained as non-current history. Carrying it into a new model prompt requires
   a separate evidenced semantic rule; source withdrawal is currently permanent
   for that basis and must not be treated like temporal expiry for convenience.
7. UI shows old/new permission, gap/unknown coverage, what will remain stale and
   what can be observed next. One explicit confirmation renews only the watch,
   with no contact/person/conversation/model/material/send permission inheritance.

## Required kill tests before implementation

- Expire/revoke monitor -> old watch stays revoked after source re-admit and restart.
- Healthy new source authority alone cannot change the old watch or make a call.
- Exact operator preview/renewal permits new observation on the SAME goal; no
  replacement goal, cursor rewind, fabricated coverage or model call is created.
- Changed goal/watch/policy/grant/checkpoint/head between preview/commit rejects;
  wrong actor/partner and duplicate replay still verify exact authority.
- Pending old assessment, attention/follow-up, need acceptance, Work/material or
  Action completion cannot cross the renewal; incurred usage/attempt remains.
- Old cached unchanged text, identical static policy reallow and no new source
  events cannot fabricate fresh new-epoch evidence or restore old approvals.
- Newly observed independent evidence can support a NEW reviewed proposal under
  separately explicit current model authority; healthy positive controls are required.
- Crash before/after transition commit cannot partially rebind, double-renew,
  forget the acknowledged gap or automatically replay a model request.
- Corrupt one transition/watch cannot starve a healthy neighboring source/goal;
  durable reconciliation cursor advances with bounded work.
- Export/import keeps history but revokes executable watch/model authority; older
  schema positive controls and immutable migration checksum boundaries stay valid.
- Actual operator UI, scheduler/reader and model-envelope integration prove the
  lifecycle; green helper predicates alone are insufficient.

## Work order

The isolated branch above is prepared; before implementation recheck fetched
canonical main. Re-audit actual
common source/evidence epoch contracts before picking the smallest schema change.
Add black-box RED acceptance first; implement explicit renewal and fresh-evidence
boundary; own red-team; local/hosted/full gates; finite native read-only check and
independent usefulness review later. Do not quietly relax source withdrawal or
reset an unknown-cost ledger to force a native model demonstration.

## Implemented contract

- A currently `OPEN` goal can explicitly renew one revoked existing source watch.
  The source must already be permitted. Scout admission and transport recovery
  stay separate; this command cannot extend or create their authority.
- Authenticated read-only GET
  `/api/audience/goals/{goal_id}/source-renewal?source_ref={source_ref}` produces
  a frozen preview. It binds goal revision/objective, old watch, permitted source
  policy/monitor grants, durable source head, checkpoint and transport status.
  It writes nothing and reads no external source.
- Operator-only `audience.renew_source` requires that exact preview hash, the
  goal revision and `acknowledge_gap:true`. Any intervening basis change rejects.
- Migration016 adds `audience_watch_epochs`. Immutable append-only domain records
  carry an independently salted watch hash, prior binding, generation, observation
  floor and transition checksum. `audience_watches` remains the current projection.
  There is no new transport, parser, queue, scheduler or model provider.
- The same goal/objective/revision survives. Cursor advances to the acknowledged
  durable head. Only later event versions are eligible as source evidence; old
  versions may establish verified structural ancestry but cannot become citations.
  An unchanged Browser re-read does not create a new event or bypass this floor.
- Epoch insertion, watch update, dependent retirement, audit and command receipt
  share the existing SQLite command transaction. Failure rolls back all of them.
  Restart retains both the boundary and consumed attempts. Duplicate requests
  validate current authority and the complete immutable result before returning
  their existing receipt. Revoke, transfer or a later renewal blocks old replay.
- No source, model, contact, person, conversation, material, Action or send grant
  is created. Old needs/assessments remain stale, attention scope hashes change,
  late model completion is withheld and actual/unknown usage is not reset.
- Model and source freshness gates remain independent. A transport catching up
  can be displayed in a renewal preview; it cannot support inference until the
  existing reader/freshness contract proves it current.
- Runtime validates the complete indexed epoch chain with a hard budget of256
  transitions per goal/source. Beyond this v1 budget renewal fails closed with
  `AUDIENCE_WATCH_EPOCH_LIMIT`; it never discards history or silently validates a
  tail. Corruption quarantines only its source, preserving neighboring progress.
- Transfer catalogs2–15 remain historical. Catalog16 includes epoch history;
  import validates its whole chain and revokes executable watches/model authority.
  Imported receipts cannot reactivate a watch.
- Audience UI offers renewal for revoked watches, explains unknown coverage and
  stale historical conclusions, requires explicit acknowledgment and rechecks the
  frozen preview before submitting the same-goal command.

## Verification and own red-team

Black-box RED acceptance first demonstrated the missing preview/renewal API.
Focused core, UI, real authenticated HTTP and real staging transfer checks now
pass15/15. Existing revoke/reallow and monitor-reissue negative tests are retained.

Six finite guard mutations were independently caught by the new focused suite:
preview binding, whole-exchange evidence floor, current-events evidence floor,
complete replay receipt binding, integrity of an older epoch and confirmation of
the SQLite watch update. A real `RAISE(IGNORE)` trigger proves a declined update
cannot publish a success receipt or partial epoch. Each mutation
was restored byte-for-byte before final regression.

Independent review found that checking only the newest epoch and its predecessor
missed corruption two generations back. Runtime now checks the complete bounded
chain; a generation1 corruption with generation3 active is an executable kill.
Another test was strengthened to forge receipt authority while its watch was
still current, so revocation could not hide a missing receipt-integrity guard.

The initial full regression passed1516/1524: eight failures were exact current
migration-count expectations15 vs16. Those assertions now reflect the additive
migration; historical prefixes, checksums and state-preservation assertions remain.
Final combined local gate: Node1525/1525, Python25/25, build244 JavaScript/JSON
and11 Python files, `git diff --check` PASS; no Node skips or cancellations.
The new migration is pinned to LF in `.gitattributes`, so its immutable receipt
bytes survive Windows/Linux checkout. Do not attribute the preceding release's
1510 test gate to this layer. Hosted CI is a separate exact-head release check.

No real Telegram renewal, native model pilot or recommendation-usefulness claim
is made for this layer. The native owner deployment remains pinned to the earlier
verified release until explicitly updated and checked. No authority deadlines,
unknown-cost ledger or configured production defaults were changed.
