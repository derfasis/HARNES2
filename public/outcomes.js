// Outcome review is a local operator workflow. Reads show saved evidence; only explicit form
// submission calls a review command. This view has no model, scheduler, or delivery adapter seam.
const OUTCOME_KINDS = ['qualified','call_proposed','call_accepted','call_booked','call_attended','no_show','joined','declined','business_value'];
const CANDIDATE_KINDS = { reply_observed:'Ответ наблюдался', reaction_observed:'Реакция наблюдалась',
  no_response_observed:'Нет ответа (наблюдение)', engagement_closed:'Взаимодействие закрыто',
  owner_booking_claimed:'Заявлено владельцем: запись', owner_outcome_stated:'Заявлено владельцем: результат' };
const OUTCOMES = { qualified:'Квалифицирован', call_proposed:'Звонок предложен', call_accepted:'Согласие на звонок',
  call_booked:'Звонок назначен', call_attended:'Звонок состоялся', no_show:'Не пришёл', joined:'Присоединился',
  declined:'Отказ', business_value:'Бизнес-ценность' };
const STATUSES = { pending:'Ожидает решения', confirmed:'Подтверждено', rejected:'Отклонено', superseded:'Устарело', unknown:'Неизвестно' };
const PROOF = { continuous:'Непрерывный интервал отмечен владельцем', gapped:'В интервале есть пробелы', unverified:'Покрытие не проверено' };
const formatDate = value => value ? new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';

export function createOutcomesView({ api, command, esc, panel, button, empty, field, modal, refresh, isEnabled = () => true }) {
  let page = null, detail = null, detailError = '', listError = '', status = 'pending', cursor = '', cursorStack = [], selected = null;
  const enabled = () => isEnabled() === true;

  async function load() {
    const route = `/api/outcomes?status=${encodeURIComponent(status)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    try { page = await api(route); listError = ''; }
    catch (error) { page = null; listError = error.message; }
    detailError = '';
    if (selected) {
      try { detail = await api(`/api/outcomes/${encodeURIComponent(selected)}`); }
      catch (error) { detail = null; detailError = error.message; }
    } else detail = null;
  }

  const coverageSummary = coverage => {
    if (!coverage || coverage.disabled) return '<p>Сводка покрытия недоступна.</p>';
    return `<div class="stats">
      <div class="stat"><span class="label">Неизвестные окна</span><strong>${esc(coverage.unknown_windows ?? 0)}</strong><small>Ожидают наблюдения или остаются неизвестными</small></div>
      <div class="stat"><span class="label">Непроверенное покрытие</span><strong>${esc(coverage.unverified_windows ?? 0)}</strong><small>Отсутствие ответа не доказано</small></div>
      <div class="stat"><span class="label">Нет окна наблюдения</span><strong>${esc(coverage.not_observed_deliveries ?? 0)}</strong><small>Сохранённая доставка без окна</small></div>
      <div class="stat"><span class="label">Доставка неизвестна</span><strong>${esc(coverage.unknown_delivery_messages ?? 0)}</strong><small>Отдельно от ответа контакта</small></div>
    </div>`;
  };

  const listMarkup = () => (page?.items ?? []).map(item => `<article class="lesson">
    <div class="panel-head"><h3>${esc(CANDIDATE_KINDS[item.kind] ?? item.kind)}</h3><span class="badge">${esc(STATUSES[item.status] ?? item.status)}</span></div>
    <p>${esc(item.id)}</p><small>Наблюдение: ${esc(formatDate(item.observed_at))} · версия правила ${esc(item.detector_version)}</small>
    ${button('Открыть основание','outcome-open',item.id)}</article>`).join('');

  function renderDetail() {
    if (detailError) return panel('Основание наблюдения', empty('Карточка недоступна', detailError));
    const d = detail;
    if (!d) return panel('Основание наблюдения', empty('Выберите наблюдение', 'Сначала выберите запись из очереди.'));
    const w = d.window ?? null, evidence = d.evidence ?? {};
    const fresh = d.evidence_current === true, canReview = enabled() && d.status === 'pending';
    const freshness = !enabled() ? '<p class="section-note">Слой outcomes выключен. Просмотр доступен, решения отключены.</p>'
      : fresh ? '<p class="section-note">Текущее основание совпадает с сохранёнными сообщениями и provenance.</p>'
        : '<p class="review-error">Основание устарело или не прошло проверку. Подтверждение отключено.</p>';
    const timing = evidence.timing_basis === 'source_timestamps'
      ? 'Источник предоставил временные метки сообщений. Они описывают заявленное время, но не являются независимой проверкой доставки.'
      : 'Использованы записанное время или отметка владельца. Это не независимая проверка доставки.';
    const proof = w?.coverage === 'continuous' && w?.coverage_event_id
      ? `Отметка владельца об интервале · событие ${esc(w.coverage_event_id)}. Это утверждение владельца, не телеметрия транспорта.`
      : `${esc(PROOF[w?.coverage] ?? PROOF.unverified)}. Нельзя заключить, что ответа не было.`;
    const candidateDecision = d.candidate_decision_id ?? d.decision_id ?? null;
    const actualDecision = d.actual_outcome_decision_id ?? null;
    const actionButtons = canReview ? `<div class="actions">
      ${fresh ? button('Записать бизнес-результат','outcome-confirm-open',d.id,'primary') : '<button class="button primary" disabled title="Основание устарело">Записать бизнес-результат</button>'}
      ${button('Отклонить наблюдение','outcome-reject-open',d.id,'danger')}
    </div>` : '';
    return panel('Основание наблюдения', `<p><strong>${esc(CANDIDATE_KINDS[d.kind] ?? d.kind)}</strong> · ${esc(STATUSES[d.status] ?? d.status)} · ревизия ${esc(d.revision)}</p>
      ${freshness}
      <p><strong>Наблюдалось:</strong> ${esc(formatDate(d.observed_at))}</p>
      <p><strong>Источник наблюдения:</strong> ${esc(d.source_message_id ?? '—')} · разговор ${esc(d.conversation_id ?? '—')}</p>
      <p><strong>Черновик / решение кандидата:</strong> ${esc(d.draft_id ?? '—')} · ${esc(candidateDecision ?? 'не связано')}</p>
      <p><strong>Текущий результат:</strong> ${esc(d.outcome_id ?? 'пока не связан')}</p>
      <p><strong>Решение, к которому связан результат:</strong> ${esc(actualDecision ?? 'не связан с решением')}</p>
      <p><strong>Время:</strong> ${esc(timing)}</p>
      ${w ? `<h3>Окно сообщения</h3><p>${esc(w.outcome)} · ${esc(formatDate(w.opened_at))} — ${esc(formatDate(w.closes_at))}</p>
        <p><strong>Покрытие:</strong> ${proof}</p><p><strong>Доставка:</strong> ${esc(w.delivery_attempt_id ?? 'не связана с попыткой')} · временная основа ${esc(w.time_basis ?? 'не указана')}</p>` : '<p class="section-note">Окно наблюдения в API не указано.</p>'}
      <h3>Сохранённое evidence</h3><pre class="code">${esc(JSON.stringify(evidence,null,2))}</pre>
      <p><strong>Наблюдение не устанавливает причинность</strong>. Ответ или его отсутствие сами по себе не являются бизнес-результатом.</p>${actionButtons}`);
  }

  function render() {
    if (listError) return panel('Результаты и наблюдения', empty('Список недоступен', listError));
    if (!page) return empty('Результаты и наблюдения', 'Загружаем сохранённые записи.');
    const options = [['pending','Ожидают решения'],['all','Все записи'],['confirmed','Подтверждены'],['rejected','Отклонены'],['superseded','Устарели'],['unknown','Неизвестны']];
    const filter = `<label for="outcome-status">Статус наблюдения</label><select id="outcome-status">${options.map(([value,title]) =>
      `<option value="${value}"${status===value?' selected':''}>${title}</option>`).join('')}</select>`;
    const disabledNote = enabled() ? '' : '<p class="section-note">Слой outcomes выключен: решения недоступны.</p>';
    return `${disabledNote}${panel('Покрытие наблюдений',coverageSummary(page.coverage))}
      ${panel('Кандидаты на рассмотрении',`${filter}<div class="person-list">${listMarkup() || empty('Записей нет','Попробуйте другой фильтр.')}</div>
        <div class="actions">${cursor ? button('Предыдущая страница','outcome-prev') : ''}${page.next_cursor ? button('Следующая страница','outcome-next') : ''}</div>`)}
      ${renderDetail()}`;
  }

  async function refreshAfterDecision() {
    await refresh();
  }

  function confirmForm(d) {
    const expectedRevision = d.revision;
    modal('Записать подтверждённый бизнес-результат', `<p>Вы явно подтверждаете бизнес-результат своим evidence или связываете наблюдение с уже записанным результатом. Сам ответ не доказывает запись на звонок, посещение или присоединение.</p>
      ${field('kind','Бизнес-результат','select','qualified',OUTCOME_KINDS.map(kind => [kind,OUTCOMES[kind]]))}
      ${field('evidence','Основание решения владельца','textarea')}
      ${field('value','Числовая величина (необязательно)','number')}
      ${field('outcome_id','Связать с уже записанным результатом (необязательно; только явный выбор)','text')}
      ${field('note','Заметка (необязательно)','textarea')}
      <p>Связанный результат сохраняет своё исходное решение атрибуции. Решение кандидата и решение результата показываются отдельно.</p>`, async values => {
      try {
        if (!enabled()) throw new Error('Слой outcomes выключен; перечитайте карточку.');
        if (d.evidence_current !== true) throw new Error('Основание устарело; перечитайте карточку.');
        if (!String(values.evidence ?? '').trim()) throw new Error('Укажите основание решения владельца.');
        const payload = { candidate_id:d.id, kind:values.kind, evidence:values.evidence, expected_revision:expectedRevision };
        if (String(values.value ?? '').trim()) payload.value = Number(values.value);
        if (String(values.outcome_id ?? '').trim()) payload.outcome_id = values.outcome_id.trim();
        if (String(values.note ?? '').trim()) payload.note = values.note.trim();
        await command('outcome.candidate_confirm', payload);
      } finally { await refreshAfterDecision(); }
    });
  }

  function rejectForm(d) {
    const expectedRevision = d.revision;
    modal('Отклонить наблюдение', field('note','Причина решения владельца','textarea') + '<p>Запись останется в истории; никаких сообщений не отправляется.</p>', async values => {
      try {
        if (!enabled()) throw new Error('Слой outcomes выключен; перечитайте карточку.');
        if (!String(values.note ?? '').trim()) throw new Error('Укажите причину решения владельца.');
        await command('outcome.candidate_reject', { candidate_id:d.id, note:values.note.trim(), expected_revision:expectedRevision });
      }
      finally { await refreshAfterDecision(); }
    });
  }

  async function act(action, id) {
    if (action === 'outcome-filter') { status = id || 'pending'; cursor = ''; cursorStack = []; selected = null; await load(); return; }
    if (action === 'outcome-open') selected = id;
    else if (action === 'outcome-next') {
      if (!page?.next_cursor) return;
      cursorStack.push(cursor); cursor = page.next_cursor; selected = null;
    } else if (action === 'outcome-prev') { cursor = cursorStack.pop() ?? ''; selected = null; }
    else if (action === 'outcome-confirm-open' || action === 'outcome-reject-open') {
      const d = detail;
      if (!d || d.id !== id || d.status !== 'pending') throw new Error('Перечитайте актуальную карточку.');
      if (!enabled()) throw new Error('Слой outcomes выключен.');
      if (action === 'outcome-confirm-open' && d.evidence_current !== true) throw new Error('Основание устарело; подтверждение недоступно.');
      if (action === 'outcome-confirm-open') confirmForm(d); else rejectForm(d);
      return;
    } else return;
    await load();
  }

  return { load, render, act };
}
