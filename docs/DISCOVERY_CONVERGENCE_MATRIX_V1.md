# Discovery Intelligence Convergence Matrix v1

## Статус

- **Статус:** requirements-only review artifact; no implementation approved
- **Frozen base:** `main = 4c411e05dffbcfe74279aa4d1ad559b498466d0d`
- **Reliable reference:** R23 Discovery (`8ebbcd1` code, `5ee39c2` ADR)
- **Astra reference:** `c9af08d`
- **Scope:** convergence requirements only
- **Non-goals:** no Astra merge, no production implementation, no migrations, no model/runtime/Telegram/live execution

This document records **what must remain true** before any Astra intelligence, UI, or evaluation work is
considered. It deliberately does not claim that Astra has passed any row. Astra statuses remain `OPEN`
until an independent comparison is performed.

## Invariant matrix

| ID | Boundary | Invariant | Minimal acceptance test | Priority | R23 | Astra | Final requirement |
|---|---|---|---|---|---|---|---|
| E1 | Evidence | Edit/delete makes an old decision stale | Approve → edit/delete → approve is rejected | P0 | PASS | OPEN | AGREED |
| E2 | Evidence | Source revocation irreversibly invalidates an old decision | Approve → revoke → restart → re-allow → old approve does not revive | P0 | PASS | OPEN | AGREED |
| E3 | Evidence | `bootstrap_context_only` never becomes a new trigger | Bootstrap history → collect → no bootstrap-only review | P0 | PASS | OPEN | AGREED |
| E4 | Provenance | Purpose/offer basis is fixed at intake | Intake with offer A → switch to B → restart → old evidence is not reinterpreted as B | P0 | PASS | OPEN | OPEN |
| A1 | Authority | Discovery creates no contact authority | After review: 0 person, permission, draft, or send | P0 | PASS | OPEN | AGREED |
| A2 | Transfer | Transfer requires exact binding, real inbound, and typed reply grant | Remove any one required element → transfer rejects | P0 | PASS | OPEN | OPEN |
| A3 | Permission | Grant is bound to person/channel/account | Grant from another account/channel rejects | P0 | N/A | OPEN | OPEN |
| H1 | Human review | Model proposes; operator authorizes | Model review without operator approval cannot transfer | P0 | PASS | OPEN | AGREED |
| H2 | Human review | Stale can be rejected but not approved | Stale proposal → reject allowed, approve rejected | P0 | PASS | OPEN | AGREED |
| H3 | Human review | Review decisions are revision-bound and idempotent | Old revision/replayed request causes no duplicate effect | P0 | PASS | OPEN | AGREED |
| R1 | Recovery | Restart never resurrects terminal state | Revoke/stale → restart → state remains terminal | P0 | PASS | OPEN | AGREED |
| R2 | Recovery | Reconciliation is fully bounded | `limit=1` cannot silently process 20 cleanup items | P0 | PASS | OPEN | AGREED |
| R3 | Recovery | Durable cursor survives restart | Partial pass → restart → continuation resumes without a zero-progress rescan | P1 | PASS | OPEN | AGREED |
| R4 | Recovery | Reapplying one source event is safe | One source event applied repeatedly produces one effect | P0 | PASS | OPEN | AGREED |
| V1 | Evaluation | Synthetic evaluation is not live proof | Every evaluation report explicitly carries `live_proof=false` | P1 | N/A | OPEN | OPEN |
| V2 | Evaluation | Evaluation never changes runtime behavior | Corpus/labels do not mutate prompt, policy, or runtime | P0 | N/A | OPEN | OPEN |
| V3 | Learning | A lesson is a candidate, not runtime authority | Positive outcome → lesson candidate with `runtime_use=false` | P1 | N/A | OPEN | OPEN |
| U1 | UI | UI cannot imply contact permission | Review card visibly states no contact permission | P1 | PASS | OPEN | AGREED |
| U2 | UI | Stale/revoked reasons are visible to the operator | Review card displays the stale/revoked reason | P1 | PASS | OPEN | AGREED |
| U3 | Operations | Review cards never enter the ordinary agent queue | Corrupt/pending review task is not scheduler-executable | P0 | PASS | OPEN | AGREED |

`PASS` for R23 means the invariant is covered by the current offline evidence; it is not a claim about Astra.
`OPEN` means the requirement still needs an owner decision or an independent Astra comparison.

## Open owner decisions

These are deliberately not implementation details and must be agreed before code changes:

1. **TTL semantics:** whether an expired situation is only terminal for projection or also affects the
   lifecycle of an existing Engagement.
2. **Transfer lifecycle:** reuse the existing Engagement boundary or open a new explicitly named
   Engagement for a transferred situation.
3. **Offer/purpose fixation:** the exact intake moment and durable basis for offer/purpose changes.
4. **Identity binding:** the minimum person/channel/account binding required for a permission or
   transfer.
5. **Evaluation/learning scope:** which synthetic evaluation artifacts may exist without entering runtime
   context or authority.

## Evidence baseline

- R23 focused Discovery suite: `51/51`
- Full Node regression: `491/491`
- Python credential/failover: `8/8`
- Build: `64 JavaScript/JSON files`, `9 Python files`
- `git diff --check`: clean
- Model, Hermes runtime, Telegram, and live execution: not run

## Decision rule

Resolve the matrix in this order:

1. agree the invariant and its owner decision;
2. define the smallest acceptance test;
3. review the GitHub compare;
4. only then write implementation.

No Astra intelligence, UI, or evaluation transfer is approved by this artifact alone.
