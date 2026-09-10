import { id } from '../store.mjs';
import { ensure, AppError, now } from '../errors.mjs';

export class TelegramChannel {
  constructor(service) { this.service = service; this.polling = false; this.stopped = false; this.lastError = null; this.lastPoll = null; }
  readiness() {
    const cfg = this.service.config.telegram;
    return { enabled: cfg.enabled, transport: 'bot_api', configured: Boolean(process.env.PARTNER_TELEGRAM_BOT_TOKEN), live_sending: cfg.liveSending,
      allowed_chats: cfg.allowedChatIds.length, account_id: this.service.telegramAccount(), last_poll: this.lastPoll, error: this.lastError };
  }
  async api(method, body, timeout = 12000) {
    const token = process.env.PARTNER_TELEGRAM_BOT_TOKEN;
    ensure(token && /^\d+:[\w-]+$/.test(token), 'Telegram token не настроен', 409);
    let response;
    try { response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); }
    catch { throw new AppError('Telegram: ответ на запрос не получен', 502, 'telegram_unknown'); }
    let result;
    try { result = await response.json(); } catch { throw new AppError('Telegram: некорректный ответ', 502, 'telegram_unknown'); }
    if (!response.ok || !result.ok) throw new AppError(`Telegram отклонил запрос (${result.error_code || response.status})`, 502, 'telegram_rejected');
    return result.result;
  }
  start() { this.timer = setInterval(() => this.poll().catch(() => { this.lastError = 'Не удалось обработать входящие Telegram'; }), 3000); }
  async poll() {
    const cfg = this.service.config.telegram;
    if (this.stopped || this.polling || !cfg.enabled || !process.env.PARTNER_TELEGRAM_BOT_TOKEN || !cfg.allowedChatIds.length) return;
    this.polling = true;
    try {
      const account = this.service.telegramAccount();
      const cursor = this.service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'telegram', account)?.cursor ?? '0';
      const updates = await this.api('getUpdates', { offset: Number(cursor), timeout: cfg.pollSeconds, allowed_updates: ['message'] }, (cfg.pollSeconds + 10) * 1000);
      for (const update of updates) {
        const message = update.message, chatId = String(message?.chat?.id ?? '');
        if (message?.chat?.type === 'private' && typeof message.text === 'string' && cfg.allowedChatIds.map(String).includes(chatId)) {
          let identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
          if (!identity) {
            await this.service.command('person.create', { name: [message.from?.first_name,message.from?.last_name].filter(Boolean).join(' ') || chatId, source: `Входящее сообщение Telegram, chat ${chatId}`, channel: 'telegram', external_id: chatId, account_id: account,
              permission: `Ответ на входящее обращение Telegram ${message.message_id}; не разрешение на произвольную рассылку` }, `telegram-person:${account}:${chatId}`, {kind:'channel'});
            identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
          }
          const conv = this.service.store.get('SELECT id FROM conversations WHERE channel_identity_id=?', identity.id);
          await this.service.command('message.record', { conversation_id: conv.id, text: message.text, direction: 'in', external_id: String(message.message_id), source: `telegram:${account}:${chatId}:${message.message_id}` }, `telegram-update:${account}:${update.update_id}`, {kind:'channel'});
        }
        // Advance only after the event is durably processed; replay is idempotent.
        this.service.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', 'telegram', account, String(update.update_id + 1));
      }
      this.lastPoll = now(); this.lastError = null;
    } catch (error) { this.lastError = error instanceof AppError ? error.message : 'Ошибка обработки Telegram'; }
    finally { this.polling = false; }
  }
  sendApproved(draftId, { autopilot = false } = {}) {
    return this.service.exclusive(async () => {
      const cfg = this.service.config.telegram;
      ensure(cfg.enabled && cfg.liveSending, 'Живая отправка Telegram выключена в конфигурации', 409);
      const draft = this.service.validApproved(draftId), conversation = this.service.conversation(draft.conversation_id);
      const identity = this.service.store.get('SELECT * FROM channel_identities WHERE id=?', conversation.channel_identity_id);
      ensure(identity?.channel === 'telegram' && identity.account_id === this.service.telegramAccount(), 'Для этого разговора не настроен текущий Telegram-бот', 409);
      ensure(cfg.allowedChatIds.map(String).includes(identity.external_id), 'Chat ID отсутствует в разрешённом списке', 409);
      const attempt = id();
      this.service.store.transaction(() => {
        this.service.store.run("UPDATE drafts SET status='sending' WHERE id=? AND status='approved'", draft.id);
        this.service.store.run('INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,created_at) VALUES(?,?,?,?,?,?,?)', attempt, draft.id, draft.current_version, 'telegram', identity.external_id, 'sending', now());
      });
      let message;
      try { message = await this.api('sendMessage', { chat_id: identity.external_id, text: draft.text }); }
      catch (error) {
        const status = error.code === 'telegram_rejected' ? 'failed' : 'delivery_unknown';
        this.service.store.transaction(() => {
          this.service.store.run('UPDATE drafts SET status=? WHERE id=?', status, draft.id);
          this.service.store.run('UPDATE delivery_attempts SET status=?,error=?,finished_at=? WHERE id=?', status, error.message, now(), attempt);
          this.service.store.event(this.service.config.partnerId, conversation.id, `delivery.${status}`, 'system', { draft_id: draft.id, attempt_id: attempt, autopilot, run_id: draft.run_id, model: this.service.config.runtime.model, conversation_revision: draft.context_revision });
        });
        return { status, error: error.message };
      }
      try {
        this.service.store.transaction(() => {
          this.service.store.run("UPDATE delivery_attempts SET status='sent',external_id=?,finished_at=? WHERE id=?", String(message.message_id), now(), attempt);
          this.service.recordDelivered(draft, String(message.message_id), autopilot ? 'telegram_autopilot' : 'telegram');
          this.service.store.event(this.service.config.partnerId, conversation.id, 'delivery.sent', 'system', { draft_id: draft.id, draft_version: draft.current_version, external_id: String(message.message_id), autopilot, run_id: draft.run_id, model: this.service.config.runtime.model, conversation_revision: draft.context_revision, model_text: draft.text, sent_text: draft.text });
        });
      } catch {
        this.service.store.run("UPDATE drafts SET status='delivery_unknown' WHERE id=?", draft.id);
        this.service.store.run("UPDATE delivery_attempts SET status='delivery_unknown',error='Provider accepted; local commit failed' WHERE id=?", attempt);
        return { status: 'delivery_unknown' };
      }
      return { status: 'sent', external_id: String(message.message_id) };
    });
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
