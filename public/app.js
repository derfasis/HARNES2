const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {pending:'Ожидает',proposed:'Предложено',running:'В работе',done:'Готово',completed:'Завершён',failed:'Ошибка',cancelled:'Отменено',interrupted:'Прервано',blocked:'Приостановлено',approved:'Одобрено',sent:'Отправлено',sending:'Отправляется',stale:'Устарел',rejected:'Отклонено',delivery_unknown:'Нужна сверка',candidate:'На рассмотрении',active:'Активно',retired:'В архиве',new:'Новый',qualified:'Квалифицирован',call_proposed:'Звонок предложен',call_accepted:'Согласие на звонок',call_booked:'Звонок назначен',call_attended:'Звонок состоялся',no_show:'Не пришёл',joined:'Присоединился',declined:'Отказ',business_value:'Бизнес-ценность',AI_OWNED:'Ведёт партнёр',HUMAN_OWNED:'Ведёт человек',accepted_for_development:'Принято в разработку',available:'Доступно',available_manual_sources:'Ручные источники',needs_configuration:'Нужно подключение',planned:'Запланировано',draft:'Черновик',reply:'Ответ',follow_up:'Продолжение диалога',research:'Исследование',planning:'Планирование',review:'Разбор',operator:'Владелец',agent:'Партнёр',system:'Система',confirmed:'Подтверждено'};
const label = x => labels[x] ?? x;
const date = value => value ? new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const badge = status => `<span class="badge ${['active','completed','done','sent','available','confirmed'].includes(status)?'green':['failed','delivery_unknown','rejected','stale'].includes(status)?'red':['proposed','candidate','running'].includes(status)?'purple':''}">${esc(label(status))}</span>`;
const button = (title,action,id='',kind='secondary') => `<button class="button ${kind}" data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`;
const modeButton = (mode,current) => `<button class="mode-button ${mode===current?'active':''}" data-do="conversation-mode" data-mode="${mode}" aria-pressed="${mode===current}">${mode}</button>`;
const empty = (title,text,action='') => `<div class="empty"><strong>${esc(title)}</strong><p>${esc(text)}</p>${action}</div>`;
const panel = (title,content,action='') => `<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
let token='',state=null,tab='overview',selected=null,detail=null;
let reviewFilter='pending',reviewOffset=0,reviewDetail=null;
const pending = new Map();
async function api(route,body) {
  const response = await fetch(route,{method:body === undefined?'GET':'POST',headers:{'x-partner-token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data = await response.json(); if(!response.ok) throw new Error(data.error ?? 'Операция не завершена'); return data;
}
function notify(message,error=false) { const n=$('#notice');n.textContent=message;n.className=`show${error?' error':''}`; }
async function command(action,payload) {
  const fingerprint=JSON.stringify({action,payload});if(!pending.has(fingerprint)) pending.set(fingerprint,crypto.randomUUID());
  const result=await api('/api/commands',{request_id:pending.get(fingerprint),action,payload});pending.delete(fingerprint);return result;
}
async function refresh() {
  state=await api('/api/state');if(selected) detail=await api(`/api/conversations/${encodeURIComponent(selected)}`);
  if(tab==='tasks')state.opportunity_reviews=await api(`/api/opportunities?status=${encodeURIComponent(reviewFilter)}&offset=${reviewOffset}`);
  if(tab==='discovery')await loadDiscovery();
  $('#model-status').textContent=state.runtime.ready?'Модель подключена':'Ожидает подключения ИИ';
  $('#model-status').className=`pill${state.runtime.ready?' ready':''}`;render();
}
function render(){
  const titles={overview:'Обзор',people:'Люди и диалоги',tasks:'Задачи',discovery:'Discovery',experience:'Память и опыт',capabilities:'Способности',runs:'История работы',settings:'Подключения'};
  $('#page-title').textContent=titles[tab];document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  $('#content').innerHTML=({overview:overview,people:people,tasks:tasks,discovery:discoveryTab,experience:experience,capabilities:capabilities,runs:runs,settings:settings}[tab])();
}
function overview(){
  const m=state.metrics,pendingTasks=state.tasks.filter(t=>['pending','proposed','running'].includes(t.status));
  return `<section class="hero"><div class="orb">✧</div><span class="eyebrow">ОБЩАЯ ЦЕЛЬ</span><h2>Развиваем бизнес вместе.</h2><p>${esc(state.partner.mission)}</p><div class="actions">${button('Задать направление','mission','','primary')}${button('Добавить человека','person-new')}</div></section>
  <div class="stats">${[['Люди в работе',state.conversations.length,'Все разговоры в одном месте'],['Ожидают решения',state.conversations.reduce((n,c)=>n+c.pending_drafts,0),'Черновики на рассмотрении'],['Задачи партнёра',pendingTasks.length,'Сохранены между запусками'],['Состоявшиеся встречи',m.call_attended??0,'Только подтверждённые события']].map(([l,n,s])=>`<div class="stat"><span class="label">${l}</span><strong>${n}</strong><small>${s}</small></div>`).join('')}</div>
  <div class="grid-two">${panel('Ближайшие действия',pendingTasks.length?pendingTasks.slice(0,5).map(t=>`<div class="feature"><div>${esc(t.title)}<small>${date(t.due_at)} · ${esc(label(t.kind))}</small></div>${badge(t.status)}</div>`).join(''):empty('Есть место для первого шага','Добавьте человека или задачу. Партнёр сохранит работу до подключения модели.',button('Создать задачу','task-new')),button('Все задачи','go-tasks'))}
  ${panel('Рабочие способности',state.capabilities.slice(0,4).map(c=>`<div class="feature"><div>${esc(c.name)}<small>${esc(c.id)}</small></div>${badge(c.status)}</div>`).join(''),button('Открыть','go-capabilities'))}</div>
  ${!state.runtime.ready?`<div class="section-note">Архитектура установлена. Можно вести контакты, записывать сообщения, планировать задачи и сохранять опыт. Для самостоятельной работы партнёра осталось подключить модель.</div>`:''}
  ${panel('Последние события',state.events.length?state.events.slice(0,6).map(e=>`<div class="activity"><span class="marker"></span><div>${esc(e.kind)}<small>${date(e.created_at)} · ${esc(label(e.actor))}</small></div></div>`).join(''):empty('История начинается здесь','Здесь появятся действия партнёра и ваши решения.'))}`;
}
// Stage 3E: a read-only Discovery viewer. It renders the frozen 3B/3C projections and issues
// nothing but the two GET endpoints. There is deliberately no command path here.
let discoveryList=null,discoveryError=null,discoveryDetail=null,discoverySelection=null,discoveryDetailError='',discoveryCursorStack=[];
async function loadDiscovery() {
  discoveryCursorStack=[];
  try { discoveryList=await api('/api/discovery/reason-states'); discoveryError=null; }
  catch(error) { discoveryList=null; discoveryError=error.message; }
  // The open situation is re-read too, so a card that went stale, revoked, or unavailable is never
  // left on screen looking fresh next to an already updated list.
  if(discoverySelection) await selectSituation(discoverySelection);
}
async function nextDiscoveryPage() {
  const cursor=discoveryList?.next_cursor; if(!cursor) return;
  try { discoveryList=await api(`/api/discovery/reason-states?cursor=${encodeURIComponent(cursor)}`); discoveryError=null; }
  catch(error) { discoveryError=error.message; }
}
async function selectSituation(situationId) {
  // A slow response for an earlier selection must never replace the one the operator is reading.
  const request=discoveryCursorStack.length,tokenAtRequest=++discoveryRequest;
  discoverySelection=situationId; discoveryDetailError='';
  try {
    const loaded=await api(`/api/discovery/${encodeURIComponent(situationId)}`);
    if(tokenAtRequest!==discoveryRequest||discoverySelection!==situationId) return;
    discoveryDetail=loaded;
  } catch(error) {
    if(tokenAtRequest!==discoveryRequest||discoverySelection!==situationId) return;
    discoveryDetail=null; discoveryDetailError=error.message;
  }
  void request;
}
let discoveryRequest=0;
const truncatedMark=value=>value?' <span class="truncated" title="Показано сокращённо">обрезано</span>':'';
const freshnessLine=value=>value.fresh?'Свежее':'Неактуально: '+value.reasons.join(', ');
function discoveryTab(){
  if(discoveryError)return empty('Discovery недоступен',discoveryError);
  const items=discoveryList?.items??[];
  const rows=items.map(item=>`<button class="person-card ${item.situation_id===discoverySelection?'active':''}" data-do="discovery-select" data-id="${esc(item.situation_id)}">
    <strong>${esc(item.situation_id)}</strong><small>${esc(item.decision)} · ${esc(item.state)}</small>
    <small>Условие: ${esc(item.unlock)}</small><small>${esc(item.reason)}</small>
    <small>${item.wait?`Ожидание: ${esc(item.wait.kind)}${item.wait.at?` до ${esc(item.wait.at)} (${esc(date(item.wait.at))})`:''}`:'Ожидание: нет'}</small><small>${esc(freshnessLine(item.freshness))}</small></button>`).join('');
  return `${panel('Discovery: состояния решений',rows?`<div class="person-list">${rows}</div>`:empty('Нет заблокированных ситуаций','Здесь появляются ситуации, ожидающие решения. Ничего менять из этого экрана нельзя.'),discoveryList?.next_cursor?button('Далее','discovery-next'):'')}
    ${discoveryDetailPanel()}`;
}
function discoveryDetailPanel(){
  if(discoveryDetailError)return panel('Ситуация',empty('Ситуация больше недоступна',discoveryDetailError));
  if(discoveryDetail&&['STOPPED','DISMISSED','TRANSFERRED','STALE'].includes(discoveryDetail.status))
    return panel(`Ситуация ${discoveryDetail.situation_id}`,`<p>Эта ситуация закрыта: ${esc(discoveryDetail.status)}. Решения недоступны.</p>`);
  const d=discoveryDetail;
  if(!d)return panel('Ситуация',empty('Выберите ситуацию','Показываем только то, что уже записано в системе. Ничего не отправляется отсюда.'));
  const evidence=d.evidence.map(item=>`<p><strong>Зафиксированное наблюдение — не подтверждённый факт</strong>: ${esc(item.text)}${truncatedMark(item.text_truncated)}<small>${esc(item.message_id)} · версия ${item.message_version} · ${esc(item.author_id??'—')}</small></p>`).join('');
  const assessments=d.assessments.map(a=>`<div class="feature"><div>
    <strong>Непроверенное предложение</strong> (${esc(a.reasoning_shape==='legacy_v0_strings'?'старый формат':'структурированный')}): ${esc(a.hypothesis.text)}${truncatedMark(a.hypothesis.text_truncated)}
    ${a.hypothesis.attributed_claims.map(c=>`<p>Цитата: ${esc(c.quote)}${truncatedMark(c.quote_truncated)}</p>`).join('')}
    ${a.hypothesis.inferences.map(x=>`<p>Предположение: ${esc(x.text)}${truncatedMark(x.text_truncated)}</p>`).join('')}
    <p>Неизвестно: ${esc(a.hypothesis.uncertainty.join('; ')||'—')}</p>
    <p><strong>Почему сейчас</strong>: ${esc(a.why_now.reason)}${truncatedMark(a.why_now.reason_truncated)}</p>
    <small>${esc(freshnessLine(a.freshness))}</small></div></div>`).join('');
  const proposals=d.opening_proposals.map(p=>`<p><strong>Предложение — не черновик, не отправлено, не даёт разрешения на контакт</strong>: ${esc(p.text)}${truncatedMark(p.text_truncated)}<small>${esc(p.rationale)}${truncatedMark(p.rationale_truncated)}</small></p>`).join('');
  return panel(`Ситуация ${d.situation_id}`,`<p>Статус: ${esc(d.status)} · в хранении: ${esc(d.storage_status)} · ревизия ${d.revision}</p>
    ${discoveryDetail.freshness?.fresh===true?'':`<p class="section-note">Основание устарело: ${esc((discoveryDetail.freshness?.reasons??[]).join(', '))}. Решения недоступны, пока основание не обновится.</p>`}
    ${discoveryOperatorActions(d)}
    <p>${esc(freshnessLine(d.freshness))}</p><h3>Наблюдения</h3>${evidence||'<p>Пока нет.</p>'}
    <h3>Гипотезы</h3>${assessments||'<p>Пока нет.</p>'}<h3>Предложения</h3>${proposals||'<p>Пока нет.</p>'}
    <p><strong>Не отправлено</strong> · <strong>Не даёт разрешения на контакт</strong> · ничего из этого экрана выполнить нельзя</p>
    <p>Задачи ревью: ${d.review_tasks.map(t=>esc(t.status)).join(', ')||'нет'}</p>`);
}

// Stage 4E: the operator's existing write commands, exposed and nothing more. The UI never
// decides, never repairs, and never retries a rejected decision on its own.
// Actions are offered only for a live, fresh basis. A stale or expired situation is shown, but it
// is not decided from the screen: the operator's own basis has already moved on.
const discoveryLive = d => !!d && !['STOPPED','DISMISSED','TRANSFERRED','STALE'].includes(d.status)
  && d.freshness?.fresh === true;
const discoveryProposedReview = d => (d?.review_tasks ?? []).find(t => t.status === 'proposed');
function discoveryOperatorActions(d) {
  if (!discoveryLive(d)) return '';
  const proposed = discoveryProposedReview(d), parts = [];
  if (proposed) {
    parts.push(button('Одобрить разбор','discovery-review-approve',proposed.id,'primary'));
    parts.push(button('Отклонить','discovery-review-reject',proposed.id,'danger'));
  }
  // Each decision gets its own control. The decision travels in data-mode, exactly like the
  // other actions carry their parameter, so the real click path cannot open an undefined form.
  for (const decision of ['WAIT','IGNORE','STOP'])
    parts.push(`<button class="button ${decision==='STOP'?'danger':'secondary'}" data-do="discovery-reason-open" data-id="${esc(d.situation_id)}" data-mode="${decision}">${decision}</button>`);
  return `<div class="actions">${parts.join('')}</div>`;
}
const reasonForm = decision => {
  const waitFields = decision === 'WAIT'
    ? field('wait_kind','Условие','select','evidence_change',[['evidence_change','Новое evidence'],['deadline','Срок']])
      + field('wait_at','Срок (ISO 8601)')
    : '';
  return modal(`Решение: ${decision}`, field('reason','Почему','textarea') + waitFields, async values => {
    if (!values.reason || !String(values.reason).trim()) throw new Error('Причина обязательна');
    if (decision === 'WAIT' && (!values.wait_kind || (values.wait_kind === 'deadline' && !values.wait_at)))
      throw new Error('Для WAIT нужно условие: evidence_change или срок');
    const d = discoveryDetail;
    if (!discoveryLive(d)) throw new Error('Ситуация уже недоступна для решения');
    const assessment = d.assessments?.at(-1);
    if (!assessment) throw new Error('Нет оценки, на которую можно опереться');
    const wait = decision === 'WAIT'
      ? (values.wait_kind === 'deadline' ? { kind: 'deadline', at: values.wait_at } : { kind: 'evidence_change' })
      : undefined;
    try {
      await command('discovery.reason', { situation_id: d.situation_id, assessment_id: String(assessment.id),
        expected_revision: d.revision, expected_evidence_fingerprint: d.evidence_fingerprint,
        decision, reason: values.reason, ...(wait ? { wait } : {}) });
    } finally {
      // One attempt, always. A refusal means this screen is out of date, so the canonical state is
      // re-read before the error reaches the operator.
      await selectSituation(d.situation_id);
      await loadDiscovery();
      render();
    }
  });
};
function engagementPanel(){
  const all=detail.engagements??[],e=all.find(e=>!['CLOSED','STOPPED'].includes(e.status));
  if(!e)return panel('Постійна справа',`<p>Увімкнення явне. Старі текстові дозволи не стають типізованою згодою. Після STOP потрібні окреме відновлення контакту, нова справа та новий дозвіл.</p>${all.map(x=>`<p>${esc(x.topic)}: ${esc(x.status)}</p>`).join('')}`,button('Відкрити справу','eng-open'));
  const decisions=(detail.decisions??[]).filter(d=>d.engagement_id===e.id);
  return panel('Постійна справа',`<h3>${esc(e.topic)}</h3><p>${esc(e.current_need)}</p><p>Стан: ${esc(e.status)} · відповідальність: ${esc(e.ownership)} · версія ${e.revision}</p><p>Умова завершення: ${esc(e.close_condition)}</p><p>Невідоме: ${esc(e.unknowns.join('; '))}</p>
  <div class="actions">${button('Оновити потребу','eng-update',e.id)}${button('Нова подія','eng-wake',e.id)}${button('Рішення оператора','eng-decide',e.id)}${button('Завершити справу','eng-close',e.id)}</div>
  <h3>Очікування</h3>${e.waiting.map(w=>`<p>${esc(w.events.join(', '))} ${w.due_at?date(w.due_at):''}</p>`).join('')||'<p>Немає активного WAIT. Це не дозвіл написати.</p>'}
  <h3>Твердження і гіпотези</h3>${e.beliefs.map(b=>`<p><strong>${esc(b.kind)}</strong>: ${esc(b.text)}<small>${esc(b.evidence_json)}</small></p>`).join('')||'<p>Поки немає.</p>'}
  <h3>Підтверджено надісланим текстом</h3>${e.explained.map(x=>`<p>${esc(x.text)}<small>Повідомлення ${esc(x.message_id)}</small></p>`).join('')||'<p>Поки немає.</p>'}
  <h3>Зобов’язання</h3>${e.commitments.map(c=>`<p>${esc(c.text)} · ${esc(c.owner)} · ${esc(c.status)} ${c.due_at?date(c.due_at):''}</p>${button('Зафіксувати результат','eng-commitment',c.id)}`).join('')||'<p>Поки немає. Proposed не означає, що обіцянку вже дано.</p>'}
  <h3>Передача людині</h3>${e.handoffs.map(h=>`<p>${esc(h.status)} · ${esc(h.owner)} · ${esc(h.reason)}</p>${h.status==='requested'?button('Прийняти відповідальність','eng-handoff-accept',h.id):button('Повернути AI / завершити','eng-handoff-resolve',h.id)}`).join('')||'<p>Немає відкритої передачі.</p>'}
  <h3>Дозволи на контакт</h3>${(detail.contact_permissions??[]).map(g=>`<p>${esc(g.purpose)} · ${esc(g.granted_by)} · до ${date(g.expires_at)} · ${g.revoked_at?'відкликано':'перевіряється під час дії'}</p>${!g.revoked_at?button('Відкликати','eng-permission-revoke',g.id):''}`).join('')}${button('Зафіксувати явний дозвіл','eng-permission-grant',e.id)}
  <h3>Історія рішень</h3>${decisions.map(d=>`<p>${esc(d.kind)} · ${esc(d.status)} · ${esc(d.reason)}</p>${button('Рішення → дія → результат','eng-episode',d.id)}`).join('')||'<p>Поки немає.</p>'}
  <div class="actions">${button('Кандидат уроку з outcome','eng-lesson',e.id)}</div><p>Стратегії: ${e.strategies.map(x=>esc(`v${x.version}: ${x.guidance}`)).join('; ')||'немає активних'}. Вони не змінюють прав.</p>`);
}

function people(){
  const list=`<div>${button('+ Добавить человека','person-new','','primary')}<div class="person-list">${state.conversations.map(c=>`<button class="person-card ${c.id===selected?'active':''}" data-do="person-select" data-id="${esc(c.id)}"><strong>${esc(c.name)}</strong><small>${esc(label(c.stage))} · ${c.channel==='telegram'?'Telegram':'Ручной канал'}</small><small class="person-preview">${esc(c.last_message??c.source)}</small>${c.suppressed?badge('blocked'):''}</button>`).join('')}</div></div>`;
  if(!detail)return `<div class="people-layout">${list}${empty('Первый разговор','Добавьте человека с источником и основанием контакта. Здесь сохранятся переписка, предложения и результаты.')}</div>`;
  const {person:p,conversation:c,messages,drafts,facts,outcomes,events}=detail;
  const handoffEvent=events.find(e=>e.kind==='conversation.handoff_required');
  const mode=(detail.engagements??[]).length?'REVIEW':c.mode??'REVIEW';
  return `<div class="people-layout">${list}<div>${panel(p.name,`<div class="actions">${badge(c.ownership)}${badge(c.stage)}${p.suppressed?badge('blocked'):''}</div><div class="contact-details"><div class="muted">Источник: ${esc(p.source)}</div><div>Основание контакта: ${esc(p.permission||'Ещё не зафиксировано')}</div>${p.notes?`<p>${esc(p.notes)}</p>`:''}</div>
  <div class="mode-control"><div><strong>Conversation mode</strong><small>${(detail.engagements??[]).length?'Постійний контур працює тільки через review. AUTOPILOT тут не надає права відправлення.':'Автопилот отвечает только в этом уже начатом разрешённом диалоге.'}</small></div><div class="mode-switch" role="group" aria-label="Conversation mode">${modeButton('REVIEW',mode)}${modeButton('AUTOPILOT',mode)}</div></div>
  <div class="actions">${button('Основание контакта','permission')}${button(c.ownership==='AI_OWNED'?'Взять разговор':'Вернуть партнёру',c.ownership==='AI_OWNED'?'takeover':'release')}${button(p.suppressed?'Возобновить':'Остановить контакт',p.suppressed?'resume':'stop','','danger')}</div>
  ${handoffEvent&&c.ownership==='HUMAN_OWNED'?`<div class="handoff-notice"><strong>HANDOFF: требуется участие владельца</strong><p>${esc(handoffEvent.payload.model_text??'Партнёр остановил автономный разговор и передал его владельцу.')}</p><small>${date(handoffEvent.created_at)} · запуск ${esc(handoffEvent.payload.run_id??'—')}</small></div>`:''}
  <div class="messages">${messages.length?messages.map(m=>`<div class="message ${m.direction==='out'?'out':''}"><small>${m.direction==='in'?esc(p.name):'Исходящее'} · ${date(m.created_at)}</small>${esc(m.text)}</div>`).join(''):empty('Сообщений пока нет','Запишите входящее сообщение или подключите Telegram.')}</div>
  <div class="actions">${button('Записать сообщение','message')}${button('Задача на ответ ИИ','reply-task','','primary')}${button('Свой черновик','draft-new')}${button('Добавить факт','fact-new')}</div>`)}
  ${engagementPanel()}
  ${panel('Предложения сообщений',drafts.length?drafts.map(d=>{const v=d.versions.at(-1);return `<article class="draft-card"><div class="panel-head">${badge(d.status)}<small>Версия ${d.current_version} · ${esc(label(v.author))}</small></div><pre>${esc(v.text)}</pre><small>${esc(d.reason)}</small><div class="actions">${['pending','approved'].includes(d.status)&&mode==='REVIEW'?button('Изменить','draft-edit',d.id):''}${d.status==='pending'&&mode==='REVIEW'&&c.ownership==='AI_OWNED'?button('Одобрить','draft-approve',d.id,'primary'):''}${['pending','approved','stale'].includes(d.status)?button('Отклонить','draft-reject',d.id):''}${d.status==='approved'?button('Подтвердить ручную отправку','delivery-manual',d.id):''}${d.status==='approved'&&c.channel==='telegram'&&state.telegram.live_sending?button('Отправить в Telegram','delivery-send',d.id,'primary'):''}${d.status==='delivery_unknown'?button('Сверить доставку','delivery-reconcile',d.id):''}</div><details><summary>Все версии и доставка</summary>${d.versions.map(v=>`<p class="tiny">v${v.version} · ${esc(label(v.author))} · ${date(v.created_at)}</p><pre>${esc(v.text)}</pre>${v.reason?`<p class="muted tiny">${esc(v.reason)}</p>`:''}`).join('')}${d.attempts.map(a=>`<p>${badge(a.status)} ${date(a.created_at)} ${esc(a.error??'')}</p>`).join('')}</details></article>`}).join(''):empty('Нет черновиков','Задача на ответ создаст черновик после подключения модели. Можно также подготовить текст вручную.'))}
  ${panel('Факты о человеке',facts.length?facts.map(f=>`<div class="lesson"><h3>${esc(f.text)}</h3><p class="tiny muted">${esc(f.source_ref)}</p>${badge(f.status)} ${f.status==='candidate'?button('Подтвердить','fact-confirm',f.id)+button('Отклонить','fact-reject',f.id):''}</div>`).join(''):empty('Подтверждённых фактов пока нет','Сохраняйте наблюдения с источником. Предположения ИИ требуют рассмотрения.'))}
  ${panel('Результаты',outcomes.length?outcomes.map(o=>`<div class="feature"><div>${esc(label(o.kind))}<small>${esc(o.evidence)}</small></div><span class="muted tiny">${date(o.created_at)}</span></div>`).join(''):empty('Результат ещё не зафиксирован','Предложение звонка, согласие и состоявшаяся встреча — отдельные события.'),button('Записать результат','outcome'))}</div></div>`;
}
function tasks(){
  const work=state.tasks.filter(t=>!['opportunity_review','discovery_review'].includes(t.kind));
  return opportunityQueuePanel()+panel('Очередь работы',`${work.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Задача</th><th>Срок</th><th>Состояние</th><th>Действия</th></tr></thead><tbody>${work.map(t=>`<tr><td>${esc(t.title)}<small>${esc(t.instructions)}</small></td><td>${date(t.due_at)}</td><td>${badge(t.status)}</td><td>${t.status==='proposed'?button('Принять','task-approve',t.id):''}${['failed','interrupted','blocked','cancelled'].includes(t.status)?button('Повторить','task-retry',t.id):''}${!['done','cancelled'].includes(t.status)?button('Отменить','task-cancel',t.id):''}</td></tr>`).join('')}</tbody></table></div>`:empty('Очередь свободна','')}`,`<div class="actions">${button('Обработать очередь','wake')}${button('+ Задача','task-new','','primary')}</div>`)+`<details><summary>Ручные snapshots</summary>${opportunityPanel()}</details>`;
}
function opportunityQueuePanel(){
  const q=state.opportunity_reviews??{items:[],total:0,offset:0,limit:50};
  const filter=`<label class="review-filter">Статус разбора<select id="review-filter">${[['pending','Ожидает'],['approved','Одобрено'],['rejected','Отклонено'],['cancelled','Отменено'],['all','Все']].map(([v,l])=>`<option value="${v}"${v===reviewFilter?' selected':''}>${l}</option>`).join('')}</select></label>`;
  return panel(`На рассмотрении (${q.total})`,q.items.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Источник / субъект</th><th>Решение</th><th>Разбор / evidence</th><th></th></tr></thead><tbody>${q.items.map(d=>`<tr><td><span class="review-preview">${esc(d.source_message?.text)}</span><small>${esc(d.subject.source)} · ${esc(d.subject.author_id)}</small></td><td>${esc(d.decision)}<small class="review-preview">${esc(d.summary)}</small></td><td>${badge(d.review.effective_status)} <span class="badge ${d.freshness.fresh?'green':'red'}">${d.freshness.fresh?'Свежая evidence':'Устарела evidence'}</span></td><td>${button('Разобрать','opportunity-detail',d.task_id)}</td></tr>`).join('')}</tbody></table></div><div class="actions">${q.offset>0?button('Назад','opportunity-prev'):''}${q.offset+q.limit<q.total?button('Далее','opportunity-next'):''}</div>`:empty('Нет карточек в этом статусе','')+(q.offset>0?button('Назад','opportunity-prev'):''),filter);
}
function opportunityPanel(){
  return panel('Opportunity: только разбор оператором',`<p>Snapshot, активный offer и один результат Router. Candidate не является одобрением или разрешением на контакт. Источники и offer задаются в config/local.json, раздел opportunity.</p>
  <p>Автоматический source pipeline: ${state.configuration?.opportunity_automatic?'включён, только no-tool анализ':'выключен'}. Публичные source events обрабатываются отдельно от очереди agent tasks.</p>
  <div class="actions">${button('Импортировать snapshot','opportunity-capture')}${button('Сохранить результат Router','opportunity-consume')}</div>
  ${(state.opportunity_captures??[]).map(c=>`<div class="feature"><div>Snapshot ${esc(c.id)}<small>${esc(c.source)} · ${date(c.created_at)}</small></div>${button('Контекст Router','opportunity-context',String(c.id))}</div>`).join('')}`);
}
function opportunityReviewMarkup(d){
  const o=d.output, r=o.next_action, f=d.freshness;
  const review=d.review??{status:'pending',effective_status:'pending',revision:0,draft_revision:0,draft_text:r.draft?.text};
  const source=d.snapshot.messages?.find(m=>m.id===d.snapshot.anchor_message_id);
  const available=d.task.status==='proposed';
  const spans=items=>items.length?items.map(e=>`<article class="lesson"><strong>${esc(e.message_id)} / ${esc(e.author_id)} / v${esc(e.version)}</strong><pre class="wrap">${esc(e.span)}</pre><small>${esc(e.kind)} · ${esc(e.attribution)}</small></article>`).join(''):'<p>Нет заявленных фрагментов.</p>';
  return `<div class="opportunity-detail"><p><strong>Candidate. Контакт и отправка запрещены.</strong></p>
  <p>Разбор: ${badge(review.effective_status)} · версия ${review.revision}<br>Разрешение на контакт: отсутствует · Исполнение: запрещено</p>
  <div class="actions">${available&&review.status==='pending'?`<button class="button" data-do="opportunity-approve" data-id="${esc(d.task.id)}"${!f.fresh?' disabled title="Evidence устарела"':''}>Одобрить разбор</button>`:''}${available&&r.draft?button('Изменить текст','opportunity-edit',d.task.id):''}${available&&review.status!=='rejected'?button('Отклонить','opportunity-reject',d.task.id,'danger'):''}${button('Обновить','opportunity-detail',d.task.id)}</div>
  <p id="review-error" class="review-error" role="alert" hidden></p>
  <h3>Исходное сообщение ${esc(source?.id??'')}</h3><pre class="wrap">${esc(source?.text??'Недоступно')}</pre>
  <p>Автор: ${esc(d.subject.author_id)}<br>Источник: ${esc(d.subject.source)}<br>Связь с CRM: ${d.subject.crm_link?esc(d.subject.crm_link.conversation_id)+' (указана оператором, не верифицирована)':'не установлена; suppression и ownership неизвестны'}</p>
  <p><strong>${f.fresh?'Свежесть подтверждена только по зарегистрированному snapshot':'УСТАРЕЛО / НЕДОСТУПНО'}</strong><br>${esc(f.reasons.join(', '))}<br>Проверено: ${date(f.checked_at)}; снимок: ${date(d.snapshot.source.captured_at)}</p>
  <h3>Offer ${esc(d.snapshot.active_offer.id)} / ${esc(d.snapshot.active_offer.version)}</h3><p>${esc(d.snapshot.active_offer.text)}</p>
  <h3>Гипотеза</h3><p>${esc(o.opportunity.hypothesis??'Подтверждённой opportunity нет')}</p>
  <h3>Evidence</h3>${spans(o.opportunity.evidence)}<h3>Противоречия</h3>${spans(o.opportunity.contradictions)}
  <h3>Неизвестно</h3><pre class="wrap">${esc([...o.opportunity.unknowns,...r.unknowns].join('\n')||'Не заявлено; это не доказательство полноты.')}</pre>
  <h3>Router: ${esc(r.decision)}</h3><p>${esc(r.strategy)}</p><p>${esc(r.reason)}</p>
  <p>Субъект: ${esc(d.subject.author_id)}<br>Target: ${esc(r.draft?.target_id??d.subject.author_id)}</p>
  ${r.draft?`<h3>Черновик · версия ${review.draft_revision}</h3><pre class="wrap">${esc(review.draft_text)}</pre>${review.draft_revision>0?`<details><summary>Исходный AI draft</summary><pre class="wrap">${esc(r.draft.text)}</pre></details>`:''}`:''}
  <h3>История разбора</h3>${(d.review_history??[]).map(e=>`<div class="lesson"><strong>${esc(label(e.review.status))} · версия ${esc(e.review.revision)}</strong><small>${date(e.created_at)} · ${esc(label(e.actor))}</small>${e.review.reason?`<p>${esc(e.review.reason)}</p>`:''}${e.previous_text!==undefined?`<details><summary>Изменение текста</summary><pre class="wrap">${esc(e.previous_text)}</pre><pre class="wrap">${esc(e.review.draft_text)}</pre></details>`:''}</div>`).join('')||'<p>Решений оператора пока нет.</p>'}
  ${(d.review_denials??[]).length?`<h3>Отказы проверок</h3>${d.review_denials.map(e=>`<p>${esc(e.code)}<br><small>${date(e.created_at)} · ${esc(label(e.actor))}</small></p>`).join('')}`:''}
  <p>Source identity: ${esc(d.source_identity?`${d.source_identity.source_id} / ${d.source_identity.message_id} / v${d.source_identity.version}`:'ручной snapshot')}<br>Display name (не identity): ${esc(d.source_identity?.display_name??'неизвестно')}<br>Duplicate state: ${esc(d.duplicate_state??'canonical_single_review')}</p>
  <p>Ключ дедупликации: ${esc(d.fingerprint)}<br>Задача: ${esc(d.task.id)} / ${esc(d.task.status)}</p>
  <details><summary>Полный проверяемый пакет: версии, критерии, ограничения, coverage</summary><pre class="code">${esc(JSON.stringify(d,null,2))}</pre></details></div>`;
}
function opportunityReadOnly(title,markup){
  $('#modal-title').textContent=title;$('#modal-body').innerHTML=markup;$('#modal').showModal();
}
function experience(){return `<div class="section-note">Факты о человеке находятся в его карточке. Здесь — рассмотренные уроки. Общие уроки должны быть обезличены; урок конкретного диалога доступен только в нём.</div><div class="grid-two">${panel('Накопленный опыт',state.lessons.length?state.lessons.map(l=>`<article class="lesson"><div class="panel-head"><h3>${esc(l.title)}</h3>${badge(l.status)}</div><p>${esc(l.text)}</p><small class="muted">Применимость: ${esc(l.applicability)}<br>Основание: ${esc(l.evidence)}<br>${l.conversation_id?'Для одного разговора':'Общий обезличенный опыт'}</small><div class="actions">${l.status==='candidate'?button('Активировать',l.controlled?'learning-activate':'lesson-active',l.id)+button('Отклонить',l.controlled?'learning-reject':'lesson-rejected',l.id):''}${l.status==='active'?button('В архив',l.controlled?'learning-retire':'lesson-retired',l.id):''}</div></article>`).join(''):empty('Опыт будет расти вместе с работой','Сохраните конкретный вывод, источник и условия, в которых он полезен.'),button('+ Урок','lesson-new','','primary'))}${panel('Проверенные знания',state.knowledge.map(k=>`<div class="lesson"><h3>${esc(k.title)}</h3><p class="muted">${k.status==='needs_owner_materials'?'Ожидаются материалы владельца':esc(k.status)}</p>${k.facts.map(f=>`<p>${esc(f.text)}<small class="muted tiny"> · ${esc(f.source)}</small></p>`).join('')}<h3>Нужно добавить</h3><ul>${(k.missing??[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`).join(''))}</div>`}
function capabilities(){return `<div class="card-grid">${state.capabilities.map(c=>`<article class="capability-card"><div class="capability-icon">${({business:'◎',experience:'◇',telegram:'↗',research:'⌕',browser:'◉',email:'✉',calendar:'▦',social:'✧'})[c.id]??'✧'}</div><h2>${esc(c.name)}</h2><p>${esc(c.id)}${c.version?` · v${esc(c.version)}`:''}</p>${badge(c.status)}</article>`).join('')}</div><div class="section-divider"></div>${panel('Предложения новых способностей',state.proposals.length?state.proposals.map(p=>`<article class="lesson"><div class="panel-head"><h3>${esc(p.name)}</h3>${badge(p.status)}</div><p>${esc(p.purpose)}</p><small class="muted">Проверка пользы: ${esc(p.acceptance)}<br>Права: ${esc(JSON.parse(p.permissions_json).join(', ')||'не указаны')}</small><div class="actions">${p.status==='proposed'?button('Принять в разработку','cap-accept',p.id)+button('Отклонить','cap-reject',p.id):''}${button('Подготовить навык','skill-stage',p.id)}</div></article>`).join(''):empty('Новые способности появляются из задач','Опишите, чего не хватает партнёру и как определить, что новая возможность полезна.'),button('+ Предложение','cap-new','','primary'))}${panel('Версии собственных навыков',state.skills.length?state.skills.map(s=>`<div class="lesson"><h3>${esc(s.name)} · v${s.version}</h3>${badge(s.status)}<details><summary>Содержание</summary><pre class="code">${esc(s.content)}</pre></details><div class="actions">${s.status==='draft'?button('Утвердить инструкции','skill-approve',s.id)+button('Отклонить','skill-reject',s.id):''}${s.status==='approved'?button('Отключить','skill-retire',s.id):''}</div></div>`).join(''):empty('Новых версий пока нет','Утверждение добавляет инструкции к контексту. Установка исполняемого кода и выдача прав выполняются отдельно.'))}`}
function runs(){const m=state.metrics;return `<div class="stats">${[['Запусков',m.runs],['Известные расходы',`$${Number(m.known_cost_usd).toFixed(3)}`],['Неизвестная стоимость',m.unknown_cost_runs??0],['Отправлено с правками',`${m.edited_sent}/${m.total_sent}`]].map(([l,n])=>`<div class="stat"><span class="label">${l}</span><strong>${esc(n)}</strong></div>`).join('')}</div><div class="section-note">Показаны расходы модели. Время владельца и инфраструктура пока не включены. Неизвестные расходы не считаются нулевыми.</div>${panel('Запуски партнёра',state.runs.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>Модель</th><th>Результат</th><th>Расход</th><th></th></tr></thead><tbody>${state.runs.map(r=>`<tr><td>${date(r.created_at)}</td><td>${esc(r.model)}<small>${esc(r.runtime)}</small></td><td>${badge(r.status)}<small>${esc(r.error??'')}</small></td><td>${r.estimated_cost_usd===null?'Неизвестно':`$${r.estimated_cost_usd.toFixed(4)}`}</td><td>${button('Открыть','run-detail',r.id)}</td></tr>`).join('')}</tbody></table></div>`:empty('Запусков пока нет','После подключения модели здесь появятся контекст каждого решения, вызовы инструментов и результат.'))}`}
function settings(){const mtproto=state.telegram.transport==='mtproto';return `<div class="grid-two">${panel('Модель и Hermes',`<div class="feature"><div>Hermes 0.21.0<small>Установлен в runtime/hermes-agent</small></div>${badge(state.runtime.ready?'available':'needs_configuration')}</div><p class="muted">Провайдер: ${esc(state.configuration.provider)}<br>Модель: ${esc(state.configuration.model||'Не выбрана')}<br>Не хватает: ${esc(state.runtime.missing.join(', ')||'всё настроено')}</p><p>Добавьте ключ в <code>.env</code>, а параметры — в <code>config/local.json</code>. Затем перезапустите приложение.</p><pre class="code">${esc(JSON.stringify({runtime:{enabled:true,provider:'custom',apiMode:'chat_completions',baseUrl:'https://YOUR-PROVIDER/v1',model:'YOUR-MODEL',inputUsdPerMillion:null,outputUsdPerMillion:null}},null,2))}</pre><p class="muted tiny">Укажите тарифы для оценки расходов. Дневной порог расходов останавливает новые запуски по учтённой стоимости; это не лимит биллинга провайдера.</p>`)}${panel('Telegram',`<div class="feature"><div>Telegram ${mtproto?'MTProto':'Bot API'}<small>Доступных чатов: ${state.telegram.allowed_chats}</small></div>${badge(state.telegram.enabled&&state.telegram.configured?'available':'needs_configuration')}</div><p>${mtproto?'Текущая сессия GramJS использует разрешённые числовые chat ID и принимает только входящие личные сообщения.':'Ключ хранится в PARTNER_TELEGRAM_BOT_TOKEN. Разрешённые chat ID задаются в конфигурации.'}</p><pre class="code">${esc(JSON.stringify({telegram:{enabled:true,liveSending:false,transport:mtproto?'mtproto':'bot_api',allowedChatIds:['YOUR_NUMERIC_CHAT_ID']}},null,2))}</pre><p class="muted">Подключение: ${state.telegram.connected?'установлено':'не установлено'}<br>Отправка: ${state.telegram.live_sending?'включена после одобрения':'выключена'}<br>Последний приём: ${date(mtproto?state.telegram.last_event:state.telegram.last_poll)}<br>${esc(state.telegram.error??'')}</p><p class="muted tiny">${mtproto?'Холодный контакт, поиск чатов и массовая рассылка запрещены.':'Бот отвечает в доступных ему диалогах.'}</p>`)}</div>${panel('Ваши данные и подключения',`<p>SQLite: <code>data/partner.sqlite</code>. Профиль и знания: <code>partner/</code>. Полный экспорт включает историю, задачи, версии сообщений и рассмотренный опыт.</p><p>MCP-интерфейс запускается командой <code>npm run mcp</code> при работающем приложении. Через него доступны чтение и предложения; одобрения и отправки не публикуются как инструменты агента.</p><p class="muted">Перевірки цієї версії описано в docs/PERSISTENT_ENGAGEMENT_VALIDATION.md. Жива модель і Telegram у цьому increment не перевірялися.</p>`)}`}

function field(name,title,type='text',value='',options=[]){return `<label for="f-${esc(name)}">${esc(title)}</label>${type==='textarea'?`<textarea id="f-${esc(name)}" name="${esc(name)}">${esc(value)}</textarea>`:type==='select'?`<select id="f-${esc(name)}" name="${esc(name)}">${options.map(([v,l])=>`<option value="${esc(v)}"${String(v)===String(value)?' selected':''}>${esc(l)}</option>`).join('')}</select>`:`<input id="f-${esc(name)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}">`}`}
function modal(title,content,onSubmit){
  $('#modal-title').textContent=title;$('#modal-body').innerHTML=`<form id="modal-form">${content}<p id="modal-error" class="review-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="button secondary" data-do="modal-close">Отмена</button><button class="button" type="submit">Сохранить</button></div></form>`;
  $('#modal-form').onsubmit=async e=>{e.preventDefault();const submit=e.submitter;submit.disabled=true;try{await onSubmit(Object.fromEntries(new FormData(e.currentTarget)));$('#modal').close();await refresh();notify('Сохранено.');}catch(error){$('#modal-error').textContent=error.message;$('#modal-error').hidden=false;}finally{submit.disabled=false;}};
  $('#modal').showModal();
}
const convOptions=()=>[['','Общая работа партнёра'],...state.conversations.map(c=>[c.id,c.name])];
const convPayload=()=>({conversation_id:selected});
async function act(action,itemId,extra){
  if(action==='discovery-select'){await selectSituation(itemId);render();return;}
  if(action==='discovery-next'){await nextDiscoveryPage();render();return;}
  // Stage 4E: operator decisions call the existing commands with the exact current basis, and a
  // rejection is reported rather than retried.
  if(action==='discovery-review-approve'||action==='discovery-review-reject'){
    const d=discoveryDetail;if(!discoveryLive(d))throw new Error('Ситуация уже недоступна');
    const proposed=discoveryProposedReview(d);
    if(!proposed||proposed.id!==itemId)throw new Error('Предложение на ревью больше не актуально');
    try{
      await command('discovery.review',{task_id:itemId,decision:action.endsWith('approve')?'approve':'reject',
        expected_revision:d.revision,expected_evidence_fingerprint:d.evidence_fingerprint});
    }finally{
      // A rejected decision means the screen is out of date: go back to canonical state, then let
      // the error reach the operator. Never retry, never paper over it.
      await selectSituation(d.situation_id);await loadDiscovery();render();
    }return;
  }
  if(action==='discovery-reason-open'){reasonForm(extra);return;}
  if(action==='discovery-reason-cancel'){if(modal.open)modal.close();return;}
  if(action.startsWith('eng-')){
    const e=(detail?.engagements??[]).find(e=>!['CLOSED','STOPPED'].includes(e.status));
    const ep={engagement_id:e?.id};
    if(action==='eng-open'){modal('Відкрити постійну справу',field('topic','Тема')+field('current_need','Поточна потреба','textarea')+field('close_condition','Умова завершення','textarea'),p=>command('engagement.open',{...convPayload(),...p}));return;}
    if(action==='eng-episode'){const data=await api(`/api/decisions/${encodeURIComponent(itemId)}`);opportunityReadOnly('Епізод рішення',`<p>Асоціація з outcome не доводить причинність.</p><pre class="code">${esc(JSON.stringify(data,null,2))}</pre>`);return;}
    if(!e)throw new Error('Спершу відкрийте нову справу');
    if(action==='eng-update'){modal('Поточний стан справи',field('current_need','Поточна потреба','textarea',e.current_need)+field('unknowns','Невідоме, по одному пункту в рядку','textarea',e.unknowns.join('\n')),p=>command('engagement.update',{...ep,...p,unknowns:p.unknowns.split('\n').map(x=>x.trim()).filter(Boolean),expected_revision:e.revision}));return;}
    if(action==='eng-wake'){modal('Подія для перегляду рішення',field('event','Тип події','select','operator_response',['operator_response','inbound','permission_changed','commitment_due','outcome'].map(x=>[x,x]))+field('evidence','Що реально змінилося','textarea'),p=>command('engagement.wake',{...ep,...p}));return;}
    if(action==='eng-close'){modal('Завершити справу',field('evidence','Підстава завершення','textarea'),p=>command('engagement.close',{...ep,...p}));return;}
    if(action==='eng-decide'){modal('Явне бізнес-рішення',field('kind','Рішення','select','WAIT',['ACT','WAIT','IGNORE','HANDOFF','STOP'].map(x=>[x,x]))+field('reason','Чому','textarea')+field('expected_next','Що очікується далі','textarea')+field('message_id','Повідомлення-доказ','select',detail.messages.at(-1)?.id??'',detail.messages.map(m=>[m.id,m.text.slice(0,100)]))+field('wait_for','Для WAIT: події через кому','text','operator_response')+field('purpose','Для ACT: мета дозволу','select','reply',[['reply','Відповідь'],['follow_up','Follow-up']])+field('text','Лише для ACT: запропонований текст','textarea'),p=>command('decision.commit',{...ep,expected_revision:e.revision,kind:p.kind,reason:p.reason,expected_next:p.expected_next,evidence:[{type:'message',id:p.message_id}],...(p.kind==='WAIT'?{wait_for:p.wait_for.split(',').map(x=>x.trim()).filter(Boolean)}:{}),...(p.kind==='ACT'?{action:{purpose:p.purpose,text:p.text}}:{})}));return;}
    if(action==='eng-permission-grant'){modal('Явний типізований дозвіл',field('purpose','Мета','select','reply',[['reply','Відповідь у цій розмові'],['follow_up','Follow-up у цій розмові']])+field('granted_by','Хто дозволив')+field('evidence','Джерело й точний обсяг згоди','textarea')+field('expires_at','Кінець дії, ISO 8601 з часовим поясом'),p=>command('permission.grant',{...convPayload(),...p,valid_from:new Date().toISOString()}));return;}
    if(action==='eng-permission-revoke'){modal('Відкликати дозвіл',field('evidence','Підстава','textarea'),p=>command('permission.revoke',{...convPayload(),...p,permission_id:itemId}));return;}
    if(action==='eng-handoff-accept'){await command('handoff.accept',{...ep,handoff_id:itemId});}
    else if(action==='eng-handoff-resolve'){modal('Завершити передачу',field('resolution','Наступний власник роботи','select','return',[['return','Повернути AI'],['close','Завершити справу']])+field('evidence','Що підтверджено людиною','textarea'),p=>command('handoff.resolve',{...ep,...p,handoff_id:itemId}));return;}
    else if(action==='eng-commitment'){modal('Результат зобов’язання',field('status','Стан','select','fulfilled',[['fulfilled','Виконано'],['cancelled','Скасовано']])+field('evidence','Підтвердження','textarea'),p=>command('commitment.resolve',{...ep,...p,commitment_id:itemId}));return;}
    else if(action==='eng-lesson'){modal('Кандидат уроку',field('title','Назва')+field('text','Гіпотеза уроку','textarea')+field('applicability','Область застосування','textarea')+field('outcome_ids','ID пов’язаних outcome через кому'),p=>command('learning.propose',{...ep,...p,outcome_ids:p.outcome_ids.split(',').map(x=>x.trim()).filter(Boolean)}));return;}
    await refresh();return;
  }
  if(action.startsWith('learning-')){
    modal('Контрольована оцінка уроку',field('evaluation','Оцінка evidence та контрприкладів','textarea')+field('limitations','Обмеження й невизначеність','textarea')+field('counterexample_ids','ID локальних пов’язаних outcome-контрприкладів через кому'),p=>command('learning.review',{lesson_id:itemId,decision:action.slice(9),...p,counterexample_ids:p.counterexample_ids.split(',').map(x=>x.trim()).filter(Boolean)}));return;
  }
  if(action.startsWith('go-')){tab=action.slice(3);await refresh();return;}
  if(action==='modal-close'){$('#modal').close();return;}
  if(action==='person-select'){selected=itemId;detail=await api(`/api/conversations/${itemId}`);render();return;}
  if(action==='opportunity-capture'){
    modal('Зарегистрировать разрешённый публичный snapshot',field('snapshot','Opportunity input JSON (с текущим active_offer)','textarea')+field('conversation_id','Необязательная связь с CRM, утверждение оператора','select','',convOptions()),async p=>{
      const result=await command('opportunity.capture',{snapshot:JSON.parse(p.snapshot),...(p.conversation_id?{conversation_id:p.conversation_id}:{})});
      notify(`Snapshot ${result.capture_id} сохранён. Откройте контекст Router в разделе задач.`);
    });return;
  }
  if(action==='opportunity-consume'){
    modal('Проверить и сохранить один результат Router',field('capture_id','ID зарегистрированного snapshot')+field('output','Результат Opportunity / Router, JSON','textarea'),p=>command('opportunity.consume',{capture_id:p.capture_id,output:JSON.parse(p.output)}));return;
  }
  if(action==='opportunity-context'){
    const c=await api(`/api/opportunity-captures/${encodeURIComponent(itemId)}`);
    opportunityReadOnly(`Контекст Router: snapshot ${itemId}`,`<p>Только данные для одного no-tool Router turn через существующий adapter. Эта кнопка не вызывает модель. ${esc(c.freshness.reasons.join(', '))}</p><pre class="code">${esc(JSON.stringify(c,null,2))}</pre>`);return;
  }
  if(action==='opportunity-detail'){
    reviewDetail=await api(`/api/opportunities/${encodeURIComponent(itemId)}`);opportunityReadOnly('Opportunity: разбор оператором',opportunityReviewMarkup(reviewDetail));return;
  }
  if(action==='opportunity-prev'||action==='opportunity-next'){
    reviewOffset=Math.max(0,reviewOffset+(action==='opportunity-next'?50:-50));await refresh();return;
  }
  if(['opportunity-approve','opportunity-edit','opportunity-reject'].includes(action)){
    const d=reviewDetail;if(!d||d.task.id!==itemId)throw new Error('Перезагрузите карточку');
    const p={task_id:itemId,fingerprint:d.fingerprint,expected_revision:d.review.revision};
    if(action==='opportunity-edit'){
      modal('Изменить review draft',field('text','Текст','textarea',d.review.draft_text)+field('reason','Причина изменения','textarea'),v=>command('opportunity.review.edit',{...p,...v}));return;
    }
    if(action==='opportunity-reject'){
      modal('Отклонить review',field('reason','Причина','textarea'),v=>command('opportunity.review.reject',{...p,...v}));return;
    }
    try{await command('opportunity.review.approve',p);await act('opportunity-detail',itemId);await refresh();}
    catch(error){const message=$('#review-error');message.textContent=error.message;message.hidden=false;}
    return;
  }
  if(action==='mission'){modal('Направление работы',field('mission','Цель партнёра','textarea',state.partner.mission),p=>command('partner.update',p));return;}
  if(action==='person-new'){modal('Добавить человека',field('name','Имя')+field('source','Источник и почему человек релевантен','textarea')+field('notes','Заметки','textarea')+field('permission','Основание для контакта (если уже есть)','textarea')+field('channel','Канал','select','manual',[['manual','Ручной'],['telegram','Telegram Bot API']])+field('external_id','Числовой Telegram chat ID (только для Telegram)'),async p=>{if(p.channel!=='telegram')delete p.external_id;const r=await command('person.create',p);selected=r.conversation_id;tab='people';});return;}
  if(['permission','resume'].includes(action)){modal(action==='resume'?'Возобновить контакт':'Основание для контакта',field('evidence','Зафиксируйте конкретное основание','textarea',action==='permission'?detail.person.permission:''),p=>command(action==='resume'?'person.resume':'person.permission',{...convPayload(),...p}));return;}
  if(action==='stop'){await command('person.stop',convPayload());}
  else if(action==='takeover'||action==='release'){await command(`conversation.${action}`,convPayload());}
  else if(action==='conversation-mode')await command('conversation.mode',{...convPayload(),mode:extra});
  else if(action==='message'){modal('Записать произошедшее сообщение',field('direction','Направление','select','in',[['in','Входящее'],['out','Фактически отправлено человеком']])+field('text','Текст сообщения','textarea')+field('source','Источник / подтверждение','text','operator_record'),p=>command('message.record',{...convPayload(),...p}));return;}
  else if(action==='reply-task'&&(detail.engagements??[]).length){const e=detail.engagements.find(e=>!['CLOSED','STOPPED'].includes(e.status));await act(e?'eng-wake':'eng-open',e?.id);return;}
  else if(action==='reply-task'){await command('task.create',{...convPayload(),kind:'reply',title:`Ответить: ${detail.person.name}`,instructions:'Разбери текущий разговор и предложи полезный следующий шаг. Сообщение оформи через инструмент черновика.',due_at:new Date().toISOString()});notify(state.runtime.ready?'Задача добавлена в очередь.':'Задача сохранена и ждёт подключения модели.');await refresh();return;}
  else if(action==='draft-new'&&(detail.engagements??[]).length){const e=detail.engagements.find(e=>!['CLOSED','STOPPED'].includes(e.status));await act(e?'eng-decide':'eng-open',e?.id);return;}
  else if(action==='draft-new'||action==='draft-edit'){const d=detail.drafts.find(x=>x.id===itemId);modal(action==='draft-new'?'Подготовить черновик':'Изменить черновик',field('text','Текст сообщения','textarea',d?.versions.at(-1).text??'')+field('reason','Причина / цель','textarea',d?.reason??''),p=>command(action==='draft-new'?'draft.create':'draft.edit',{...p,...(d?{draft_id:d.id}:convPayload())}));return;}
  else if(action==='draft-approve'||action==='draft-reject')await command(action==='draft-approve'?'draft.approve':'draft.reject',{draft_id:itemId});
  else if(action==='delivery-manual'){modal('Подтвердить ручную отправку',`<p class="muted">Используйте после того, как вы действительно отправили этот текст.</p>`+field('evidence','Подтверждение / ссылка / ID сообщения','textarea')+field('external_id','Внешний ID (необязательно)'),p=>{if(!p.external_id)delete p.external_id;return command('delivery.manual',{...p,draft_id:itemId});});return;}
  else if(action==='delivery-reconcile'){modal('Сверить неопределённую доставку',field('status','Фактический результат','select','sent',[['sent','Отправка подтверждена'],['failed','Точно не отправлено']])+field('evidence','Как проверено','textarea')+field('external_id','ID отправленного сообщения (если известно)'),p=>{if(!p.external_id)delete p.external_id;return command('delivery.reconcile',{...p,draft_id:itemId});});return;}
  else if(action==='delivery-send'){const result=await api('/api/deliver',{draft_id:itemId});notify(label(result.status),result.status!=='sent');await refresh();return;}
  else if(action==='fact-new'){modal('Записать подтверждённый факт',field('text','Факт','textarea')+field('source_ref','Источник','textarea'),p=>command('fact.create',{...convPayload(),...p}));return;}
  else if(action.startsWith('fact-'))await command('fact.review',{fact_id:itemId,status:action==='fact-confirm'?'confirmed':'rejected'});
  else if(action==='outcome'){modal('Записать подтверждённый результат',field('kind','Результат','select','qualified',['qualified','call_proposed','call_accepted','call_booked','call_attended','no_show','joined','declined','business_value'].map(x=>[x,label(x)]))+field('evidence','Подтверждение результата','textarea')+field('source_message_id','ID сообщения-источника (необязательно)')+field('draft_id','ID связанного черновика (необязательно)')+field('decision_id','Пов’язане рішення (для атрибуції, не доказ причинності)','select','',[['','Не пов’язувати'],...(detail.decisions??[]).map(d=>[d.id,`${d.kind}: ${d.reason.slice(0,60)}`])])+field('value','Бизнес-ценность в USD (необязательно)','number'),p=>{for(const k of ['source_message_id','draft_id','decision_id','value'])if(!p[k])delete p[k];if(p.value!==undefined)p.value=Number(p.value);return command('outcome.record',{...convPayload(),...p});});return;}
  else if(action==='task-new'){const local=new Date(Date.now()+3600000);local.setMinutes(local.getMinutes()-local.getTimezoneOffset());modal('Новая задача',field('title','Название')+field('kind','Тип','select','research',['research','reply','follow_up','planning','review'].map(x=>[x,label(x)]))+field('conversation_id','Разговор','select',selected??'',convOptions())+field('instructions','Что нужно получить','textarea')+field('due_at','Срок по времени этого компьютера','datetime-local',local.toISOString().slice(0,16))+field('evidence','Основание / договорённость','textarea'),p=>command('task.create',{...p,conversation_id:p.conversation_id||null,due_at:new Date(p.due_at).toISOString()}));return;}
  else if(action.startsWith('task-'))await command(`task.${action.slice(5)}`,{task_id:itemId});
  else if(action==='wake'){await api('/api/scheduler/wake',{});notify('Обработка очереди запрошена.');return;}
  else if(action==='lesson-new'){modal('Сохранить урок',field('title','Краткое название')+field('conversation_id','Область','select','',convOptions())+field('text','Вывод (общие уроки — без персональных данных)','textarea')+field('applicability','Когда это применимо','textarea')+field('evidence','Какие события и правки подтверждают вывод','textarea'),p=>command('lesson.propose',{...p,conversation_id:p.conversation_id||null}));return;}
  else if(action.startsWith('lesson-'))await command('lesson.review',{lesson_id:itemId,status:action.slice(7)});
  else if(action==='cap-new'){modal('Предложить новую способность',field('name','Название')+field('purpose','Зачем нужна','textarea')+field('permissions','Нужные права через запятую')+field('acceptance','Как проверить полезность','textarea')+field('skill_content','Черновик SKILL.md (необязательно)','textarea'),p=>command('capability.propose',{...p,permissions:p.permissions.split(',').map(x=>x.trim()).filter(Boolean)}));return;}
  else if(action==='cap-accept'||action==='cap-reject')await command('capability.review',{proposal_id:itemId,status:action==='cap-accept'?'accepted_for_development':'rejected'});
  else if(action==='skill-stage'){const p=state.proposals.find(x=>x.id===itemId);modal('Подготовить версию навыка',field('name','Имя: латиница и дефисы')+field('content','Инструкции SKILL.md','textarea',p.skill_content),v=>command('skill.stage',{...v,proposal_id:itemId}));return;}
  else if(action.startsWith('skill-'))await command('skill.review',{skill_id:itemId,status:action==='skill-approve'?'approved':action==='skill-retire'?'retired':'rejected'});
  else if(action==='run-detail'){const run=await api(`/api/runs/${itemId}`);$('#modal-title').textContent=`Запуск · ${label(run.status)}`;$('#modal-body').innerHTML=`<pre class="wrap">${esc(run.result?.final_response??run.error??'Нет результата')}</pre><details><summary>Точный контекст</summary><pre class="code">${esc(JSON.stringify(run.context,null,2))}</pre></details><details><summary>Инструменты (${run.tools.length})</summary><pre class="code">${esc(JSON.stringify(run.tools,null,2))}</pre></details><details><summary>Полный результат runtime</summary><pre class="code">${esc(JSON.stringify(run.result,null,2))}</pre></details>`;$('#modal').showModal();return;}
  await refresh();notify('Сохранено.');
}
document.addEventListener('click',async event=>{const nav=event.target.closest('[data-tab]');if(nav){tab=nav.dataset.tab;try{await refresh();}catch(error){notify(error.message,true);}return;}const btn=event.target.closest('[data-do]');if(!btn)return;btn.disabled=true;try{await act(btn.dataset.do,btn.dataset.id,btn.dataset.mode);}catch(error){notify(error.message,true);}finally{btn.disabled=false;}});
document.addEventListener('change',async event=>{if(event.target.id==='review-filter'){reviewFilter=event.target.value;reviewOffset=0;try{await refresh();}catch(error){notify(error.message,true);}}});
$('#close-modal').onclick=()=>$('#modal').close();
$('#export-button').onclick=async()=>{try{const data=await api('/api/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`digital-ai-partner-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Экспорт подготовлен. В нём есть персональные данные; храните его как рабочую базу.');}catch(error){notify(error.message,true);}};
try{token=(await api('/api/session')).token;await refresh();}catch(error){notify(error.message,true);}
setInterval(()=>{if(state&&!$('#modal').open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))refresh().catch(error=>notify(error.message,true));},15000);
