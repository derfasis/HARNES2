# Telegram channel cycle v1

A bounded, operator-reviewed Bot API publication path for one channel. No scheduler,
autopilot, channel discovery, or private outreach is added. All switches default off.

## Configure and prepare

In local configuration set `telegram.channelCycle.channelChatId` to one negative
numeric channel ID (not `@username`), `botUsername` to the bot's bare Telegram username,
and `maxPostsPerDay` to 1–3 (default 1). Configure the existing bot token privately;
the bot needs Telegram permission to publish in that channel. Do not commit credentials.
Drafting needs the destination configured but does not require live sending.

Generate a UUID v4 post ID and include its exact link in the text:
`https://t.me/<botUsername>?start=post_<UUID>`.
`business/telegram-attribution.mjs` exports the payload/link helpers. Text is nonempty
and at most 4096 characters. Approval binds the version, bot account and configured
destination; edits reset approval. Switching destinations requires a new draft.

## Operator API

All routes require the existing `x-partner-token` operator session header and JSON
for POST requests. No dashboard controls are added.

- `POST /api/channel-posts/create`: `{request_id,payload:{post_id,text}}`.
- `POST /api/channel-posts/edit`: `{request_id,payload:{post_id,version,text}}`.
- `POST /api/channel-posts/approve`: `{request_id,payload:{post_id,version}}`.
- `POST /api/channel-posts/deliver`: `{post_id}`.
- `GET /api/channel-posts`: `{posts:[...]}`, including each post's `starts` count.

The same draft commands are available through the existing command envelope as
`channel_post.create`, `.edit`, `.approve`. Service actors allow an agent only to
create a draft outside private conversations; editing and approval are operator-only.
The planning-only `partner_propose_channel_post` tool creates these pending drafts.
No agent approval, delivery tool or automatic send path is added.

## Send gates and recovery

Delivery requires `telegram.enabled`, `telegram.liveSending` and
`telegram.channelCycle.enabled` all true, Bot API transport, the same bot account,
destination and username as the draft, and current operator approval. Enabling these
switches is a separate, explicit operational decision, not an effect of approval.

A durable attempt is written before calling Telegram. The rolling 24-hour cap counts
sent, sending and delivery_unknown attempts across this partner's channel posts.
Explicit Telegram rejection is failed; network/receipt ambiguity or a crash while
sending is delivery_unknown. Unknown outcomes cannot be retried through this API.
Failed posts need a fresh operator approval before retry. No automatic retry occurs.
Import preserves history and attribution but clears unsent publication approvals.

## Attribution and follow-up

Only the existing allowlisted private-chat ingestion can create attribution. It
recognizes `/start <payload>` and `/start@<configuredBot> <payload>`, matching a stored
post payload for the current partner and account. Unknown payloads are ignored.
Each conversation/post pair counts once, durably, even if the update is replayed.
Non-allowlisted chats create neither messages nor attribution.

An operator can compare `starts` after 72 hours. A start is a bot interaction, not a
unique human, qualified prospect, consent to marketing, conversion or proof the user
read the channel post. Links can be forwarded; attribution proves only payload use.
Private allowlisting is not expanded automatically by publication. No 72-hour job,
contact permission, model spending authority or follow-up message is created.
