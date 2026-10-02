# Source Scout + Auditor v1 — verification and integration handoff

## Provenance and authorization

Canonical remote main rechecked during verification: `4ab8be309d11c93b9df73161fc07c6c029f35aee`.
PR #27 Partner Workspace remains OPEN/DRAFT at `b2cbfbef7a1a77cea595b5f82d19bf20ff1aeac9`.
It is an explicit dependency, not a merged baseline. Main and PR #27 were not modified.

Separate prerequisite `codex/partner-workspace-ownership-fences-v1@22dc21a4803badd70bcac41b8a4c7fbd704ab073`
contains process/PID and callback ownership fences, exact Control Plane tickets and
the intentional MTProto blob pin update. The Scout branch descends from it.
Implementation `0e06cc6` and provenance correction `2499347` were initially published
with syntax-only verification. The owner subsequently explicitly authorized tests,
Gemini/API, CLIProxy and bounded live verification. This report supersedes the
earlier unexecuted-test status. Outbound/contact/join authority was not expanded.

Work uses `D:/HARNES2-worktrees/source-scout-auditor-v1`; unrelated original-workspace
changes were preserved. Smoke runs used isolated temporary business state.

## Executed gates

- Full `npm test`: **1137/1137 Node PASS**, zero skipped/cancelled.
- `npm run test:credentials`: **15/15 Python PASS**.
- `npm run build`: **169 JavaScript/JSON + 9 Python syntax compilations PASS**.
- `git diff --check`: PASS.
- Focused Scout acceptance/SDK/integrity/UI/authority/budget/cadence checks: PASS.

These are local Windows results for the completion tree. Hosted CI is reported
separately for its exact head; local PASS does not imply hosted PASS.

The first executable pass exposed three fixture issues, fixed without weakening
production semantics: a recovered history page is made explicitly due instead of
depending on one-second wall time; two lean service fakes declare Scout disabled;
an older Browser blocked test remains serialized without nesting a second SQLite
transaction around the fenced helper's own transaction.

New operator tests exercise escaping and permalink allowlisting, read-only load,
model-off requests, unchecked historical-gap approval, exact PTS/fingerprint,
manual rationale, approved assessment admission, revision binding and a real
authenticated server on an ephemeral port with Telegram/models disabled.

## Independent review and fixes

Dev ChatGPT reviewed published `2499347` without changing the branch. Root
confirmed and resolved its three concrete findings:

1. **Audit spending all source capacity:** durable `audit_sources` reserves
   monitor capacity within the existing total per-source hard cap. Global
   `requests`/`audit_requests` remain independent. Interleaving/restart preserve
   both caps; legacy attribution is conservative and malformed state fails closed.
   A source cap of one explicitly leaves zero audit capacity.
2. **Fixed cadence incompatible with 60s freshness tolerance:** polling now
   targets `min(120s, effective maxLagSeconds / 2)`. This is a nominal attempt
   cadence, not an SLA; budget waits never advance source confirmation.
3. **Topic grants shadowing one another:** a second campaign's monitor grant for
   the same account/channel is refused before grant/network effects.
   Legacy duplicate authority is withheld after restart, without a first winner
   or silent rewrite. Candidate account/campaign must match the grant. Operator
   currentness compares the exact grant policy. Static authority is not overridden.

History reuse between campaigns remains supported. To transfer monitoring, revoke
the earlier grant and explicitly acknowledge the existing checkpoint for the new
one. PTS and the integrity latch survive. No aggregation or fake fresh cutover
was added. Healthy neighboring sources survive conflicting/cross-campaign records.

## Executable semantic red-team

Seven original mutants were killed in a detached worktree with a passing baseline.
Each failed the intended semantic assertion; production bytes were restored:

| Weakened invariant | Observed kill |
| --- | --- |
| Public reader captured policy | Retired reader remained owner after successor grant |
| Whole-checkpoint CAS at unchanged PTS | Stale acknowledgement accepted |
| SQLite immutable grant trigger | Historical catch-up PTS could change |
| Independent global audit accounting | Extra audit reached adapter |
| Source event ID fence | Equal-timestamp revision failed to stale sample |
| Transitive opaque ancestry | Descendant re-entered semantic evidence |
| Post-await audit authority | Expired held RPC returned sample_page instead of withheld |

The held-history expiry case is permanent. It expires authority only after the
RPC starts, keeps process ownership valid and proves no content/cursor advance;
a revoke command staling the job cannot produce a false positive.

Four additional detached mutants were also killed: weakening the per-source
audit reserve, restoring fixed 120s cadence, disabling duplicate-source admission
rejection and disabling legacy conflict withholding. Restored authority tests
passed 5/5 with healthy-neighbor and static-reload controls. In total: **11/11
targeted mutants killed**. These prove particular guards are exercised, not that
all possible failure paths have been exhausted.

## Authorized live smoke, 2026-10-02

**Telegram:** existing current-workspace protected StringSession/API configuration,
temporary partner/database and an explicit audit grant. One `contacts.Search`
query `фитнес` (limit 5), one native public candidate and one `GetHistory` page
capped at 20 rows. Account identity was verified. No joins, dialogs, private
handlers, admission/monitor grant, model or sender was installed.

- 1 search + 1 history request; no other Scout RPCs.
- 20 observed messages: 1 supported text, 19 opaque/unsupported; three observed
  days, zero visible author IDs/replies. These are bounded sample counts only.
- `sample_page`, collecting, coverage unverified, continuous coverage false.
- Zero persons/messages/drafts/contact permissions/delivery attempts and zero
  source.message events. Audit history did not become business ingestion.
- Client disconnected, process ownership released and temporary sample DB removed.

This proves bounded SDK search/history acquisition, not useful community quality
or monitoring CURRENT. The older configured numeric source has no recoverable
public locator in current metadata; StringSession stores no entity/hash cache.
No locator/hash was guessed and dialogs were not enumerated.

**Gemini, separate synthetic-data smoke:** one explicitly queued Scout assessment
through the installed HermesAdapter and Control Plane using an isolated sealed
synthetic source sample and the owner's existing loopback CLIProxy. Advertised
model `gemini-3.7-flash-high`:

- Durable assessment_proposed; exact evaluator/sample digest and valid cited ref.
- Completed public source_assessment ticket and run; no tools.
- 2148 input / 129 output tokens; cost **unknown**, not zero.
- No change to person/draft/delivery/contact/grant/Scout-read counts.
- Recommendation unsuitable. Envelope validation did not approve the assessment
  or create monitoring permission.

These are two separate smoke runs. Live Telegram message content was not sent to
Gemini; no real-source selection-quality proof is claimed. Hermes permits one
empty-response retry, so a no-tool run has at most two provider iterations, not
a promised one-wire-call ceiling. CLIProxy was started for the smoke and stopped.
Persistent configuration and credentials were unchanged. Ignored local receipts
contain aggregate/synthetic data only; this document tracks no keys or live content.

## Remaining limits and integration

- Search recall and useful community/opportunity density remain unknown. No
  claim that this smoke found the best sources or validated a 5–10-source pilot.
- History is non-atomic. Unobserved edits/deletes may escape the local event fence;
  finished_at does not mean fresh-through or continuous coverage.
- Numeric peers without cache/public locator may be unavailable. Ongoing monitoring
  requires an already joined native source and separate explicit owner grant.
- Budgets, fair scheduler turns and RPC delays can cause honest stale state.
  Deadlines do not remotely cancel Telegram calls. SDK/private authentication is
  outside a hard wire-wide quota. Hard history caps are not retention redesign.
- Model smoke proves contract/runtime/authority plumbing, not decision quality.
  Unknown provider cost remains conservatively recorded.
- PR #27 and the ownership prerequisite must be integrated deliberately. Scout
  test results do not verify an unmerged canonical main. No main merge or
  outbound/contact authority is included in this handoff.

The next product gate is an explicitly admitted read-only portfolio pilot with
owner-visible evidence and lag. Keep search/audit, monitor, model requests, contact
and send as separate authorities.
