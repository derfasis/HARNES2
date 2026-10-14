# Reviewed References v1: verification and handoff

Baseline: canonical main `a9c2ad9e823ae8e12951a43498a582fecfd7f758` (Scoped Scout assessment). Implementation branch: `codex/engagement-reviewed-reference-v1`.

The initial black-box acceptance suite failed against the old implementation on the missing commands/context. The final local gate passes **1701 Node tests, 35 Python credential-isolation tests, build and `git diff --check`**, with no skipped or cancelled Node tests. Thirty new acceptance/API/UI/transfer/kill tests cover this increment. Historical transfer fixtures were corrected to represent their actual migration catalogue; old SQL checksums and unrelated frozen paths remain unchanged. The frozen Store pin changes only for the reviewed reference table appended to its transfer catalogue.

## Independent review and kill cases

Review found and fixed active-reference selection hidden by presentation history, malformed packet timestamp alignment, stale dependent beliefs/counterevidence, late model completion overwriting cancellation, and long-source transfer truncation parity. A held ACT/draft positive control is created before source edit; completion is then cancelled, its token usage retained, and its draft invalidated. Corrupt records do not block a healthy neighbor. Revocation, expiry, edit/delete/gap, new question, restart and imported authority cannot resurrect a prior reference.

Two temporary in-memory mutation probes demonstrated actual failures when the expiry guard or stale-belief filter was removed. This is not exhaustive mutation coverage. API/UI tests include authenticated native server access, exact queries, escaped source content, safe primary-source links, old-selection response suppression and operator-only attachment. Test server cleanup ordering was corrected after an initial harness hook failure; its leftover test instance was explicitly stopped.

## Real source and model conformance, 2026-10-14

An isolated native server read the configured [official Germany registration page](https://www.pmebusiness.com/registrationv2/?country=de&lang=de) through the existing Browser reader. A source-backed Continuity result and approved Work material were then attached to one **synthetic private question**. This was a technical test, not a real customer, owner market choice or production activation.

Run `fccbe050-eb84-49d1-ae27-6d6302602557` completed through the configured CLIProxyAPI/Hermes route with `gemini-3.8-flash-high`. It cited the attached reference and produced an **ACT with pending draft**, disclosed digital-assistant identity and explicitly left mandatory costs, package obligation and payouts unknown. Independent semantic review passes the narrow source-explanation task; commercial eligibility, complete terms and pricing still require proper evidence and review.

Usage: **61,750 input + 5,290 output tokens**, four worker-reported API units. Provider HTTP/retry counts and monetary cost are unknown; a logical run is not necessarily one provider request. Cleanup revoked the test reference/contact grant, closed its Engagement and left **zero active references/grants, delivery attempts and outgoing messages**. Real model was used; private inbound was synthetic; partner/customer sends were zero. Runtime, scheduler and Telegram test activation were removed and the native test server drained.

The original result and spent attempt ledgers are retained locally under ignored `.cache/scout-scoped-verification/reviewed-reference-v1/`. Two earlier helper attempts are preserved: an invalid Browser configuration stopped before any source/model dispatch; a nested-transaction helper error stopped after one real source read and before any model. Neither was replayed or presented as a model success. The corrected ordered attempt performed one additional source pass and one logical model run. Across this verification there were two source passes and one logical model run; no published production semantics were changed to accommodate the helpers.

## Practical limits

The attached excerpt described registration navigation, not comprehensive commercial terms. The source projection was truncated at 2,000 characters, publication time was unknown and no independent corroboration was claimed. Germany is a declared test applicability label; it is not the owner's or person's established market. This increment connects evidence-backed material to a question, but does not automatically choose relevant research, establish product fit, acquire consent or send anything.

Prior native Telegram transport verification is separate from this synthetic-question conformance. Hosted CI must pass on the exact pushed implementation before canonical integration. Browser/Dev chat access was not available in this session; a local handoff is not a delivered Dev message.
