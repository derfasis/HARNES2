// Operator surface for durable audience goals. All remote text is escaped before rendering.
export function createAudienceView({ api, command, esc, panel, button, empty, field, modal, refresh, notify }) {
  let listing = null, goal = null, need = null, assessment = null, reassessmentContext = null;
  let reassessmentContextGuard = null;
  let reassessmentLoading = false, reassessmentError = '';
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
        // A need is the authoritative link to its assessment. Older goal
        // summaries are intentionally bounded and may omit that assessment.
        if (selectedAssessment) {
          assessment = await api(`/api/audience/assessments/${encodeURIComponent(selectedAssessment)}`);
        } else { assessment = null; selectedAssessment = null; }
        if (reassessmentContext && reassessmentContextGuard && (
          reassessmentContextGuard.goal_id !== goal.id
          || reassessmentContextGuard.goal_revision !== goal.revision
          || reassessmentContextGuard.need_id !== need?.id
          || reassessmentContextGuard.need_revision !== need?.revision
          || reassessmentContextGuard.need_basis_fingerprint !== need?.basis_fingerprint
          || reassessmentContextGuard.listing_model_enabled !== (listing.model_enabled === true))) {
          reassessmentContext = null; reassessmentContextGuard = null; reassessmentError = '';
        }
      } else { goal = null; need = null; assessment = null; selectedGoal = selectedNeed = selectedAssessment = null; }
    } catch (e) { listing = null; goal = need = assessment = null; error = e.message; }
  }
  const statusName = value => ({OPEN:'Открыта',PAUSED:'Приостановлена',open:'Открыта',active:'Активна',paused:'Приостановлена',accepted:'Принято',rejected:'Отклонено',proposed:'На рассмотрении',captured:'Собрано',stale:'Устарело',pending:'Ожидает',interrupted:'Прервано',invalid:'Невалидный вывод'})[value] ?? value ?? 'Неизвестно';
  const badge = value => `<span class="badge ${['OPEN','accepted','active'].includes(value)?'green':['rejected','PAUSED','paused','stale'].includes(value)?'red':['proposed','captured'].includes(value)?'purple':''}">${esc(statusName(value))}</span>`;
  const sourceDate = value => {
    if (!value) return 'неизвестно';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'неизвестно' : parsed.toLocaleString('ru-RU');
  };
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
        ? '<div class="section-note">Глобальные модельные вызовы выключены. Обычная Audience-оценка может выполняться по отдельному конечному разрешению цели и профиля; это может повлечь оплату. Без такого разрешения сбор и предложение выполняются оператором вручную.</div>'
        : '<div class="section-note">Глобальная возможность модельных вызовов включена. Для каждой цели отдельно требуется действующее конечное разрешение на внимание и проверка свежести источников и бюджета. Кнопка «Собрать основание» создаёт операторский снимок. Предложение не принимается автоматически.</div>';
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
    html += attentionPanel(goal);
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
  function hasPendingReassessment(needId) {
    const rows = [...(goal?.assessments ?? []), ...(assessment ? [assessment] : [])];
    return rows.some(a => ['captured','running'].includes(a.status)
      && (a.packet?.reassessment?.need_id ?? a.reassessment?.need_id) === needId);
  }
  function attentionPanel(g) {
    const a = g.attention;
    if (!a || typeof a !== 'object') return '';
    const grants = Array.isArray(a.grants) ? a.grants : [];
    const profiles = Array.isArray(a.profile_options) ? a.profile_options : [];
    const profileRows = profiles.map(profile => {
      const config = profile.model_config && typeof profile.model_config === 'object' ? profile.model_config : {};
      const profileModel = config.model ?? config.model_id ?? 'модель не указана';
      const profileProvider = config.provider ?? 'провайдер не указан';
      const profileEndpoint = config.base_url ?? config.baseUrl ?? 'endpoint не указан';
      return `<article class="lesson">
        <p><strong>Профиль ${esc(profile.label ?? profile.profile_id ?? 'без названия')}</strong> · ${esc(profile.state ?? 'состояние неизвестно')}</p>
        <p>ID: <code>${esc(profile.profile_id ?? 'не указан')}</code> · отпечаток определения: <code>${esc(profile.definition_hash ?? 'не указан')}</code></p>
        <p>Модель: ${esc(profileProvider)} · ${esc(profileModel)} · ${esc(profileEndpoint)}</p>
        <p>Готовность вызова: ${profile.model_ready === true ? 'готов при отдельном разрешении' : 'не готова'} · область цели: <code>${esc(profile.scope_fingerprint ?? 'не указана')}</code></p>
        ${profile.block_reasons?.length ? `<p><strong>Ограничения:</strong> ${esc(profile.block_reasons.join('; '))}</p>` : ''}
        ${profile.state !== 'revoked' && profile.state !== 'stale' && typeof profile.definition_hash === 'string' && profile.definition_hash
          ? button('Отозвать профиль', 'audience-attention-profile-revoke', profile.profile_id, 'danger') : ''}
      </article>`;
    }).join('') || '<p>Профилей для этой цели нет.</p>';
    const rows = grants.map(grant => {
      const boundId = grant.model_profile?.id ?? null;
      const boundProfile = boundId ? profiles.find(profile => profile.profile_id === boundId) : null;
      const boundHash = grant.model_profile?.definition_hash ?? boundProfile?.definition_hash ?? (boundId ? 'не указан' : 'глобальная legacy-модель');
      return `<article class="lesson">
        <p><strong>Разрешение ${esc(grant.id ?? 'не указано')}</strong> · ${esc(grant.status ?? grant.state ?? 'состояние неизвестно')}</p>
        <p>Попытки: использовано ${esc(grant.attempts_used ?? 'неизвестно')} из ${esc(grant.max_attempts ?? 'неизвестно')} · осталось ${esc(grant.remaining_attempts ?? 'неизвестно')} · до ${esc(grant.expires_at ?? 'неизвестно')}.</p>
        <p>Привязка модели: ${boundId ? `профиль ${esc(boundId)} · отпечаток ${esc(boundHash)}` : esc(boundHash)}</p>
        ${grant.status !== 'revoked' && grant.state !== 'revoked' ? button('Отозвать разрешение', 'audience-attention-revoke', grant.id, 'danger') : ''}
      </article>`;
    }).join('') || '<p>Разрешений на модельное внимание для этой цели нет.</p>';
    const allowedBaseUrls = Array.isArray(a.allowed_base_urls) ? a.allowed_base_urls.filter(url => typeof url === 'string' && url.trim()) : [];
    const grantableProfiles = profiles.filter(profile => profile.can_grant === true && profile.model_ready === true
      && profile.state !== 'revoked' && typeof profile.profile_id === 'string'
      && typeof profile.scope_fingerprint === 'string' && profile.scope_fingerprint);
    const canOfferGrant = a.can_grant === true || grantableProfiles.length > 0;
    return panel('Ограниченное модельное внимание', `<p><strong>Настройка модели:</strong> ${a.model_configured === true ? 'провайдер и модель настроены' : 'настройка провайдера не подтверждена'}.</p>
      <p><strong>Готовность вызова:</strong> ${a.model_ready === true ? 'вызов готов при наличии отдельного разрешения' : 'готовность вызова не подтверждена'}.</p>
      <p><strong>Глобальный переключатель:</strong> ${listing?.model_enabled === true ? 'включён' : 'выключен'}. Он независим от разрешения этой цели.</p>
      <p><strong>Локальный credential readiness:</strong> ${a.credential_ready === true ? 'учётные данные готовы; значение ключа скрыто' : a.credential_ready === false ? 'учётные данные не готовы; ключ не запрашивается здесь' : 'готовность учётных данных неизвестна'}.</p>
      <p><strong>Разрешённые model endpoints:</strong> ${allowedBaseUrls.length ? allowedBaseUrls.map(url => esc(url)).join('; ') : 'не указаны'}.</p>
      <p><strong>Разрешение на чтение и актуальность источника:</strong> ${a.source_current === true ? 'подтверждены' : 'не подтверждены'}.</p>
      <p><strong>Готовность цели:</strong> ${a.ready === true ? 'модельная оценка допущена условиями' : 'оценка сейчас не готова'}.</p>
      ${a.block_reasons?.length ? `<p><strong>Ограничения:</strong> ${esc(a.block_reasons.join('; '))}</p>` : ''}
      <p><strong>Отпечаток области действия:</strong> <code>${esc(a.scope_fingerprint ?? 'не указан')}</code></p>
      <h3>Неизменяемые профили модели</h3>${profileRows}
      ${allowedBaseUrls.length ? button('Создать профиль модели', 'audience-attention-profile-create', g.id, 'secondary') : '<p>Создать профиль нельзя: сервер не сообщил разрешённые endpoints.</p>'}
      ${rows}
      ${canOfferGrant ? button('Разрешить ограниченное внимание', 'audience-attention-grant', g.id, 'secondary') : '<p>Новое разрешение сейчас недоступно.</p>'}
      <p class="muted tiny">Разрешение задаёт конечный предел только для этой цели и выбранного профиля. Подтверждение может разрешить платную обычную Audience-оценку; создание профиля само по себе вызовов не делает. Результат остаётся предложением и не принимает гипотезу, не создаёт работу, контакт или отправку. Стоимость может быть неизвестна.</p>`);
  }

  function openAssessmentRetry(a) {
    const retry = a?.retry, target = a?.packet?.reassessment;
    const kind = retry?.kind;
    if (!a || a.id !== selectedAssessment || !['ordinary','focused'].includes(kind)
      || retry.available !== true || !['interrupted','invalid','stale'].includes(a.status)
      || (kind === 'focused') !== (target?.version === 1)
      || !retry.context_fingerprint || !a.basis_fingerprint) {
      throw new Error('Повтор недоступен: обновите оценку и проверьте её актуальность и разрешённость.');
    }
    const commandAction = kind === 'ordinary' ? 'audience.retry_assessment' : 'audience.retry_reassessment';
    const payload = { assessment_id:a.id, expected_basis_fingerprint:a.basis_fingerprint,
      expected_context_fingerprint:retry.context_fingerprint };
    modal('Явный повтор неудачной оценки', `<p>Будет создана одна новая ограниченная попытка без инструментов. Она может повлечь дополнительную оплату; неизвестная стоимость прошлой попытки не считается нулевой. Это не обещание бесплатного запуска или ровно одного HTTP-вызова. Результат останется инертным: повтор не принимает гипотезу и не создаёт работу, контакт или отправку.</p>${field('reason', 'Почему вы явно разрешаете новую попытку', 'textarea')}<small>Укажите причину длиной от 1 до 500 знаков.</small>`, async p => {
      const reason = String(p.reason ?? '').trim();
      if (!reason || reason.length > 500) throw new Error('Укажите причину повтора длиной от 1 до 500 знаков.');
      const result = await command(commandAction, { ...payload, reason });
      selectedAssessment = result.assessment_id;
      if (!selectedAssessment) throw new Error('Сервер не вернул дочернюю оценку. Обновите список оценок.');
      selectedNeed = null;
      await load();
    });
  }
  function reassessmentContextPanel(n) {
    if (!reassessmentContext && !reassessmentError && !reassessmentLoading) {
      return `<div class="actions">${button('Пересмотреть с новым контекстом', 'audience-reassessment-context', n.id, 'secondary')}</div>`;
    }
    if (reassessmentLoading) return '<section class="context-review"><p>Загружаем контекст для пересмотра…</p></section>';
    if (reassessmentError) return `<section class="context-review"><p>Контекст пересмотра недоступен: ${esc(reassessmentError)}</p>${button('Повторить загрузку контекста', 'audience-reassessment-context', n.id, 'secondary')}</section>`;
    const c = reassessmentContext ?? {};
    const priorIds = new Set(c.prior_exchange_ids ?? []), newIds = new Set(c.new_exchange_ids ?? []);
    const exchanges = c.exchanges ?? [];
    const rows = exchanges.map(x => {
      const prior = priorIds.has(x.id), fresh = newIds.has(x.id);
      const origin = prior ? 'Историческое основание' : fresh ? 'Новый контекст' : 'Контекст без указанной группы';
      return `<article class="workspace-evidence"><strong>${esc(origin)} · обмен ${esc(x.id ?? '—')} · ${esc(x.source_ref ?? 'источник не указан')}</strong>
        <p>${x.current === true ? 'Актуальность подтверждена для этого снимка' : 'Актуальность не подтверждена'}${x.reasons?.length ? ` · ${esc(x.reasons.join('; '))}` : ''}</p>
        ${(x.evidence ?? []).map(e => `<p>${esc(e.text ?? 'Свидетельство без текста')}<small>${esc(e.source_event_id ?? '')}${e.message_version ? ` · версия ${esc(e.message_version)}` : ''} · опубликовано ${esc(sourceDate(e.published_at))} · источник изменён ${esc(sourceDate(e.source_updated_at))} · наблюдалось ${esc(sourceDate(e.observed_at))}${e.confirmed_at ? ` · Browser подтвердил ${esc(sourceDate(e.confirmed_at))}` : ''}</small></p>`).join('') || '<p>Свидетельства не приложены.</p>'}</article>`;
    }).join('') || '<p>Обмены для сравнения не предоставлены.</p>';
    const coverage = c.coverage ?? {};
    const omissions = c.omissions ?? c.withheld_exchanges ?? coverage.withheld_exchanges ?? [];
    const pending = hasPendingReassessment(n.id) || c.pending === true || Boolean(c.pending_assessment_id) || Boolean(c.pending_assessment?.id);
    const canRequest = c.model_enabled === true && c.available === true && !pending;
    return `<section class="context-review"><h3>Пересмотр гипотезы с текущим контекстом</h3>
      <p><strong>Отпечаток контекста:</strong> <code>${esc(c.context_fingerprint ?? 'не указан')}</code></p>
      ${c.current === true ? '<p>Контекст и основание актуальны на момент снимка. Существование или решение прежней гипотезы этим не подтверждается.</p>' : '<p>Контекст неполон или требует сверки; это само по себе не означает, что прежняя потребность решена.</p>'}
      ${c.reasons?.length ? `<p><strong>Причины и ограничения:</strong> ${esc(c.reasons.join('; '))}</p>` : ''}
      <p><strong>Границы снимка:</strong> ${esc(c.scope?.selection ?? c.scope ?? 'не указаны')}</p>
      <p><strong>Историческая память гипотезы:</strong> ${esc(c.hypothesis_memory?.hypothesis ?? n.hypothesis ?? '')}. Это прежняя интерпретация, а не подтверждённый факт и не подсказка о том, что потребность всё ещё существует. Текущее состояние разрешения: ${esc(c.hypothesis_memory?.resolution ?? 'неизвестно')}.</p>
      <p><strong>Сравнение старого и нового контекста:</strong> исторических обменов ${esc((c.prior_exchange_ids ?? []).length)} · новых обменов ${esc((c.new_exchange_ids ?? []).length)} · всего показано ${esc(exchanges.length)}.</p>${rows}
      <p class="muted tiny"><strong>Ограниченный охват:</strong> ${esc(coverage.selection ?? 'не указан')} · максимум ${esc(coverage.batch_exchanges ?? 'неизвестен')} обменов · на источник ${esc(coverage.source_capacity ?? 'неизвестно')} · полнота ${esc(coverage.source_completeness ?? 'неизвестна')}.</p>
      <p class="muted tiny">Обмены, не вошедшие в снимок: ${esc(coverage.omitted_sample_exchanges ?? omissions.length)}.</p>
      ${omissions.length ? `<p><strong>Пропуски и исключения (показано до 8):</strong></p>${omissions.slice(0,8).map(x => `<article class="workspace-evidence"><strong>${esc(x.source_ref ?? 'Источник')} · ${esc(x.id ?? 'обмен')}</strong><p>${esc((x.reasons ?? []).join('; ') || x.reason || 'Причина не указана')}</p></article>`).join('')}` : '<p class="muted tiny">Список пропусков не предоставлен; это не доказывает полноту охвата.</p>'}
      <p class="section-note">Модельные вызовы ${c.model_enabled === true ? 'включены' : 'выключены'}. Этот просмотр не принимает гипотезу, не одобряет материал и не выдаёт разрешение на контакт или отправку.</p>
      <div class="actions">${canRequest ? button('Запросить пересмотр с этим контекстом', 'audience-reassess', n.id, 'primary') : pending ? '<span>Пересмотр уже ожидает или выполняется.</span>' : '<span>Запрос модели недоступен: контекст недоступен или модели выключены.</span>'}</div>
    </section>`;
  }
  function needPanel(n) {
    const current = n.current === true;
    const accepted = n.status === 'accepted';
    const ev = n.evidence_event_ids ?? [];
    const counter = n.counterevidence_event_ids ?? [];
    const exchanges = n.exchange_ids ?? [];
    const quotes = n.support_quotes ?? [];
    const evidenceById = new Map((assessment?.packet?.exchanges ?? []).flatMap(x => x.evidence ?? []).map(x => [x.source_event_id, x]));
    const exchangeById = new Map((assessment?.packet?.exchanges ?? []).map(x => [x.id, x]));
    const refs = ids => ids.map(id => {
      const e = evidenceById.get(id);
      return `<article class="workspace-evidence"><p>${esc(e?.text ?? 'Текст не сохранён в доступном снимке.')}</p><small>${esc(id)}${e?.source_ref ? ` · ${esc(e.source_ref)}` : ''} · опубликовано ${esc(sourceDate(e?.published_at))} · источник изменён ${esc(sourceDate(e?.source_updated_at))} · наблюдалось ${esc(sourceDate(e?.observed_at))}</small></article>`;
    }).join('') || '<p>Нет привязанных событий.</p>';
    const contextVersion = n.proposal_version === 2;
    const context = contextVersion ? `<section class="context-review"><h3>Контекст предоставленного снимка</h3>
      <p class="muted tiny">Все обмены из ограниченного снимка классифицированы. Это не подтверждает полноту исходного источника.</p>
      ${(n.context_review ?? []).map(row => {
        const labels = { supporting:'Поддерживает', related:'Связанный контекст', counterevidence:'Контрсвидетельство', uncertain:'Неопределённый контекст', unrelated:'Не относится' };
        const exchange = exchangeById.get(row.exchange_id);
        const selected = row.evidence_event_ids ?? [];
        return `<article class="workspace-evidence"><strong>${esc(labels[row.classification] ?? row.classification ?? 'Классификация не указана')} · обмен ${esc(row.exchange_id ?? '—')}</strong>
          ${exchange ? `<p>${esc(exchange.source_ref ?? '')} · ${exchange.current === true ? 'был актуален при сборе' : 'требовал сверки при сборе'}</p>` : '<p>Обмен отсутствует в доступном снимке.</p>'}
          <p>${esc(row.reason ?? 'Обоснование не указано')}</p>
          ${selected.length ? selected.map(id => { const e = evidenceById.get(id); return `<blockquote>${esc(e?.text ?? 'Выбранная цитата недоступна в снимке.')}<small> · событие ${esc(id)}</small></blockquote>`; }).join('') : '<small>Выбранные цитаты: нет.</small>'}</article>`;
      }).join('') || '<p>Классификации контекста не сохранены.</p>'}</section>`
      : '<div class="section-note">Историческое предложение версии 1: в записи нет зафиксированной проверки полного контекста или предпросмотра материала.</div>';
    const preview = contextVersion && n.material_preview ? `<section class="material-preview"><h3>Предпросмотр предлагаемого материала</h3>
      <p><strong>${esc(n.material_preview.title ?? 'Без названия')}</strong></p>
      <pre class="workspace-pre">${esc(n.material_preview.content ?? '')}</pre>
      <p><strong>SHA-256:</strong> <code>${esc(n.preview_sha256 ?? 'не указан сервером')}</code></p>
      <p class="muted tiny">Это точный предпросмотр для рассмотрения, ещё не проверен владельцем и не является действием или отправкой.</p>
      ${(n.material_preview.evidence_event_ids ?? []).length ? `<p><strong>Цитаты материала:</strong> ${esc(n.material_preview.evidence_event_ids.join(', '))}</p>` : '<p>Цитаты материала не указаны.</p>'}
      <p><strong>Полное основание материала:</strong> ${esc((n.preview_basis_event_ids ?? []).join(', ') || 'не подтверждено сервером')}. Связанный контекст сохраняется независимо от списка цитат модели.</p>
      ${n.linked_work_case?.id ? `<p><strong>Связанное дело Work:</strong> ${esc(n.linked_work_case.id)} · ревизия ${esc(n.linked_work_case.revision ?? '—')} · ${n.linked_work_case.current === true ? 'актуально' : 'не подтверждено'}</p>` : '<p>Дело Work не связано.</p>'}
      <p class="muted tiny">Импорт добавит точный текст как предложенный материал в открытое дело Work. Он всё ещё требует проверки материала в Work и отдельного разрешения Action.</p>
      ${current && accepted && n.linked_work_case?.current === true && n.linked_work_case?.id && n.preview_sha256 ? button('Импортировать предпросмотр в дело Work', 'audience-import-preview', n.id, 'secondary') : ''}</section>`
      : contextVersion ? '<section class="material-preview"><h3>Предпросмотр материала</h3><p>Предпросмотр не сохранён.</p></section>' : '';
    return panel(n.title ?? 'Потребность', `<p>${badge(n.status)} · ревизия ${esc(n.revision ?? '—')} · ${current ? 'основание актуально' : 'основание неактуально'}</p>
      <p><strong>Эпистемический статус:</strong> ${esc(n.epistemic_status ?? 'не указан')}</p>
      <p><strong>Гипотеза:</strong> ${esc(n.hypothesis ?? '')}</p><p><strong>Почему сейчас:</strong> ${esc(n.why_now ?? 'Не указано')}</p>
      <p><strong>Возможный следующий шаг:</strong> ${esc(n.next_step ?? 'Не указан')}</p><p><strong>Основание:</strong> ${esc(n.reason ?? 'Не указано')}</p>
      <p><strong>Неизвестно:</strong> ${esc((n.unknowns ?? []).join('; ') || 'Не указано')}</p>
      <p><strong>Точные цитаты-основания:</strong></p>${quotes.map(q => `<blockquote>${esc(q.quote)}<small> · событие ${esc(q.source_event_id)}</small></blockquote>`).join('') || '<p>Цитаты отсутствуют.</p>'}
      <p><strong>Поддерживающие события:</strong></p>${refs(ev)}<p><strong>Контрсвидетельства:</strong></p>${refs(counter)}<p><strong>Связанные обмены:</strong> ${esc(exchanges.join(', ') || 'нет ссылок')}</p>
      ${context}
      ${reassessmentContextPanel(n)}
      ${preview}
      <p><strong>Актуальность основания:</strong> ${current ? 'ссылки и основание актуальны по сохранённой проверке; существование нерешённой проблемы этим не подтверждается' : esc((n.reasons ?? []).join('; ') || 'не подтверждена')}</p>
      <p class="muted tiny">Это гипотеза для рассмотрения. Принятие её не предоставляет разрешение на контакт или отправку. Для Continuity должна быть включена отдельная конфигурация.</p>
      <div class="actions">${current && n.status === 'proposed' ? button('Принять гипотезу', 'audience-accept', n.id, 'primary') : ''}
      ${['proposed','stale'].includes(n.status) ? button('Отклонить', 'audience-reject', n.id, 'danger') : ''}
      ${current && accepted ? button(n.thread_id ? 'Обновить предложение Continuity' : 'Открыть работу в Continuity', n.thread_id ? 'audience-refresh-work' : 'audience-open-work', n.id, 'secondary') : ''}</div>`);
  }
  function validDecisionReview(review, exchanges) {
    if (!review || typeof review !== 'object' || Array.isArray(review) || review.version !== 1
      || review.scope !== 'supplied_packet_only' || !['needs_proposed','no_need_proposed'].includes(review.disposition)
      || !decisionText(review.summary, 1000) || !Array.isArray(review.unknowns)
      || review.unknowns.length < 1 || review.unknowns.length > 8
      || !review.unknowns.every(value => decisionText(value, 1000)) || !Array.isArray(review.exchange_reviews)
      || review.exchange_reviews.length < 1 || review.exchange_reviews.length > 8
      || review.exchange_reviews.length !== exchanges.length) return false;
    const byId = new Map(exchanges.map(exchange => [exchange.id, exchange]));
    const seen = new Set();
    for (const row of review.exchange_reviews) {
      const exchange = byId.get(row?.exchange_id);
      if (!exchange || seen.has(row.exchange_id) || !['relevant','no_proposal','uncertain'].includes(row.judgment)
        || typeof row.exchange_id !== 'string' || row.exchange_id.length > 36
        || !decisionText(row.reason, 1000) || !Array.isArray(row.evidence_event_ids)
        || row.evidence_event_ids.length < 1 || row.evidence_event_ids.length > 32
        || !row.evidence_event_ids.every(decisionEventId)
        || new Set(row.evidence_event_ids).size !== row.evidence_event_ids.length
        || !Array.isArray(row.support_quotes) || row.support_quotes.length < 1 || row.support_quotes.length > 32) return false;
      seen.add(row.exchange_id);
      const evidence = new Map((exchange.evidence ?? []).map(item => [item.source_event_id, item]));
      if (!row.evidence_event_ids.every(eventId => evidence.has(eventId))) return false;
      const quotedRefs = new Set();
      for (const citation of row.support_quotes) {
        const item = evidence.get(citation?.source_event_id);
        if (!item || !row.evidence_event_ids.includes(citation.source_event_id)
          || !decisionEventId(citation.source_event_id) || !decisionText(citation.quote, 2000)
          || typeof item.text !== 'string' || !item.text.includes(citation.quote)) return false;
        quotedRefs.add(citation.source_event_id);
      }
      if (!row.evidence_event_ids.every(eventId => quotedRefs.has(eventId))) return false;
    }
    return seen.size === exchanges.length;
  }
  function decisionText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /\S/.test(value);
  }
  function decisionEventId(value) {
    return typeof value === 'string' && value.length <= 20 && /^[1-9][0-9]*$/.test(value);
  }
  function decisionReviewPanel(a, exchanges) {
    const metadata = a.decision_review;
    const state = metadata?.state;
    const pending = ['captured','running'].includes(a.status);
    const valid = ['current','stale'].includes(state) && validDecisionReview(metadata.review, exchanges)
      && metadata.epistemic_status === 'unverified_model_interpretation'
      && metadata.resolution === 'unknown' && metadata.scope === 'supplied_packet_only'
      && ((state === 'current') === (a.current === true));
    const notRecorded = state === 'not_recorded' && metadata.review === null
      && metadata.epistemic_status === 'unverified_model_interpretation'
      && metadata.resolution === 'unknown' && metadata.scope === 'supplied_packet_only';
    if (state === 'stale' && metadata.review === null && a.current === false
      && metadata.epistemic_status === 'unverified_model_interpretation'
      && metadata.resolution === 'unknown' && metadata.scope === 'supplied_packet_only') {
      return `<section class="context-review"><h3>Решение модели</h3><p>Ответ не применён: основание устарело; объяснение решения не записано.</p><p class="muted tiny">Результат не относится к текущему основанию. Неизвестно, решена ли потребность.</p></section>`;
    }
    if (state === 'invalid' || (['current','stale'].includes(state) && !valid)
      || state === 'not_recorded' && !notRecorded
      || !['current','stale','invalid','not_recorded'].includes(state)) {
      return `<section class="context-review"><h3>Решение модели</h3><p>Объяснение решения не прошло проверку и скрыто.</p><p class="muted tiny">Неизвестно, решена ли потребность. Решение модели не подтверждено и не выходит за пределы предоставленного снимка.</p></section>`;
    }
    if (!valid) {
      const message = pending
        ? 'Оценка ещё выполняется; объяснение решения пока не записано.'
        : 'Объяснение решения не записано для этой исторической оценки.';
      return `<section class="context-review"><h3>Решение модели</h3><p>${message}</p><p class="muted tiny">Пустой результат без записанного обоснования не позволяет заключить, почему модель воздержалась. Неизвестно, решена ли потребность.</p></section>`;
    }
    const review = metadata.review;
    const exchangeById = new Map(exchanges.map(exchange => [exchange.id, exchange]));
    const evidenceById = new Map(exchanges.flatMap(exchange => exchange.evidence ?? []).map(item => [item.source_event_id, item]));
    const rows = review.exchange_reviews.map(row => {
      const exchange = exchangeById.get(row.exchange_id);
      const judgment = { relevant:'Связано с целью', no_proposal:'Не поддерживает предложение', uncertain:'Неопределённо' }[row.judgment];
      const citations = row.support_quotes.map(citation => {
        const item = evidenceById.get(citation.source_event_id);
        return `<blockquote>${esc(citation.quote)}<small> · событие ${esc(citation.source_event_id)} · опубликовано ${esc(sourceDate(item.published_at))} · источник изменён ${esc(sourceDate(item.source_updated_at))} · наблюдалось ${esc(sourceDate(item.observed_at))}</small></blockquote>`;
      }).join('') || '<small>Точная цитата не указана.</small>';
      return `<article class="workspace-evidence"><strong>${esc(judgment)} · обмен ${esc(exchange.id)} · ${esc(exchange.source_ref ?? 'источник не указан')}</strong><p>${esc(row.reason)}</p>${citations}</article>`;
    }).join('');
    const stale = state === 'stale';
    const disposition = review.disposition === 'no_need_proposed' ? 'Потребность не предложена.' : 'Предложена гипотеза для отдельного рассмотрения.';
    return `<section class="context-review"><h3>Решение модели по предоставленному снимку</h3>
      <p><strong>${disposition}</strong> ${stale ? 'Историческое объяснение сохранено; основание устарело.' : 'Объяснение относится к текущему сохранённому основанию.'}</p>
      <p>${esc(review.summary)}</p>
      <p><strong>Неизвестно, решена ли потребность.</strong> Это непроверенная интерпретация модели, а не вывод о полном источнике или подтверждение результата.</p>
      <p>Гипотеза не является решением владельца и сама по себе не разрешает принятие, работу, контакт или отправку.</p>
      <p><strong>Охват:</strong> только предоставленный снимок (${exchanges.length} обменов). Полнота источника неизвестна.</p>
      ${review.unknowns.length ? `<p><strong>Неизвестно:</strong> ${esc(review.unknowns.join('; '))}</p>` : ''}
      ${rows || '<p>Обменов в сохранённом снимке нет.</p>'}
    </section>`;
  }
  function assessmentPanel(a) {
    const packet = a.packet;
    const exchanges = packet?.exchanges ?? [];
    const evidenceCount = exchanges.reduce((n, x) => n + (x.evidence?.length ?? 0), 0);
    const target = packet?.reassessment;
    const focused = target?.version === 1;
    const ordinaryRetry = packet?.reasoning_retry?.version === 1;
    const emptyReassessment = focused && Array.isArray(a.output?.needs) && a.output.needs.length === 0;
    const retryOf = target?.retry_of ?? packet?.reasoning_retry?.retry_of;
    const retry = a.retry;
    const retryAction = retry?.kind === 'ordinary' ? 'audience-retry-assessment'
      : retry?.kind === 'focused' ? 'audience-retry-reassessment' : null;
    const receipt = a.attempt_receipt;
    const reviewHtml = decisionReviewPanel(a, exchanges);
    const packetWithheld = packet?.withheld_exchanges ?? packet?.coverage?.withheld_exchanges;
    const withheldSample = Array.isArray(packetWithheld) ? packetWithheld.slice(0, 8) : [];
    const withheldReasons = new Map();
    for (const item of withheldSample) for (const reason of new Set(Array.isArray(item?.reasons)
      ? item.reasons.filter(reason => typeof reason === 'string' && reason.trim()) : []))
      withheldReasons.set(reason, (withheldReasons.get(reason) ?? 0) + 1);
    const withheldReasonText = [...withheldReasons].map(([reason, count]) => `${esc(reason)} (${count})`).join(', ') || 'коды причин не указаны';
    const omittedSample = packet?.coverage?.omitted_sample_exchanges;
    const coverageHtml = packet ? `<p class="muted tiny"><strong>Охват пакета:</strong> включено ${exchanges.length} обменов. В ограниченном списке исключённых обменов — ${withheldSample.length} (не более 8 показанных записей); причины в этом списке: ${withheldReasonText}. Общее число исключённых или ожидающих обменов неизвестно; полнота источника неизвестна.
      ${Number.isSafeInteger(omittedSample) && omittedSample >= 0 ? `В ограниченном окне пересмотра ${omittedSample} кандидатов не вошли в пакет; это не полный backlog источника.` : ''}</p>` : '';
    const safeOutput = a.output && typeof a.output === 'object' && !Array.isArray(a.output)
      ? Object.fromEntries(Object.entries(a.output).filter(([key]) => key !== 'decision_review')) : a.output;
    const receiptInteger = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'неизвестно';
    const receiptHtml = receipt && typeof receipt === 'object' ? `<section class="context-review"><h3>Квитанция попытки модели</h3>
      <p>Запуск ${esc(receipt.run_id ?? 'не указан')} · состояние ${esc(receipt.status ?? 'неизвестно')} · вызовы API: ${receiptInteger(receipt.model_api_calls)}.</p>
      <p>Токены: вход ${receiptInteger(receipt.input_tokens)}, выход ${receiptInteger(receipt.output_tokens)}${receipt.usage_status === 'unknown' ? ' · использование неизвестно' : ''}.</p>
      <p>${receipt.cost_status === 'unknown' || !Number.isFinite(receipt.estimated_cost_usd) || receipt.estimated_cost_usd < 0
        ? 'Стоимость этой попытки неизвестна; её нельзя считать нулевой.'
        : `Оценка стоимости: $${esc(receipt.estimated_cost_usd.toFixed(6))} (${esc(receipt.cost_status)}).`}</p>
      ${receipt.failure_cause ? `<p>Нормализованная причина сбоя: ${esc(receipt.failure_cause.kind ?? 'неизвестно')}${receipt.failure_cause.provider_error_type ? ` · ${esc(receipt.failure_cause.provider_error_type)}` : ''}.</p>` : ''}
      <p class="muted tiny">Эта попытка не разрешает отправку или другие внешние действия. Отображается только закрытая квитанция; текст ошибки провайдера не используется.</p>
    </section>` : '';
    const retryDisplayable = retryAction || (focused && retry && retry.available !== true);
    const retryHtml = ['interrupted','invalid','stale'].includes(a.status) && retryDisplayable && retry && typeof retry === 'object'
      ? `<section class="context-review"><h3>Повтор неудачной оценки</h3>
        <p>Тип попытки: ${retry.kind === 'ordinary' ? 'обычная оценка цели' : 'пересмотр гипотезы'}.</p>
        ${retryOf ? `<p>Родительская оценка: ${esc(retryOf.assessment_id ?? 'не указана')} · отпечаток попытки ${esc(retryOf.basis_fingerprint ?? 'не указан')}.</p>` : ''}
        ${retry.child_assessment?.id ? `<p>Дочерняя оценка: ${esc(retry.child_assessment.id)} · ${badge(retry.child_assessment.status)}</p>` : ''}
        ${retry.available === true
          ? '<p>Можно явно запросить одну новую ограниченную попытку без инструментов. Ответ модели останется инертным предложением.</p>'
          : `<p>Повтор недоступен: ${esc((retry.reasons ?? []).join('; ') || 'причина не указана')}.</p>`}
        ${retry.available === true && retryAction ? button('Повторить оценку', retryAction, a.id, 'secondary') : ''}
      </section>` : '';
    return panel(focused ? 'Пересмотр гипотезы' : 'Основание сбора', `<p>Состояние: ${badge(a.status)} · ID ${esc(a.id ?? '')}</p>
      ${focused ? `<p>Цель пересмотра: потребность ${esc(target.need_id ?? '—')} · ревизия ${esc(target.need_revision ?? '—')} · контекст ${esc(target.context_fingerprint ?? '—')}</p><p class="muted tiny">Новая оценка ограничена зафиксированным контекстом. Она не одобряет прежнюю гипотезу и не разрешает контакт.</p>` : ''}
      ${retryOf ? `<p>Линия повтора: дочерняя оценка ${esc(a.id)} создана по явному запросу для родителя ${esc(retryOf.assessment_id ?? 'не указан')} (отпечаток родителя ${esc(retryOf.basis_fingerprint ?? 'не указан')}).</p>` : ''}
      ${packet ? `<p>Актуальность: ${a.current === true ? 'текущая' : a.current === false ? 'устарела' : 'не указана'}</p>
        <p><strong>Обмены (${exchanges.length}), свидетельства (${evidenceCount}):</strong></p>${exchanges.map(x => `<article class="workspace-evidence"><strong>Обмен ${esc(x.id)} · ${esc(x.source_ref)}</strong><p>${x.current === true ? 'Текущий' : 'Требует сверки'}${x.reasons?.length ? ` · ${esc(x.reasons.join('; '))}` : ''}</p>${(x.evidence ?? []).map(e => `<p>${esc(e.text ?? 'Свидетельство без текста')}<small>${esc(e.source_event_id ?? '')}${e.message_version ? ` · версия ${esc(e.message_version)}` : ''} · опубликовано ${esc(sourceDate(e.published_at))} · источник изменён ${esc(sourceDate(e.source_updated_at))} · наблюдалось ${esc(sourceDate(e.observed_at))}${e.confirmed_at ? ` · Browser подтвердил ${esc(sourceDate(e.confirmed_at))}` : ''}</small></p>`).join('')}</article>`).join('') || '<p>Свидетельства не приложены.</p>'}
        ${packet.unknowns?.length ? `<p><strong>Неизвестно:</strong> ${esc(packet.unknowns.join('; '))}</p>` : ''}` : '<p>Снимок основания не возвращён.</p>'}
      ${emptyReassessment ? '<p><strong>Новая интерпретация не предложена; прежняя находка не признана решённой.</strong></p>' : ''}
      ${coverageHtml}${reviewHtml}
      ${safeOutput ? `<details><summary>${Array.isArray(safeOutput.needs) && safeOutput.needs.length === 0 ? 'Сохранённый ответ модели' : 'Сохранённое предложение'}</summary><pre class="workspace-pre">${esc(JSON.stringify(safeOutput, null, 2))}</pre></details>` : ''}
      ${receiptHtml}${retryHtml}
      <div class="actions">${focused && ['captured','running'].includes(a.status) ? button('Отменить пересмотр', 'audience-cancel-reassessment', a.id, 'danger') : ''}${ordinaryRetry && ['captured','running'].includes(a.status) ? button('Отменить обычную попытку', 'audience-cancel-assessment', a.id, 'danger') : ''}${!focused && !ordinaryRetry && a.status === 'captured' && a.current === true ? button('Внести гипотезу вручную', 'audience-propose', a.id, 'primary') : ''}</div>`);
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
    if (action === 'audience-goal') { selectedGoal = id; selectedNeed = selectedAssessment = null; reassessmentContext = reassessmentContextGuard = null; reassessmentError = ''; await load(); return; }
    if (action === 'audience-need') { selectedNeed = id; selectedAssessment = null; reassessmentContext = reassessmentContextGuard = null; reassessmentError = ''; await load(); return; }
    if (action === 'audience-assessment') { selectedAssessment = id; selectedNeed = null; await load(); return; }
    if (action === 'audience-next') { cursor = listing?.next_cursor ?? ''; await load(); return; }
    if (!goal) throw new Error('Сначала откройте цель.');
    if (action === 'audience-attention-profile-create') {
      const current = goal, attention = current.attention;
      const allowed = Array.isArray(attention?.allowed_base_urls)
        ? [...new Set(attention.allowed_base_urls.filter(url => typeof url === 'string' && url.trim()))] : [];
      if (current.id !== id || !allowed.length) throw new Error('Нет разрешённого сервером endpoint для профиля. Обновите цель.');
      const frozen = { goal_id:current.id, expected_revision:current.revision };
      const content = '<p>Профиль — неизменяемая запись настроек. Его создание не запускает модель и не списывает средства. Секреты и произвольные адреса здесь не принимаются.</p>'
        + field('label', 'Название профиля') + field('provider', 'Совместимый endpoint', 'select', 'custom', [['custom','OpenAI-compatible / CLIProxyAPI']])
        + field('api_mode', 'Режим API', 'select', 'chat_completions', [['chat_completions','Chat Completions'],['responses','Responses']])
        + field('base_url', 'Разрешённый endpoint', 'select', allowed[0], allowed.map(url => [url,url]))
        + field('model', 'Модель') + field('max_output_tokens', 'Лимит выходных токенов', 'number', '2048')
        + field('input_usd_per_million', 'Цена входа USD за миллион токенов (необязательно)', 'number')
        + field('output_usd_per_million', 'Цена выхода USD за миллион токенов (необязательно)', 'number')
        + '<p class="muted tiny">Учётные данные не вводятся и остаются в локальной конфигурации. Настройки глобальной модели не меняются.</p>';
      modal('Создать неизменяемый профиль модели', content, async p => {
        const baseUrl = String(p.base_url ?? '').trim();
        if (!allowed.includes(baseUrl)) throw new Error('Выберите endpoint из актуального серверного списка.');
        const label = String(p.label ?? '').trim(), provider = String(p.provider ?? '').trim();
        const model = String(p.model ?? '').trim(), apiMode = String(p.api_mode ?? '');
        const maxOutputTokens = Number(p.max_output_tokens);
        const optionalPrice = value => value === '' || value == null ? null : Number(value);
        const inputPrice = optionalPrice(p.input_usd_per_million), outputPrice = optionalPrice(p.output_usd_per_million);
        if (!label || label.length > 100 || provider !== 'custom'
          || !model || model.length > 200 || !['chat_completions','responses'].includes(apiMode)
          || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 16000
          || [inputPrice,outputPrice].some(price => price !== null && (!Number.isFinite(price) || price < 0 || price > 1000000))) {
          throw new Error('Проверьте название, провайдера, режим, модель, лимит и необязательные цены.');
        }
        if (goal?.id !== frozen.goal_id || goal?.revision !== frozen.expected_revision) throw new Error('Цель изменилась. Обновите её перед созданием профиля.');
        await command('model.profile_create', { label, provider, api_mode:apiMode, base_url:baseUrl,
          model, max_output_tokens:maxOutputTokens, input_usd_per_million:inputPrice,
          output_usd_per_million:outputPrice });
        await load();
      }); return;
    }
    if (action === 'audience-attention-profile-revoke') {
      const profile = (goal.attention?.profile_options ?? []).find(row => row.profile_id === id);
      if (!profile || !profile.definition_hash || ['revoked','stale'].includes(profile.state)) {
        throw new Error('Этот профиль нельзя отозвать из текущего состояния цели.');
      }
      const frozen = { profile_id:profile.profile_id, expected_definition_hash:profile.definition_hash };
      modal('Отозвать профиль модели', '<p>Отзыв запретит использовать профиль в новых разрешениях и вызовах. Исторические записи сохранятся.</p>'
        + field('reason', 'Причина отзыва', 'textarea'), async p => {
        const reason = String(p.reason ?? '').trim();
        if (!reason || reason.length > 500) throw new Error('Укажите причину отзыва длиной от 1 до 500 знаков.');
        await command('model.profile_revoke', { ...frozen, reason });
        await load();
      }); return;
    }
    if (action === 'audience-attention-grant') {
      const current = goal, attention = current.attention;
      if (current.id !== id || !attention) throw new Error('Разрешение недоступно: обновите цель.');
      const profiles = Array.isArray(attention.profile_options) ? attention.profile_options : [];
      const choices = profiles.filter(profile => profile.can_grant === true && profile.model_ready === true
        && profile.state !== 'revoked' && typeof profile.profile_id === 'string'
        && typeof profile.scope_fingerprint === 'string' && profile.scope_fingerprint);
      const legacyAvailable = attention.can_grant === true && typeof attention.scope_fingerprint === 'string' && attention.scope_fingerprint;
      if (!choices.length && !legacyAvailable) throw new Error('Нет готовой модели с актуальным основанием для разрешения.');
      const options = [
        ['', 'Выберите модель для этого разрешения'],
        ...(legacyAvailable ? [['legacy','Глобальная legacy-модель']] : []),
        ...choices.map(profile => [profile.profile_id, `${profile.label ?? profile.profile_id} · ${profile.profile_id} · ${profile.definition_hash ?? 'без хеша'}`]),
      ];
      // Preserve the existing one-click legacy path only when there is no
      // scoped profile to choose; when profiles exist the operator must pick.
      const defaultProfile = choices.length === 0 && legacyAvailable ? 'legacy' : '';
      const frozen = { goal_id:current.id, expected_revision:current.revision };
      const defaultExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      modal('Ограниченное модельное внимание для цели', `<p>Разрешение привязано к выбранной цели, профилю и числу попыток. Подтверждение само не отправляет запрос напрямую, но может допустить модельный вызов при ближайшем обычном Audience-проходе. Он может повлечь оплату. Глобальные переключатели не меняются; свежесть источника и бюджеты проверяются отдельно.</p>${field('model_profile_id', 'Модельный профиль', 'select', defaultProfile, options)}${field('max_attempts', 'Максимум попыток (1–50)', 'number', '1')}${field('expires_at', 'Истекает (ISO 8601 UTC, не более чем через 7 дней)', 'text', defaultExpiry)}${field('reason', 'Причина разрешения', 'textarea')}<p class="muted tiny">Стоимость может быть неизвестна. Результат остаётся предложением владельцу: это не принимает гипотезу, не создаёт работу, контакт и не разрешает отправку.</p>`, async p => {
        const maxAttempts = Number(p.max_attempts);
        const expiresAt = String(p.expires_at ?? '').trim();
        const expiresMs = Date.parse(expiresAt);
        const reason = String(p.reason ?? '').trim();
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) {
          throw new Error('Укажите целое число попыток от 1 до 50.');
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) || !Number.isFinite(expiresMs)
          || expiresMs <= Date.now() || expiresMs > Date.now() + 7 * 24 * 60 * 60 * 1000) {
          throw new Error('Укажите будущую дату ISO 8601 с часовым поясом, не более чем через семь дней.');
        }
        if (!reason || reason.length > 500) throw new Error('Укажите причину длиной от 1 до 500 знаков.');
        const selectedProfileId = String(p.model_profile_id ?? defaultProfile);
        if (!selectedProfileId) throw new Error('Выберите модель для этого ограниченного разрешения.');
        const payload = { ...frozen, max_attempts:maxAttempts, expires_at:expiresAt, reason };
        if (selectedProfileId === 'legacy') {
          if (!legacyAvailable) throw new Error('Глобальное разрешение устарело. Обновите цель.');
          payload.expected_scope_fingerprint = attention.scope_fingerprint;
        } else {
          const selected = choices.find(profile => profile.profile_id === selectedProfileId);
          if (!selected) throw new Error('Выбранный профиль больше не готов. Обновите цель.');
          payload.model_profile_id = selected.profile_id;
          payload.expected_scope_fingerprint = selected.scope_fingerprint;
        }
        if (goal?.id !== frozen.goal_id || goal?.revision !== frozen.expected_revision) throw new Error('Цель изменилась. Обновите её перед разрешением.');
        await command('audience.attention_grant', payload);
        await load();
      }); return;
    }
    if (action === 'audience-attention-revoke') {
      const grant = (goal.attention?.grants ?? []).find(row => row.id === id);
      if (!grant || grant.status === 'revoked' || grant.state === 'revoked' || typeof grant.grant_fingerprint !== 'string'
        || !grant.grant_fingerprint) throw new Error('Это разрешение нельзя отозвать из текущего состояния цели.');
      const frozen = { grant_id:grant.id, expected_grant_fingerprint:grant.grant_fingerprint };
      modal('Отозвать разрешение модельному вниманию', `<p>Отзыв остаётся доступен, даже если модель выключена, источник изменился или разрешение истекло.</p>${field('reason', 'Причина отзыва', 'textarea')}`, async p => {
        const reason = String(p.reason ?? '').trim();
        if (!reason || reason.length > 500) throw new Error('Укажите причину отзыва длиной от 1 до 500 знаков.');
        await command('audience.attention_revoke', { ...frozen, reason });
        await load();
      }); return;
    }
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
    if (action === 'audience-reassessment-context') {
      if (!need || need.id !== id) throw new Error('Сначала откройте гипотезу.');
      reassessmentLoading = true; reassessmentError = '';
      try {
        reassessmentContext = await api(`/api/audience/needs/${encodeURIComponent(need.id)}/context`);
        reassessmentContextGuard = { goal_id: goal.id, goal_revision: goal.revision, need_id: need.id,
          need_revision: reassessmentContext.need_revision, need_basis_fingerprint: reassessmentContext.need_basis_fingerprint,
          listing_model_enabled: listing?.model_enabled === true };
      }
      catch (e) { reassessmentContext = null; reassessmentError = e.message; }
      finally { reassessmentLoading = false; }
      return;
    }
    if (action === 'audience-reassess') {
      if (!need || need.id !== id || !reassessmentContext) throw new Error('Сначала загрузите текущий контекст гипотезы.');
      const c = await api(`/api/audience/needs/${encodeURIComponent(need.id)}/context`);
      const loaded = reassessmentContext;
      const changed = c.need_id !== loaded.need_id || c.need_revision !== loaded.need_revision
        || c.need_basis_fingerprint !== loaded.need_basis_fingerprint || c.context_fingerprint !== loaded.context_fingerprint
        || c.model_enabled !== loaded.model_enabled || c.available !== loaded.available
        || c.scope?.revision !== loaded.scope?.revision || c.need_id !== need.id
        || c.need_revision !== need.revision || c.need_basis_fingerprint !== need.basis_fingerprint
        || c.scope?.revision !== goal.revision;
      reassessmentContext = c;
      reassessmentContextGuard = { goal_id: goal.id, goal_revision: c.scope?.revision, need_id: c.need_id,
        need_revision: c.need_revision, need_basis_fingerprint: c.need_basis_fingerprint,
        listing_model_enabled: listing?.model_enabled === true };
      if (changed) throw new Error('Контекст или настройки изменились после просмотра. Проверьте обновлённый контекст перед запросом.');
      const pending = hasPendingReassessment(need.id) || c.pending === true || Boolean(c.pending_assessment_id) || Boolean(c.pending_assessment?.id);
      if (c.model_enabled !== true || c.available !== true || pending) {
        throw new Error('Пересмотр недоступен: модель выключена, контекст недоступен или уже ожидается другой пересмотр.');
      }
      const result = await command('audience.reassess', { need_id: c.need_id, expected_revision: c.need_revision,
        expected_basis_fingerprint: c.need_basis_fingerprint, expected_context_fingerprint: c.context_fingerprint });
      selectedAssessment = result.assessment_id ?? result.id;
      await load(); return;
    }
    if (action === 'audience-cancel-reassessment') {
      const a = assessment;
      const target = a?.packet?.reassessment;
      if (!a || a.id !== id || target?.version !== 1 || !['captured','running'].includes(a.status)) {
        throw new Error('Отменить можно только ожидающий или выполняющийся пересмотр для открытой оценки.');
      }
      await command('audience.cancel_reassessment', { assessment_id: a.id,
        // Bind cancellation to the immutable captured assessment, even when
        // later source observations have advanced the live context.
        expected_basis_fingerprint: a.basis_fingerprint });
      await load(); return;
    }
    if (action === 'audience-cancel-assessment') {
      const a = assessment;
      if (!a || a.id !== id || a.packet?.reasoning_retry?.version !== 1
        || !['captured','running'].includes(a.status)) {
        throw new Error('Отменить можно только ожидающую или выполняющуюся обычную попытку повтора.');
      }
      await command('audience.cancel_assessment', { assessment_id:a.id,
        expected_basis_fingerprint:a.basis_fingerprint });
      await load(); return;
    }
    if (action === 'audience-retry-reassessment' || action === 'audience-retry-assessment') {
      if (!assessment || assessment.id !== id) throw new Error('Сначала откройте неудачную оценку.');
      openAssessmentRetry(assessment); return;
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
    if (action === 'audience-import-preview') {
      const n = need;
      const linked = n.linked_work_case;
      if (n.id !== id || n.status !== 'accepted' || n.current !== true || !linked?.id || linked.current !== true || !n.preview_sha256) {
        throw new Error('Предпросмотр можно импортировать только для принятой актуальной гипотезы и актуального связанного дела Work. Обновите данные и проверьте снова.');
      }
      await command('audience.import_preview', { need_id: n.id, expected_revision: n.revision,
        expected_basis_fingerprint: n.basis_fingerprint, case_id: linked.id,
        expected_case_revision: linked.revision, expected_preview_sha256: n.preview_sha256 });
      await load(); return;
    }
    throw new Error(`Неизвестное действие Audience Intelligence: ${action}`);
  }
  return { load, render, act };
}
