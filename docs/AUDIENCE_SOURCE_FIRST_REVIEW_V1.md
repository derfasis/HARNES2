# Audience source-first review

## Scope and acceptance before implementation

This branch starts from canonical `main@3d2c83f77636df27558a88d737806f8d4493bd21`.
It does not integrate the unproven prompt from `codex/audience-source-fidelity-v2`.
Two isolated native A002 calibrations using that frozen prompt recognized own H1
intent but failed independent semantic review. Exact quotes were preserved while
free narrative strengthened present absence into future rejection, absence of
consent into a ban, and older publications into current activity. The respective
requested aliases were `gemini-3.7-flash-high` and `gemini-pro-agent`; provider
response IDs were `gemini-3.8-flash-n` and `gemini-pro-default`. Neither response
establishes model weights, superiority, or a prompt-quality improvement. Each
finite diagnostic stopped after its first failure; remaining cases are NOT_TESTED.

The minimal repair here is an operator presentation change, not semantic approval.
Reuse the existing assessment API, frozen packet, canonical author/message/time
metadata, proposal bindings, browser rendering, and all review/authority contracts.
No new parser, API, schema, model judge, worker, profile, or inference call is needed.

- Before the hypothesis and proposed material, show every source message in the
  bounded frozen assessment packet. Model-selected citations cannot hide an
  unselected cancellation, a peer's words, or other supplied context.
- Show full source text without model paraphrase or excerpt substitution, account
  author, source, message/event IDs, version, and distinct source clocks. Account
  identity is not a verified human identity; missing authors/dates remain unknown.
- Label selected support/counter/context with the proposal's actual producer
  (`model`, `operator`, or unknown), not established author criteria. Unselected
  packet messages remain visible. Mark proposal narrative
  as unverified and make no claim that current technical evidence proves continuing
  intent, semantic truth, contact consent, or authority.
- Require the displayed assessment ID/goal to match the need's durable association.
  The need must also match the selected need and goal. Assessment panels require
  their own explicit selection and a present matching goal; the API's required
  goal field is not optional legacy authority.
  Missing required source text/references or duplicate event IDs fail closed for
  this source block. Never substitute another assessment or a model quotation.
- Neutral need-list and panel headings precede the source; the proposed title is
  part of the separate unverified interpretation, below the source messages.
- Without a usable source snapshot, withhold acceptance, preview import, text
  approval and Continuity open/refresh in both rendering and direct action paths.
  Recheck the snapshot/currentness on modal submission, pinned to the displayed
  need revision and basis. Keep rejection, withdrawal and independent focused
  reassessment cancellation available under their existing contracts.
- Stale needs show a historical-source banner. Rendering does not repair, refresh,
  accept, reject, revise, grant, send, or import anything. Existing command payloads,
  exact material hashes, and source/revocation/restart boundaries stay unchanged.
- Escape all original text and metadata. Do not load additional source history,
  call a model, infer a person, or convert source text into an instruction.

Black-box UI tests are written and run red before this change. They exercise the
public view's load/action/render path, including source-vs-fabricated-paraphrase,
peer identity, full counter/context, unselected cancellation, wrong assessment,
missing/ambiguous evidence, stale/unknown metadata, escaping and zero commands.
Then run focused UI checks, full regression, credential isolation, build and
`git diff --check`. Independently red-team the final source/interpretation boundary.

## Limits

The full *supplied* frozen packet is still a bounded sample; no audience/history
completeness claim is made. A source statement is an observed statement, not proof
that its content is true. This UI cannot detect an invented semantic condition or
automatically label model quality PASS/FAIL. The two prior semantic failures remain
failures. Source-first makes them easier to inspect before a separate owner decision;
it is not a substitute for a reliable model or a verified commercial offer.

## Verification

- The first six black-box UI cases were **6/6 red** before implementation. Final
  coverage is **16/16 PASS**, including the separately red-first producer label,
  source/action/modal gates, strict selected-goal binding and title-order cases.
  Positive acceptance/import controls and retained rejection/withdrawal/cancel
  prevent a blanket-blocking false green. The unselected-message case now checks
  both a peer's cancellation and a later cancellation by the original author,
  including the original author ID, message/version and distinct source clocks.
  Tests also require the source block to exclude the fabricated
  model paraphrase while the separate unverified interpretation remains unchanged.
  Wrong-assessment/goal markers cannot appear anywhere in the need view.
- Independent Luna review caught a possible fallback through the older source
  rendering. The need's legacy evidence/context lookups now use the same validated
  packet association as the new source block. A deliberately selected focused
  reassessment retains its own review/cancellation surface; it is not borrowed as
  the historical need's source basis.
- Full regression caught an overbroad first version of that display fence, which
  hid focused reassessment/cancellation. The fence now binds the assessment panel
  to its explicit selection, independently of the need's immutable source link.
  Existing Continuity and cancellation tests pass without changing their semantics.
- Dev's review found blind positive controls and title placement; independent
  review found ambiguous producer labels and optional assessment goal binding.
  These are now closed, including direct-action and modal-submit paths. Two old
  UI fixtures now include the production schema/API's mandatory assessment goal;
  their review/cancel assertions remain unchanged. A final independent read-only
  review found no remaining blocker in this UI change. Semantic model failures
  remain unresolved and are not covered up by a green UI gate.
- Final full gate: `npm test -- --test-concurrency=4` — **1,646/1,646 PASS**;
  `npm run test:credentials` — **25/25 PASS**; `npm run build` and
  `git diff --check` — **PASS**. No tests are filtered. A prior default-concurrency
  run had one pre-existing short-expiry activation test expire during startup;
  its failure log is preserved, and its expiry/safety check was not weakened.
- A fresh worktree initially lacked dependencies. Installation used the unchanged
  lockfile (`npm ci --ignore-scripts`) and the existing verified Python environment;
  no dependency versions or workflow defaults were changed.
- In-app-browser UI smoke rendered the actual saved failing A002 output with
  source authors, original Ukrainian conditions and clocks before the unmodified
  model interpretation. The replay is explicitly synthetic/historical with no
  commands, live sources or model calls. It is not a live Telegram pilot.
- The two native calibration attempts used **13,644 input / 2,848 output tokens**
  in total. Exact HTTP requests, pricing and quota percentages are unknown.
  Read-only SQLite audit confirmed one revoked, profile-bound, single-attempt
  grant per completed case, zero active owners/tickets/claims/contact permissions,
  and zero persons/conversations/drafts/sends or local action attempts. The locally
  started CLIProxyAPI8318 was stopped. Original receipts/evaluations were preserved.

Native artifacts remain in the isolated research worktree under
`.cache/audience-source-fidelity-v2-20261010/` and
`.cache/audience-native-route-control-20261010/`. These failed experiments are not
part of the source-first release and their quality remains **FAIL**, not PASS.

The next quality step must address interpretation fidelity and be independently
evaluated before scaling observation or adopting a requested model route. This
change provides an inspectable source-first review surface, not that model repair.
