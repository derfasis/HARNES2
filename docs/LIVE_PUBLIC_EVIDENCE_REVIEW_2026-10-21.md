# Live public-source evidence review — 21 October 2026

Baseline: `main@95e50f61d510759f1e326b15981005bef10c0a2e`.

This is a bounded integration experiment, not proof of recruitment quality or
commercial demand. No public message, private contact, account registration,
financial transaction or campaign was performed. Runtime defaults remain off.

## Observations

1. The existing `BrowserSourceReader → pollBrowserSource → Store` path fetched
   a real public Telegram web page through the default network transport. It
   durably retained 14,985 characters without Browser-level truncation. Reopening
   the isolated database recovered the same source event and evidence bytes.
2. The ordinary Audience model packet contained only a 1,983-character excerpt
   of that page. The relevant project text was outside the excerpt. A successful
   assessment of this packet therefore did **not** prove analysis of the target
   publication. Provider acceptance and durable ingestion do not establish model
   input coverage. Inspect the actual frozen packet before claiming that a
   particular source item was evaluated.
3. The public permalink used an embedded Telegram widget. The ordinary outer
   page contained only navigation. Configuring the observed public widget URL
   as the source, using the same existing reader, retained a complete 1,116-
   character source item. No iframe traversal permission, parser, synthetic
   native Telegram envelope or transport-fence exception was introduced.
4. Preflight of the actual second model packet verified the target topic and
   original permalink before dispatch. The model proposed no need and treated
   the publication as advertising, with audience interest and claims unknown.
   However, it joined two adjacent source lines with a space in a supporting
   quote. The mandatory literal proof correctly rejected the result with
   `AUDIENCE_DECISION_QUOTE_MISMATCH`. This is **not an accepted assessment**.
5. The 20 YouTube Atom endpoints that returned HTTP 200 in the preceding day's
   finite check all returned HTTP 404 in this check. One rejection was also
   independently observed in the browser. The cause is unknown; these failures
   do not establish channel deletion or author inactivity. Yesterday's retained
   publications are historical observations, not today's freshness proof.

## Runtime accounting and cleanup

There were two separate native Audience → pinned Hermes → existing local
CLIProxyAPI logical runs, with one recorded HTTP model request each. Returned
identity was the proxy/provider alias `gemini-3-flash`; upstream model identity
is not independently attested. Returned usage totals were 12,362 input and
709 output tokens. Price and remaining upstream account quota are unknown.

An attempted launcher start was rejected by execution policy and was not
re-attempted through another launcher. Read-only checks found an already-running
authorized proxy on the existing endpoint; no restart was needed.

Both model tests used isolated databases, one-attempt grants and no scheduler.
All test grants were revoked and goals paused through existing commands. The
first cleanup attempt omitted the required grant fingerprint and was refused;
the follow-up used the persisted fingerprint and completed without a model call.
No person, conversation, draft, approval, delivery attempt or Action proposal
was created. No Control Plane process owner remains in either test database.

## Regression and decision

`tests/audience-literal-quote-lines.test.mjs` uses synthetic text to preserve the
observed failure as an offline regression. It proves that schema validity cannot
authorize a whitespace-altered quote, while literal single-line and correctly
JSON-encoded multiline excerpts remain valid. It does not test model quality.

Do not normalize or fuzzy-match a rejected model quote into acceptance. Do not
raise context limits merely to conceal page-versus-item scope. The production
prompt, schema and proof validator are unchanged. There was no third model run
to pursue a green result.

If this failure class becomes common, evaluate a versioned fragment-selection
contract: the model selects a source-version-bound fragment ID, and trusted
code resolves its immutable text. A message-level event ID alone cannot identify
an exact fragment. Such a contract must preserve stale/revoke checks and should
not be introduced as an automatic repair layer for malformed legacy output.

Private experiment reports, frozen packets, SQLite stores and raw source data
remain local; this public document contains only the method and measured limits.
Product eligibility and current contractual terms remain separate prerequisites
for any subsequent commercial pilot.

## Local verification

- New literal-quote regressions: 3/3 PASS.
- Full Node suite: 1,784/1,784 PASS.
- Python credential-isolation suite: 41/41 PASS.
- Build and staged `git diff --check`: PASS.

These checks validate the committed test/documentation change and existing
invariants. They do not turn the rejected live assessment into an accepted one.
