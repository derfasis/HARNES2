import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from './config.mjs';
import { hash } from './store.mjs';
import { now } from './errors.mjs';

export function searchExperience(service, query = '', conversationId = null, limit = 5) {
  const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0,12);
  const scope = conversationId ? ' AND (l.conversation_id IS NULL OR l.conversation_id=?)' : ' AND l.conversation_id IS NULL';
  const params = [service.config.partnerId, ...(conversationId ? [conversationId] : [])];
  const projection = 'l.id,l.title,l.text,l.applicability,l.reviewed_at';
  if (!terms.length) return service.store.all(`SELECT ${projection} FROM lessons l WHERE l.partner_id=? AND l.status='active'${scope} ORDER BY l.reviewed_at DESC LIMIT ?`, ...params, limit);
  const match = terms.map(x => `"${x.replaceAll('"','')}"`).join(' OR ');
  return service.store.all(`SELECT ${projection} FROM lessons_fts JOIN lessons l ON l.rowid=lessons_fts.rowid WHERE l.partner_id=? AND l.status='active'${scope} AND lessons_fts MATCH ? ORDER BY rank LIMIT ?`, ...params, match, limit);
}
export function contextFor(service, conversationId = null, task = null) {
  const profile = readJson(path.join(ROOT, 'partner/profile.json'));
  const identity = fs.readFileSync(path.join(ROOT, 'partner/identity.md'), 'utf8');
  const behavioralExamples = fs.readFileSync(path.join(ROOT, 'partner/behavioral_examples.md'), 'utf8');
  const knowledge = fs.readdirSync(path.join(ROOT, 'partner/knowledge')).filter(x => x.endsWith('.json')).map(x => readJson(path.join(ROOT, 'partner/knowledge', x)));
  const skillName = conversationId ? 'recruiting' : 'planning';
  const skill = fs.readFileSync(path.join(ROOT, 'partner/skills', skillName, 'SKILL.md'), 'utf8');
  const skillVersion = skill.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const skills = [{ name: skillName, content: skill, ...(skillVersion ? { version: skillVersion } : {}), sha256: hash(skill) },
    ...service.store.all("SELECT name,version,content,sha256 FROM skill_versions WHERE status='approved' ORDER BY name").slice(0,10)];
  const context = { schema_version: 1, generated_at: now(), partner: { ...profile, ...service.partner() }, identity, identity_sha256: hash(identity),
    behavioral_examples: behavioralExamples, behavioral_examples_sha256: hash(behavioralExamples), knowledge,
    knowledge_sha256: hash(JSON.stringify(knowledge)), skills, task,
    instructions: 'Choose the best next step inside this scope. Before responding, use one internal objective: discover, answer, clarify, advance, handoff, or stop. Answer direct questions directly; when interest or a call is explicit, move to a concrete next step. Use business tools for proposals. Final text is an internal note, never delivery. Missing evidence is unknown, not permission. In AUTOPILOT, reply only inside the existing permitted conversation; create reply, clarify, or propose_call drafts for ordinary responses, and use handoff when the owner must participate. Never initiate a first contact or cold outreach.' };
  if (conversationId) {
    const conv = service.conversation(conversationId), person = service.person(conv.person_id);
    const messages = service.store.all('SELECT id,direction,author,text,source,created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?', conv.id, service.config.context.maxRecentMessages).reverse();
    context.conversation = conv; context.person = person;
    context.messages = messages.map(m => ({ ...m, text: m.text.slice(0,service.config.context.maxMessageCharacters), truncated: m.text.length > service.config.context.maxMessageCharacters }));
    context.facts = service.store.all("SELECT id,text,source_message_id,source_ref,status FROM facts WHERE person_id=? AND status='confirmed' ORDER BY created_at DESC LIMIT 100", person.id);
    context.tasks = service.store.all("SELECT id,kind,title,instructions,due_at,status,evidence FROM tasks WHERE conversation_id=? AND kind<>'opportunity_review' AND status IN ('pending','proposed','running') ORDER BY due_at LIMIT 30", conv.id);
    context.lessons = searchExperience(service, `${task?.instructions ?? ''} ${messages.at(-1)?.text ?? ''}`, conv.id, service.config.context.maxLessons);
  } else {
    context.work = service.store.all("SELECT t.id,t.conversation_id,t.kind,t.title,t.due_at,t.status FROM tasks t WHERE t.partner_id=? AND t.kind<>'opportunity_review' AND t.status IN ('pending','proposed','running','interrupted') ORDER BY t.due_at LIMIT 100", service.config.partnerId);
    context.contacts = service.store.all('SELECT c.id AS conversation_id,p.name,p.source,p.suppressed,c.ownership,c.stage FROM conversations c JOIN persons p ON p.id=c.person_id WHERE p.partner_id=? ORDER BY c.created_at DESC LIMIT 100', service.config.partnerId);
    context.lessons = searchExperience(service, task?.instructions ?? '', null, service.config.context.maxLessons);
  }
  return context;
}

export function compactPromptContext(context) {
  const compact = { ...context };
  compact.prompt_assets = {
    identity: { source: 'partner/identity.md', sha256: context.identity_sha256 },
    behavioral_examples: { source: 'partner/behavioral_examples.md', sha256: context.behavioral_examples_sha256 },
    skills: (context.skills ?? []).map(skill => ({
      name: skill.name,
      ...(skill.version ? { version: skill.version } : {}),
      ...(skill.sha256 ? { sha256: skill.sha256 } : {}),
    })),
  };
  delete compact.identity;
  delete compact.behavioral_examples;
  delete compact.skills;
  return compact;
}
