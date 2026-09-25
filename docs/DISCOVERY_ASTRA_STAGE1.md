# Astra Stage 1: Hypothesis + WHY NOW

Baseline: `main@23195c2c2bd0ce45142264999dc668cf9fef3d9d`.
Approved scope: Stage 1 of
[`3637b52` convergence plan](https://github.com/derfasis/HARNES2/blob/3637b5227081f3082648de7105921635e1177309/docs/DISCOVERY_ASTRA_CONVERGENCE_PLAN_V1.md).

This slice adapts only the hypothesis/evidence/uncertainty semantics. It uses the
existing `discovery.assess` operator boundary, immutable assessment events,
Discovery evidence references, and freshness checks. No donor commit is merged
or cherry-picked. No migration, new table, runtime call, or decision vocabulary
is introduced. Existing review and transfer authorization remain unchanged.

## Contract

`discovery.assess` continues to require the current situation revision and full
evidence fingerprint. Its existing `evidence_event_ids` selects the durable
source events used by the assessment. The following structured values are now
accepted together in place of the two legacy strings:

```json
{
  "hypothesis": {
    "text": "A concise explanation may help; interest is unconfirmed.",
    "evidence_event_ids": ["123"],
    "attributed_claims": [
      {"source_event_id": "123", "quote": "I have two hours a week."}
    ],
    "inferences": [
      {"text": "Available time may constrain fit.", "evidence_event_ids": ["123"]}
    ],
    "uncertainty": ["The time claim is unverified.", "Intent to join is unknown."]
  },
  "why_now": {
    "reason": "The explicit question may deserve attention while its evidence is current.",
    "evidence_event_ids": ["123"]
  }
}
```

The server stores `reasoning_version: 1` with the immutable assessment. Both
objects and every reference participate in the existing assessment fingerprint.

- Hypothesis, WHY NOW, and each inference require nonempty, unique reference
  lists. References must be selected by this assessment, belong to this situation,
  and still identify the current durable message version.
- Each attributed claim requires an exact substring of the referenced message
  after ordinary text trimming. Author identity comes from source evidence,
  never from a model-provided attribution. A quote proves what the source said,
  not whether the statement is true.
- Claims and inferences may be empty arrays. Uncertainty must contain at least
  one explicit unknown/limitation. This is structural validation, not validation
  of the reasoning's quality or truth.
- Arrays, strings, and the entire assessment retain bounded size. Unknown fields
  in this business contract are rejected, including fabricated observations,
  freshness assertions, or contact authority.
- The existing string/string form remains supported as `reasoning_version: 0`.
  Old stored events without a version are read as version 0. No attributed claims
  or uncertainty are invented for legacy text; it is not upgraded into a v1
  interpretation. Mixed string/object submissions are rejected.

The model/runtime is not wired in this slice. These are unverified proposals
recorded through the existing operator command; the metadata does not claim
that an actual model generated an assessment.

## Source truth and currentness

`discoveryDetail()` keeps original source messages in `evidence`, separate from
assessment text. Each assessment exposes:

- `epistemic_status: unverified_proposal`, including after operator approval;
- `basis`: original source/subject/context, purpose and offer fingerprint,
  assessment evidence fingerprint, situation expiry, and selected durable source
  references with author, message version, observation and message timestamps;
- `freshness: {fresh, reasons}` applying to **both** hypothesis and WHY NOW.

Observation time comes from `events.created_at` of the source event, not the
message's claimed timestamp, the assessment timestamp, or the read time. Expiry
remains the baseline situation's intake-derived TTL. Assessment/review/restart
does not extend it. The basis metadata is a read projection of existing durable
records, not another persisted model-controlled source of truth.

Freshness is recomputed on read using the canonical source policy, transport
checkpoint, latest message versions, pending source changes, purpose/offer and
TTL. It additionally checks that the assessment's full evidence fingerprint
still matches and that no later assessment superseded it. Operator review alone
does not change its evidence basis; it does not verify the hypothesis as fact.

| Change | Old hypothesis and WHY NOW |
|---|---|
| Edit/delete of evidence | Stale; retain original historical interpretation |
| Revocation | Immediately unavailable; existing bounded maintenance durably retires the situation, including while Discovery is disabled |
| Reallow after durable revocation | Still stale; no resurrection of that generation |
| New same-scope evidence still pending | Stale with `DISCOVERY_PENDING_SOURCE_CHANGE` |
| New same-scope evidence applied | Old assessment stale with `DISCOVERY_EVIDENCE_CHANGED`; a new assessment is needed |
| New assessment on the same evidence | Earlier assessment stale with `DISCOVERY_ASSESSMENT_SUPERSEDED` |
| Offer/purpose changes or expiry | Existing baseline invalidation applies |
| Restart | Recompute from durable state; Telegram recovery invalidates the old current checkpoint |
| Replay of an old request | Returns the original receipt only; never refreshes the assessment |

Durable stale reasons such as `SOURCE_REVOKED` are exposed alongside canonical
currentness failures. Transient transport unavailability follows the baseline:
freshness requires a current confirmed checkpoint again. A healthy fixture
source is not arbitrarily invalidated by restart. Durable edit/delete/revoke,
evidence changes and supersession cannot be repaired by replay or reconnect.

This slice does not invent a second revocation or recovery system. Existing
startup maintenance and reconciliation remain responsible for recording durable
revocation and processing pending observations.

## Authority and scope

The existing `OBSERVE`, `DISMISS`, `CANDIDATE` commands keep their semantics.
Candidate opening text remains an opening proposal in an event, not a draft.
Ordinary review creates no consent, person, conversation, contact permission,
draft, send, or model run. Agent access to `discovery.assess` remains forbidden.

No Stage 2 decision implementation, UI, evaluation, learning, retention change,
model/runtime wiring, or live Telegram work is included. Existing P0/P1 tests
and convergence gate are unchanged. No owner-only decisions from the approved
plan are resolved by this slice.

## Verification

`proof_level=integration` using deterministic synthetic inputs;
`live_proof=false`. These checks validate storage, provenance, currentness and
authority boundaries, not model quality, conversion, or live operation.

Acceptance tests were written and run before implementation: the first ten
failed on the missing structured contract/read metadata. An additional check
covers selected-evidence scope and same-evidence supersession/replay. Review
also caught a missing durable observation timestamp; its strengthened assertion
failed before the timestamp projection was corrected.

| Check | Result |
|---|---|
| Stage 1 + convergence, isolated | 25/25 (11 new + 14 existing) |
| Existing convergence gate, standalone | 14/14 |
| Full Node regression | 516/516 |
| Python credential/failover | 8/8 |
| Syntax build | 66 JavaScript/JSON + 9 Python files |
| `git diff --check` | Clean |

Commands: `node --test tests/discovery-stage1.test.mjs tests/discovery-convergence-gate.test.mjs`,
`node --test tests/discovery-convergence-gate.test.mjs`, `npm test`,
`npm run test:credentials`, `npm run build`, `git diff --check`.

All data used by tests is disposable. No credentials/datasets were imported,
and no model, live Telegram connection, or outgoing delivery was enabled.
