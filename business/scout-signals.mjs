import { digest } from './source-ingestion.mjs';
// Counts describe the observed sample. No bot/human verdict, promotional classification,
// keyword rejection, or claim about all messages/people in the community.
export function scoutSignals(messages) {
  const authors=new Set(),days=new Set(),exact=new Set();
  const byId=new Map(messages.map(m=>[m.message_id,m]));
  const groups=new Map(),omitted=[],duplicates=new Set();
  let replies=0,repeats=0,unsupported=0,characters=0;
  for(const m of messages){
    if(m.author_ref)authors.add(m.author_ref);
    days.add(m.date.slice(0,10));if(m.reply_to)replies++;
    if(m.unsupported||typeof m.text!=='string'||!m.text.trim()){unsupported++;continue;}
    const hash=digest(m.text);if(exact.has(hash))repeats++;exact.add(hash);
  }
  for(const m of [...messages].sort((a,b)=>Number(a.message_id)-Number(b.message_id))){
    if(m.unsupported||typeof m.text!=='string'||!m.text.trim())continue;
    // Check the entire known ancestry. An independent message by the same author
    // remains useful; a reply descended from an opaque anchor is withheld.
    let ancestor=m,root=m.message_id,incomplete=false,blocked=false;
    const seen=new Set();
    while(ancestor){
      if(seen.has(ancestor.message_id)){blocked=true;break;}
      seen.add(ancestor.message_id);
      if(ancestor.unsupported){blocked=true;break;}
      root=ancestor.message_id;
      if(!ancestor.reply_to)break;
      const parent=byId.get(ancestor.reply_to);
      if(!parent){incomplete=true;break;}
      ancestor=parent;
    }
    if(blocked){omitted.push({message_id:m.message_id,reason:'opaque_or_cyclic_reply_ancestry'});continue;}
    const duplicate=digest([m.author_ref,m.reply_to,m.text]);
    if(m.author_ref&&duplicates.has(duplicate)){omitted.push({message_id:m.message_id,reason:'same_author_context_exact_repeat'});continue;}
    if(m.author_ref)duplicates.add(duplicate);
    let group=groups.get(root);
    if(!group){group={id:root,messages:[],context_incomplete:incomplete};groups.set(root,group);}
    group.context_incomplete ||= incomplete;
    if(group.messages.length>=8||characters+m.text.length>24000){
      group.context_incomplete=true;omitted.push({message_id:m.message_id,reason:'semantic_packet_capacity'});continue;
    }
    group.messages.push(m);characters+=m.text.length;
  }
  const selected=[...groups.values()].filter(g=>g.messages.length)
    .sort((a,b)=>b.messages.length-a.messages.length||Number(b.id)-Number(a.id)).slice(0,24);
  const selectedRefs=new Set(selected.flatMap(g=>g.messages.map(m=>m.message_id)));
  for(const group of groups.values())for(const m of group.messages){
    if(!selectedRefs.has(m.message_id))omitted.push({message_id:m.message_id,reason:'semantic_group_capacity'});
  }
  return {
    metrics:{messages:messages.length,authors:authors.size,active_days:days.size,replies,exact_repeats:repeats,unsupported},
    groups:selected.map(g=>({...g,evidence_refs:g.messages.map(m=>m.message_id),preview:g.messages.map(m=>m.text).join('\n').slice(0,500)})),
    omitted,limits:{groups:24,messages_per_group:8,characters:24000},
    uncertainty:['Visible author identifiers are not proven distinct people.','A bounded non-atomic history sample and missing ancestry do not prove continuous coverage.','Exact repetitions are not a spam percentage.'],
  };
}
