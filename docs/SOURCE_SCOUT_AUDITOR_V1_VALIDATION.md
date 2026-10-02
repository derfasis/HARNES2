# Source Scout + Auditor v1 — verification and integration handoff

## Branch lineage

Canonical remote main inspected for this task: `4ab8be309d11c93b9df73161fc07c6c029f35aee`.
The layer depends on PR #27 Partner Workspace, still unmerged at audit time:
`b2cbfbef7a1a77cea595b5f82d19bf20ff1aeac9`.

Separate prerequisite branch `codex/partner-workspace-ownership-fences-v1`:

- `8b4025dd32ce09719c070853094469284bc0aa97`: live/unknown PID cannot be replaced
  merely because its lease expired; process ownership fences public/private
  callback commits and direct agent commands require the exact control ticket.
- `0761c943802116ffd01ca6ac6c9115c6cc35034b`: post-await private ownership checks,
  late public/browser failure guards and matching scoped test fixtures.

- `22dc21a4803badd70bcac41b8a4c7fbd704ab073`: intentional blob pin update for the
  ownership-fenced MTProto channel; no runtime or test execution.

`codex/source-scout-auditor-v1` fast-forwards these prerequisites as ancestors.
They are not silently represented as canonical main. The old workspace and its
unrelated changes were preserved; implementation uses a separate worktree.
No main merge, live configuration change, provider call or Telegram run occurred.

## Verification actually performed

Only static verification is authorized by the latest owner-pasted AGENTS guidance.
The later local repository file has broader historical permission; it does not
override that owner restriction. Dev ChatGPT discussion was explicitly requested.

- `npm run build`: PASS — 165 JavaScript/JSON files and 9 Python files;
  syntax and compilation only.
- `node --check` on changed implementation/test modules.
- `git diff --check` before commit.
- Static architecture/red-team review by root, delegated code reviewers and dev.

**Acceptance/kill tests were authored, not executed. No regression PASS, live
validation, model-quality verdict or merge-ready claim is made.** Previously
reported Workspace gates belong to their old exact head, not this implementation.

## Authored verification cases

- `scout-acceptance.test.mjs`: explicit search/audit authority, bounded catalogue,
  no source/checkpoint/CRM effects from history, topic isolation/sample reuse,
  revoke during await, read cursor/restart/backoff, inaccessible != empty,
  invalid page cursor, edit/delete freshness and model-off boundary.
- `scout-integrity-kill.test.mjs`: shared account FLOOD_WAIT across restart,
  monitor reservation/global/per-source caps with positive reads, fair durable
  monitor rotation, source-ID mapping/equal-timestamp edit/delete fence,
  transitive opaque ancestry, whole-checkpoint catch-up CAS and immutable gap
  acknowledgement across restart, retired reconciliation and integrity latch,
  fake-only valid model evidence versus fabricated references.
- `scout-sdk.test.mjs`: pinned SDK bridge and real existing reader wiring, using
  fake transport responses only, including revoke between native page validation
  and durable difference commit. No credentials or external IO are needed.
- `workspace-transfer.test.mjs`: schema-11 grant/job/receipt sanitation and
  historical schema-9/10 catalogue compatibility.
- Historical export fixture constructors exclude later Scout tables. Frozen
  Router/Projection/worker/old migration assets remain unchanged. Store and
  MTProto channel blob pins change intentionally for additive tables/recovery
  and gated read integration; semantic assertions remain present.

## Static findings closed before handoff

1. Expired-but-alive owner split-brain and stale public/private callbacks: separate
   prerequisite commits, without weakening single-owner resource boundaries.
2. Bare runId piggyback without exact ticket: prerequisite command guard.
3. Audit-as-ingestion/coverage confusion: separate immutable historical samples,
   native reader establishes its own baseline and difference proofs.
4. Topic/username grant leakage: campaign revisions plus account/channel identity;
   native locator mismatch is refused before history/monitor publication.
5. Edit during history await hidden by finished_at, and raw/namespaced message ID
   mismatch: source event fence captured before first RPC and explicit ID mapping.
6. Opaque grandparent leaking via an otherwise normal reply: transitive ancestry
   checks without poisoning unrelated messages by the same author.
7. Empty/invalid RPC payload becoming “empty chat,” and all-opaque history taking
   unlimited pages: structural page proof, monotonic cursor and native-row bound.
8. Scout-only FLOOD_WAIT/independent budgets starving existing sources: shared
   durable account gate, monitor reservation and bounded fair rotations.
9. StringSession restart losing access hashes: re-resolve observed public locator
   against admitted native identity; no invented hash/dialog enumeration.
10. Re-admission hash changes leaving an old reader captured against old authority:
    versioned reader identity, exact acknowledged catch-up and no CURRENT reuse.
11. Corrupt checkpoint preventing revocation/poisoning healthy starts: revocation
    commits independently of repair, registry quarantines per-source failures.
12. Late model result/receipt failure and accidental inference retry: grant/process/
    packet revalidation, persistence latch and explicit new model request.
13. Same-PTS checkpoint change after an owner saw it: whole-checkpoint CAS and
    immutable historical-gap acknowledgement; stale confirmation cannot grant.
14. Revocation after native read validation but before queued durable commit:
    the reader checks its exact captured policy without waiting for registry
    retirement; retired Scout reconciliation cannot persist state either.
15. Monitoring consuming the audit allowance before topic changes: an independent
    durable audit/search counter preserves its allocation while the shared total
    still enforces the global ceiling; an interleaving/restart case is authored.

These are static findings and authored failure cases, not executed mutation proof.

## Remaining risks / release gate

Execute the authored tests and full `npm test`, `npm run test:credentials`, build
and diff gate only after owner lifts the restriction. Then independently red-team
the layer, including delayed callbacks, import/restart, corrupt records, source
revoke/regrant and account-level throttling. Test real SDK username resolution,
joined membership, rate limits and reader wiring in an explicitly authorized
bounded read-only pilot before enabling long-running monitoring.

Search recall is unknown. Native community titles/users are not people-quality
signals. History is non-atomic and unmonitored edits/deletes can escape the local
event fence. Numeric peers without a native cache/public locator may be unavailable.
No fresh-cutover replacement of an existing checkpoint is provided; explicit
historical catch-up is required. A hanging RPC cannot be remotely cancelled by a
JavaScript deadline; late results are withheld, not magically undone. Private SDK
reads/authentication and SDK internals are not a hard wire-wide request quota.
Schema 011 execution/migration upgrade, operator UI behavior and functional tests
remain unverified until their authorized runtime gate.

Durable history capacities are hard stops, not a retention redesign. Availability,
model quality and useful opportunity density need pilot evidence. No contact,
causal-credit or sending authority is inferred from an assessment.
