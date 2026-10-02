# Implementation baseline

Canonical main: `4ab8be309d11c93b9df73161fc07c6c029f35aee` (Outcome PR #26 merged).
Implementation: `codex/partner-workspace-v1`; no merge into main.
The acceptance scope below is retained from the approved prebuild plan; earlier SHAs are historical planning context.

# Partner Workspace v1 — implementation preflight

Status: awaiting the agreed merged canonical main; implementation has not started.

Verified GitHub state on 2026-10-01:

- Remote main: `8c8889b32bd49cfdf4f3dc32628b1b7883e513bb`.
- PR #26: OPEN, draft, mergedAt=null, mergeCommit=null.
- Outcome branch: `33526a1b04b57866bf5517af404eb6ee2ea86b46`.
- Outcome is a reviewed dependency candidate, not merged main.
- Existing dirty worktrees are preserved. No branch or repository file was changed.
- Tests/build/product model/live calls have not been run for this milestone.

## Baseline gate

After Outcome merges, fetch main, verify Outcome migrations 008/009 and contracts are present, compare the merged tree against 33526a1, and record the exact baseline. Create a new codex/partner-workspace-v1 branch/worktree from that main. Do not silently base implementation on the Outcome branch, merge main, or cherry-pick the dependency.

Only revise the approved architecture where the merged Outcome changes its assumptions. Inspect ingestion timing, delivery-observation intents, candidate revision/fingerprint handling, transfer invalidation and the actual regression gate before code.

## Approved separation

- Workspace: operator surface and bounded read projections; exposes proposals, never grants execution by implication.
- Work Core: durable public workcase linking goal, evidence, immutable ready material, exact action/handoff and expectation.
- Control Plane: headless admission, scoped authority enforcement, fair scheduling, resource ownership and recovery. A ticket is not an owner grant.
- Existing domain owners: Continuity memory, Executive research, Engagement/contact permission, Action grants/attempts/verification, Outcome/attribution.
- Hermes, SQLite, AJV and existing readers remain the execution/persistence foundation. No replacement framework, new social connector or general workflow engine is authorized by this milestone's design.

## Implementation seams already identified

- Replace process-wide public/private exclusion consistently in config, source-ingestion, runtime and domain calls to automaticBoundary; retain source allowlists and actual read-only transport fences.
- Split ordinary engagement reasoning from sourceTick. Keep source polling and deterministic reconciliation independent of model waiting.
- Enforce admission at the runtime/tool boundary as well as scheduler dispatch. Preserve existing domain prepare/complete freshness checks.
- Reuse runs for billing/attempt provenance. Reserve admission resources atomically with run creation; unknown is not free and is not an automatic retry.
- Add immutable ready-material versions, not instructions in a brief and not a synthetic conversation/draft.
- Extend bounded Action with a fixed owner-local material export bound to exact version/hash; retain accepted-current-Continuity prerequisite, grants and independent verification.
- Keep material review, receipts and workcase progress out of continuity.note to prevent authority/review cycles.
- Public expectation observations remain separate from private Outcome windows. Explicit links never create identity, contact permission or causal credit.
- Catalog actual capability contracts/readiness for both model and operator; instruction skills remain separate from authority.
- Ensure new Workspace dispatch cannot enter legacy autopilot approval/send hooks.
- Private MTProto concurrent events must not be dropped. Queue/recovery health must not falsely claim complete historical coverage.

## Black-box acceptance oracles (planned, not executed)

1. Two-day case through command/API + actual scheduler: goal -> source event -> proposal -> ready material -> explicit reviews/grant -> real local artifact -> independent read -> expectation -> shutdown/restart -> new source evidence -> continued case. Same goal/case IDs; no re-entered objective or duplicate effect.
2. Disabled defaults: no model, external send, person/conversation/permission creation from public work. Add positive controls with explicit local grants.
3. Coexistence: delayed fake public inference does not stop source intake; authorized private drafting and local verification progress under fair admission.
4. Stale matrix: edit/delete/revoke/expiry before review, before dispatch and during model waiting block dependent writes/effects. Unchanged evidence remains usable.
5. Exact bytes: material edits require new review/grant; old approval exports neither latest text nor changed render bytes. Independently hash/read the artifact.
6. Authority escalation: source instructions, skills, capability metadata, material approval and admission tickets cannot produce contact grants or send. Exercise direct runtime/API bypass paths.
7. Review-cycle regression: material review and receipt persistence do not mutate the accepted Continuity basis; actual source/goal changes still invalidate it.
8. Replay and revocation: repeated commands/unchanged Browser polls produce no duplicate case/material/effect; reallow does not resurrect revoked grants.
9. Crash failpoints: prepared, dispatching, effect completed before receipt, verification underway. Probe real effects after restart; never replay an unknown dispatch.
10. Late completion: obsolete process/ticket/case revision cannot apply result or release a newer owner's reservation. Preserve historical usage/receipt separately.
11. Budget/fairness: competing admissions cannot overclaim a model slot/run allowance; hot source or failing plane cannot starve other ready work; unknown cost is not zero.
12. Result truth: task.done != published; owner-attested publication != independently observed response; incomplete coverage != measured silence; association != causal credit.
13. Transfer/restore: provenance/material history survives; active grants/leases do not become executable; actual source freshness/coverage is re-established.
14. Operator surface: serve the actual page/module via authenticated loopback HTTP; strict request validation, captured revisions, stale refusals and no silent resend/retry.

Use existing temporary SQLite/BusinessService fixtures from actions/continuity, actual start()/Scheduler composition, deferred fake runtimes and the real local verifier. Do not prove implementation with source-text grep or mocks that skip admission. A live read-only smoke is distinct from synthetic gate evidence.

## Finish gate

New focused acceptance + adversarial tests; existing convergence gate unchanged; full Node/Python regression; build; git diff --check; independent red-team; docs with exact branch/head/baseline, verification limits and remaining risks. Commit/push the isolated branch; do not merge main.
