# Situation Router v1

This directory contains the isolated offline experiment for choosing the next
socially appropriate move in a live chat situation. The router returns only a
structured proposal; it cannot approve, send, schedule, or call business tools.

## First slice

- `synthetic/` contains a small committed smoke set with no real identities.
- `data/benchmarks/situation-router/real-sanitized/` is the ignored local set of
  20 real-but-sanitized situations derived read-only from the old parser DB.
- `scripts/situation-router-benchmark.mjs` runs one isolated Hermes process per
  fixture, with retries set to zero and no effect tools.
- `control-v1.json` freezes the six-case post-baseline control set. Its expected
  decisions are report metadata and are never included in model context.
- Model runs require the explicit `SITUATION_ROUTER_MODEL_RUN=1` gate.

The control set is intentionally mixed: the two real-but-sanitized policy
regressions (`real-07`, `real-12`) plus committed positive examples for a public
reply, wait, DM and human handoff. Run it only after separate owner approval:

```powershell
$env:SITUATION_ROUTER_MODEL_RUN='1'
npm run benchmark:situation-router:control
```

The first human benchmark asks whether the model chooses the right channel and
social move, not whether its prose is merely attractive:

1. Decision and channel fit the live situation: ignore, wait, public reply, DM,
   or human handoff.
2. Reasoning is grounded in supplied message IDs and does not invent facts,
   identities, consent, or future events.
3. Strategy and draft are natural, useful, transparent and non-pushy.
4. Uncertainty, privacy, stop signals and risk lead to WAIT, HANDOFF or IGNORE
   when appropriate.
5. A draft remains only a pending proposal. It is never evidence of approval,
   sending, booking or attendance.

No expected decision is included in model input. After one approved 20-case
run, a human reviews the cases and decides whether persistence, dashboard and
Telegram integration are justified. Success is intentionally not automated in
this first slice; the initial target is 15-18 socially sound decisions out of
20.
