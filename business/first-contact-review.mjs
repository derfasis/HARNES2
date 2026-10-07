// Review of one inert public response. Neither model advice nor this review grants
// contact, source writes, recipient identity, action execution or delivery authority.
import { ensure, requiredText, now } from './errors.mjs';
import { id, hash } from './store.mjs';
import { digest } from './source-ingestion.mjs';
import { proposalRefs } from './audience-proposals.mjs';

const ACTION = 'audience.review_first_contact';
const AUTHORITY = Object.freeze({ executable:false, contact_permission:false, allowed_effects:[] });
const KEYS = ['need_id','expected_revision','expected_basis_fingerprint','expected_proposal_sha256','decision','note'];
const check = (ok, code) => ensure(ok, code, 409, code);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function firstContactHash(need) {
  return need.first_contact ? digest({ version:1, first_contact:need.first_contact,
    material_preview:need.material_preview ?? null, evidence_event_ids:proposalRefs(need) }) : null;
}

export function firstContactState(audience, need, packet) {
  const base = { version:1, state:'not_proposed', proposal_sha256:null, target:null,
    review:null, fit:'unknown', outcome:'not_observed', ...AUTHORITY };
  if (!need.first_contact) return base;
  const target = packet.exchanges.flatMap(e => e.evidence).find(e => e.source_event_id === need.first_contact.target_event_id);
  const proposalHash = firstContactHash(need);
  const state = { ...base, state:need.current ? need.first_contact.channel === 'none' ? 'not_proposed' : 'pending' : 'stale', proposal_sha256:proposalHash,
    target:target ? {source_ref:target.source_ref,source_event_id:target.source_event_id,
      message_id:target.message_id,author_ref:target.author_id ?? null} : null };
  if (!target) return {...state,state:'invalid'};
  // The action event and command receipt commit together in BusinessService. A
  // tampered/missing receipt cannot become an approval through an audit label.
  const event = audience.store.get(`SELECT * FROM events WHERE partner_id=? AND kind=?
    AND CASE WHEN json_valid(payload_json) THEN payload_json->>'$.need_id' END=? ORDER BY id DESC LIMIT 1`, audience.partnerId, ACTION, need.id);
  if (!event) return state;
  try {
    const data = JSON.parse(event.payload_json), params = Object.fromEntries(Object.entries(data).filter(([k]) => KEYS.includes(k)));
    check(exact(data,[...KEYS,'result','run_id','request_id']) && event.actor === 'operator'
      && event.conversation_id === null && data.run_id === null && typeof data.request_id === 'string'
      && exact(data.result,['need_id','review_id','proposal_sha256',...Object.keys(AUTHORITY)])
      && typeof data.result.review_id === 'string' && /^[0-9a-f-]{36}$/.test(data.result.review_id)
      && data.result.need_id === params.need_id && data.result.proposal_sha256 === params.expected_proposal_sha256
      && data.result.executable === false && data.result.contact_permission === false
      && Array.isArray(data.result.allowed_effects) && data.result.allowed_effects.length === 0
      && ['approve','reject'].includes(params.decision) && typeof params.note === 'string' && params.note.trim().length > 0
      && params.note.length <= 2000 && Number.isInteger(params.expected_revision)
      && Number.isFinite(Date.parse(event.created_at)) && Date.parse(event.created_at) <= Date.now(), 'FIRST_CONTACT_REVIEW_INVALID');
    const receipt = audience.store.get('SELECT * FROM command_receipts WHERE id=?', data.request_id);
    check(receipt && receipt.fingerprint === hash(JSON.stringify({partner:audience.partnerId,action:ACTION,p:params,
      actor:'operator',run:null,scope:null})) && digest(JSON.parse(receipt.result_json)) === digest(data.result),
    'FIRST_CONTACT_REVIEW_INVALID');
    if (params.expected_revision !== need.revision || params.expected_basis_fingerprint !== need.basis_fingerprint
      || params.expected_proposal_sha256 !== proposalHash) return state;
    if (params.decision === 'approve') check(need.status === 'accepted' && need.first_contact.channel === 'public_reply'
      && !!need.material_preview, 'FIRST_CONTACT_REVIEW_INVALID');
    return {...state,state:need.current ? params.decision === 'approve' ? 'approved' : 'rejected' : 'stale',
      review:{id:data.result.review_id,decision:params.decision,note:params.note,reviewed_at:event.created_at}};
  } catch { return {...state,state:'invalid'}; }
}

export function assertFirstContactReview(audience, params, { receipt = null } = {}) {
  check(exact(params,KEYS), 'FIRST_CONTACT_FIELDS_INVALID');
  const need = audience.need(params.need_id);
  check(need.first_contact && need.current && ['proposed','accepted'].includes(need.status), 'FIRST_CONTACT_STALE_BASIS');
  check(need.revision === params.expected_revision && need.basis_fingerprint === params.expected_basis_fingerprint
    && need.first_contact_state.proposal_sha256 === params.expected_proposal_sha256, 'FIRST_CONTACT_REVISION_CONFLICT');
  check(need.first_contact_state.state !== 'invalid', 'FIRST_CONTACT_REVIEW_INVALID');
  check(['approve','reject'].includes(params.decision), 'FIRST_CONTACT_DECISION_INVALID');
  requiredText(params.note,'review note',2000);
  if (params.decision === 'approve') check(need.status === 'accepted' && need.first_contact.channel === 'public_reply'
    && !!need.material_preview, 'FIRST_CONTACT_RESPONSE_NOT_APPROVABLE');
  if (!receipt) check(params.decision === 'approve' ? need.first_contact_state.state === 'pending'
    : ['pending','approved'].includes(need.first_contact_state.state), 'FIRST_CONTACT_REVIEW_RESOLVED');
  if (receipt) {
    let prior;
    try { prior = JSON.parse(receipt.result_json); } catch { check(false,'FIRST_CONTACT_REVIEW_INVALID'); }
    check(need.first_contact_state.review?.id === prior.review_id
      && need.first_contact_state.state === (params.decision === 'approve' ? 'approved' : 'rejected'),
    'FIRST_CONTACT_REVIEW_SUPERSEDED');
  }
  audience.requireEnabled();
  return need;
}

export function reviewFirstContact(audience, params) {
  const need = assertFirstContactReview(audience,params);
  return {need_id:need.id,review_id:id(),proposal_sha256:need.first_contact_state.proposal_sha256,...AUTHORITY};
}
