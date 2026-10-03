// Operator surface for durable audience goals. All remote text is escaped before rendering.
export function createAudienceView({ api, command, esc, panel, button, empty, field, modal, refresh, notify }) {
  let listing = null, goal = null, need = null, assessment = null;
  let selectedGoal = null, selectedNeed = null, selectedAssessment = null, cursor = '';
  let error = '';

  async function load() {
    try {
      listing = await api(`/api/audience?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      error = '';
      if (selectedGoal && listing.items.some(item => item.id === selectedGoal)) {
        goal = await api(`/api/audience/${encodeURIComponent(selectedGoal)}`);
        if (selectedNeed) {
          try { need = await api(`/api/audience/needs/${encodeURIComponent(selectedNeed)}`); }
          catch { need = null; selectedNeed = null; }
          if (need && !selectedAssessment) selectedAssessment = need.assessment_id;
        } else need = null;
        if (selectedAssessment && (goal.assessments ?? []).some(item => item.id === selectedAssessment)) {
          assessment = await api(`/api/audience/assessments/${encodeURIComponent(selectedAssessment)}`);
        } else { assessment = null; selectedAssessment = null; }
      } else { goal = null; need = null; assessment = null; selectedGoal = selectedNeed = selectedAssessment = null; }
    } catch (e) { listing = null; goal = need = assessment = null; error = e.message; }
  }
  const statusName = value => ({OPEN:'Открыта',PAUSED:'Приостановлена',open:'Открыта',active:'Активна',paused:'Приостановлена',accepted:'Принято',rejected:'Отклонено',proposed:'На рассмотрении',captured:'Собрано',stale:'Устарело',pending:'Ожидает',interrupted:'Прервано',invalid:'Невалидный вывод'})[value] ?? value ?? 'Неизвестно';
  const badge = value => `<span class="badge ${['OPEN','accepted','active'].includes(value)?'green':['rejected','PAUSED','paused','stale'].includes(value)?'red':['proposed','captured'].includes(value)?'purple':''}">${esc(statusName(value))}</span>`;
  const selectedRows = (rows, type, selected) => rows.map(row => `<button class="person-card ${row.id === selected?'active':''}" data-do="audience-${type}" data-id="${esc(row.id)}">
    <strong>${esc(row.title ?? row.id)}</strong><small>${badge(row.status)} · ревизия ${esc(row.revision ?? '—')}</small>
    ${row.objective ? `<small>${esc(row.objective)}</small>` : ''}</button>`).join('');

  function render() {
    if (error) return empty('Audience Intelligence недоступен', error);
    if (!listing) return empty('Audience Intelligence', 'Загружаем рабочие цели.');
    const disabled = listing.enabled !== true;
    const notice = disabled
      ? '<div class="section-note">Audience Intelligence выключен в конфигурации. Новые цели, сбор и принятие выключены; сохранённые записи доступны для просмотра и отклонения.</div>'
      : listing.model_enabled !== true
        ? '<div class="section-note">Модельные вызовы выключены. Сбор и предложение выполняются оператором вручную на выбранных разрешённых источниках.</div>'
        : '<div class="section-note">Модельные оценки включены: когда модель доступна, серверный планировщик может запускать ограниченные оценки на свежих данных. Кнопка «Собрать основание» создаёт операторский снимок. Предложение не принимается автоматически.</div>';
    let html = notice + panel('Рабочие цели', selectedRows(listing.items ?? [], 'goal', selectedGoal)
      || empty('Целей пока нет', 'Создайте ограниченную цель и укажите источники, уже разрешённые для чтения.'),
      !disabled ? button('+ Новая цель', 'audience-new', '', 'primary') : '');
    html += `<div class="actions">${listing.next_cursor ? button('Следующие цели', 'audience-next') : ''}</div>`;
    if (!goal) return html;
    const needs = goal.needs ?? [];
    const assessments = goal.assessments ?? [];
    const capturePending = assessments.some(a => ['captured','running'].includes(a.status));
    html += panel(goal.title ?? 'Цель', `<p>${esc(goal.objective ?? '')}</p>
      <p>${badge(goal.status)} · ревизия ${esc(goal.revision ?? '—')}</p>
      <p><strong>Источники и доступность:</strong> ${esc((goal.watches ?? []).map(w => {
        if (typeof w === 'string') return w;
        const ref = w.source_ref ?? w.source_id ?? '';
        const health = w.health ?? {};
        const state = health.current === true ? 'доступен' : 'актуальность не подтверждена';
        const cursor = w.cursor ?? 'неизвестен', head = w.head ?? 'неизвестен';
        return `${ref}: ${state}${health.reason ? ` (${health.reason})` : ''}; указатель ${cursor}, верхняя граница ${head}`;
      }).filter(Boolean).join('; ') || 'не указаны')}</p>
      <p><strong>Текущие данные:</strong> ${goal.ready === true ? 'есть основание для ограниченного сбора' : 'основание для сбора не подтверждено'} · очередь обновлений: ${goal.backlog === true ? 'есть необработанные события' : goal.backlog === false ? 'не обнаружена' : 'состояние неизвестно'}. Это не означает полного охвата источников.</p>
      ${goal.coverage ? `<p class="muted tiny">Охват: ${esc(goal.coverage.selection)} · лимит снимка: ${esc(goal.coverage.batch_exchanges ?? 'неизвестен')} обменов · лимит на источник: ${esc(goal.coverage.source_capacity ?? 'неизвестен')} · полнота источника: ${esc(goal.coverage.source_completeness)} · независимость авторов не подтверждена.</p>` : ''}
      ${goal.reasons?.length ? `<p><strong>Актуальность:</strong> ${esc(goal.reasons.join('; '))}</p>` : ''}
      ${(goal.withheld_exchanges ?? []).length ? `<p><strong>Обмены, не включённые в основание (показано не более 8):</strong></p>${goal.withheld_exchanges.map(x => `<article class="workspace-evidence"><strong>${esc(x.source_ref ?? 'Источник')} · ${esc(x.id ?? 'обмен')}</strong><p>Исключён из текущего основания · ${esc((x.reasons ?? []).join('; ') || 'причина не указана')}</p>${x.unsupported_count !== undefined ? `<small>Неподдержанные события: ${esc(x.unsupported_count)}</small>` : ''}</article>`).join('')}` : '<p class="muted tiny">Неактуальные обмены не указаны; это не подтверждает полноту источника.</p>'}
      <p class="muted tiny">Предложение о потребности не является фактом, согласием или разрешением на контакт.</p>
      <div class="actions">${!disabled && goal.status === 'OPEN' ? button('Приостановить цель', 'audience-pause', goal.id, 'danger') : ''}
      ${!disabled && goal.ready === true && goal.status === 'OPEN' && !capturePending ? button('Собрать основание', 'audience-capture', goal.id, 'primary') : ''}</div>`);
    html += panel('Потребности и гипотезы', selectedRows(needs, 'need', selectedNeed)
      || empty('Потребностей пока нет', 'Соберите основание, чтобы вручную предложить гипотезу.'));
    if (need) html += needPanel(need);
    html += panel('Сборы и предложения', assessments.map(a => `<article class="lesson">
      <h3>${esc(a.producer ?? 'Операторское предложение')}</h3><p>${badge(a.status)} · ${esc(a.id)}</p>
      ${a.created_at ? `<small>${esc(new Date(a.created_at).toLocaleString('ru-RU'))}</small>` : ''}
      ${button('Открыть сбор', 'audience-assessment', a.id)}</article>`).join('')
      || empty('Сборов пока нет', 'Сбор сохраняет версионированное основание для ручного предложения.'));
    if (assessment) html += assessmentPanel(assessment);
    return html;
  }
  function needPanel(n) {
    const current = n.current === true;
    const accepted = n.status === 'accepted';
    const ev = n.evidence_event_ids ?? [];
    const counter = n.counterevidence_event_ids ?? [];
    const exchanges = n.exchange_ids ?? [];
    const quotes = n.support_quotes ?? [];
    const evidenceById = new Map((assessment?.packet?.exchanges ?? []).flatMap(x => x.evidence ?? []).map(x => [x.source_event_id, x]));
    const refs = ids => ids.map(id => {
      const e = evidenceById.get(id);
      return `<article class="workspace-evidence"><p>${esc(e?.text ?? 'Текст не сохранён в доступном снимке.')}</p><small>${esc(id)}${e?.source_ref ? ` · ${esc(e.source_ref)}` : ''}</small></article>`;
    }).join('') || '<p>Нет привязанных событий.</p>';
    return panel(n.title ?? 'Потребность', `<p>${badge(n.status)} · ревизия ${esc(n.revision ?? '—')} · ${current ? 'основание актуально' : 'основание неактуально'}</p>
      <p><strong>Эпистемический статус:</strong> ${esc(n.epistemic_status ?? 'не указан')}</p>
      <p><strong>Гипотеза:</strong> ${esc(n.hypothesis ?? '')}</p><p><strong>Почему сейчас:</strong> ${esc(n.why_now ?? 'Не указано')}</p>
      <p><strong>Возможный следующий шаг:</strong> ${esc(n.next_step ?? 'Не указан')}</p><p><strong>Основание:</strong> ${esc(n.reason ?? 'Не указано')}</p>
      <p><strong>Неизвестно:</strong> ${esc((n.unknowns ?? []).join('; ') || 'Не указано')}</p>
      <p><strong>Точные цитаты-основания:</strong></p>${quotes.map(q => `<blockquote>${esc(q.quote)}<small> · событие ${esc(q.source_event_id)}</small></blockquote>`).join('') || '<p>Цитаты отсутствуют.</p>'}
      <p><strong>Поддерживающие события:</strong></p>${refs(ev)}<p><strong>Контрсвидетельства:</strong></p>${refs(counter)}<p><strong>Связанные обмены:</strong> ${esc(exchanges.join(', ') || 'нет ссылок')}</p>
      <p><strong>Актуальность:</strong> ${current ? 'текущая по сохранённой проверке' : esc((n.reasons ?? []).join('; ') || 'не подтверждена')}</p>
      <p class="muted tiny">Это гипотеза для рассмотрения. Принятие её не предоставляет разрешение на контакт или отправку. Для Continuity должна быть включена отдельная конфигурация.</p>
      <div class="actions">${current && n.status === 'proposed' ? button('Принять гипотезу', 'audience-accept', n.id, 'primary') : ''}
      ${['proposed','stale'].includes(n.status) ? button('Отклонить', 'audience-reject', n.id, 'danger') : ''}
      ${current && accepted ? button(n.thread_id ? 'Обновить предложение Continuity' : 'Открыть работу в Continuity', n.thread_id ? 'audience-refresh-work' : 'audience-open-work', n.id, 'secondary') : ''}</div>`);
  }
  function assessmentPanel(a) {
    const packet = a.packet;
    const exchanges = packet?.exchanges ?? [];
    const evidenceCount = exchanges.reduce((n, x) => n + (x.evidence?.length ?? 0), 0);
    return panel('Основание сбора', `<p>Состояние: ${badge(a.status)} · ID ${esc(a.id ?? '')}</p>
      ${packet ? `<p>Актуальность: ${a.current === true ? 'текущая' : a.current === false ? 'устарела' : 'не указана'}</p>
        <p><strong>Обмены (${exchanges.length}), свидетельства (${evidenceCount}):</strong></p>${exchanges.map(x => `<article class="workspace-evidence"><strong>Обмен ${esc(x.id)} · ${esc(x.source_ref)}</strong><p>${x.current === true ? 'Текущий' : 'Требует сверки'}${x.reasons?.length ? ` · ${esc(x.reasons.join('; '))}` : ''}</p>${(x.evidence ?? []).map(e => `<p>${esc(e.text ?? 'Свидетельство без текста')}<small>${esc(e.source_event_id ?? '')}${e.message_version ? ` · версия ${esc(e.message_version)}` : ''}${e.observed_at ? ` · наблюдалось ${esc(new Date(e.observed_at).toLocaleString('ru-RU'))}` : ''}</small></p>`).join('')}</article>`).join('') || '<p>Свидетельства не приложены.</p>'}
        ${packet.unknowns?.length ? `<p><strong>Неизвестно:</strong> ${esc(packet.unknowns.join('; '))}</p>` : ''}` : '<p>Снимок основания не возвращён.</p>'}
      ${a.output ? `<details><summary>Сохранённое предложение</summary><pre class="workspace-pre">${esc(JSON.stringify(a.output, null, 2))}</pre></details>` : ''}
      <div class="actions">${a.status === 'captured' && a.current === true ? button('Внести гипотезу вручную', 'audience-propose', a.id, 'primary') : ''}</div>`);
  }
  function createGoal() {
    const refs = listing.source_refs ?? [];
    const choices = refs.map((ref, i) => `<label class="research-choice"><input type="checkbox" name="source_${i}" value="${esc(ref)}"> ${esc(ref)}</label>`).join('');
    const content = field('title', 'Название цели') + field('objective', 'Что понять или отслеживать', 'textarea')
      + '<p>Выберите только источники, уже разрешённые для чтения. Создание цели само не запускает чтение.</p>'
      + (choices || '<p class="muted">Доступных источников нет.</p>');
    modal('Новая цель аудитории', content, async p => {
      const source_ids = Object.keys(p).filter(k => k.startsWith('source_')).map(k => p[k]);
      if (!p.title.trim() || !p.objective.trim() || !source_ids.length) throw new Error('Заполните название, цель и выберите хотя бы один источник.');
      cursor = '';
      const r = await command('audience.open', { title: p.title.trim(), objective: p.objective.trim(), source_ids });
      selectedGoal = r.goal_id ?? r.id; selectedNeed = selectedAssessment = null;
    });
  }
  async function act(action, id) {
    if (action === 'audience-new') { createGoal(); return; }
    if (action === 'audience-goal') { selectedGoal = id; selectedNeed = selectedAssessment = null; await load(); return; }
    if (action === 'audience-need') { selectedNeed = id; selectedAssessment = null; await load(); return; }
    if (action === 'audience-assessment') { selectedAssessment = id; selectedNeed = null; await load(); return; }
    if (action === 'audience-next') { cursor = listing?.next_cursor ?? ''; await load(); return; }
    if (!goal) throw new Error('Сначала откройте цель.');
    if (action === 'audience-pause') {
      modal('Приостановить цель аудитории', field('reason', 'Причина', 'textarea'), async p => {
        if (!p.reason.trim()) throw new Error('Укажите причину.');
        await command('audience.pause', { goal_id: goal.id, expected_revision: goal.revision, reason: p.reason.trim() });
      }); return;
    }
    if (action === 'audience-capture') {
      const current = goal;
      const result = await command('audience.capture', { goal_id: current.id, expected_revision: current.revision,
        expected_basis_fingerprint: current.basis_fingerprint });
      selectedAssessment = result.assessment_id; selectedNeed = null;
      await load(); return;
    }
    if (action === 'audience-propose') {
      const a = assessment;
      const evidence = (a?.packet?.exchanges ?? []).flatMap(x => x.evidence ?? []);
      const evidenceText = new Map(evidence.map(e => [e.source_event_id, String(e.text ?? '').slice(0, 2000)]));
      const allEvOpts = [...new Map(evidence.map((e, i) => [e.source_event_id ?? String(i), [e.source_event_id ?? String(i), `${e.source_ref ?? 'Источник'}: ${(e.text ?? '').slice(0, 100)}`]])).values()];
      const evOpts = allEvOpts.slice(0, 32);
      const content = field('title', 'Краткое название') + field('hypothesis', 'Гипотеза', 'textarea')
        + field('why_now', 'Почему сейчас', 'textarea') + field('next_step', 'Возможный следующий шаг', 'select', 'observe', [['observe','Наблюдать'],['research','Исследовать'],['prepare_material','Подготовить материал']])
        + field('reason', 'Обоснование', 'textarea') + field('unknowns', 'Что остаётся неизвестным (по одному пункту)', 'textarea')
        + (evOpts.length ? `<p>Поддерживающие события (ссылки на обмены будут выведены из выбранных событий)</p>${allEvOpts.length > evOpts.length ? `<small>Показаны первые ${evOpts.length} из ${allEvOpts.length}; схема ограничивает один вывод 32 ссылками.</small>` : ''}${evOpts.map(([v,l],i) => `<label class="research-choice"><input type="checkbox" name="evidence_${i}" value="${esc(v)}" checked> ${esc(l)}</label>`).join('')}` : '<p>Evidence references будут пусты: в сборе нет цитируемых событий.</p>');
      modal('Предложить гипотезу аудитории', content, async p => {
        const ids = Object.keys(p).filter(k => k.startsWith('evidence_')).map(k => p[k]);
        const unknowns = p.unknowns.split('\n').map(x => x.trim()).filter(Boolean);
        if (!p.title.trim() || p.title.length > 200 || !p.hypothesis.trim() || p.hypothesis.length > 2000
          || !p.why_now.trim() || p.why_now.length > 2000 || !p.reason.trim() || p.reason.length > 2000) throw new Error('Укажите название, гипотезу, почему сейчас и обоснование (до 2000 знаков на текст).');
        if (!ids.length) throw new Error('Выберите хотя бы одно поддерживающее событие.');
        if (!unknowns.length) throw new Error('Укажите хотя бы один неизвестный или ограничение.');
        if (unknowns.length > 8 || unknowns.some(x => x.length > 2000)) throw new Error('Укажите не более восьми ограничений, до 2000 знаков каждое.');
        const support_quotes = ids.map(source_event_id => ({ source_event_id, quote: evidenceText.get(source_event_id) }));
        if (support_quotes.some(q => !q.quote?.trim())) throw new Error('Для каждого события требуется доступный точный фрагмент текста.');
        const exchange_ids = [...new Set((a.packet.exchanges ?? []).filter(x => x.evidence.some(e => ids.includes(e.source_event_id))).map(x => x.id))];
        if (!exchange_ids.length) throw new Error('Выбранные события не привязаны к текущему обмену.');
        const result = await command('audience.propose', { assessment_id: a.id, output: { needs: [{ need_id: null, title: p.title.trim(), hypothesis: p.hypothesis.trim(), why_now: p.why_now.trim(), next_step: p.next_step, reason: p.reason.trim(), unknowns, evidence_event_ids: ids, counterevidence_event_ids: [], support_quotes, exchange_ids }] } });
        selectedNeed = result.need_ids?.[0] ?? null;
      }); return;
    }
    if (!need || need.id !== id) throw new Error('Сначала откройте гипотезу.');
    if (action === 'audience-accept' || action === 'audience-reject') {
      const decision = action.endsWith('accept') ? 'accept' : 'reject';
      modal(`${decision === 'accept' ? 'Принять' : 'Отклонить'} гипотезу`, field('note', 'Основание решения', 'textarea'), async p => {
        if (!p.note.trim()) throw new Error('Укажите основание решения.');
        await command('audience.review', { need_id: need.id, expected_revision: need.revision,
          expected_basis_fingerprint: need.basis_fingerprint, decision, note: p.note.trim() });
      }); return;
    }
    if (action === 'audience-open-work' || action === 'audience-refresh-work') {
      const n = need;
      const r = await command(action === 'audience-refresh-work' ? 'audience.refresh_work' : 'audience.open_work',
        { need_id: n.id, expected_revision: n.revision, expected_basis_fingerprint: n.basis_fingerprint });
      if (r.thread_id) notify(`Предложение Continuity для ветки ${r.thread_id} сохранено. Проверьте его в разделе «Исследования»; дело Workspace само не открыто.`);
      await load(); return;
    }
    throw new Error(`Неизвестное действие Audience Intelligence: ${action}`);
  }
  return { load, render, act };
}
