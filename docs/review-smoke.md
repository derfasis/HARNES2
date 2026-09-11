# Controlled Review Smoke

This is a manual, owner-controlled smoke. It is not AUTOPILOT and it must use only an owner-controlled Telegram test contact.

## Guardrails

- Use one known test chat ID in `telegram.allowedChatIds`; do not use a real lead.
- Set the conversation mode to `REVIEW` and keep ownership `AI_OWNED` for draft generation.
- Keep live sending disabled while generating drafts. The owner reviews every draft and may send it manually from the owner account.
- Do not enable AUTOPILOT, bulk polling, cold outreach, or a second contact.
- Limit the smoke to three inbound messages and at most one manually approved outbound message.
- Before and after the smoke, verify runtime, Telegram, and live sending settings; restore the disabled defaults afterward.

## Script

Use these synthetic messages in order:

1. `Привет, чем занимаешься?`
2. `Это сетевой? Я раньше пробовал, опыт был так себе.`
3. `Сейчас всё же интересно. Давай коротко созвонимся, завтра после 18:00 могу.`

After each inbound message, let Hermes create a draft and stop for owner review. Check that:

- the draft preserves the project and prior-experience context;
- the third-turn draft treats tomorrow after 18:00 as a requested/preferred time;
- it does not say that the time is suitable, agreed, or scheduled before owner confirmation;
- a call request produces a handoff/proposed-call draft rather than an implied booking.

The owner may approve the final draft manually. If it is manually sent, record the actual delivery evidence in the UI. A draft approval is not delivery, and a call request is not a booked call. Confirm that handoff transfers the conversation to the owner and that no autonomous send occurred.

Stop after this smoke. Record only the review outcome and any draft wording issue; do not publish raw prompts, context, tool schemas, messages, or credentials.
