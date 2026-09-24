# Discovery v1 handoff

Canonical starting main: `7b5846e94915248b8628ec899643fdb2b308409b`, confirmed again against origin/main on 2026-09-24. Work branch: `codex/discovery-intelligence-v1` in an isolated worktree. Existing CLIProxy edits in `D:/HARNES2` were not used or overwritten.

The separate candidate `codex/opportunity-stale-transport-retry` was reviewed and explicitly integrated first using `cherry-pick -x`:

- original candidate: `0cde893efb142de44bf92a1ecf44d268ce3e1c0b`;
- integration commit: `4ef915742199fe82038d92e9db37cc78dd0e212f`;
- candidate was **not part of main**. Its provenance remains a separate commit in the delivered patch series.

The next commit contains Discovery. No merge to main is performed by this task. Delivery manifest records final SHA and SHA-256 of the portable patch and tracked-source archive; no local config, credentials, data, Telegram session, node_modules, virtual environment or upstream runtime cache belongs in the archive.

Read `DISCOVERY_INTELLIGENCE_V1.md` for architecture, controls, exact retention scope and deferred strategy activation; `DISCOVERY_V1_VALIDATION.md` for checks. Acceptance regression includes accumulated observations → WAIT → restart → REVIEW → operator approval → independently recorded inbound/grant → existing Engagement ACT → human edit/manual delivery fixture → observed outcome → scoped candidate lesson. All fixtures are offline; no message was sent externally.

Installation/update: apply both patches to the canonical base in order using `git am`, or inspect the branch/ZIP. Run the existing setup for pinned dependencies/Hermes when installing on a new machine. Normal startup applies additive migrations 004 and 005; preserve a normal business export before upgrading real data. Never edit historical migration checksums. Import restores to a NEW staging directory and accepts checksum-verified schema prefixes 2/3/4/5.

Discovery is off by default. A future authorized read-only pilot requires a specific purpose/version, configured active offer, already authorized allowed source refs / Telegram processing basis, `discovery.enabled=true`, `opportunity.automatic=true`, and `runtime.enabled=false`, `telegram.enabled=false`, `telegram.liveSending=false`. Existing model credentials/budget must then be configured explicitly. This handoff neither configures those credentials nor authorizes billing. Enabling source observation does not enable private-chat sending.

Use the dashboard “Наблюдение” tab for exact evidence and decision history. Approve a REVIEW only after checking its interpretation. To transfer, independently establish the exact author binding, actual inbound and typed reply grant; the command rechecks these. Continue through existing Engagement, after a separately chosen runtime mode change if desired. `discovery.lesson.review` only reviews a candidate; it never activates a strategy.

Next acceptance gate: frozen reasoning version vs existing Projection on blind temporal prefixes, including a random sample of IGNORE/WAIT and independent labels for later-created needs. Measure both false positives and misses, invalid/abstaining responses, detection delay, operator burden and costs. Do not infer causal revenue from an associated outcome or model skill from these deterministic fixtures.
