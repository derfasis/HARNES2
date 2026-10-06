export function createScoutView({ api, command, esc, modal, refresh, openAudienceGoal = null }) {
  let data = null;
  let selectedId = null;
  let detail = null;
  let error = '';
  let detailError = '';

  const label = value => ({active:'Активна',paused:'Приостановлена',pending:'В очереди',running:'Выполняется',done:'Готово',completed:'Завершено',failed:'Ошибка',blocked:'Ожидает настройки',approved:'Одобрено',rejected:'Отклонено',candidate:'Кандидат',stale:'Устарело'}[value] ?? value ?? '—');
  const date = value => value ? new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
  const badge = status => `<span class="badge ${status==='active'||status==='completed'||status==='done'?'green':status==='failed'||status==='rejected'?'red':''}">${esc(label(status))}</span>`;
  const button = (title, action, id='', kind='secondary', disabled=false) => `<button class="button ${kind}" data-do="${esc(action)}" data-id="${esc(id)}"${disabled?' disabled title="Оценка отключена в конфигурации сервера"':''}>${esc(title)}</button>`;
  const panel = (title, body, action='') => `<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2>${action}</div>${body}</section>`;
  const empty = (title, body) => `<div class="empty"><strong>${esc(title)}</strong><p>${esc(body)}</p></div>`;
  const input = (name,title,value='',type='text') => `<label>${esc(title)}<input name="${esc(name)}" type="${type}" value="${esc(value)}"></label>`;
  const area = (name,title,value='') => `<label>${esc(title)}<textarea name="${esc(name)}">${esc(value)}</textarea></label>`;
  const campaign = () => (detail?.campaign ?? detail ?? data?.campaigns?.find(x=>x.id===selectedId));
  const liveMonitor = (c,x) => {
    const grant=x?.monitor_grant;
    return c?.status==='active'&&x?.joined===true&&/^[1-9][0-9]{0,18}$/.test(String(x?.channel_id??''))
      &&grant?.current===true&&grant.status==='active'
      &&(grant.campaign_id===undefined||grant.campaign_id===c.id)
      &&(grant.candidate_id===undefined||grant.candidate_id===x.id)
      &&(grant.campaign_revision===undefined||grant.campaign_revision===c.revision)
      &&typeof grant.expires_at==='string'&&Date.parse(grant.expires_at)>Date.now();
  };
  const canRecoverObservation = (c,x) => liveMonitor(c,x)
    &&x?.checkpoint?.reason==='INTEGRITY_RECONCILIATION_REQUIRED'
    &&x.observation_recovery?.eligible===true;
  const assessmentFailures = {
    SCOUT_MODEL_INCOMPLETE:'Модель не завершила оценку. Успешный результат не подтверждён.',
    SCOUT_TOOLS_FORBIDDEN:'Модель попыталась использовать инструменты. Оценка отклонена.',
    SCOUT_OUTPUT_NOT_TEXT:'Модель не вернула текст оценки.',
    SCOUT_OUTPUT_TOO_LARGE:'Ответ превысил допустимый размер. Оценка отклонена.',
    SCOUT_JSON_MARKDOWN_FENCE:'Модель обернула JSON в Markdown. Оценка отклонена.',
    SCOUT_JSON_INVALID:'Модель вернула некорректный JSON. Оценка отклонена.',
    SCOUT_SCHEMA_INVALID:'Ответ не соответствует обязательной структуре оценки.',
    SCOUT_EVIDENCE_INVALID:'Модель сослалась на сообщения вне прочитанного образца.',
    SCOUT_EVIDENCE_REQUIRED:'Модель предложила источник без подтверждающих сообщений.',
  };
  const assessmentFailure = diagnostic => typeof diagnostic?.code==='string'&&Object.hasOwn(assessmentFailures,diagnostic.code)?assessmentFailures[diagnostic.code]:'';
  const safeGrant = grant => grant ? `<div class="scout-grant"><strong>${esc(grant.purpose||'Разрешение выдано')}</strong><small>Истекает: ${esc(date(grant.expires_at))} · ${esc(label(grant.status||'active'))}${typeof grant.current==='boolean'?` · ${grant.current?'Действует сейчас':'Сейчас не действует'}`:''}</small>${grant.id?button('Отозвать разрешение','scout-revoke',grant.id,'danger'):''}</div>` : `<span class="muted">Разрешение отсутствует</span>`;
  const readGateMarkup = (gate, limits) => {
    if (!gate || typeof gate !== 'object') return '';
    const reason = gate.ready === false ? (gate.reason ?? 'Чтение сейчас заблокировано') : undefined;
    const usage = gate.requests;
    const limit = limits?.maxRequestsPerDay;
    const remaining = gate.remaining;
    const facts = [];
    if (usage !== undefined || limit !== undefined) facts.push(`Запросов чтения сегодня: ${usage === undefined ? 'неизвестно' : esc(usage)} / ${limit === undefined ? 'лимит не указан' : esc(limit)}`);
    if (remaining !== undefined) facts.push(`Остаток: ${esc(remaining)}`);
    if (gate.retry_at) { const retry = new Date(gate.retry_at); facts.push(`Повтор после (UTC): ${esc(Number.isNaN(retry.valueOf()) ? 'время неизвестно' : retry.toISOString())}`); }
    return `<div class="section-note scout-read-gate"><strong>Ограничения чтения источников</strong><p>${reason ? esc(reason) : 'Статус лимита чтения получен от сервера.'}${facts.length ? `<br>${facts.join(' · ')}` : ''}</p><small>80% дневного лимита оставлено мониторинговому чтению; это лимит чтения, не вызовы Gemini.</small></div>`;
  };

  async function load() {
    try {
      data = await api('/api/scout'); error='';
      if(selectedId && data.campaigns?.some(c=>c.id===selectedId)) await select(selectedId, false);
      else if(data.campaigns?.length) await select(data.campaigns[0].id, false);
      else { selectedId=null; detail=null; }
    } catch(e) { error=e.message; data=null; detail=null; }
  }
  async function select(id, rerender=true) {
    selectedId=id; detailError='';
    try { detail=await api(`/api/scout/campaigns/${encodeURIComponent(id)}`); }
    catch(e) { detail=null; detailError=e.message; }
    if(rerender) render();
  }
  function render() {
    if(error) return panel('Источники',empty('Не удалось загрузить кампании',error));
    const campaigns=data?.campaigns??[];
    const active=campaign();
    const disabled=!data?.enabled;
    const hero=`<div class="section-note">${disabled?'Сбор источников выключен в конфигурации сервера. Чтобы включить его, владелец должен вручную изменить серверную конфигурацию. Этот экран не включает модель, оплату провайдера, Telegram или отправку сообщений.':'Сбор управляется ограниченным разрешением владельца. Разрешение и каждый сбор запускаются отдельными явными действиями.'} ${data?.model_enabled?'Модель настроена.':'Модель выключена; доступен ручной пилот и просмотр детерминированных образцов.'}</div>`;
    const list=campaigns.length?`<div class="person-list">${campaigns.map(c=>`<button class="person-card ${c.id===selectedId?'active':''}" data-do="scout-select" data-id="${esc(c.id)}"><strong>${esc(c.title||c.topic||'Без названия')}</strong><small>${esc(c.topic||'')} · ${badge(c.status)}</small><small>Ревизия ${esc(c.revision)} · кандидатов: ${Number(c.candidate_count??c.candidates?.length??0)}</small></button>`).join('')}</div>`:empty('Кампаний пока нет','Создайте кампанию для отдельной темы поиска. Создание не выдаёт разрешение и не запускает сбор.');
    return `${hero}${readGateMarkup(data?.read_gate,data?.limits)}${panel('Кампании',list,button('+ Новая тема','scout-create','','primary'))}${active?detailView(active,disabled):''}`;
  }
  function detailView(c, disabled) {
    if(detailError) return panel('Кампания',empty('Не удалось открыть кампанию',detailError));
    const cfg=c.config??{};
    const scoutGrant=c.authority?.scout;
    const auditCurrent=scoutGrant?.current===true;
    const candidates=c.candidates??[];
    const jobs=c.jobs??[];
    const candidateMarkup=candidates.length?candidates.map(x=>{
      const s=x.sample, a=x.assessment;
      const monitoring=x.monitor_grant;
      const hasLiveMonitor=liveMonitor(c,x);
      const checkpoint=x.checkpoint??monitoring?.checkpoint;
      const checkpointMarkup=checkpoint&&checkpoint.pts!==undefined?`<small class="muted scout-checkpoint">Точка текущего разрешения чтения: PTS ${esc(checkpoint.pts)}</small>`:'';
      const recovery=x.observation_recovery;
      const recoveryMarkup=liveMonitor(c,x)&&(recovery?.epoch||recovery?.pending||recovery?.eligible===true)?`<div class="scout-audit scout-observation-recovery"><strong>Наблюдение источника</strong><p>Исторический пробел неизвестен. Старые доказательства сохранены для аудита, но устарели для текущих выводов.</p>${recovery.epoch?`<small>Поколение: ${esc(recovery.epoch.generation)} · базовый PTS: ${esc(recovery.epoch.baseline_pts)} · история неполная. ${x.checkpoint?.phase==='current'?'Успешный опрос вперёд подтвердил текущее наблюдение.':'Текущее состояние подтвердится после успешного опроса вперёд.'}</small>`:'<small>Новое поколение наблюдения ещё не создано.</small>'}${recovery.pending?`<small>Ожидает решения оператора до ${esc(date(recovery.pending.expires_at))}.</small>${button('Отменить продолжение наблюдения','scout-observation-rebaseline-cancel',x.id,'danger')}`:canRecoverObservation(c,x)?button('Продолжить с нового наблюдения','scout-observation-rebaseline',x.id,'secondary'):''}</div>`:'';
      return `<article class="scout-card"><div class="panel-head"><div><h3>${esc(x.title||x.username||x.channel_id||'Источник')}</h3><small>${esc(x.username?`@${x.username}`:'')}${x.channel_id?` · ${esc(x.channel_id)}`:''} · ${esc(x.kind||'')}</small>${checkpointMarkup}</div>${badge(a?.status||'candidate')}</div>
        <p>${esc(x.reason||'')}</p><div class="scout-audit"><strong>Исторический образец</strong>${s?`<small>Завершён: ${esc(date(s.finished_at))} · покрытие: ${esc(s.coverage??'неизвестно')}</small><p>Сообщений: ${esc(s.metrics?.messages??'неизвестно')} · авторов с ID: ${esc(s.metrics?.authors??'неизвестно')} · активных дней: ${esc(s.metrics?.active_days??'неизвестно')} · ответов: ${esc(s.metrics?.replies??'неизвестно')}</p><p>Точных повторов: ${esc(s.metrics?.exact_repeats??'неизвестно')} · неподтверждённых: ${esc(s.metrics?.unsupported??'неизвестно')}</p>${(s.groups??[]).map(g=>`<div class="scout-evidence"><strong>${esc(g.id||'Группа')}</strong><small>Ссылки на evidence: ${esc((g.evidence_refs??[]).join(', ')||'нет')}</small><p>${esc(g.preview||'')}</p><small>${(g.messages??[]).map(m=>typeof m.link==='string'&&/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/[1-9][0-9]*$/.test(m.link)?`<a href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">Сообщение ${esc(m.message_id)}</a>`:`Сообщение ${esc(m.message_id)}`).join(' · ')}</small></div>`).join('')}`:empty('Исторических данных нет','Отсутствие истории не означает пустой канал.')}</div>
        <p class="muted tiny">Точные повторы не оценивают спам. ID авторов не подтверждают, что это разные люди.</p>
        <div class="scout-audit"><strong>Текущий мониторинг</strong>${safeGrant(monitoring)}</div>
        ${a?`<div class="scout-audit"><strong>Оценка · ${esc(a.id||'')}</strong><p>${esc(a.reason||'')}</p><p>Возможности: ${esc((a.opportunities??[]).map(o=>`${o.description} [${(o.evidence_refs??[]).join(', ')}]`).join('; ')||'не указаны')}</p><p>Неопределённость: ${esc((a.uncertainty??[]).join('; ')||'не указана')}</p>${a.status==='pending'||a.status==='proposed'?button('Одобрить оценку','scout-review-approve',a.id)+button('Отклонить оценку','scout-review-reject',a.id):''}</div>`:''}
        ${recoveryMarkup}<div class="actions">${button('Проверить источник','scout-audit',x.id)}${s?button('Запросить оценку','scout-assess',x.id,'secondary',data?.model_enabled!==true):''}${s&&data?.model_enabled!==true?'<small class="muted">Оценка отключена в конфигурации; кнопка не ставит запрос в очередь.</small>':''}${s?button('Выдать разрешение мониторинга','scout-admit',x.id):''}${hasLiveMonitor&&openAudienceGoal?button('Добавить цель Audience','scout-audience-handoff',x.id,'secondary'):''}</div></article>`;
    }).join(''):empty('Кандидатов пока нет','Добавьте известный источник вручную или запустите поиск после отдельной выдачи разрешения.');
    const jobsMarkup=jobs.length?jobs.map(j=>`<div class="feature"><div>${esc(j.kind)}<small>${esc(j.reason||'')} · Следующий запуск: ${esc(date(j.next_at))}</small>${assessmentFailure(j.diagnostic)?`<small>${esc(assessmentFailure(j.diagnostic))}</small>`:''}</div>${badge(j.status)}</div>`).join(''):empty('Очередь пуста','Новые задания появятся после явного запуска поиска или проверки.');
    const unknown=(c.unknown??[]).length?`<ul>${c.unknown.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:empty('Неизвестных состояний нет','');
    const queries=(cfg.queries??[]).join('\n');
    return `${panel(`Тема: ${c.title||c.topic||'Кампания'}`,`<div class="feature"><div>Состояние<small>Ревизия ${esc(c.revision)}</small></div>${badge(c.status)}</div><p>Тема: ${esc(cfg.topic??c.topic??'')}<br>Аудитория: ${esc(cfg.audience??'')}<br>Язык: ${esc(cfg.language??'')}<br>География: ${esc(cfg.geography??'')}</p><details><summary>Поисковые запросы и основание</summary><pre class="workspace-pre">${esc(queries||'Запросов нет')}</pre></details><div class="scout-audit"><strong>Разрешение на ограниченный поиск и чтение истории</strong>${safeGrant(scoutGrant)}</div><div class="actions">${!disabled&&!auditCurrent?button('Выдать разрешение поиска','scout-authorize',c.id,'primary'):''}${!disabled&&auditCurrent?button('Запустить поиск','scout-search',c.id,'primary'):''}${button('Изменить тему','scout-revise',c.id)}${c.status==='active'?button('Приостановить кампанию','scout-pause',c.id,'danger'):''}</div>`,button('Открыть Partner Workspace','scout-workspace'))}${panel('Кандидаты и доказательства',candidateMarkup,button('Добавить источник вручную','scout-seed',c.id))}${panel('Задания и повторы',jobsMarkup)}${panel('Неизвестное / требует проверки',unknown)}`;
  }
  function createCampaign() {
    modal('Новая кампания источников',input('title','Название кампании')+input('topic','Тема')+area('audience','Целевая аудитория')+input('language','Язык','ru')+input('geography','География')+area('queries','Поисковые запросы, по одному в строке'),p=>{
      const queries=p.queries.split('\n').map(x=>x.trim()).filter(Boolean); if(!p.title.trim()||!p.topic.trim())throw new Error('Укажите название и тему.');
      return command('scout.create',{title:p.title.trim(),topic:p.topic.trim(),audience:p.audience,language:p.language,geography:p.geography,queries});
    });
  }
  async function act(action,id) {
    const c=campaign();
    if(action==='scout-select') return select(id);
    if(action==='scout-create') return createCampaign();
    if(action==='scout-workspace') { document.querySelector('[data-tab="workspace"]')?.click(); return; }
    if(!c) throw new Error('Сначала выберите кампанию.');
    const base={campaign_id:c.id,revision:c.revision};
    if(action==='scout-audience-handoff') {
      if(typeof openAudienceGoal!=='function')throw new Error('Переход к Audience недоступен.');
      // Re-read the campaign and grant at the moment of handoff. A stale Scout
      // card must not open a form as if its source lease were still active.
      const current=await api(`/api/scout/campaigns/${encodeURIComponent(c.id)}`);
      if(current?.id!==c.id||current.status!=='active')throw new Error('Мониторинг источника больше не доступен.');
      const candidate=(current.candidates??[]).find(row=>row.id===id);
      const grant=candidate?.monitor_grant;
      if(candidate?.joined!==true||!/^[1-9][0-9]{0,18}$/.test(String(candidate?.channel_id??''))
        ||grant?.current!==true||grant.status!=='active'||grant.campaign_id!==current.id
        ||grant.candidate_id!==candidate.id||grant.campaign_revision!==current.revision
        ||typeof grant.expires_at!=='string'||Date.parse(grant.expires_at)<=Date.now())
        throw new Error('Разрешение мониторинга истекло или отозвано. Обновите источник перед передачей в Audience.');
      await openAudienceGoal({source_ref:`telegram:channel:${candidate.channel_id}`,grant_id:grant.id,
        expires_at:grant.expires_at,campaign_id:current.id,campaign_revision:current.revision,candidate_id:candidate.id});
      return;
    }
    if(action==='scout-observation-rebaseline'||action==='scout-observation-rebaseline-cancel') {
      const current=await api(`/api/scout/campaigns/${encodeURIComponent(c.id)}`);
      if(current?.id!==c.id||current.status!=='active'||current.revision!==c.revision)
        throw new Error('Кампания изменилась. Обновите карточку источника.');
      const candidate=(current.candidates??[]).find(row=>row.id===id);
      if(!candidate||candidate.id!==id||!liveMonitor(current,candidate))
        throw new Error('Действующее разрешение мониторинга больше недоступно. Обновите источник.');
      const recovery=candidate.observation_recovery;
      if(action==='scout-observation-rebaseline-cancel') {
        const authorizationId=recovery?.pending?.id;
        if(!authorizationId)throw new Error('Ожидающее разрешение уже отсутствует. Обновите источник.');
        modal('Отменить продолжение наблюдения',`<p>Отменить ожидающее разрешение для этого источника? Это действие не меняет checkpoint, состояние мониторинга или выводы.</p>${area('reason','Причина отмены')}`,p=>{
          if(!p.reason?.trim())throw new Error('Укажите причину отмены.');
          return command('source.rebaseline_cancel',{authorization_id:authorizationId,reason:p.reason.trim()});
        });
        return;
      }
      if(!canRecoverObservation(current,candidate)||recovery?.pending)
        throw new Error('Продолжение наблюдения сейчас недоступно. Обновите источник.');
      const displayed=(c.candidates??[]).find(row=>row.id===id);
      if(!candidate.checkpoint_fingerprint||candidate.checkpoint_fingerprint!==displayed?.checkpoint_fingerprint)
        throw new Error('Checkpoint изменился после обновления. Обновите карточку источника.');
      const fingerprint=candidate.checkpoint_fingerprint;
      const sourceId=candidate.source_ref;
      if(typeof sourceId!=='string'||!sourceId)throw new Error('Не удалось подтвердить источник. Обновите карточку.');
      const defaultExpiry=new Date(Date.now()+30*60*1000);
      const localExpiry=new Date(defaultExpiry.getTime()-defaultExpiry.getTimezoneOffset()*60000).toISOString().slice(0,16);
      modal('Продолжить с нового наблюдения',`<p><strong>Исторический пробел неизвестен.</strong> Нельзя подтвердить, какие сообщения были пропущены, и не следует трактовать канал как пустой.</p><p>Старые факты и evidence сохраняются для аудита, но становятся устаревшими и не подтверждают текущее состояние. После разрешения worker начнёт новое поколение с пустой историей; состояние станет текущим только после успешного следующего опроса вперёд.</p><p>Это не вступает в канал и не разрешает поиск, отправку сообщений, контакт с участниками или вызов модели.</p><p>Checkpoint: <code>${esc(fingerprint)}</code></p><p>Срок предварительно установлен на 30 минут; его можно сократить или продлить максимум до одного часа.</p><label class="scout-source"><input type="checkbox" name="acknowledge_gap" value="yes">Я понимаю, что пробел в наблюдении неизвестен, и разрешаю продолжить с нового наблюдения</label>${input('expires_at','Разрешение истекает (не более 1 часа)',localExpiry,'datetime-local')}${area('reason','Причина решения оператора')}`,p=>{
        if(p.acknowledge_gap!=='yes')throw new Error('Подтвердите понимание неизвестного исторического пробела.');
        const expiry=new Date(p.expires_at), now=Date.now();
        if(!p.expires_at||Number.isNaN(expiry.valueOf())||expiry.valueOf()<=now||expiry.valueOf()>now+60*60*1000)
          throw new Error('Укажите будущий срок разрешения не более чем на 1 час.');
        if(!p.reason?.trim())throw new Error('Укажите причину решения оператора.');
        return command('source.rebaseline',{source_id:sourceId,checkpoint_fingerprint:fingerprint,acknowledge_gap:true,expires_at:expiry.toISOString(),reason:p.reason.trim()});
      });
      return;
    }
    if(action==='scout-revise') {
      const cfg=c.config??{};
      modal('Изменить тему кампании',`<p class="review-error">Изменение создаёт новую ревизию. Старые разрешения и результаты могут стать устаревшими.</p>${input('topic','Тема',cfg.topic??c.topic)}${area('audience','Целевая аудитория',cfg.audience)}${input('language','Язык',cfg.language)}${input('geography','География',cfg.geography)}${area('queries','Поисковые запросы, по одному в строке',(cfg.queries??[]).join('\n'))}`,p=>command('scout.revise',{...base,topic:p.topic,audience:p.audience,language:p.language,geography:p.geography,queries:p.queries.split('\n').map(x=>x.trim()).filter(Boolean)})); return;
    }
    if(action==='scout-authorize') { modal('Ограниченное разрешение на поиск',`<p>Разрешение позволяет только ограниченный поиск и чтение истории для этой ревизии. Поиск запускается отдельно.</p>${input('expires_at','Истекает','', 'datetime-local')}${area('purpose','Цель разрешения')}`,p=>{const expiry=new Date(p.expires_at);if(!p.expires_at||Number.isNaN(expiry.valueOf())||expiry<=new Date()||!p.purpose.trim())throw new Error('Укажите будущий срок и цель.');return command('scout.authorize',{...base,expires_at:expiry.toISOString(),purpose:p.purpose.trim()});}); return; }
    if(action==='scout-search') { modal('Запустить поиск',`<p>Будет создано задание для указанной ревизии кампании. Оно использует текущее ограниченное разрешение. Никакие сообщения не отправляются.</p><p>Тема: ${esc(c.config?.topic??c.topic??'')} · ревизия ${esc(c.revision)}</p>`,()=>command('scout.search',base)); return; }
    if(action==='scout-seed') { modal('Добавить известный источник',input('reference','Ссылка t.me/@username или числовой channel ID'),p=>{if(!p.reference.trim())throw new Error('Укажите источник.');return command('scout.seed',{...base,reference:p.reference.trim()});}); return; }
    if(action==='scout-audit') { await command('scout.audit',{...base,candidate_id:id}); await refresh(); return; }
    if(action==='scout-assess') { if(data?.model_enabled!==true)throw new Error('Оценка отключена в конфигурации сервера; запрос не отправлен.');const x=(c.candidates??[]).find(x=>x.id===id);if(!x?.sample?.id)throw new Error('Нет образца для оценки.');modal('Запросить оценку образца',`<p>Запрос оценки образца ${esc(x.sample.id)} будет поставлен в очередь и может вызвать модель при обработке. Вызов модели не выполняется этим экраном.</p>`,()=>command('scout.request_assessment',{...base,candidate_id:id,sample_id:x.sample.id})); return; }
    if(action==='scout-review-approve'||action==='scout-review-reject') { const decision=action.endsWith('approve')?'approve':'reject';modal(`${decision==='approve'?'Одобрить':'Отклонить'} оценку`,area('note','Основание решения'),p=>{if(!p.note.trim())throw new Error('Укажите основание решения.');return command('scout.review',{...base,assessment_id:id,decision,note:p.note.trim()});});return; }
    if(action==='scout-admit') {
      const x=(c.candidates??[]).find(x=>x.id===id);
      if(!x?.sample?.id)throw new Error('Нет исторического образца.');
      const checkpoint=x.checkpoint??x.monitor_grant?.checkpoint;
      const hasCheckpoint=checkpoint&&checkpoint.pts!==undefined&&checkpoint.pts!==null;
      const approved=x.assessment?.status==='approved'&&x.assessment?.current!==false&&x.assessment?.stale!==true;
      const manual=approved?'':`<p>Нет действующей одобренной оценки. Продолжайте только после отдельной ручной проверки образца и укажите основание.</p><label class="scout-source"><input type="checkbox" name="manual_review" value="yes">Я вручную проверил именно этот исторический образец и хочу допустить мониторинг</label>${area('manual_rationale','Основание ручного решения')}`;
      const catchup=hasCheckpoint?`<div class="scout-catchup"><strong>Историческое чтение закрыто по умолчанию</strong><small>Текущий checkpoint: PTS ${esc(checkpoint.pts)}</small><label class="scout-source"><input type="checkbox" name="allow_catchup" value="yes">Я разрешаю прочитать накопившиеся сообщения с PTS ${esc(checkpoint.pts)}, включая период без прошлого разрешения</label></div>`:'';
      modal('Ограниченное разрешение мониторинга',`<p>Разрешение позволяет читать ограниченные обновления источника в существующем контуре мониторинга. Оно не разрешает контактировать с участниками или отправлять сообщения.</p><p>Образец ${esc(x.sample.id)} · ${approved?'привязана действующая одобренная оценка':'оценка не одобрена или устарела'}</p>${hasCheckpoint?`<p class="muted">Повторный допуск может остаться заблокированным проверкой целостности. Сброс или новый cutover здесь не предусмотрен.</p>`:''}${manual}${catchup}${input('expires_at','Истекает','', 'datetime-local')}${area('purpose','Цель мониторинга')}`,p=>{
        const expiry=new Date(p.expires_at);
        if(!p.expires_at||Number.isNaN(expiry.valueOf())||expiry<=new Date()||!p.purpose.trim())throw new Error('Укажите будущий срок и цель.');
        if(!approved&&(p.manual_review!=='yes'||!p.manual_rationale?.trim()))throw new Error('Подтвердите ручную проверку и укажите её основание.');
        if(hasCheckpoint&&p.allow_catchup!=='yes')throw new Error('Для исторического чтения нужно отдельно подтвердить разрешение.');
        const rationale=p.manual_rationale?.trim()??'';
        const purpose=approved?p.purpose.trim():`${p.purpose.trim()}\nОснование ручной проверки: ${rationale}`;
        if(purpose.length>1000)throw new Error('Сократите цель и основание ручной проверки до 1000 символов.');
        return command('scout.admit',{...base,candidate_id:id,sample_id:x.sample.id,assessment_id:approved?x.assessment.id:null,expires_at:expiry.toISOString(),purpose,max_lag_seconds:300,catchup_from_pts:hasCheckpoint?checkpoint.pts:null,expected_checkpoint_fingerprint:hasCheckpoint?x.checkpoint_fingerprint:null,accept_historical_gap:hasCheckpoint});
      });return;
    }
    if(action==='scout-revoke') { await command('scout.revoke',{...base,grant_id:id}); await refresh(); return; }
    if(action==='scout-pause') { modal('Приостановить кампанию',`<p>Остановить дальнейшие задания для ревизии ${esc(c.revision)}?</p>`,()=>command('scout.pause',base));return; }
    throw new Error(`Неизвестное действие источников: ${action}`);
  }
  return {load,select,render,act};
}
