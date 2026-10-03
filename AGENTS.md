# Project guidance

- The product goal is in `digital_ai_partner_idea_for_astra.md`; implementation entrypoint is `README.md`.
- The owner explicitly authorizes all tests needed to verify the product: local/offline suites, credential-isolation tests, hosted CI, real model/API calls, failure injection, recovery tests, and live read-only Telegram/Browser/network checks. Use the owner's configured credentials, Gemini accounts, and existing CLIProxyAPI rotation for bounded verification without requesting the same permission again. Never print, commit, export, or forward credentials. Test authority does not grant production/customer contact or sending authority.
- Business data and rules belong to `business/` and `partner/`. Keep upstream Hermes changes separate and retain its license and pinned revision.
- Do not import credentials or datasets from the old `D:\\HARNES` workspace without a task requiring them. Never put secrets in tracked configuration, logs or exports.
- A draft is not a sent message; an accepted call is not an attended call. Preserve versioned approvals, source evidence, suppression, ownership, and unknown delivery state.
- Runtime and Telegram start disabled. Do not silently enable model billing or live sending.

## Delegated engineering and release responsibility

- The owner delegates architecture, implementation, debugging, technical verification and routine engineering decisions to the coding agent. Do not require the owner to audit code or understand Git to approve routine work; verify independently, fix real failures, and explain practical outcomes in plain language.
- Work in an isolated branch/worktree, preserve useful existing changes, and verify the combined state against the actual canonical main. The owner authorizes integration and push to main after the required checks pass and real blockers are resolved. Respect repository protections; never force-push main, bypass a required gate, or merge while known blockers remain.
- The owner evaluates product usefulness in the dashboard: what was observed, what opportunity or need was inferred, why, and what response/material is proposed. Make those judgments inspectable with source evidence, uncertainty and review controls. A green test suite does not prove a useful recommendation.
- Use existing provider/proxy configuration for real conformance checks when needed, with finite calls and recorded usage. Keep production defaults disabled and distinguish test activation from enduring runtime authority. Unknown pricing/delivery/outcome must stay unknown.
- Aim to build a more useful and reliable partner than the competing project the owner describes as built with Opus 5.5. Treat this as a product-quality target, not a verified claim of model superiority. Prioritize a working end-to-end scenario, evidence-backed quality and recovery over architecture or commits for their own sake.

## GitHub-first engineering rule

- Do not build generic infrastructure from scratch when a mature open-source solution already exists.
- Before implementing a new transport, parser, mapper, queue, workflow engine, storage layer, dashboard primitive, agent framework, protocol adapter, or other non-unique plumbing, search GitHub first.
- Prefer reusing, vendoring, wrapping, or minimally adapting a maintained OSS project/library over writing an equivalent subsystem ourselves.
- Custom HARNES2 code should focus on the unique product layer: business rules, evidence/provenance, permissions, safety boundaries, durable state, operator workflow, and thin adapters around reused components.
- If no suitable OSS solution exists, or using one would weaken safety, correctness, licensing compatibility, or architecture, state that explicitly before starting a greenfield implementation.
- Do not patch around a third-party protocol/library limitation field-by-field if a higher-level maintained library already solves that class of problem; evaluate replacement/reuse first.
