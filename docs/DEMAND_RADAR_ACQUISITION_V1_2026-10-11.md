# Demand Radar acquisition v1 — engineering record, 2026-10-11

## Status and scope

Executable offline acquisition slice; production adoption, native semantic
fidelity and real-community yield remain unproven. This is a completed testable
step toward the owner's search goal, not completion of the whole product.

Canonical main rechecked: d74329d7c027c2cf1a924788ff57fcd3370ac6a9.
Dev donor: codex/demand-radar-acquisition-probe-v0 at
77bd8d5f6240f506ae75e1d6b1df29ae362fcf98, PR #50 / task #49.
Completion branch: codex/demand-radar-acquisition-v1, separate worktree.
Original dirty D:/HARNES2 is preserved. Production code/config, authority,
runtime prompts, schema and workflows are unchanged in this iteration.

The owner's clarification changes the search target: expressed commercial
tasks, resources and constraints before someone asks for a particular MLM
program. Existing clients or a profession alone are not expressed demand;
quoted customer requests and vendor pitches are not the author's own task.
An own historical task is not current intent, offer fit or consent.

## Implemented

1. Versioned RU/UA mission with six broad acquisition families; topics are
   replaceable via local mission JSON. Literal matches are retrieval only.
2. Native sealed Scout-row adapter reusing the exact existing canonical
   commitment, preserving original semantic content hashes and separately
   computing text hashes. Nullable/string opaque reasons follow real RPC
   output. A reduced Scout row cannot independently reconstruct its original
   semantic hash; the sample commitment binds it. Wrong source/account/window/
   cursor/coverage/content is rejected. No new Telegram TL parser or transport.
3. Typed, bounded semantic message input: 1500 rows, 16000 characters per text,
   two million total text characters, bounded identities and metadata; no ID
   object/number coercion. Known ancestry checked all the way to missing,
   opaque or cyclic roots. Unsupported unrelated history does not disable the
   author's independent normal messages.
4. Original texts, authors, dates, links, content hashes, negatives, unselected
   messages and omitted reasons remain inspectable. Stable duplicates stay in
   context. Same-author context references are bounded and co-occurrence has
   no automatic intent/cancellation interpretation.
5. Review packets reserve unmatched exploration as well as matched anchors.
   Full messages only; 32 context rows per group and a global character budget;
   all omissions/deferred anchors are visible. Ancestors of same-author
   messages from other threads are included or disclosed as omitted too.
6. Cursor binds the verified projected content, mission and budgets. Same
   frozen inputs resume after restart without DB or volatile cursor state;
   changed inputs invalidate the cursor. Oversized/broken anchors cannot trap
   later healthy work forever in a frozen bounded sample.
7. Offline CLI produces a new local JSON report, with bounded file reads,
   validation before writing, no overwrite and sanitized error codes. It has
   no provider/runtime/Telegram activation and no sending option.
8. Authored synthetic corpus: 22 messages, manually defined historical own-task
   gold and negative/ambiguity controls. No real personal messages or hidden
   gold are sent to a model. Gold is separate from matcher output.

## Reuse decision

GitHub-first audit considered subscope, reddit-idea-scout and opportunity-radar.
subscope (MIT, cf45ffd8956d0d24bbaaf4eaa5d7f0ecc293cb27) provides a useful
retrieval/classification/explanation pattern, not a directly safe RU/UA
implementation. Its English Reddit/SaaS rules and access-block failover were
not adopted. No OSS code or new dependencies copied. GramJS/Scout, sealed row
schema, canonical digest and existing model boundary remain the foundations.

## Actual executable demo

Command:

```powershell
node experiments/demand-radar-v0/run.mjs --demo --out .cache/demand-radar-acquisition/demo-v1.json
```

Observed: 22 raw rows; 21 readable; 17 literal matches; 4 readable nonmatches;
1 opaque. First packet: 8 anchors; 10 eligible anchors deferred.
Eight of nine manually labelled **historical own-task** anchors match the
literal route. The ninth has unexpected wording and enters exploration.

Eight annotated controls match too, including vendor quotation, forwarded
request, client resource without own task, later cancellation, missing
ancestry, duplicate, seller promotion and peer context. They are not positive
semantic findings. The earlier task at 5001 is followed by cancellation at
5010; both are preserved. This closed synthetic exercise does not measure
live precision, representative recall, market frequency or current leads.

Dev challenged the tiny-corpus recall: routing most text may look good until
owner attention is limited. The same frozen demo with --max-anchors 5 and
--exploration-slots 1 selected only 3/9 historical own-task gold as anchors;
13 eligible anchors were deferred. This is direct evidence that the current
deterministic queue is not semantic prioritization or an effective top-five
lead finder. Nothing was tuned to this gold afterward. Follow-up selection
must earn that claim in the separate native fidelity/attention experiment.

Model dispatches 0; platform network calls 0; actual contacts/sends 0.
Intent NOT_ASSESSED, current intent/fit UNKNOWN, contact permission false.

## Independent red-team and verification

Luna independently wrote native-sample integrity and packet kill-tests before
the implementation. Tests exercise real synthetic Scout sealing through the
existing service/runtime helper rather than blessing hand-waved digests.

Found and fixed: the original scaffold accepted coerced identities, did not
verify native commitments, inspected only the immediate parent, and emitted
unbounded same-author references. Later independent red-team found an actual
cross-thread context hole: a same-author reply entered the packet without its
known parent. The new test failed before the fix and passes afterward.

Independent integration review then found a more serious false-green fixture
assumption: existing Scout test helpers use boolean unsupported/raw-text hashes,
but the actual TelegramScoutRpc serializes a nullable opaque reason and
digest(semantic). The initial adapter incorrectly required the helper's shape.
It is corrected against the actual RPC format, keeping raw sample commitment
verification before the thin semantic bridge. Native regression obtains rows
from actual GramJS/TelegramScoutRpc projection with a mocked transport, then
seals them through the real Scout runtime. Production Scout code is unchanged.

Focused suite: 29 tests PASS, including malformed/oversized input,
digest/content/coverage corruption, full ancestry, forged verified objects,
unrelated opaque context, negatives/cancellation, context limits/whole text,
cursor changes, restart continuation, unmatched exploration, CLI failure
secrecy and output preservation. The CLI continuation test starts a fresh
Node process for every page, using only the frozen sample and saved cursor.

Final combined local gate on Node v24.18.1:

| Check | Observed result |
| --- | --- |
| node --test tests/demand-radar-*.test.mjs | 29/29 PASS |
| npm test | 1675/1675 PASS; no failures, skips or pending tests |
| npm run test:credentials | 25/25 Python PASS |
| npm run build | PASS; 265 JavaScript/JSON and 11 Python files |
| git diff --check | PASS |
| Real model/platform executions | 0; not an accuracy or live-yield test |

Independent mutation check on copied modules/tests (tracked source unchanged):
baseline PASS; all 11 mutations killed by assertion failures, not syntax errors.

| Removed/weakened guarantee | Failing tests |
| --- | --- |
| Raw sealed sample digest check | 2 |
| Full reply ancestry check | 3 |
| Same-author reference bound | 1 |
| Verified packet input check | 2 |
| Cursor binding to evidence/options | 1 |
| Other-thread contextual parent preservation | 1 |
| Contact permission false | 3 |
| Context row limit | 1 |
| Context character limit | 1 |
| Actual nullable/string native unsupported shape | 1 |
| Original semantic hash preservation | 1 |

Local machine artifacts: .cache/demand-radar-acquisition/node-gate-final.log,
mutations/results.json, executable demo reports and mutation harness. These
are not production records or CI evidence. Hosted CI must validate the new
exact pushed head separately; old PR #50 success is not reused as that proof.

## Limits and next evidence needed

- Sealed file integrity is not cryptographic authentication, current source
  permission, fresh DB state, continued usage consent, a continuous history
  proof or proof of distinct people. The tool labels these unverified.
- Public membership and owner test authority do not authorize arbitrary
  platform content use. Dev reports no independently verified real RU/UA
  corpus with the required provenance and processing basis yet.
- Historical findings cannot be replayed into Discovery as current events.
- The current native Gemini path has known source-fidelity failures. This
  iteration does not alter prompts or declare those failures fixed.
- The existing conformance runner is one hardcoded English case with a
  three-attempt history cap, not the planned frozen four-case/two-arm RU/UA
  driver. Native Stage0 must reuse the real CLIProxyAPI/Hermes route, freeze
  cases/gold/prompt variants before calls, record requested/reported model
  identities and tokens, and distinguish logical dispatch from unknown proxy
  retries/billing. No web Gemini substitution.
- Verified market-specific offer terms are still missing; FitLine matching
  remains UNKNOWN. Comparisons must retain alternative solutions/refusals.
- CLI is not a durable production scheduler. A failed final file write or
  crash can leave an incomplete report; no success is asserted and an existing
  file is not silently overwritten. Recovery uses original sample and cursor,
  with explicit operator handling of incomplete artifacts.

Next engineering step is the frozen native semantic experiment and an
independently admitted corpus, then a thin integration with existing Scout
and current-event Discovery. Do not widen live collection, monitor grants,
contact authority or sending to hide missing evidence.

## Independent Dev review: nested replies correction

After push of `5b77a5b`, Dev identified a real remaining context bug: a
different author's reply to a reply could disappear while the packet claimed
`context_incomplete: false`. A new depth-three black-box test failed against
the old implementation: only IDs 100 and 110 survived, while counterevidence
120 and 130 was silently omitted.

The packet now indexes the bounded sealed sample's parent/child relationships
and traverses all known descendants of the selected anchor. It retains full
texts, traverses through opaque children while disclosing them, and lists every
known row excluded by the 32-row or shared character limit. Unknown context
is visible, never reconstructed. Same-author side-thread ancestry remains
preserved ahead of its dependent reply. No source-currentness, authority,
production or dispatch semantics changed.

Four focused regressions cover depth-three counterevidence, an opaque child
with a readable grandchild, eight omitted rows at the 32-row cap, and a
nested branch excluded by the character budget. Restoring direct-only
gathering in a separate copied-module sandbox makes the depth and cap tests
fail at assertions, not setup/syntax errors.

The native Scout digest does not cover `sample.id`, `candidate_id`,
`finished_at` or the seal status. They are caller-provided metadata, not
independently authenticated lineage. A future integration must compare
the current Scout DB record, permission epoch and sample status separately;
the offline bridge cannot establish those facts by hashing a submitted file.

Combined local verification of the correction: 33/33 focused, 1679/1679
Node (no skipped/pending/failed tests), 25/25 Python credential-isolation,
build (265 JavaScript/JSON, 11 Python), and diff check PASS. The old head
`5b77a5b` separately reached hosted SUCCESS in run `38148194024`; the
corrected head needs its own hosted result. Exact release head is recorded
in the handoff and local owner journal, avoiding a self-referential doc hash.
