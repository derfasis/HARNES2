# Project guidance

- The product goal is in `digital_ai_partner_idea_for_astra.md`; implementation entrypoint is `README.md`.
- The owner explicitly authorizes running any tests required for verification, including local/offline suites, hosted CI, real model/API calls, and live read-only network/Telegram/Browser tests. Test permission does not authorize production/customer sends or weakening safety defaults; real outbound messages/actions still require explicit task-level authorization.
- Business data and rules belong to `business/` and `partner/`. Keep upstream Hermes changes separate and retain its license and pinned revision.
- Do not import credentials or datasets from the old `D:\\HARNES` workspace without a task requiring them. Never put secrets in tracked configuration, logs or exports.
- A draft is not a sent message; an accepted call is not an attended call. Preserve versioned approvals, source evidence, suppression, ownership, and unknown delivery state.
- Runtime and Telegram start disabled. Do not silently enable model billing or live sending.

## GitHub-first engineering rule

- Do not build generic infrastructure from scratch when a mature open-source solution already exists.
- Before implementing a new transport, parser, mapper, queue, workflow engine, storage layer, dashboard primitive, agent framework, protocol adapter, or other non-unique plumbing, search GitHub first.
- Prefer reusing, vendoring, wrapping, or minimally adapting a maintained OSS project/library over writing an equivalent subsystem ourselves.
- Custom HARNES2 code should focus on the unique product layer: business rules, evidence/provenance, permissions, safety boundaries, durable state, operator workflow, and thin adapters around reused components.
- If no suitable OSS solution exists, or using one would weaken safety, correctness, licensing compatibility, or architecture, state that explicitly before starting a greenfield implementation.
- Do not patch around a third-party protocol/library limitation field-by-field if a higher-level maintained library already solves that class of problem; evaluate replacement/reuse first.