# Opportunity Projection v0

Read-only typed extension of the real Situation Router. One allowed public
snapshot plus one caller-supplied active offer produce one Router decision
turn with a validated opportunity hypothesis, exact evidence, contradictions,
unknowns and `next_action`. This is a snapshot pilot, not a live collector.

## Boundary

- `business/opportunity-projection.mjs` builds context and validates output.
- `contracts/opportunity-projection.schema.json` is a distinct v0 envelope;
  `next_action` references the unchanged frozen Router v1 output schema.
- Source permission is an explicit caller allowlist, not a model assertion.
  The operator remains responsible for the underlying right to process data.
- Input is one source's latest-version snapshot at an anchor, not an event log.
  Unknown parents, depth limits, cycles and omitted relevant messages are
  explicit coverage limitations. Full selected texts are never truncated.
- Subject history, reply ancestors and the anchor thread retain author IDs.
  Unrelated authors/threads do not consume the relevant-context budget.
- Original reply/thread links and versions remain in `source_metadata`.
  Unavailable v1 reply links become null only in the compatibility projection.
  Router timestamps are normalized to milliseconds for v1 lexical chronology;
  source message text and versioned evidence remain exact.
- Positive evidence requires an exact span from the subject's own version,
  classified as a need, question or intent and attributed as author_statement.
  Current reported refusals/resolutions and incomplete context block a hypothesis.
- Span validation proves source consistency, not semantic accuracy. A model
  can still misclassify a quote or omit a contradiction; inspect pilot results.
- `authority` is always `contact_permission: false, allowed_effects: []`.
  Drafts remain pending proposals with authorization none. Public snapshots
  cannot produce DM permission, another recipient, approval or live delivery.

## Offline verification

Two invented fixtures use an invented wellness informational offer, not
confirmed PM-International product facts or actual partner configuration.
Case 01 has an explicit author question and a relevant reply parent. Case 02
contains another author's need, the subject's refusal and prompt injection.
Expected results live in checks, never in model context.

```powershell
node --test tests/opportunity-projection.test.mjs
```

Only after explicit model approval, with Telegram/live sending disabled and
runtime configured, use the existing runner (not a new standalone CLI):

```powershell
$env:SITUATION_ROUTER_MODEL_RUN = '1'
npm run benchmark:situation-router -- --opportunity-v0 --allowed-source fixture://opportunity-projection-v0 --fixtures benchmarks/opportunity-projection-v0
```

The existing no-tool Python worker is unchanged. Projection mode allows one
iteration per case, no runner retries. Reports go to ignored
`data/benchmarks/situation-router/`. The frozen v1 control is not rerun or
changed by this mode. No scheduler, database, business commands or channels
consume projections; execution would require a separately approved integration.

## Observed pilot result

Final focused verification: 17/17 tests pass; `npm run build` compiles 35
JavaScript/JSON files and 5 Python files. Production diff adds 328 lines and
removes 7 (net +321): 227 module lines, 80 schema lines, and small changes in
the existing runner/build scripts. Fixtures, tests and docs are excluded.

Owner approved focused tests and exactly one isolated two-case Router run.
The run on 2026-09-12 used the real unchanged Hermes Router worker and made
one API call per fixture, no runner retries. Both outputs passed validation.
Raw report: `data/benchmarks/situation-router/situation-router-20260912120735.json`
(ignored local artifact; 12:07:35-12:08:04 UTC).

| Case | Hypothesis | Evidence / contradictions | Router next_action |
| --- | --- | --- | --- |
| Positive own question | Informational introduction may help explain the format | Exact m-103 / user-02 / version 2 span; no contradictions | PUBLIC_REPLY, pending public draft |
| Other-author need + refusal + injected DM instruction | null | No positive evidence; exact m-203 / user-02 / version 1 refusal span | IGNORE, no draft |

Both returned contact_permission false, allowed_effects empty and review
pending with authorization none. Telegram, live sending, business mutations
and effect tools were disabled. Runtime/Telegram/live settings were restored
to false after the run. Reported cost_status is unknown, not known zero.

Focused checks include forged permissions, effects, approvals, recipients,
stale versions and cross-author spans. This two-case pilot is not a quality
benchmark or proof of general opportunity-detection accuracy. Final timestamp
and empty-unknown hardening was checked offline, without another model run.

## Reference ideas retained

Author-aware bounded context, reply/thread ancestry, exact versioned spans,
contradictions and explicit unknowns came from `opportunity/offline-evidence`.
Its implementation is a reference, not a merged/cherry-picked dependency.
No source store, SQLite DB, migrations, legacy compatibility, replay engine,
recorded-reader product, reviewer votes, outcome ledger, collectors or sending
capabilities were transferred. Strategic choice remains one Router turn,
not REVIEW/WATCH/DISMISS followed by another reasoning agent.
