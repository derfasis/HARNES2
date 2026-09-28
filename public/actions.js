// Explicitly reviewed bounded actions. GETs never grant, retry, verify, or execute.
export function createActionsView({ api, command, esc, panel, button, empty, field, modal, refresh }) {
  let page = null, detail = null, cursor = '', selected = null, threads = null, thread = null;
  const title = x => x?.title || x?.objective || x?.id || '';
  async function load() {
    page = await api(`/api/actions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    detail = selected ? await api(`/api/actions/${encodeURIComponent(selected)}`) : null;
    if (detail?.packet?.thread_id) thread = await api(`/api/continuity/threads/${encodeURIComponent(detail.packet.thread_id)}`);
    else thread = null;
    if (page.enabled) threads = await api('/api/continuity/threads?limit=50');
  }
  const listing = () => (page?.items ?? []).map(a => `<article class="lesson"><h3>${esc(title(a))}</h3>
    <p>${esc(a.status)} · revision ${esc(a.revision)}</p>${button('Открыть', 'action-open', a.id)}</article>`).join('');
  function render() {
    if (!page) return empty('Действия', 'Загружаем разрешённую работу.');

    let html = !page.enabled ? '<div class="section-note">Слой действий выключен. Сохранённые действия доступны для просмотра.</div>' :
      '<div class="section-note">Только текущая принятая интерпретация может быть основанием. Разрешение ограничено одному локальному действию и сроку; отправка сообщений недоступна.</div>';
    html += panel('Действия владельца', listing() || empty('Действий пока нет', 'Создайте локальный brief или handoff на основании принятого понимания.'),
      page.enabled ? button('Новое действие', 'action-new', '', 'primary') + (page.model_enabled ? button('Предложить с ИИ', 'action-plan') : '') : '');
    html += `<div class="actions">${cursor ? button('Назад к началу', 'action-first') : ''}${page.next_cursor ? button('Следующие', 'action-next') : ''}</div>`;
    if (!detail) return html;
    const d = detail, p = d.packet ?? {}, current = d.current === true;
    const basis = current ? '' : `<p class="badge red">Основание устарело${d.current_reason ? `: ${esc(d.current_reason)}` : ''}. Grant и retry скрыты.</p>`;
    const evidence = (p.evidence ?? []).map(e => `<article class="lesson"><small>${esc(e.source_ref ?? e.kind ?? '')}</small><blockquote>${esc(e.quote ?? e.text ?? '')}</blockquote></article>`).join('');
    let actions = '';
    if (current && d.can_grant) actions += button('Разрешить на 1 час', 'action-grant', d.id, 'primary');
    if (current && d.can_retry) actions += button('Повторить (новый grant)', 'action-retry', d.id);
    if (d.can_revoke) actions += button('Отозвать разрешение', 'action-revoke', d.id, 'danger');
    if (['proposed','plan_requested'].includes(d.status)) actions += button('Отклонить', 'action-reject', d.id);
    if (d.attempts?.length) actions += button('Проверить результат', 'action-verify', d.id);
    if (d.human_task) {
      actions += `<p>Задача владельца: ${esc(d.human_task.status)} · ${esc(d.human_task.instructions)}</p>`;
      if (current && !d.verify_requested && d.status === 'completed' && d.human_task.status === 'proposed') actions += button('Подтвердить handoff', 'action-handoff-ack', d.id);
      if (current && !d.verify_requested && d.status === 'completed' && d.human_task.status === 'pending') actions += button('Закрыть handoff', 'action-handoff-resolve', d.id);
    }
    html += panel(d.title, `<p>Состояние: ${esc(d.status)} · версия ${esc(d.revision)}</p>${basis}
      <p><strong>Основание:</strong> ${esc(p.interpretation?.summary?.text ?? '')}</p>
      <p><strong>Рабочий вопрос:</strong> ${esc(p.objective ?? thread?.objective ?? '')}</p>
      <p><strong>Цель:</strong> ${esc(d.proposal?.title ?? '')}</p><p>${esc(d.proposal?.instructions ?? '')}</p>
      <p><strong>Ожидаемый результат:</strong> ${esc(d.proposal?.expected_result ?? '')}</p>
      <p>Target: owner-local · ${esc(d.proposal?.capability_id ?? '')}</p>
      <details><summary>Evidence (${(p.evidence ?? []).length})</summary>${evidence}</details>
      <p>Риск: локальный файл владельца или задача владельцу; контакты и внешние записи не затрагиваются.</p>
      <p>Proposal hash: <code>${esc(d.proposal_hash ?? '')}</code></p>
      <p>Создание результата не подтверждает его бизнес-эффект. Handoff — задача только человеку. Проверка: ${d.verify_requested ? 'запрошена повторная сверка' : 'последнее сохранённое наблюдение'}.</p>
      <details><summary>Точный пакет и разрешения</summary><pre class="code">${esc(JSON.stringify({packet:p,proposal:d.proposal,grants:d.grants},null,2))}</pre></details>
      <div class="actions">${actions}${button('Обработать локальные действия', 'action-wake')}</div>
      ${d.attempts?.length ? `<details><summary>Попытки и сверка</summary>${d.attempts.map(a => `<p>${esc(a.status)} · ${esc(a.verification_state ?? '')} ${esc(JSON.stringify(a.verification ?? null))}</p><pre class="code">${esc(JSON.stringify(a.receipt ?? null, null, 2))}</pre>`).join('')}</details>` : ''}
      ${d.artifact_available ? button('Открыть локальный пакет', 'action-artifact', d.id) : ''}`);
    return html;
  }
  async function act(action, id) {
    if (action === 'action-open') selected = id;
    else if (action === 'action-next') { cursor = page.next_cursor ?? cursor; selected = null; }
    else if (action === 'action-first') { cursor = ''; selected = null; }
    else if (action === 'action-new') {
      const eligible = (threads?.items ?? []).filter(t => t.status === 'OPEN');
      if (!eligible.length) { modal('Нет принятого основания', '<p>Сначала примите актуальное понимание в Research.</p>', async () => {}); return; }
      modal('Новое действие', field('thread_id', 'Принятое понимание', 'select', eligible[0].id, eligible.map(t => [t.id, title(t)]))
        + field('capability_id', 'Ограниченное действие', 'select', 'brief.publish_local.v1', [['brief.publish_local.v1','Опубликовать локальный brief'],['owner_handoff.create.v1','Создать задачу владельцу']])
        + field('title','Название') + field('instructions','Что нужно сделать','textarea') + field('expected_result','Проверяемый результат','textarea')
        + '<p>Только материалы принятого понимания и связанное evidence. Никаких сообщений или внешних записей.</p>', async v => {
          const t = await api(`/api/continuity/threads/${encodeURIComponent(v.thread_id)}`);
          const r = await command('action.propose', { thread_id: t.id, expected_basis_fingerprint: t.basis_fingerprint,
            reason: 'Действие основано на принятом понимании владельца', proposal: { capability_id: v.capability_id, title: v.title,
              instructions: v.instructions, expected_result: v.expected_result, due_at: null } }); selected = r.action_id;
        }); return;
    } else if (action === 'action-plan') {
      const eligible = (threads?.items ?? []).filter(t => t.status === 'OPEN');
      if (!eligible.length) throw new Error('Сначала создайте и примите понимание в Исследованиях.');
      modal('Предложить ограниченный план', field('thread_id','Принятое понимание','select',eligible[0].id,eligible.map(t => [t.id,title(t)]))
        + '<p>Один модельный вызов предложит план. Исполнение требует отдельного разрешения.</p>', async v => {
          const t = await api(`/api/continuity/threads/${encodeURIComponent(v.thread_id)}`);
          const r = await command('action.request_plan', { thread_id: t.id, expected_basis_fingerprint: t.basis_fingerprint }); selected = r.action_id;
        }); return;
    } else if (action === 'action-grant' || action === 'action-retry') {
      const d = detail;
      modal(action === 'action-grant' ? 'Проверить и разрешить действие' : 'Выдать новое разрешение для повтора',
        `<p><strong>${esc(d.proposal.title)}</strong></p><p>${esc(d.proposal.instructions)}</p><p>Ожидаемый результат: ${esc(d.proposal.expected_result)}</p>
        <p>Target: только локальная область владельца. Основание: ${esc(d.packet.interpretation?.summary?.text ?? '')}</p>
        <p>Риск: локальная запись/задача; без исходящих сообщений. Proposal hash: <code>${esc(d.proposal_hash)}</code></p>
        <details open><summary>Точный пакет для этого разрешения</summary><pre class="code">${esc(JSON.stringify({proposal:d.proposal,packet:d.packet,revision:d.revision},null,2))}</pre></details>
        <p>Одна попытка, срок 1 час. Проверка: ${esc(d.proposal.capability_id === 'brief.publish_local.v1' ? 'независимое чтение байтов файла' : 'независимое чтение задачи из SQLite')}.</p>
        ${field('confirm','Подтверждение','select','no',[['no','Не разрешать'],['yes','Разрешить только это действие']])}`,
        async v => { if (v.confirm !== 'yes') return;
          await command(action === 'action-grant' ? 'action.grant' : 'action.retry', { action_id: d.id, expected_revision: d.revision,
            proposal_hash: d.proposal_hash, expires_at: new Date(Date.now() + 3600000).toISOString() }); }); return;
    } else if (['action-revoke','action-reject','action-handoff-ack','action-handoff-resolve'].includes(action)) {
      const d = detail;
      if (action === 'action-handoff-resolve') {
        modal('Результат задачи владельца', field('outcome','Состояние','select','done',[['done','Выполнено'],['declined','Отклонено']])+field('note','Заметка','textarea'),
          v => command('action.handoff_resolve',{action_id:d.id,expected_revision:d.revision,outcome:v.outcome,note:v.note})); return;
      }
      const op = action === 'action-revoke' ? 'action.revoke' : action === 'action-reject' ? 'action.reject' : 'action.handoff_acknowledge';
      modal(action === 'action-handoff-ack' ? 'Принять задачу владельца' : action === 'action-revoke' ? 'Отозвать разрешение' : 'Отклонить действие',
        field('note','Основание','textarea'), v => command(op,{action_id:d.id,expected_revision:d.revision,...(op === 'action.handoff_acknowledge' ? {note:v.note} : {reason:v.note})})); return;
    } else if (action === 'action-wake') await api('/api/actions/wake', {});
    else if (action === 'action-verify') await command('action.verify',{action_id:detail.id,expected_revision:detail.revision});
    else if (action === 'action-artifact') {
      const artifact = await api(`/api/actions/${encodeURIComponent(id)}/artifact`);
      modal('Локальный пакет', `<p>Проверяемый пакет локального результата.</p><pre class="code">${esc(JSON.stringify(artifact,null,2))}</pre>`, async () => {}); return;
    }
    await load(); await refresh();
  }
  return { load, render, act };
}
