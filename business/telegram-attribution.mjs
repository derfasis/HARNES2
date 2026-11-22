import { ensure } from './errors.mjs';

const PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;
export function channelPostPayload(postId) {
  const payload = `post_${postId}`;
  ensure(PAYLOAD.test(payload), 'Invalid channel post payload');
  return payload;
}
export function channelPostLink(botUsername, postId) {
  ensure(typeof botUsername === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername), 'Invalid bot username');
  return `https://t.me/${botUsername}?start=${channelPostPayload(postId)}`;
}
export function containsChannelPostLink(text, botUsername, postId) {
  if (typeof text !== 'string') return false;
  const link = channelPostLink(botUsername, postId);
  for (let at = text.indexOf(link); at !== -1; at = text.indexOf(link, at + 1)) {
    if (!/[A-Za-z0-9_-]/.test(text[at + link.length] ?? '')) return true;
  }
  return false;
}
export function parseStartPayload(text, botUsername) {
  if (typeof text !== 'string') return null;
  const match = /^\/start(?:@([A-Za-z][A-Za-z0-9_]{4,31}))? ([A-Za-z0-9_-]{1,64})$/.exec(text);
  if (!match || match[1] && (!botUsername || match[1].toLowerCase() !== botUsername.toLowerCase())) return null;
  return match[2];
}
