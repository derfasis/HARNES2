# Native proxy readiness — bounded operational prerequisite

Final status: **PRE_DISPATCH_BLOCKED — SHARED_PROXY_NOT_QUIESCENT**.
No new model dispatch, no proxy handover, no operational upgrade applied.

The frozen Stage0 experiment remains stopped at its consumed first reservation.
The 404 on `gemini-3.7-flash-high` and the separate 403 on `gemini-3.8-flash`
have no valid model completion. The latter alias is explicitly configured to
the third-party `apinex.bond` compatibility route; it does not test the owner's
Google OAuth accounts. Historical request logs do not correlate to these calls.

The running official CLIProxyAPI is version 6.10.8, exact upstream commit
`da6c599efd8da34d23d3668371fbb5ac70399e9d` (May 4, 2026). Its fallback
Antigravity version is 1.21.9. The [upstream issue and fix](https://github.com/router-for-me/CLIProxyAPI/issues/5175)
postdate this build. This is a justified upgrade prerequisite, not proof that
the effective UA caused our old 404: the old runtime UA/backend remain UNKNOWN.

One separately admitted operational native conformance test is proposed:

- Official release `v8.0.23`, binary commit `d318bcc3`; Windows archive verified
  against published SHA256 `d2839470df9a3698c9b0a93a6f42f8c569be4a0f74099f7110ba9350f62ca6f7`.
- Existing synthetic `audience-conformance.mjs`, original source/domain/Hermes
  pipeline, one logical dispatch; no frozen RU/UA case is replayed or relabeled.
- Exact predeclared alias `gemini-3.7-flash-high`. If absent from the restricted
  proxy's metadata catalog, stop before model dispatch; no guessed alias fallback.
- Native-only temporary loopback proxy, no third-party compatibility routes;
  retry rounds 0 and maximum one eligible credential per round. A separate
  loopback gateway consumes its fsynced cap-one forwarding reservation before
  forwarding. Hermes empty-response/SDK retries cannot forward a second request.
- No shared concurrent OAuth store. Only if the known old process is idle and
  matches its expected executable/config will the operator temporarily stop it,
  run the pinned test proxy exclusively against the original auth directory,
  then stop the test process and roll forward the standing proxy to the pinned
  public v8 executable with the original configuration unchanged. The old public
  executable remains available; no automatic auth-store downgrade is attempted.
  No OAuth credential is copied, exported, printed or sent to another service.
- OAuth refresh is an authorized possible side effect of using existing accounts;
  its process-local locks do not justify concurrent daemons. Refresh/network and
  internal executor fallback counts remain UNKNOWN. A one-forward gateway is
  not a claim of one upstream wire request or zero billing.
- New operation marker is exclusive and fsynced before child invocation. Any
  reserved/uncertain/failed state is terminal, including crash. No reset/retry.
  The historical conformance ledger is also preserved and incremented normally.
- Public runtime, scheduler, live Telegram and sending remain disabled. A finite
  test-only attention grant must be revoked; all person/contact/conversation/
  draft/delivery/work transfer/action tables must remain empty.
- Save only safe gateway metadata, native receipt, reported identity and usage.
  Provider-origin identity is recorded separately from requested alias; an
  OpenAI-compatible model field alone does not attest Google model weights.

Two earlier logical native dispatches plus this maximum one new dispatch is a
maximum of three in this diagnostic iteration, not a reset of Stage0's cap.
No semantic result or production activation is authorized by route success.
The ignored operator/gateway artifacts are local verification plumbing, not a
new HARNES runtime or a production compatibility layer.

Execution result and recovery evidence are appended after the operation.

Pre-dispatch independent audit corrected the recovery decision: new OAuth refresh
can persist updated records, so restarting v6 would require a separate proven
serialization downgrade. There is no Go toolchain on this host. Rather than fake
that proof or copy live tokens, this operational upgrade stays on official v8.
The public binary is installed side by side at
`C:/Users/PC/CLIProxyAPI/cli-proxy-api-8.0.23.exe`; no real key or auth file is copied.
The original private config must retain its hash, and its listener must recover.

The actual pinned binary passed a credential-free startup with an empty auth
directory: metadata READY, zero models, zero auth files created, graceful stop,
and no test client key found in log files. Gateway offline tests exercise
401/403/404/429, reservations, restart, concurrent forwarding, safe structured
error projection and alias/version separation. A root run exposed Windows
early-rejection socket resets: bounded one-time body reading and a repeated
65KB-invalid-request regression replaced the buggy rejection behavior.

Controller audit also added proof of old PID/listener exit before v8 starts,
no duplicate restoration after uncertain shutdown, report/history/gateway/run/
SQLite binding, and a hard RECOVERY_REQUIRED disposition on listener recovery
failure. A separate kill exposed report requested-model mismatch; it is now
checked rather than borrowing the attempt's matching model as the report's.

## Final admission before the new dispatch

Dev's pinned-source review identified load-time YAML mutation and potentially
skipped credentials. Independent audit then narrowed the exact predicates:
the real original config is pure legacy with an existing bcrypt management
secret; no grouped/current counterparts are present. For that shape the pinned
loader skips secret hashing and layout rewriting. The operator preblocks other
shapes and still requires the original file's SHA256 to remain unchanged.
Sources: [config loader](https://github.com/router-for-me/CLIProxyAPI/blob/d318bcc3/internal/config/config_load.go),
[normalization](https://github.com/router-for-me/CLIProxyAPI/blob/d318bcc3/internal/config/config_v8.go).

The temporary daemon's management probe uses a random test-only local nonce;
it returns only aggregate provider/disabled/status counts, never auth entries.
Those are **management-listable registered auths**, not raw manager cardinality,
eligibility or account health. Native Antigravity counts must match the bounded
file inventory before dispatch. The file inventory is 25 records: 8 Antigravity,
1 Claude, 16 Codex; 6 explicitly disabled, including 1 Antigravity.

The permanent proxy must own its exact listener and preserve configured aliases
that were advertised before handover. Its expected local API authorization and
catalog are checked independently of completion success. Ordinary future starts
must also use v8: only the public default executable is atomically upgraded;
the old public binary is retained separately as `cli-proxy-api-6.10.8.exe`.
No private YAML or OAuth backup is created, and no automatic downgrade occurs.

The final local verification is **10 gateway + 15 controller + 7 pool tests PASS**.
Controller tests include a healthy report control and non-vacuous report/model/
run/store, missing receipt, stale lease, pool mismatch, PID exit, listener-owner,
catalog recovery and plaintext-config failures. These are ignored operator tests,
separate from the existing HARNES code gate.

Revision 2 is frozen in ignored `public-plan-revision-2.json` before any new
dispatch, including operator/gateway/probe/input hashes, previous-plan linkage,
the roll-forward decision and the stopped Stage0 ledger hash. Local scripts,
production defaults and real-call budgets are not silently reset.

## Observed result

The real admission attempt stopped **before** creating an exclusive lease or
model/gateway reservation. The known old process and listener matched, but the
shared proxy had 2–3 established connections. A separate OS metadata inspection
identified an inbound client as `ZCode.exe`; its command line did not contain the
HARNES workspace. Socket state alone does not prove that an upstream request is
actively executing, but this also was not an independently owned test daemon.
The operator did not interrupt another client or relax the idle precondition.

Dev's shutdown concern was independently checked against the old exact commit:
[StartService](https://github.com/router-for-me/CLIProxyAPI/blob/da6c599e/internal/cmd/run.go#L25-L50)
uses SIGINT/SIGTERM; [Service.Run](https://github.com/router-for-me/CLIProxyAPI/blob/da6c599e/sdk/cliproxy/service.go#L447-L462)
creates its 30-second shutdown context at startup. That deadline can expire before
shutdown begins. There is no proven external shutdown path here that both targets
only this old process and guarantees draining the unrelated client's requests.

Immutable local observation: ignored `pre-dispatch-observation.json`, UTC
`2026-10-11T16:14:53Z`. Observed facts:

| Check | Result |
| --- | --- |
| New model calls / gateway forwards | 0 / 0 |
| Exclusive/native/gateway reservations | none created |
| Original proxy PID and listener | untouched, PID 54948 on 8317 |
| Original config/default binary hashes | unchanged |
| Stage0 ledger | unchanged, stopped 1/8 |
| Operator bytes vs frozen revision 2 | identical |
| Operational upgrade / registered runtime pool / native route | NOT_TESTED |
| RU/UA semantic fidelity | NOT_TESTED |

The public v8 binary and separately retained public v6 binary are staged only.
No real credential was copied and no private config was changed. The temporary
daemon using the owner's auth directory was never started. The prior two failed
logical native dispatches remain the complete model-call history for this
iteration. Their actual upstream retry/billing counts remain UNKNOWN.

In addition to the 32 focused offline operator tests, two synthetic checks
verified public-binary promotion and refusal to repeat it against changed inputs;
the credential-free real-binary startup also passed. None is a successful model
completion. The HARNES implementation itself is unchanged: its code gate at
`0b9089c26489620e064ab3c490937ee143f8bee5` passed 1660 Node + 25 Python + build
locally and exact-head hosted Windows [CI run 38151163862](https://github.com/derfasis/HARNES2/actions/runs/38151163862).
This report's follow-up commit must not borrow that hosted success as its own.

Next prerequisite is a safely quiescent shared proxy or a separately supervised
handover that preserves other clients and exclusive ownership of the OAuth
store. Only then may a newly recorded finite native conformance run proceed.
Do not run a second live daemon against this shared auth directory, copy OAuth
tokens, fall back to web Gemini, guess another alias, or reset the stopped Stage0.
