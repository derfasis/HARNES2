import { id } from './store.mjs';
import { ensure, requiredText, now } from './errors.mjs';
import { validateChannelCycle } from './config.mjs';
import { channelPostLink, channelPostPayload, containsChannelPostLink, parseStartPayload } from './telegram-attribution.mjs';

export const CHANNEL_POST_COMMANDS = new Set(['channel_post.create', 'channel_post.edit', 'channel_post.approve']);
export class ChannelCycle {
  constructor(service) { this.s = service; this.db = service.store; }
  get(postId) {
    const row = this.db.get(`SELECT p.*,v.text FROM channel_posts p JOIN channel_post_versions v
      ON v.post_id=p.id AND v.version=p.current_version WHERE p.id=? AND p.partner_id=?`, postId, this.s.config.partnerId);
    ensure(row, 'Channel post not found', 404); return row;
  }
  list() {
    return this.db.all(`SELECT p.*,v.text,(SELECT COUNT(*) FROM channel_post_starts s WHERE s.post_id=p.id) AS starts
      FROM channel_posts p JOIN channel_post_versions v ON v.post_id=p.id AND v.version=p.current_version
      WHERE p.partner_id=? ORDER BY p.created_at DESC,p.id`, this.s.config.partnerId);
  }
  current(row) {
    const cfg = validateChannelCycle(this.s.config);
    ensure(this.s.config.telegram.transport === 'bot_api', 'Channel cycle requires Bot API', 409);
    const account = process.env.PARTNER_TELEGRAM_BOT_TOKEN?.split(':')[0];
    ensure(account && account === this.s.telegramAccount() && account === row.account_id, 'Channel bot account changed', 409);
    ensure(cfg.channelChatId && cfg.channelChatId === row.channel_chat_id && cfg.botUsername === row.bot_username,
      'Channel destination changed', 409);
    ensure(containsChannelPostLink(row.text, row.bot_username, row.id), 'Post must contain its own deep link');
    return cfg;
  }
  command(action, p, actor) {
    ensure(actor.kind === 'operator' || actor.kind === 'agent' && action === 'channel_post.create', 'Operator required', 403);
    if (action === 'channel_post.create') {
      ensure(!actor.conversationId, 'Channel posts cannot originate from a private conversation', 403);
      const cfg = validateChannelCycle(this.s.config), postId = requiredText(p.post_id, 'post_id', 36);
      ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(postId), 'post_id must be a UUID v4');
      ensure(cfg.channelChatId && cfg.botUsername, 'Configure channel destination before drafting', 409);
      const text = requiredText(p.text, 'text', 4096);
      ensure(containsChannelPostLink(text, cfg.botUsername, postId), 'Post must contain its own deep link');
      this.db.run(`INSERT INTO channel_posts(id,partner_id,account_id,channel_chat_id,bot_username,payload,created_at)
        VALUES(?,?,?,?,?,?,?)`, postId, this.s.config.partnerId, this.s.telegramAccount(), cfg.channelChatId,
      cfg.botUsername, channelPostPayload(postId), now());
      this.db.run('INSERT INTO channel_post_versions VALUES(?,?,?,?,?)', postId, 1, text, actor.kind, now());
      return this.get(postId);
    }
    const row = this.get(p.post_id);
    ensure(['pending', 'approved', 'failed'].includes(row.status), 'Post already attempted or unavailable', 409);
    ensure(p.version === row.current_version, 'Channel post version changed', 409);
    if (action === 'channel_post.edit') {
      const text = requiredText(p.text, 'text', 4096);
      ensure(containsChannelPostLink(text, row.bot_username, row.id), 'Post must contain its own deep link');
      this.db.run('INSERT INTO channel_post_versions VALUES(?,?,?,?,?)', row.id, row.current_version + 1, text, actor.kind, now());
      this.db.run("UPDATE channel_posts SET current_version=current_version+1,approved_version=NULL,status='pending' WHERE id=?", row.id);
    } else {
      this.current(row);
      this.db.run("UPDATE channel_posts SET approved_version=current_version,status='approved' WHERE id=?", row.id);
    }
    return this.get(row.id);
  }
  attribute(conversationId, text) {
    const payload = parseStartPayload(text, this.s.config.telegram.channelCycle?.botUsername);
    if (!payload) return;
    const post = this.db.get('SELECT id FROM channel_posts WHERE partner_id=? AND account_id=? AND payload=?',
      this.s.config.partnerId, this.s.telegramAccount(), payload);
    if (!post) return;
    const conversation = this.s.conversation(conversationId);
    this.db.run('INSERT OR IGNORE INTO channel_post_starts VALUES(?,?,?,?)', conversation.id, post.id, conversation.person_id, now());
  }
  send(postId, client) {
    return this.s.exclusive(async () => {
      const row = this.get(postId), cfg = this.current(row);
      ensure(this.s.config.telegram.enabled === true && this.s.config.telegram.liveSending === true && cfg.enabled,
        'Channel live sending disabled', 409);
      ensure(row.status === 'approved' && row.approved_version === row.current_version, 'Current operator approval required', 409);
      const attempt = id();
      this.db.transaction(() => {
        const current = this.get(postId);
        ensure(current.status === 'approved' && current.current_version === row.current_version
          && current.approved_version === row.current_version, 'Current operator approval required', 409);
        const used = this.db.get(`SELECT COUNT(*) AS n FROM channel_post_attempts a JOIN channel_posts p ON p.id=a.post_id
          WHERE p.partner_id=? AND a.status IN ('sent','sending','delivery_unknown') AND a.created_at>?`,
        this.s.config.partnerId, new Date(Date.now() - 86400000).toISOString()).n;
        ensure(used < cfg.maxPostsPerDay, 'Channel daily cap reached', 409);
        this.db.run("UPDATE channel_posts SET status='sending' WHERE id=?", row.id);
        this.db.run('INSERT INTO channel_post_attempts(id,post_id,post_version,status,created_at) VALUES(?,?,?,?,?)',
          attempt, row.id, row.current_version, 'sending', now());
      });
      let message;
      try {
        message = await client.api('sendMessage', { chat_id: row.channel_chat_id, text: row.text });
        ensure(Number.isSafeInteger(message?.message_id), 'Missing Telegram message receipt');
      } catch (error) {
        const status = error.code === 'telegram_rejected' ? 'failed' : 'delivery_unknown';
        this.finish(row.id, attempt, status, null, status === 'failed' ? 'Telegram rejected request' : 'Telegram outcome unknown');
        return { status };
      }
      try { this.finish(row.id, attempt, 'sent', String(message.message_id), null); }
      catch { this.finish(row.id, attempt, 'delivery_unknown', null, 'Provider accepted; local commit failed'); return { status: 'delivery_unknown' }; }
      return { status: 'sent', external_id: String(message.message_id) };
    });
  }
  finish(postId, attempt, status, externalId, error) {
    this.db.transaction(() => {
      this.db.run('UPDATE channel_posts SET status=? WHERE id=?', status, postId);
      this.db.run('UPDATE channel_post_attempts SET status=?,external_id=?,error=?,finished_at=? WHERE id=?', status, externalId, error, now(), attempt);
    });
  }
}
