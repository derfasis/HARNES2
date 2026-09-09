# Project guidance

- The product goal is in `digital_ai_partner_idea_for_astra.md`; implementation entrypoint is `README.md`.
- The owner explicitly requested installation/architecture without tests or model calls. Do not run tests or contact a model until the owner changes this instruction. Syntax compilation via `npm run build` is allowed.
- Business data and rules belong to `business/` and `partner/`. Keep upstream Hermes changes separate and retain its license and pinned revision.
- Do not import credentials or datasets from the old `D:\HARNES` workspace without a task requiring them. Never put secrets in tracked configuration, logs or exports.
- A draft is not a sent message; an accepted call is not an attended call. Preserve versioned approvals, source evidence, suppression, ownership, and unknown delivery state.
- Runtime and Telegram start disabled. Do not silently enable model billing or live sending.
