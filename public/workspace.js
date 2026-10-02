export function createWorkspaceView({ api, command, esc, modal, refresh, wake = async () => {} }) {
  let workspace = null;
  let currentCase = null;
  let caseContinuity = null;
  let selectedGoal = null, goalTurn = null;
  let sourceSlots = [];
  let error = '';

  const input = (name,title,type='text',value='') => `<label>${esc(title)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"></label>`;
  const area = (name,title,value='') => `<label>${esc(title)}<textarea name="${esc(name)}">${esc(value)}</textarea></label>`;
  const button = (title, action, id = '', kind = 'secondary') => `<button class="button ${kind}" data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`;
  const textSlot = (val, tag = 'pre', className = 'workspace-pre') => {
    const index = sourceSlots.push(String(val ?? '')) - 1;
    return `<${tag} class="${className}" data-workspace-text-slot="${index}"></${tag}>`;
  };
  const value = (title, val) => `<div class="workspace-value"><strong>${esc(title)}</strong>${textSlot(val && typeof val==='object' ? JSON.stringify(val,null,2) : val==null||val==='' ? 'Не указано' : val)}</div>`;
  const status = val => `<span class="badge">${esc(val || 'неизвестно')}</span>`;
  const statusText = value => ({open:'Открыт',OPEN:'Открыта',proposed:'На рассмотрении',approved:'Одобрено владельцем',rejected:'Отклонено владельцем',superseded:'Заменено новой версией',stale:'Устарело',active:'Действует',revoked:'Отозвано',expired:'Истекло',completed:'Завершено',failed:'Ошибка',unknown:'Неизвестно',authorized:'Разрешено',verifying:'Проверяется',closed:'Закрыт',CLOSED:'Закрыта',captured:'Снимок готов',accepted:'Принято',pending:'Ожидает',evidence_observed:'Есть новые наблюдения',consumed:'Использовано',not_executed:'Не исполнено',interrupted_unknown:'Исполнение неизвестно',unchecked:'Ещё не проверено',returned:'Квитанция получена',local_material_published:'Материал сохранён локально',local_brief_published:'Сводка сохранена локально',human_task_created:'Задача человеку создана',present:'Найдено',absent:'Не найдено',running:'Готовится',interrupted:'Прервано',wait_material:'Ожидать запрошенный материал',plan_requested:'Ожидает плана',review_material:'Рассмотреть материал',prepare_material:'Подготовить материал',review_new_evidence:'Обновить основание',prepare_local_action:'Подготовить локальное действие',owner_grant_required:'Нужно разрешение владельца',execute_or_verify:'Исполнить или проверить',observe_and_continue:'Продолжить наблюдение',define_expectation:'Задать ожидание',owner_recovery_required:'Нужна сверка владельца','brief.publish_local.v1':'Локальная сводка','material.export_local.v1':'Локальный экспорт','owner_handoff.create.v1':'Передача владельцу'}[value] ?? value ?? 'Неизвестно');
  const dateText = value => value ? new Date(value).toLocaleString('ru-RU') : 'Не указан';
  const sourceId = source => typeof source === 'string' ? source : source?.id;
  const sourceTitle = source => typeof source === 'string' ? source : (source?.title ?? source?.id);

  async function load() {
    try {
      workspace = await api('/api/workspace');
      if (currentCase) {
        currentCase = await api(`/api/workspace/cases/${encodeURIComponent(currentCase.id)}`);
        caseContinuity = await api(`/api/continuity/threads/${encodeURIComponent(currentCase.thread_id)}`);
      }
      if (selectedGoal) {
        const goal = (workspace.goals ?? []).find(g => g.id === selectedGoal);
        goalTurn = goal?.latest_turn?.id ? await api(`/api/continuity/turns/${encodeURIComponent(goal.latest_turn.id)}`) : null;
      }
      error = '';
    } catch (e) { error = e.message || 'Рабочее пространство недоступно'; }
    return workspace;
  }

  const isEnabled = () => workspace?.enabled === true && workspace?.control?.enabled === true;
  function ensureEnabled() {
    if (!isEnabled()) throw new Error('Рабочее пространство или его control plane выключены');
  }

  function renderCaseEvidence(thread) {
    if (!thread) return '';
    const sourceEvidence=thread.evidence??[], memoryEvidence=thread.memory_evidence??[];
    return `<section class="workspace-evidence"><h3>Основания цели</h3>
      ${thread.memory?.current?`<div class="workspace-evidence-item"><strong>Рассмотренное понимание владельца · интерпретация, не подтверждённый факт</strong>${textSlot(thread.memory.content?.summary?.text,'p','')}</div>`:'<p>Актуального рассмотренного понимания цели нет.</p>'}
      <strong>Текущие утверждения источников</strong>${sourceEvidence.length?sourceEvidence.map(e=>`<article class="workspace-observation"><span>${esc(e.source_ref)}</span>${textSlot(e.text,'p','')}<details><summary>Ссылка на событие</summary><code>${esc(e.source_event_id)}</code></details></article>`).join(''):'<p>Текущие утверждения источников не доступны.</p>'}
      ${memoryEvidence.length?`<details><summary>Источники поддерживают рассмотренное понимание (${memoryEvidence.length})</summary>${memoryEvidence.map(e=>`<article class="workspace-observation"><span>${esc(e.source_ref)}</span>${textSlot(e.text,'p','')}<small>Событие ${esc(e.source_event_id)}</small></article>`).join('')}</details>`:''}
    </section>`;
  }

  function renderCase(c) {
    if (!c) return '';
    const materials = c.materials ?? [];
    const hasReviewedMaterial = materials.some(m => m.status === 'approved');
    const canGrant = c.action?.status === 'proposed' && c.action?.can_grant === true;
    const canExpect = c.next_move === 'define_expectation';
    const canRefresh = c.current === false && !!c.current_basis_fingerprint;
    const materialRows = materials.map(m => `<article class="workspace-material"><div class="panel-head"><strong>${esc(m.title)}</strong>${status(statusText(m.status))}</div><p>Версия ${esc(m.version??m.revision)} · ${esc(statusText(m.status))}</p>${textSlot(m.content)}<details><summary>Точная версия и основание</summary><p>ID: <code>${esc(m.id)}</code> · SHA-256: <code>${esc(m.sha256)}</code></p><p>Связано событий: ${esc(m.evidence_event_ids?.length??0)}</p><small>${(m.evidence_event_ids??[]).map(ref=>esc(ref)).join(', ')}</small></details><div class="actions">${m.status==='proposed'?button('Рассмотреть эту версию','workspace-review-open',m.id,'primary'):''}</div></article>`).join('');
    const action = c.action;
    const actionSummary = action ? `<div class="workspace-summary"><h3>Действие по материалу</h3><p>${esc(action.proposal?.title??action.title??'Локальное действие')} · ${esc(statusText(action.proposal?.capability_id??'Способность не указана'))} · ${esc(statusText(action.status))}</p>
      <p>Разрешение владельца: ${(action.grants??[]).length?(action.grants??[]).map(g=>`v${esc(g.version)} · ${esc(statusText(g.status))} · до ${esc(dateText(g.expires_at))}${g.reason?` · ${esc(g.reason)}`:''}`).join('; '):'ещё не выдано'}</p>
      ${(action.attempts??[]).length?(action.attempts??[]).map(a=>`<div class="workspace-observation"><strong>Квитанция исполнения: ${esc(statusText(a.receipt?.status??a.status))}</strong><p>Независимая проверка: ${esc(statusText(a.verification?.state??a.verification_state??'не выполнена'))}</p>${a.receipt?.outcome?textSlot(statusText(a.receipt.outcome),'p',''):''}</div>`).join(''):'<p>Исполнение не зафиксировано.</p>'}
      <details><summary>Точные ссылки действия</summary><p>ID: <code>${esc(action.id)}</code> · hash: <code>${esc(action.proposal_hash)}</code> · основание: <code>${esc(action.basis_fingerprint)}</code></p></details></div>` : '<p class="muted">Действие ещё не подготовлено.</p>';
    const expectation = c.expectation;
    const expectationSummary = expectation ? `<div class="workspace-summary"><h3>Наблюдение за результатом</h3>${c.expectation.action_id!==c.action?.id?'<p>Это ожидание относится к предыдущему локальному действию.</p>':''}${textSlot(expectation.question,'p','')}<p>Состояние: ${esc(statusText(expectation.status))} · срок: ${esc(dateText(expectation.deadline))}</p><p class="muted">Покрытие ограничено записанными наблюдениями; отсутствие записи не подтверждает отсутствие события.</p>${(expectation.observations??[]).map(o=>`<div class="workspace-observation">${textSlot(o.text??JSON.stringify(o),'p','')}<small>${esc(o.source_ref??'')} · ${esc(o.source_event_id??'')}</small></div>`).join('')}</div>` : '<p class="muted">Независимое наблюдение за результатом ещё не задано.</p>';
    return `<section class="panel workspace-case">
      <div class="panel-head"><div><span class="eyebrow">РАБОЧИЙ СЛУЧАЙ</span><h2>${esc(c.title)}</h2></div>${status(statusText(c.status))}</div>
      <p class="muted">Версия случая ${esc(c.revision)} · ${c.current?'Основание актуально':'Основание требует обновления'} · следующий шаг: ${esc(statusText(c.next_move))} · оснований: ${esc(c.evidence_event_ids?.length??0)}</p>
      ${c.reason?value('Сводка основания',({'WORK_STALE_BASIS':'Источник или рассмотренное понимание изменились; требуется проверить новое основание.','WORK_MATERIAL_SUPERSEDED':'Материал заменён новой версией.','WORK_CLOSED':'Случай закрыт.'})[c.reason]??c.reason):''}
      <details><summary>Точные ссылки на основание</summary><p>Тред: <code>${esc(c.thread_id)}</code> · fingerprint: <code>${esc(c.basis_fingerprint)}</code></p><p>События: ${(c.evidence_event_ids??[]).map(ref=>`<code>${esc(ref)}</code>`).join(', ')||'не указаны'}</p></details>
      ${renderCaseEvidence(caseContinuity)}
      ${c.request?`<p>Запрос материала: ${esc(statusText(c.request.status))}. ${['failed','stale','interrupted'].includes(c.request.status)?'Повтор не запускается автоматически; подготовьте материал вручную или рассмотрите новое основание.':''}</p>`:''}
      <h3>Материал владельца</h3>${c.material?`<p>${esc(c.material.title)} · версия ${esc(c.material.version??c.material.revision)} · ${esc(statusText(c.material.status))} · SHA-256 <code>${esc(c.material.sha256)}</code></p>${textSlot(c.material.content)}`:'<p class="muted">Материал пока не подготовлен.</p>'}
      ${actionSummary}${expectationSummary}
      <div class="workspace-evidence"><h3>Разделение свидетельств</h3><p><strong>Утверждение источника:</strong> записанный текст с атрибуцией; сам по себе он не устанавливает факт. <strong>Гипотеза модели:</strong> интерпретация, которую рассматривает владелец.</p><p><strong>Материал:</strong> отдельная версия с точным SHA-256. <strong>Рассмотрение материала:</strong> явное решение владельца.</p><p><strong>Разрешение владельца:</strong> отдельная выдача прав с ограниченным сроком. <strong>Квитанция исполнения:</strong> свидетельство действия. <strong>Независимая проверка:</strong> подтверждение результата. Отчёт владельца не означает внешнюю публикацию.</p></div>
      <div class="actions">${button('К списку','workspace-case-list')}${c.current&&c.material?.status==='proposed'?button('Рассмотреть материал','workspace-review-open',c.material.id,'primary'):''}${c.current?button('Добавить материал владельца','workspace-material-new',c.id,'primary'):''}${workspace?.model_enabled?button('Запросить материал с помощью модели','workspace-request-material',c.id):'<span class="muted tiny">Модельный запрос выключен</span>'}${canRefresh?button('Обновить основание','workspace-refresh',c.id):''}${canExpect?button('Ожидать результат','workspace-expect',c.id):''}${hasReviewedMaterial?button('Подготовить локальный экспорт','workspace-prepare-export',c.id):''}${hasReviewedMaterial?button('Подготовить передачу владельцу','workspace-prepare-handoff',c.id):''}${canGrant?button('Выдать отдельное разрешение','workspace-grant',c.id,'primary'):''}${button('Закрыть случай','workspace-close',c.id,'danger')}</div>
      <details><summary>История версий материалов (${materials.length})</summary>${materials.length?materialRows:'<p class="muted">Материалы пока не добавлены.</p>'}</details>
      ${c.observations?.length?`<h3>Наблюдения и подтверждения</h3>${c.observations.map(x=>`<article class="workspace-observation"><strong>${esc(({source_fact:'Утверждение источника (не подтверждённый факт)',model_hypothesis:'Гипотеза модели',material_review:'Рассмотрение материала',owner_grant:'Разрешение владельца',execution_receipt:'Квитанция исполнения',independent_verification:'Независимая проверка',owner_report:'Отчёт владельца',external_publication:'Внешняя публикация'})[x.kind]??x.kind??'Наблюдение')}</strong>${textSlot(x.text??JSON.stringify(x),'p','')} ${x.created_at?`<small>${esc(x.created_at)}</small>`:''}</article>`).join('')}`:''}
    </section>`;
  }

  function renderGoalTurn() {
    if (!goalTurn) return '';
    const output = goalTurn.output;
    const evidence = [...(goalTurn.packet?.evidence??[]),...(goalTurn.packet?.memory_evidence??[])];
    const canReview = goalTurn.reviewable && ['proposed','stale'].includes(goalTurn.status);
    return panel('Предложенная интерпретация',`${status(goalTurn.status)}<p>Точный turn ${esc(goalTurn.id)} · основание ${esc(goalTurn.basis_fingerprint)}</p>
      ${output?`<strong>Интерпретация</strong>${textSlot(output.summary?.text,'p','')}<strong>Неизвестно</strong>${textSlot((output.unknowns??[]).join(' · '),'p','')}<details><summary>Основания и полный вывод</summary>${evidence.map(e=>`<article class="workspace-observation"><strong>${esc(e.source_ref)} · ${esc(e.source_event_id)}</strong>${textSlot(e.text,'p','')}</article>`).join('')}${textSlot(JSON.stringify(output,null,2))}</details>`:'<p>Подготовьте собственную интерпретацию по текущему пакету оснований.</p>'}
      <div class="actions">${goalTurn.status==='captured'?button('Подготовить интерпретацию вручную','workspace-goal-propose',goalTurn.id,'primary'):''}${canReview?button('Принять понимание','workspace-goal-review-accept',goalTurn.id,'primary'):''}${canReview?button('Отклонить понимание','workspace-goal-review-reject',goalTurn.id):''}</div>`);
  }

  function render() {
    sourceSlots = [];
    if (error) return `<div class="section-note">${esc(error)}. Обновите страницу или обратитесь к владельцу настройки.</div>`;
    if (!workspace) return '<div class="empty">Загрузка Partner Workspace…</div>';
    if (!isEnabled()) return `<div class="section-note">Partner Workspace или control plane выключен. ${esc(workspace.disabled_reason ?? 'Состояние управления и выполнения остаётся выключенным; действия не отправлены.')}</div>`;
    if (currentCase) return `${renderCase(currentCase)}<div class="actions">${button('Разбудить только локальную очередь','workspace-wake-local')}</div>`;
    const g = workspace.goals ?? [], cases = workspace.cases ?? [], refs = workspace.source_refs ?? [];
    const control = workspace.control ?? {};
    return `<section class="hero workspace-hero"><span class="eyebrow">PARTNER WORKSPACE</span><h2>Цели, случаи и проверяемые материалы</h2><p>Утверждения источника, интерпретации, материалы, разрешения и результаты показаны раздельно.</p><div class="actions">${button('Новая цель','workspace-goal-new','','primary')}</div></section>
      <section class="workspace-controls"><strong>Состояние управления</strong><span>Control plane: ${control.enabled?'включён':'выключен'}</span><span>Активные запуски: ${(control.active??[]).length}</span><span>Модельные материалы: ${workspace.model_enabled?'включены владельцем':'выключены'}</span><span>Плоскости: ${esc((control.planes??[]).map(p=>({public:'наблюдение',private:'диалоги',work:'материалы'})[typeof p==='string'?p:p.id]??(typeof p==='string'?p:p.id)).join(', ') || 'не указаны')}</span></section>
      ${panel('Разрешённые источники',refs.length?refs.map(s=>`<article class="workspace-source-card"><div class="panel-head"><strong>${esc(sourceTitle(s))}</strong><small>${esc(typeof s==='string'?'source':s.kind??'source')} · ${esc(sourceId(s))}</small></div>${typeof s==='object'?`${textSlot(s.content??s.text??s.summary??'Содержимое источника недоступно')}${s.captured_at?`<small>Зафиксирован: ${esc(s.captured_at)}</small>`:''}`:''}</article>`).join(''):'<p class="muted">Источники не добавлены владельцем.</p>')}
      <details class="panel"><summary>Доступные способности и условия</summary><p>Наличие способности не выдаёт права на её исполнение.</p>${(control.capabilities??[]).map(x=>{
        const labels={
          'source.read.v1':['Наблюдать публичные источники','Только чтение источников из списка владельца'],
          'conversation.reason.v1':['Готовить ответы в существующих диалогах','С сохранением разрешений и отдельным рассмотрением черновика'],
          'material.prepare.v1':['Готовить материал','По явному запросу и текущему рассмотренному основанию'],
          'brief.publish_local.v1':['Сохранить сводку локально','Точное отдельное разрешение владельца'],
          'owner_handoff.create.v1':['Поставить задачу человеку','Точное отдельное разрешение владельца'],
          'material.export_local.v1':['Сохранить рассмотренный материал локально','Точная версия и отдельное разрешение владельца']
        }[x.id]??[x.name??x.id,'Условия не установлены'];
        return `<div class="feature"><div>${esc(labels[0])}<small>${esc(labels[1])}</small></div></div>`;
      }).join('')}</details>
      ${panel('Цели',g.length?g.map(x=>`<article class="workspace-card"><div class="panel-head"><h3>${esc(x.title)}</h3>${status(statusText(x.status))}</div>${value('Цель',x.objective)}${value('Критерий успеха',x.success_condition)}<p>Версия ${esc(x.revision)} · ${x.ready?'свидетельства текущие':'нуждается во внимании'}</p>${value('Рассмотренное понимание',x.memory?.current?x.memory.content?.summary?.text:'Нет актуального рассмотренного понимания')}${value('Требует внимания',x.attention?.reasons?.join(', ')||'Нет')}<div class="actions">${x.latest_turn?.id&&['proposed','stale'].includes(x.latest_turn.status)?button('Рассмотреть предложенную интерпретацию','workspace-goal-review',x.id):''}${x.ready&&x.attention?.pending&&!['captured','running','proposed'].includes(x.latest_turn?.status)?button('Зафиксировать текущее основание','workspace-goal-capture',x.id):''}${x.ready&&x.memory?.current&&x.memory?.turn_id?button('Открыть как рабочий случай','workspace-goal-open-case',x.id,'primary'):''}</div></article>`).join(''):'<p class="muted">Целей пока нет. Создайте цель с явным описанием и выбранным источником.</p>')}
      ${renderGoalTurn()}
      ${panel('Рабочие случаи',cases.length?cases.map(c=>`<article class="workspace-card"><div class="panel-head"><h3>${esc(c.title)}</h3>${status(statusText(c.status))}</div><p>${c.current?'Основание актуально':'Основание требует обновления'} · ${esc(statusText(c.next_move))}</p><small>Версия ${esc(c.revision)}</small><div class="actions">${button('Открыть','workspace-case-open',c.id,'primary')}</div></article>`).join(''):'<p class="muted">Случаев пока нет. Создайте цель.</p>')}
      ${renderCase(currentCase)}
      <div class="actions">${button('Разбудить только локальную очередь','workspace-wake-local')}</div>`;
  }

  async function act(action,id='') {
    ensureEnabled();
    if (action === 'workspace-case-list') { currentCase=null; caseContinuity=null; return; }
    if (action === 'workspace-case-open') { currentCase = await api(`/api/workspace/cases/${encodeURIComponent(id)}`); caseContinuity=await api(`/api/continuity/threads/${encodeURIComponent(currentCase.thread_id)}`); error=''; return; }
    if (action === 'workspace-wake-local') { await wake(); await load(); return; }
    if (action === 'workspace-goal-review') {
      selectedGoal=id; const goal=(workspace.goals??[]).find(g=>g.id===id);
      if(!goal?.latest_turn?.id) throw new Error('У цели нет предложенной интерпретации для рассмотрения');
      goalTurn=await api(`/api/continuity/turns/${encodeURIComponent(goal.latest_turn.id)}`); return;
    }
    if (action === 'workspace-goal-capture') {
      const goal=(workspace.goals??[]).find(g=>g.id===id);
      if(!goal?.ready||!goal.attention?.pending||!goal.basis_fingerprint) throw new Error('Основание цели больше не готово к рассмотрению');
      const result=await command('continuity.capture',{thread_id:goal.id,expected_revision:goal.revision,expected_basis_fingerprint:goal.basis_fingerprint});
      selectedGoal=id; goalTurn=await api(`/api/continuity/turns/${encodeURIComponent(result.turn_id)}`); await load(); return;
    }
    if (action === 'workspace-goal-open-case') {
      const goal=(workspace.goals??[]).find(g=>g.id===id);
      if(!goal?.ready||!goal.memory?.current||!goal.memory?.turn_id||!goal.basis_fingerprint) throw new Error('Для случая нужно актуальное рассмотренное понимание цели');
      const result=await command('work.open',{thread_id:goal.id,expected_basis_fingerprint:goal.basis_fingerprint,title:goal.title});
      currentCase=await api(`/api/workspace/cases/${encodeURIComponent(result.case_id)}`); caseContinuity=await api(`/api/continuity/threads/${encodeURIComponent(currentCase.thread_id)}`); await load(); return;
    }
    if (action === 'workspace-goal-propose') {
      if(!goalTurn||goalTurn.id!==id||goalTurn.status!=='captured') throw new Error('Снимок основания недоступен для предложения');
      const evidence=[...(goalTurn.packet?.evidence??[]),...(goalTurn.packet?.memory_evidence??[])];
      const choices=evidence.map(e=>`<option value="${esc(e.source_event_id)}">${esc(e.source_ref)} · ${esc(e.source_event_id)}</option>`).join('');
      modal('Подготовить собственную интерпретацию',`${area('summary','Что вы понимаете из выбранного свидетельства')}<label>Единственное конкретное основание<select name="evidence_event_id"><option value="">Выберите основание</option>${choices}</select></label>${area('unknowns','Что остаётся неизвестным (по одной строке)')}<label>Следующий шаг<select name="next_kind"><option value="observe">Наблюдать</option><option value="ask_owner">Задать вопрос владельцу</option><option value="close">Закрыть цель</option></select></label>${input('next_reason','Почему выбран этот шаг')}${input('owner_question','Вопрос владельцу (если выбран этот шаг)')}`,p=>{
        const evidence_event_id=p.evidence_event_id, unknowns=(p.unknowns??'').split('\n').map(x=>x.trim()).filter(Boolean);
        if(!p.summary?.trim()||!evidence.some(e=>e.source_event_id===evidence_event_id)||!unknowns.length||!p.next_reason?.trim()||!['observe','ask_owner','close'].includes(p.next_kind)||(p.next_kind==='ask_owner'&&!p.owner_question?.trim())) throw new Error('Укажите интерпретацию, её существующее основание, неизвестное и следующий шаг.');
        return command('continuity.propose',{turn_id:goalTurn.id,output:{summary:{text:p.summary.trim(),evidence_event_ids:[evidence_event_id]},claims:[],hypotheses:[],unknowns,next:{kind:p.next_kind,reason:p.next_reason.trim(),wake_at:null,owner_question:p.next_kind==='ask_owner'?p.owner_question.trim():null}}});
      }); return;
    }
    if (action === 'workspace-goal-review-accept' || action === 'workspace-goal-review-reject') {
      if(!goalTurn||goalTurn.id!==id) throw new Error('Загружено другое основание цели');
      modal(action.endsWith('accept')?'Принять интерпретацию цели':'Отклонить интерпретацию цели',`${area('note','Основание решения')}`,p=>{
        if(!p.note?.trim()) throw new Error('Укажите основание решения.');
        return command('continuity.review',{turn_id:goalTurn.id,expected_basis_fingerprint:goalTurn.basis_fingerprint,decision:action.endsWith('accept')?'accept':'reject',note:p.note.trim()});
      }); return;
    }
    const c = currentCase;
    if (['workspace-material-new','workspace-request-material','workspace-refresh','workspace-expect','workspace-prepare-export','workspace-prepare-handoff','workspace-close','workspace-review-open'].includes(action) && !c) throw new Error('Сначала откройте рабочий случай');
    if (action === 'workspace-goal-new') {
      const refs = workspace.source_refs ?? [];
      const sources = refs.map(s=>`<option value="${esc(sourceId(s))}">${esc(sourceTitle(s))}${typeof s==='string'?'':` · ${esc(s.kind ?? 'source')}`}</option>`).join('');
      modal('Новая цель',`${input('title','Название')}${area('objective','Цель')}${area('success_condition','Условие успеха')}<label>Источник из разрешённого списка<select name="source_ids"><option value="">Выберите источник</option>${sources}</select></label>${input('max_age_seconds','Максимальный возраст источника в секундах','number')}`,async p=>{
        const source_ids = Array.isArray(p.source_ids)?p.source_ids:p.source_ids?[p.source_ids]:[];
        const allowed = new Set(refs.map(sourceId));
        if (!p.title?.trim() || !p.objective?.trim() || !p.success_condition?.trim() || !source_ids.length || source_ids.some(x=>!allowed.has(x)) || !Number.isInteger(Number(p.max_age_seconds)) || Number(p.max_age_seconds)<1) throw new Error('Укажите цель, критерий успеха, допустимый источник и максимальный возраст.');
        return command('work.goal',{title:p.title.trim(),objective:p.objective.trim(),success_condition:p.success_condition.trim(),source_ids,max_age_seconds:Number(p.max_age_seconds)});
      }); return;
    }
    if (action === 'workspace-material-new') {
      const evidence = c.evidence_event_ids ?? [];
      const options=evidence.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');
      modal('Новый материал владельца',`${input('title','Название')}${area('content','Точный текст материала')}<label>Событие-основание<select name="evidence_event_id"><option value="">Выберите существующее событие</option>${options}</select></label>`,p=>{
        const evidence_event_ids=p.evidence_event_id?[p.evidence_event_id]:[];
        if (!p.title?.trim() || !p.content?.trim() || !evidence_event_ids.length || !evidence.includes(p.evidence_event_id)) throw new Error('Укажите материал, название и событие из списка оснований этого случая.');
        return command('work.material',{case_id:c.id,expected_revision:c.revision,title:p.title.trim(),content:p.content,evidence_event_ids});
      }); return;
    }
    if (action === 'workspace-request-material') {
      modal('Запросить материал с помощью модели','<p>Этот запрос может запустить модель и использовать платные вычисления. Работа модели остаётся выключенной, пока владелец её явно не настроит.</p><label class="workspace-source"><input type="checkbox" name="confirm" value="yes">Я явно запрашиваю модельный материал для этого случая</label>',p=>{
        if(p.confirm!=='yes') throw new Error('Подтвердите явный запрос модели.');
        return command('work.request_material',{case_id:c.id,expected_revision:c.revision});
      }); return;
    }
    if (action === 'workspace-review-open') {
      const m=(c.materials??[]).find(x=>x.id===id); if(!m) throw new Error('Версия материала больше недоступна');
      modal('Рассмотрение точной версии материала',`<p>Версия ${esc(m.version??m.revision)} · SHA-256 <code>${esc(m.sha256)}</code>. Точное содержимое этой версии показано в карточке рабочего случая.</p><label>Решение<select name="decision"><option value="reject">Отклонить</option><option value="approve">Одобрить</option></select></label>${area('note','Основание решения')}`,p=>{
        if (!['approve','reject'].includes(p.decision) || !p.note?.trim()) throw new Error('Укажите решение и основание.');
        return command('work.review',{case_id:c.id,expected_revision:c.revision,material_id:m.id,sha256:m.sha256,decision:p.decision,note:p.note.trim()});
      }); return;
    }
    if (action === 'workspace-prepare-export' || action === 'workspace-prepare-handoff') {
      const material=(c.materials??[]).find(x=>x.status==='approved');
      if(!material) throw new Error('Сначала рассмотрите точную версию материала.');
      const capability_id=action==='workspace-prepare-export'?'material.export_local.v1':'owner_handoff.create.v1';
      modal('Подготовить предложение действия',`<p>Будет создано только предложение. Исполнение требует отдельного разрешения владельца.</p><p>${esc(material.title)} · ${esc(material.sha256)}</p><label>Материал<select name="material_id"><option value="${esc(material.id)}">${esc(material.title)} · ${esc(material.sha256)}</option></select></label>`,p=>command('work.prepare_action',{case_id:c.id,expected_revision:c.revision,material_id:p.material_id,capability_id})); return;
    }
    if (action === 'workspace-grant') {
      const proposed=c.action??{};
      const action_id=proposed.action_id??proposed.id, proposal_hash=proposed.proposal_hash;
      if(!action_id||!proposal_hash) throw new Error('Предложение не содержит идентификатор действия и точный hash.');
      modal('Выдать ограниченное разрешение',`<p>Это отдельное решение владельца для конкретного предложения. Действие: ${esc(action_id)} · hash: <code>${esc(proposal_hash)}</code></p>${input('expires_at','Срок действия разрешения','datetime-local')}`,p=>{
        const expiry=new Date(p.expires_at); if(!p.expires_at||Number.isNaN(expiry.valueOf())||expiry<=new Date()) throw new Error('Укажите будущий срок действия.');
        return command('action.grant',{action_id,expected_revision:proposed.revision,proposal_hash,expires_at:expiry.toISOString()});
      }); return;
    }
    if (action === 'workspace-refresh') {
      if(c.current!==false||!c.current_basis_fingerprint||c.current_basis_fingerprint===c.basis_fingerprint) throw new Error('Свежего проверенного основания для обновления нет');
      return command('work.refresh',{case_id:c.id,expected_revision:c.revision,expected_basis_fingerprint:c.current_basis_fingerprint});
    }
    if (action === 'workspace-expect') {
      modal('Зафиксировать ожидание после проверки результата',`${area('question','Что именно ожидается?')}${input('deadline','Срок','datetime-local')}`,p=>{
        if(!p.question?.trim()||!p.deadline) throw new Error('Укажите ожидание и срок.');
        const deadline=new Date(p.deadline); if(Number.isNaN(deadline.valueOf())) throw new Error('Срок некорректен.');
        return command('work.expect',{case_id:c.id,expected_revision:c.revision,question:p.question.trim(),deadline:deadline.toISOString()});
      }); return;
    }
    if (action === 'workspace-close') { modal('Закрыть случай',area('reason','Причина закрытия'),p=>{if(!p.reason?.trim())throw new Error('Укажите причину закрытия.');return command('work.close',{case_id:c.id,expected_revision:c.revision,reason:p.reason.trim()});}); return; }
    throw new Error(`Неизвестное действие Partner Workspace: ${action}`);
  }

  function panel(title, content) { return `<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div>${content}</section>`; }
  function hydrate(root) {
    root.querySelectorAll('[data-workspace-text-slot]').forEach(node => {
      node.textContent = sourceSlots[Number(node.dataset.workspaceTextSlot)] ?? '';
    });
  }
  return { load, render, act, hydrate };
}
