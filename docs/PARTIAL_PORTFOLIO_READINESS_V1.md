# Partial portfolio readiness: acceptance and work log

Canonical base verified from `git ls-remote origin refs/heads/main`:
`4b4b3c5893f61694570cf4f9f147fb00850d9915`.
Isolated branch: `codex/partial-portfolio-readiness-v1`.

## Product problem and chosen change — before implementation

The owner wants a partner observing a useful portfolio, rather than a two-source
demonstration. The previous pass verified 20 public group profiles and 39 offline
checks, including bounded audit queues and durable monitoring fairness. Those
profiles are not admitted live sources, and their dialogue usefulness is unknown.

Two independent Luna code audits found a concrete discrepancy: Audience selects
current exchanges from the healthy part of a goal's portfolio, whereas
`AudienceAttention.summary()` reports the whole goal not ready if any source's
transport is not current. Conversely, it may report ready with healthy transports
but no unconsidered, supported evidence. This confuses the owner's dashboard
without describing the dispatcher's actual next ordinary inference opportunity.

Chosen implementation: reuse one existing bounded next-packet selection in both
Audience detail/capture and Attention's read-only readiness presentation. Show
enrolled sources, current source health, sources represented in the next bounded
packet and eligible exchanges separately. Keep whole-portfolio currentness as a
separate fact. Partial valid evidence may support an ordinary proposed inference;
revoked source authority still invalidates the exact whole-goal model mandate.

No new parser, transport, queue, scoring engine, registry or durable state machine
is required. No schema migration, source admission, production activation,
permission renewal, model billing or outbound effect is authorized by this view.
No weakened freshness, watch epoch, grant binding, cap or completion rule.

Dev recommends verifying the existing complete product path on own-authored
controls rather than inventing another framework. We agree: the readiness fix is
driven by an actual discrepancy, and its acceptance must exercise actual dispatch
with a local controlled provider, not only render a hand-written green status.
Real-model product quality remains a separate finite experiment after this fix.

## Acceptance written before code

1. A 20-source goal retains explicit source authority for all watches. One source
   has a current supported exchange; others have a temporary transport/observation
   problem. The summary reports partial health and selected packet separately,
   and ordinary readiness agrees with dispatch. Provider context excludes the
   withheld sources; no broad coverage claim is made.
2. No supported unconsidered exchange means no ready ordinary inference, even
   when source health is current. Unknown/opaque/missing ancestry is not evidence.
3. Revoking a watch blocks the exact original whole-goal inference authority,
   even if a healthy exchange remains. Do not silently shrink/renew the grant.
4. Capture, restart and completion retain the existing once-only consideration,
   finite attempt accounting and last-admitted-run completion semantics. A view
   refresh neither captures evidence nor purchases inference.
5. Operator rendering distinguishes complete source health from selected bounded
   evidence, shows a partial portfolio plainly, escapes untrusted fields, and
   does not POST or turn a status into contact/effect authority.
6. Run focused readiness/authority/recovery tests, full Node and credential tests,
   build and diff checks before deciding release. Record exact results and limits.

## Work log

- 2026-10-08: Rechecked the original dirty workspace and preserved its edits.
  Rechecked isolated worktree and remote main; both code heads are the canonical
  base above. Existing live pilot remains stopped. Source research artifacts
  remain outside tracked production data.
- 2026-10-08: Read-only audits confirmed current-only exchange selection,
  independent whole-goal source authority, and the presentation discrepancy.
  Discussed the next product slice with Dev in the owner's open ChatGPT chat.
- 2026-10-08: Extracted the existing bounded selector into `AudienceLoop.nextPacket`
  and reused its exact result in detail/Attention. Capture continues through the
  same detail selection. No new durable table or changed admission contract.
  `source_current` describes all enrolled sources; `evidence_ready` describes the
  next ordinary packet; `ready` still requires the existing model, authority and
  budget conditions. A captured/running assessment is reported separately and
  prevents the presentation from advertising another ordinary admission.
- 2026-10-08: Added five actual service/processor acceptance tests, five operator
  UI tests and retained eight bounded 20-source Scout proofs in the permanent
  suite. Witnessed the old partial-health and empty-evidence assertions fail
  before accepting the implementation. Real calls in acceptance use a controlled
  local provider; no network provider or Telegram transport is invoked.
- 2026-10-08: Full gate passed: `npm test` — 1,630/1,630 Node tests, zero skipped;
  `npm run test:credentials` — 25 Python tests; `npm run build` — 259 JavaScript/
  JSON and 11 Python files compiled; `git diff --check` — clean. The independent
  focused Audience/Attention/UI/recovery/renewal set passed 71/71.
- 2026-10-08: Own red-team caught 3/3 isolated load-time mutations: restoring the
  all-source health block, bypassing one revoked watch's whole-goal scope check,
  and removing durable once-only consideration. Each produced its relevant
  failed semantic assertion, not merely a load error. Mutations did not alter
  production files. Independent final review found no code/test blocker.
- 2026-10-08: Rendered the actual local operator UI against a finite, isolated
  own-authored fixture: 20 enrolled sources, one current, one exchange from one
  source in the next packet, completeness unknown. Model/Telegram/scheduler/send
  remained disabled and no inference grant existed. The server was stopped after
  inspection; its PID and port listener were confirmed absent. No production DB
  or live pilot was started. This does not prove real community selection quality.

## Changed code and release boundary

- `business/audience.mjs`: shared selection and explicit partial-portfolio counts.
- `business/audience-attention.mjs`: packet-based next-inference presentation,
  separate whole-portfolio health and captured/running assessment status.
- `public/audience.js`: displays these distinctions, unknowns and escaped values
  without issuing commands. Existing owner grant/revoke handlers are unchanged.
- `tests/audience-portfolio-readiness.test.mjs`: healthy-subset dispatch,
  empty-evidence refusal, whole-goal revoke, read-only preview/capture equivalence,
  in-flight last-attempt completion and restart/no second purchase.
- `tests/audience-attention-ui.test.mjs`: five new rendering assertions including
  missing/null/pending and hostile input cases.
- `tests/scout-portfolio-{audit,cadence}.test.mjs`: bounded twenty-candidate audit,
  durable history cursor, twenty-reader rotation/restart, fair quotas, account-wide
  FLOOD_WAIT persistence and no fabricated fresh/complete evidence under caps.

No workflow, production configuration, schema, provider/tool wiring, source
permission, contact permission or send boundary changes. Runtime and outbound
defaults remain disabled. The original dirty workspace is preserved.

Local verification is complete. Publish an isolated review branch and require
hosted CI on its exact commit before integration; a queued run is not a pass.
Git release does not admit sources, renew grants or activate the live partner.

## Limits

Offline source and provider fixtures prove conductibility and contracts, not
Telegram throughput, real community demand, PM/FitLine match or intelligence.
Telegram content-processing basis remains unresolved. A public profile, an owner
test grant and a green suite do not license AI use of third-party messages.
The broader partner project remains active after this bounded release.
