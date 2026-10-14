# Native Audience fidelity: rejected prompt experiments

These two authored synthetic discussions check conditional procurement and a fixed-fee service task alongside someone else's quoted affiliate inquiry. They are not live Telegram messages, customers, observed conversions or statistical market evidence.

`holdouts.json` contains only the owner objective and normalized source messages. `gold.json` contains separate expected tasks, bindings, unknowns and prohibited inferences. Never send gold to a model. The objective explicitly asks for cautious internal analysis, so this is controlled instruction-following evidence rather than unprompted behavior.

The exact LF bytes are frozen:

- Inputs: `449b2c968daa55f6eaedc0252e897657b3994641e8e3b2d4c1ede1cb35275e17`
- Gold: `940c3592cf6a6a6079f97a0ac2f439c914504461193c814caca4097da1e18a52`

Decision: neither prompt candidate is adopted. Production reasoning remains unchanged. `original-control-inputs.json` preserves the exact earlier synthetic 10-case/53-message fixture; only A001/A002/A004/A007 were dispatched. `outputs/` contains sixteen exact native result files and five separate independent reviews across baseline, candidate 1 and candidate 2. The first candidate and its failures remain visible alongside the final candidate. `manifest.json` pins their raw hashes and per-run recorded usage. `prompts/` preserves exact experimental bytes, separate from the production prompt; these immutable snapshots are not loaded by the runtime.

The native validation used isolated Stores, canonical `source.ingest`, Audience/profile/attention admission and the existing no-tools Hermes adapter. Each case in each batch received one finite attempt; spent attempts were not retried/resumed. Original output was retained before separate source/claim review, never rewritten to fit gold. Both candidates retained useful tasks but failed unconditional factuality: time, negative claims, economics or offer status were strengthened beyond source support. Independent reviewer flags are evaluations, not source facts. No benchmark is automatically billed by `npm test`.

Score the actual paraphrase in every owner-facing field, not just whether a citation exists. Preserve supported positive tasks while rejecting unsupported strengthening of time, ownership, commitments and economics. Report individual failures and unknowns. Repeating this tiny known set after prompt changes is regression evidence, not a blind general-accuracy estimate or causal A/B result. See `docs/AUDIENCE_INTERPRETATION_FIDELITY_V1.md` for the associated four-case historical control and validation limits.
