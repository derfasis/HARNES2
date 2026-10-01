# Outcome & Attribution v1 completion handoff

Branch: `codex/outcome-attribution-completion-v1`.
Parent: `14b7f4f795a81f89ba61035a38ae3bd47d297dc2`.
Canonical main verified unchanged: `8c8889b32bd49cfdf4f3dc32628b1b7883e513bb`.
The parent's ancestry includes the requested `9855eb99a014f56f46389215e17e0c2d3f079ee2`.
The existing dirty worktrees were preserved; no merge, reset or modification of main occurred.

Architecture and API contracts: [OUTCOME_ATTRIBUTION_V1.md](OUTCOME_ATTRIBUTION_V1.md).

## What changed and why

- Real delivery now reaches the Outcome observer. Delivery observation intents survive
  optional observer failures; savepoints remove partial derived writes without replaying sends.
- Additive migration 009 separates source time from recording time, captures delivered
  version/attempt/decision provenance and assigns immutable per-basis observation identities.
- Reconciliation has bounded durable cursors, unknown lifecycle, late positive correction,
  proof revocation/re-attestation and deterministic item quarantine. Corrupt cursor/proof
  inputs cannot permanently block healthy items.
- A future scalar coverage promise cannot certify silence. Completed owner attestations
  are explicit evidence with a proof level; current transports produce no automatic interval proof.
- Review checks exact revisions and complete immutable evidence. Canonical outcome writes
  and attribution are atomic; overlapping observations explicitly link one business result.
  Historical review does not regress joined/declined or restore contact authority.
- Telegram source-time projection has partner-scoped v2 command identities. Replaying a
  pre-upgrade provider receipt recovers missing source time without duplicate work or permission.
- Historical migration/import shapes and actual pre-release databases upgrade safely.
  Transfer revalidates scope, strips active silence claims and discards local recovery cursors.
- Outcome and model-cost metrics are partner-scoped. Unknown coverage, missing windows,
  unknown delivery and confirmed results have distinct denominators.
- Authenticated API validation and a separately served operator review module are complete.
  The UI reads canonical attribution, submits explicit owner reviews and refreshes after refusal.
- Removed unused model knobs, placeholder executable detectors, unbounded answered scans,
  repeated unknown audit writes, redundant source-grep testing and UI attribution fallbacks.

## Gate observed on the final implementation tree

| Check | Result |
| --- | --- |
| Full Node regression, `npm test` | 1028 / 1028 PASS; no failures, skips or cancellations |
| Python credential/adapter tests, `npm run test:credentials` | 15 / 15 PASS |
| Syntax build, `npm run build` | PASS: 131 JS/JSON files, 9 Python files |
| `git diff --check` | PASS |

The full regression includes the existing convergence/source/router gates. Outcome files
cover 80 cases, including 33 adversarial cases. Functional verification uses synthetic
local state, real SQLite and HTTP paths, and fake Telegram providers. It makes no live
Telegram delivery or model-quality claim. No application model call or real outbound
effect was enabled for verification.

The initial seven production-path completion tests all failed on the unmodified parent.
Final acceptance reaches the real delivery command path and real decision association.
Further adversarial tests exposed direct canonical write non-atomicity, invalid timestamp
starvation, pre-upgrade receipt replay poisoning and corruption seams.
Final review also found a false green in frontend unit tests: the server did not serve
the newly imported module. A real HTTP page/entrypoint/module test failed first and now passes.

## Safety invariants

Runtime, Telegram live sending and Outcomes remain disabled by default.
No permission, person, contact, draft, send or execution grant is derived from an outcome candidate.
Public ingestion remains read-only. Existing authority and freshness boundaries are preserved.
Stale/revoked observation evidence blocks its dependent promotion. Unknown delivery and
coverage are separate from success. Human confirmation creates a business fact, not causal
credit; all association responses continue to state `causal_credit: not_established`.
Historical confirmation preserves STOP, suppression, revoked contact grants and cancelled work.

## Remaining limits

- Private Telegram intake still lacks durable complete-interval proof/catch-up guarantees.
  Negative observations therefore require explicit retrospective owner evidence, or stay unknown.
- Source chronology with missing provider dates remains based on recording/owner time.
  Equal-second provider chronology is conservatively unknown until later positive evidence.
- Owner business evidence is not independently verified; attribution is association, not causality.
- Confirmed owner facts remain history when their observational basis is later corrected.
  A business-result correction/reopening workflow and retention redesign are not included.
- Functional tests and HTTP/module tests do not replace a production Telegram or browser
  click-through validation. No live environment was claimed as tested.

## Next architectural step

Integrate this completion into PR #26 and merge the reviewed Outcome contract first.
Then branch from the resulting canonical main for Durable Partner Control Plane v1.
Do not start its implementation on this unmerged completion branch.

The architectural choice remains a shared control plane over distinct public observation,
private engagement, Outcome and bounded local Action execution planes. It must replace
global mode exclusion with explicit plane eligibility, health/recovery and authority
envelopes; private intake durability is a prerequisite within that work. It must not
unify public identity with contact permission or enable automatic sending.
