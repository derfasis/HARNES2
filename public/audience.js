// Operator surface for durable audience goals. All remote text is escaped before rendering.
export function createAudienceView({ api, command, esc, panel, button, empty, field, modal, refresh, notify }) {
  let listing = null, goal = null, need = null, assessment = null, reassessmentContext = null;
  let reassessmentContextGuard = null;
  let reassessmentLoading = false, reassessmentError = '';
  let followupContext = null, followupContextGuard = null;
  let followupLoading = false, followupError = '';
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
        if (followupContext && followupContextGuard && (
          followupContextGuard.goal_id !== goal.id || followupContextGuard.need_id !== need?.id
          || followupContextGuard.need_revision !== need?.revision
          || followupContextGuard.need_basis_fingerprint !== need?.basis_fingerprint)) {
          followupContext = null; followupContextGuard = null; followupError = '';
        }
        if (reassessmentContext && reassessmentContextGuard && (
          reassessmentContextGuard.goal_id !== goal.id
          || reassessmentContextGuard.goal_revision !== goal.revision
          || reassessmentContextGuard.need_id !== need?.id
          || reassessmentContextGuard.need_revision !== need?.revision
          || reassessmentContextGuard.need_basis_fingerprint !== need?.basis_fingerprint
          || reassessmentContextGuard.listing_model_enabled !== (listing.model_enabled === true))) {
          reassessmentContext = null; reassessmentContextGuard = null; reassessmentError = '';
        }
      } else {
        goal = null; need = null; assessment = null; selectedGoal = selectedNeed = selectedAssessment = null;
        followupContext = null; followupContextGuard = null; followupError = '';
      }
    } catch (e) { listing = null; goal = need = assessment = null; error = e.message; }
  }
  const statusName = value => ({OPEN:'Открыта',PAUSED:'Приостановлена',open:'Открыта',active:'Активна',paused:'Приостановлена',accepted:'Принято',rejected:'Отклонено',proposed:'На рассмотрении',captured:'Собрано',stale:'Устарело',pending:'Ожидает',interrupted:'Прервано',invalid:'Невалидный вывод'})[value] ?? value ?? 'Неизвестно';
  const badge = value => `<span class="badge ${['OPEN','accepted','active'].includes(value)?'green':['rejected','PAUSED','paused','stale'].includes(value)?'red':['proposed','captured'].includes(value)?'purple':''}">${esc(statusName(value))}</span>`;
  const sourceDate = value => {
    if (!value) return 'неизвестно';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'неизвестно' : parsed.toLocaleString('ru-RU');
  };
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  function firstContactBinding(n) {
    const proposal = n?.first_contact, state = n?.first_contact_state;
    if (!exactKeys(proposal, ['version','target_event_id','target_quote','channel','help','channel_reason'])
      || proposal.version !== 1 || !['public_reply','none'].includes(proposal.channel)
      || typeof proposal.target_event_id !== 'string' || !proposal.target_event_id
      || typeof proposal.target_quote !== 'string' || !proposal.target_quote.trim()
      || typeof proposal.help !== 'string' || !proposal.help.trim()
      || typeof proposal.channel_reason !== 'string' || !proposal.channel_reason.trim()) return { valid:false, reason:'Предложение неполное или имеет неподдерживаемый формат.' };
    if (!exactKeys(state, ['version','state','proposal_sha256','target','target_freshness','review','fit','executable','contact_permission','allowed_effects','outcome'])
      || state.version !== 1 || !['not_proposed','pending','approved','rejected','stale','invalid'].includes(state.state)
      || typeof state.proposal_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.proposal_sha256)
      || !exactKeys(state.target, ['source_ref','source_event_id','message_id','author_ref'])
      || typeof state.target.source_ref !== 'string' || !state.target.source_ref
      || state.target.source_event_id !== proposal.target_event_id
      || typeof state.target.message_id !== 'string' || !state.target.message_id
      || !(typeof state.target.author_ref === 'string' && state.target.author_ref || state.target.author_ref === null)
      || state.fit !== 'unknown' || state.executable !== false || state.contact_permission !== false
      || !Array.isArray(state.allowed_effects) || state.allowed_effects.length !== 0
      || state.outcome !== 'not_observed') return { valid:false, reason:'Состояние предложения не совпадает с безопасным контрактом; рассмотрение отключено.' };
    const freshness = state.target_freshness;
    if (!exactKeys(freshness, ['state','published_at','fresh_until','max_age_seconds'])
      || !['current','expired','unknown','invalid'].includes(freshness.state)
      || !(freshness.published_at === null || typeof freshness.published_at === 'string' && !Number.isNaN(Date.parse(freshness.published_at)))
      || !(freshness.fresh_until === null || typeof freshness.fresh_until === 'string' && !Number.isNaN(Date.parse(freshness.fresh_until)))
      || !Number.isInteger(freshness.max_age_seconds) || freshness.max_age_seconds < 60 || freshness.max_age_seconds > 2592000
      || freshness.state === 'current' && (typeof freshness.published_at !== 'string' || typeof freshness.fresh_until !== 'string'
        || freshness.published_at !== (assessment?.packet?.exchanges ?? []).flatMap(exchange => exchange.evidence ?? [])
          .find(item => item.source_event_id === proposal.target_event_id)?.published_at
        || Date.parse(freshness.published_at) > Date.now()
        || Date.parse(freshness.fresh_until) !== Date.parse(freshness.published_at) + freshness.max_age_seconds * 1000)
      || freshness.state === 'unknown' && (freshness.published_at !== null || freshness.fresh_until !== null)
      || freshness.state === 'expired' && (typeof freshness.published_at !== 'string' || typeof freshness.fresh_until !== 'string')
      || freshness.state === 'expired' && (Date.parse(freshness.fresh_until) > Date.now()
        || Date.parse(freshness.fresh_until) !== Date.parse(freshness.published_at) + freshness.max_age_seconds * 1000)
      || freshness.state === 'invalid')
      return { valid:false, reason:'Возраст публикации или срок свежести не совпадает с сохранённой целью; рассмотрение отключено.' };
    if (state.state === 'pending' && state.review !== null) return { valid:false, reason:'Ожидающее предложение неожиданно содержит решение; рассмотрение отключено.' };
    const reviewDecision = state.state === 'approved' ? 'approve' : state.state === 'rejected' ? 'reject' : null;
    if (reviewDecision
      && (!exactKeys(state.review, ['id','decision','note','reviewed_at']) || typeof state.review.id !== 'string'
        || state.review.decision !== reviewDecision || typeof state.review.note !== 'string'
        || typeof state.review.reviewed_at !== 'string' || Number.isNaN(Date.parse(state.review.reviewed_at))))
      return { valid:false, reason:'Запись рассмотрения не совпадает с состоянием; рассмотрение отключено.' };
    const evidence = (assessment?.packet?.exchanges ?? []).flatMap(exchange => exchange.evidence ?? []);
    const target = evidence.find(item => item.source_event_id === proposal.target_event_id);
    const basis = new Set([...(n.evidence_event_ids ?? []), ...(n.counterevidence_event_ids ?? []), ...(n.context_event_ids ?? [])]);
    if (!target || !basis.has(proposal.target_event_id) || !String(target.text ?? '').includes(proposal.target_quote)
      || target.source_ref !== state.target.source_ref || target.message_id !== state.target.message_id
      || (target.author_id ?? null) !== state.target.author_ref
      || ['current','expired'].includes(freshness.state) && freshness.published_at !== target.published_at
      || freshness.state === 'unknown' && target.published_at !== null
      || freshness.state === 'expired' && Date.parse(freshness.fresh_until) > Date.now())
      return { valid:false, reason:'Источник, сообщение или точная цитата не совпадают с сохранённым основанием; рассмотрение отключено.' };
    if (proposal.channel === 'public_reply'
      && (typeof n.material_preview?.content !== 'string' || !n.material_preview.content.trim()))
      return { valid:false, reason:'Точный текст ответа отсутствует; рассмотрение отключено.' };
    return { valid:true, proposal, state, target,
      freshnessCurrent:freshness.state === 'current' && typeof freshness.fresh_until === 'string' && Date.parse(freshness.fresh_until) > Date.now() };
  }
  const canonicalJson = value => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const sourceRenewalRoute = (goalId, sourceRef) => `/api/audience/goals/${encodeURIComponent(goalId)}/source-renewal?source_ref=${encodeURIComponent(sourceRef)}`;
  async function openSourceRenewal(sourceRef) {
    const currentGoal = goal;
    const watch = currentGoal?.watches?.find(row => (row?.source_ref ?? row?.source_id) === sourceRef && row.status === 'revoked');
    if (!currentGoal || currentGoal.id !== selectedGoal || !watch || !Number.isInteger(currentGoal.revision)) {
      throw new Error('Возобновить можно только отозванный источник открытой цели. Обновите цель.');
    }
    const frozenGoalId = currentGoal.id;
    const frozenSourceRef = sourceRef;
    const previewRoute = sourceRenewalRoute(frozenGoalId, frozenSourceRef);
    const frozen = await api(previewRoute);
    if (frozen?.version !== 1 || frozen?.purpose !== 'audience_source_renewal_preview_v1'
      || frozen.goal_id !== frozenGoalId || frozen.source_ref !== frozenSourceRef
      || frozen.expected_revision !== currentGoal.revision || frozen.gap !== true
      || typeof frozen.preview_sha256 !== 'string' || !frozen.preview_sha256) {
      throw new Error('Сервер не вернул полную сверку разрыва для этой цели и источника. Обновите цель.');
    }
    if (goal?.id !== frozenGoalId || selectedGoal !== frozenGoalId
        || !goal.watches?.some(row => (row?.source_ref ?? row?.source_id) === frozenSourceRef && row.status === 'revoked')) {
      throw new Error('Цель или состояние источника изменились. Откройте цель и проверьте её снова.');
    }
    const show = value => value === null || value === undefined || value === '' ? 'неизвестно' : String(value);
    const content = `<p><strong>Цель:</strong> ${esc(currentGoal.title ?? currentGoal.id)}</p>
        <p><strong>Задача:</strong> ${esc(currentGoal.objective ?? 'не указана')}</p>
        <p><strong>Источник:</strong> <code>${esc(frozen.source_ref)}</code></p>
        <p><strong>Разрыв наблюдений:</strong> полнота за пропущенный период неизвестна · прежний указатель: ${esc(show(frozen.old_cursor))} · верхняя граница: ${esc(show(frozen.head))} · нижняя граница новых наблюдений: ${esc(show(frozen.observation_floor))}.</p>
        <p><strong>Транспорт сейчас:</strong> ${frozen.transport_current === true ? 'доступность подтверждена' : 'доступность не подтверждена'}${frozen.transport_reason ? ` · ${esc(frozen.transport_reason)}` : ''}</p>
        <p><strong>Политика источника:</strong> прежняя <code>${esc(show(frozen.prior_policy_hash))}</code> · текущая <code>${esc(show(frozen.current_source_policy_hash))}</code></p>
        <p>Старые материалы и выводы по этому источнику останутся устаревшими. Проверка только показывает состояние, она не читает источник и не создаёт нового разрешения, профиля модели или новой задачи.</p>
        <label class="research-choice"><input type="checkbox" name="acknowledge_gap" value="true"> Я понимаю, что между прежним указателем и новыми наблюдениями есть разрыв, и подтверждаю его.</label>
        <p class="muted tiny">Предпросмотр ${esc(frozen.preview_sha256)} · ревизия цели ${esc(frozen.expected_revision)}. Подтверждение отправит только команду возобновления чтения этого источника.</p>`;
    modal('Проверить и подтвердить возобновление источника', content, async p => {
        if (!['true','on',true].includes(p.acknowledge_gap)) throw new Error('Подтвердите разрыв наблюдений перед возобновлением.');
        if (goal?.id !== frozenGoalId || selectedGoal !== frozenGoalId
          || !goal.watches?.some(row => (row?.source_ref ?? row?.source_id) === frozenSourceRef && row.status === 'revoked')) {
          throw new Error('Цель или состояние источника изменились. Обновите цель перед подтверждением.');
        }
        const latest = await api(previewRoute);
        if (canonicalJson(latest) !== canonicalJson(frozen)) {
          throw new Error('Сверка изменилась после просмотра. Закройте окно и заново проверьте возобновление.');
        }
        await command('audience.renew_source', { goal_id:frozenGoalId, source_ref:frozenSourceRef,
          expected_revision:frozen.expected_revision, preview_sha256:frozen.preview_sha256, acknowledge_gap:true });
        await load();
    });
  }
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
        ? '<div class="section-note">Глобальные модельные вызовы выключены. Обычная Audience-оценка может выполняться только при отдельном конечном разрешении цели и профиля, допускающем вызовы режиме активации, свежем основании и бюджете; это может повлечь оплату. В режиме только чтения модельные вызовы заблокированы даже при наличии разрешения. Операторский сбор и предложение не вызывают модель.</div>'
        : '<div class="section-note">Глобальная возможность модельных вызовов включена. Для каждой цели отдельно требуется действующее конечное разрешение на внимание и проверка свежести источников и бюджета. Кнопка «Собрать основание» создаёт операторский снимок. Предложение не принимается автоматически.</div>';
    let html = notice + panel('Рабочие цели', selectedRows(listing.items ?? [], 'goal', selectedGoal)
      || empty('Целей пока нет', 'Создайте ограниченную цель и укажите источники, уже разрешённые для чтения.'),
      !disabled ? button('+ Новая цель', 'audience-new', '', 'primary') : '');
    html += `<div class="actions">${listing.next_cursor ? button('Следующие цели', 'audience-next') : ''}</div>`;
    if (!goal) return html;
    const needs = goal.needs ?? [];
    const assessments = goal.assessments ?? [];
    const capturePending = assessments.some(a => ['captured','running'].includes(a.status));
    const revokedWatches = (goal.watches ?? []).filter(w => typeof w === 'object'
      && w?.status === 'revoked' && typeof (w.source_ref ?? w.source_id) === 'string');
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
      ${revokedWatches.length ? `<div class="section-note"><strong>Отозванные источники.</strong> Возобновление чтения требует отдельной сверки политики и явного подтверждения разрыва наблюдений. Исторические заключения останутся устаревшими; только новые наблюдения после указанной границы смогут стать текущими.
        ${listing.enabled === true ? revokedWatches.map(w => button(`Проверить возобновление: ${w.source_ref ?? w.source_id}`, 'audience-renew-source', w.source_ref ?? w.source_id)).join('') : ''}</div>` : ''}
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
    const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'данные не указаны';
    const plural = (value, forms) => {
      if (!Number.isSafeInteger(value) || value < 0) return 'данные не указаны';
      const n = value % 100, last = value % 10;
      return `${value} ${n >= 11 && n <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2]}`;
    };
    const summary = a.source_summary && typeof a.source_summary === 'object' ? a.source_summary : null;
    const sourceCountKnown = Number.isSafeInteger(summary?.current_sources) && summary.current_sources >= 0
      && Number.isSafeInteger(summary?.enrolled_sources) && summary.enrolled_sources >= 0;
    const packetCountKnown = Number.isSafeInteger(summary?.selected_exchanges) && summary.selected_exchanges >= 0
      && Number.isSafeInteger(summary?.selected_sources) && summary.selected_sources >= 0;
    const completeness = summary?.source_completeness === 'unknown' ? 'неизвестна'
      : typeof summary?.source_completeness === 'string' && summary.source_completeness.trim()
        ? esc(summary.source_completeness) : 'данные не указаны';
    const pending = a.pending_assessment;
    const pendingState = pending && typeof pending === 'object' && !Array.isArray(pending)
      && typeof pending.id === 'string' && pending.id.trim()
      && typeof pending.producer === 'string' && pending.producer.trim()
      && ['captured','running'].includes(pending.status)
      ? `${pending.status === 'captured' ? 'снимок сохранён, анализ не начат' : 'анализ выполняется'} · ID ${esc(pending.id)} · ${esc(pending.producer)}`
      : pending === null ? 'нет ожидающей оценки' : 'данные не указаны';
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
      <p><strong>Актуальность всех подключённых источников:</strong> ${a.source_current === true ? 'подтверждена' : a.source_current === false ? 'не подтверждена' : 'данные не указаны'}.</p>
      <p><strong>Источники актуальны:</strong> ${sourceCountKnown ? `${count(summary.current_sources)} из ${count(summary.enrolled_sources)}` : 'данные не указаны'}.</p>
      <p><strong>Основание следующего анализа:</strong> ${packetCountKnown ? `${plural(summary.selected_exchanges, ['обмен','обмена','обменов'])} из ${plural(summary.selected_sources, ['источника','источников','источников'])}` : 'данные не указаны'}.</p>
      <p><strong>Полнота источников:</strong> ${completeness}.</p>
      <p><strong>Основание для следующего анализа:</strong> ${a.evidence_ready === true ? 'есть в ограниченном пакете' : a.evidence_ready === false ? 'подходящее основание не найдено' : 'данные не указаны'}.</p>
      <p><strong>Ранее созданная оценка:</strong> ${pendingState}.</p>
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
  const followupProfileHash = profile => profile?.profile_hash;
  const followupStateLabel = state => ({ available:'доступен', revoked:'отозван', stale:'устарел', invalid:'не прошёл проверку',
    active:'действует', pending:'ожидает', captured:'ожидает запуска', running:'выполняется', consumed:'использован',
    expired:'истёк', proposed:'предложена', accepted:'принята', rejected:'отклонена' })[state] ?? 'состояние неизвестно';
  const followupProfiles = context => (context?.profile_options ?? []).filter(profile =>
    profile?.available === true && !['revoked','stale','invalid'].includes(profile.state)
    && profile.model_ready !== false
    && typeof profile.profile_id === 'string' && profile.profile_id.length > 0
    && typeof followupProfileHash(profile) === 'string' && followupProfileHash(profile).length > 0
    && !(profile.reasons?.length) && !(profile.block_reasons?.length));
  const stableValue = value => Array.isArray(value) ? value.map(stableValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stableValue(value[key])])) : value;
  const sameValue = (a,b) => JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
  function followupContextPanel(n) {
    if (!followupContext && !followupError && !followupLoading) {
      return `<div class="actions">${button('Показать новые сообщения', 'audience-followup-context', n.id, 'secondary')}</div>`;
    }
    if (followupLoading) return '<section class="context-review"><p>Проверяем новые сообщения…</p></section>';
    if (followupError) return `<section class="context-review"><p>Не удалось проверить новые сообщения: ${esc(followupError)}</p>${button('Повторить проверку', 'audience-followup-context', n.id, 'secondary')}</section>`;
    const c = followupContext ?? {};
    const correctlyBound = c.need_id === n.id && c.need_revision === n.revision
      && c.need_basis_fingerprint === n.basis_fingerprint && followupContextGuard?.goal_id === goal?.id
      && followupContextGuard?.need_id === n.id && followupContextGuard?.need_revision === n.revision
      && followupContextGuard?.need_basis_fingerprint === n.basis_fingerprint;
    const scopeValid = c.scope?.version === 2 && c.scope?.purpose === 'audience_current_events_v1'
      && typeof c.context_fingerprint === 'string' && c.context_fingerprint.length > 0;
    const exchanges = Array.isArray(c.exchanges) ? c.exchanges : [];
    const scopeExchanges = Array.isArray(c.scope?.exchanges) ? c.scope.exchanges : [];
    const freshRows = exchanges.map(exchange => {
      const scopeExchange = scopeExchanges.find(row => row.id === exchange.id) ?? {};
      const currentIds = scopeExchange.current_event_ids ?? [];
      const structuralIds = scopeExchange.structural_event_ids ?? [];
      const evidence = Array.isArray(exchange.evidence) ? exchange.evidence : [];
      return `<article class="workspace-evidence"><strong>Текущий обмен ${esc(exchange.id ?? '—')} · ${esc(exchange.source_ref ?? 'источник не указан')}</strong>
        <p>${exchange.current === true ? 'Новые сообщения доступны' : 'Актуальность сообщений не подтверждена'}</p>
        <p><strong>Новые сообщения:</strong> ${esc(currentIds.join(', ') || 'не указаны')}
          · сообщения, нужные для проверки связи: ${esc(structuralIds.join(', ') || 'не указаны')}</p>
        ${exchange.reasons?.length ? `<p><strong>Ограничения:</strong> ${esc(exchange.reasons.join('; '))}</p>` : ''}
        ${evidence.map(item => `<p>${esc(item.text ?? 'Текст текущего события не предоставлен')}<small>Событие ${esc(item.source_event_id ?? 'не указано')}${item.message_version ? ` · версия ${esc(item.message_version)}` : ''} · опубликовано ${esc(sourceDate(item.published_at))} · источник изменён ${esc(sourceDate(item.source_updated_at))} · наблюдалось ${esc(sourceDate(item.observed_at))}${item.confirmed_at ? ` · Browser подтвердил ${esc(sourceDate(item.confirmed_at))}` : ''}</small></p>`).join('') || '<p>Свежие цитируемые события не предоставлены.</p>'}</article>`;
    }).join('') || '<p>Текущих поддержанных обменов не предоставлено.</p>';
    const historical = c.historical_memory && typeof c.historical_memory === 'object' ? c.historical_memory : {};
    const historicalEvidence = Array.isArray(c.historical_evidence) ? c.historical_evidence : [];
    const historicalMetadata = historicalEvidence.slice(0,8).map(item => `<li>${esc(item.source_ref ?? 'Источник не указан')} · сообщение ${esc(item.message_id ?? 'не указано')} · версия ${esc(item.message_version ?? 'не указана')} · ${esc((item.reasons ?? []).join('; ') || 'только исторические сведения')}</li>`).join('');
    const profiles = Array.isArray(c.profile_options) ? c.profile_options : [];
    const usableProfiles = followupProfiles(c);
    const profileRows = profiles.map(profile => `<article class="lesson"><strong>${esc(profile.label ?? profile.profile_id ?? 'Профиль без названия')}</strong>
      <p>ID: <code>${esc(profile.profile_id ?? 'не указан')}</code> · hash: <code>${esc(followupProfileHash(profile) ?? 'не указан')}</code> · ${esc(followupStateLabel(profile.state))}</p>
      <p>${esc(profile.provider ?? profile.model_config?.provider ?? 'провайдер не указан')} · ${esc(profile.model ?? profile.model_config?.model ?? 'модель не указана')} · ${profile.available === true ? 'профиль доступен для отдельного разбора' : 'профиль недоступен'} · ${profile.model_ready === true ? 'модель готова при отдельном разрешении' : 'готовность модели не подтверждена'}</p>
      ${(profile.reasons?.length || profile.block_reasons?.length) ? `<p><strong>Ограничения:</strong> ${esc([...(profile.reasons ?? []), ...(profile.block_reasons ?? [])].join('; '))}</p>` : ''}</article>`).join('') || '<p>Профили для разбора не предоставлены.</p>';
    const requests = (Array.isArray(c.requests) ? c.requests : []).filter(row => !row.need_id || row.need_id === n.id);
    const activeRequests = requests.filter(row => ['active','pending','captured','running'].includes(row.state ?? row.status));
    const requestRows = requests.map(row => `<article class="lesson"><p><strong>Запрос ${esc(row.request_id ?? 'не указан')}</strong> · ${esc(followupStateLabel(row.state ?? row.status))}</p>
      <p>Профиль ${esc(row.model_profile_id ?? row.profile_id ?? 'не указан')} · hash ${esc(row.expected_profile_hash ?? row.profile_hash ?? 'не указан')} · истекает ${esc(row.expires_at ?? 'неизвестно')}</p>
      ${row.request_fingerprint && ['active','pending','captured','running'].includes(row.state ?? row.status)
        ? button('Отозвать этот запрос', 'audience-followup-revoke', row.request_id, 'danger') : ''}</article>`).join('') || '<p>Истории запросов нет.</p>';
    const eligible = correctlyBound && scopeValid && c.available === true && exchanges.length > 0
      && usableProfiles.length > 0 && activeRequests.length === 0;
    return `<section class="context-review"><h3>Новые сообщения по этой гипотезе</h3>
      <p><strong>Гипотеза:</strong> ${esc(c.need_id ?? '—')} · версия ${esc(c.need_revision ?? '—')} · основание <code>${esc(c.need_basis_fingerprint ?? 'не указано')}</code></p>
      <p><strong>Состояние источников:</strong> <code>${esc(c.context_fingerprint ?? 'не указано')}</code> · ${esc(JSON.stringify(c.observation_heads ?? {}))}</p>
      <p><strong>Проверка:</strong> только выбранные новые сообщения из доступных источников.</p>
      <p><strong>Прежняя непроверенная гипотеза — это не факт и не подтверждение:</strong> ${esc(historical.title ?? 'Без названия')} · ${esc(historical.hypothesis ?? 'Текст прежней гипотезы не сохранён')}${historical.hypothesis_truncated === true ? ' · текст сокращён' : ''}.</p>
      <p>Версия ${esc(historical.revision ?? 'неизвестна')} · ${esc(followupStateLabel(historical.status ?? 'unknown'))} · результат ${historical.resolution === 'unknown' ? 'неизвестен' : esc(historical.resolution ?? 'неизвестен')}.</p>
      <p class="muted tiny">Прежний текст источников здесь не показывается и не считается новым подтверждением. Неизвестно, разрешилась ли прежняя гипотеза.</p>
      ${historicalMetadata ? `<p><strong>Сведения о прежних сообщениях (до 8):</strong></p><ul>${historicalMetadata}</ul>` : '<p class="muted tiny">Прежние тексты не используются как новое подтверждение.</p>'}
      <p><strong>Новые сообщения (${exchanges.length} обменов):</strong></p>${freshRows}
      ${c.reasons?.length ? `<p><strong>Причины недоступности или ограничения:</strong> ${esc(c.reasons.join('; '))}</p>` : ''}
      <p><strong>Доступные профили:</strong></p>${profileRows}
      <p class="muted tiny">Разрешено до двух запросов на генерацию к провайдеру или прокси, включая повторы. Возможна оплата; неизвестная стоимость не означает, что это бесплатно. Внутренние повторы провайдера не видны системе. Ответ не принимает гипотезу и не создаёт работу, контакт или отправку: для этого нужны отдельные решения.</p>
      ${activeRequests.length ? '<p>Для этой гипотезы уже есть действующий запрос; новый пока недоступен.</p>' : ''}
      <div class="actions">${eligible ? button('Разрешить один разбор новых сообщений', 'audience-followup-request', n.id, 'primary') : '<span>Разбор недоступен. Проверьте версию гипотезы, новые сообщения и выбранный профиль.</span>'}</div>
      <h4>История запросов</h4>${requestRows}
    </section>`;
  }
  function openFollowupRequest(n) {
    const c = followupContext ?? {}, profiles = followupProfiles(c);
    const frozen = { goal_id:goal?.id, need_id:n.id, need_revision:n.revision,
      need_basis_fingerprint:n.basis_fingerprint, context_fingerprint:c.context_fingerprint,
      observation_heads:structuredClone(c.observation_heads ?? {}) };
    if (selectedNeed !== n.id || c.need_id !== n.id || c.need_revision !== n.revision
      || c.need_basis_fingerprint !== n.basis_fingerprint || c.available !== true
      || c.scope?.version !== 2 || c.scope?.purpose !== 'audience_current_events_v1'
      || !frozen.context_fingerprint || !profiles.length) throw new Error('Нельзя разрешить разбор: обновите гипотезу, новые сообщения и профиль.');
    const options = [['','Выберите профиль'], ...profiles.map(profile => [profile.profile_id,
      `${profile.label ?? profile.profile_id} · ${profile.profile_id} · ${followupProfileHash(profile)}`])];
    const defaultExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    modal('Разрешить один разбор новых сообщений', `<p>Гипотеза ${esc(n.id)} · версия ${esc(n.revision)} · основание <code>${esc(n.basis_fingerprint)}</code>.</p>
      <p>Перед запуском ещё раз проверим новые сообщения и выбранный профиль.</p>
      ${field('model_profile_id','Профиль модели','select','',options)}
      ${field('expires_at','Истекает (ISO 8601 UTC, не более чем через 7 дней)','text',defaultExpiry)}
      ${field('reason','Зачем нужен разбор','textarea')}
      <p>Разрешение запускает один ограниченный разбор: до двух запросов на генерацию к провайдеру или прокси, включая повторы. Внутренние повторы провайдера системе неизвестны. Возможна оплата; неизвестная стоимость не означает, что вызов бесплатный. Глобальные переключатели модели останутся выключены.</p>
      <p>Ответ станет новой гипотезой и не будет принят автоматически. Работа, контакт и отправка требуют отдельных решений.</p>`, async p => {
      const profileId = String(p.model_profile_id ?? '').trim();
      const expiry = String(p.expires_at ?? '').trim(), expiryAt = Date.parse(expiry);
      const reason = String(p.reason ?? '').trim();
      if (!profileId) throw new Error('Выберите профиль.');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)
        || !Number.isFinite(expiryAt) || expiryAt <= Date.now() || expiryAt > Date.now() + 7 * 86400000)
        throw new Error('Укажите будущую дату ISO 8601 UTC не более чем через семь дней.');
      if (!reason || reason.length > 500) throw new Error('Укажите причину длиной от 1 до 500 знаков.');
      if (selectedGoal !== frozen.goal_id || selectedNeed !== frozen.need_id || need?.id !== frozen.need_id
        || need?.revision !== frozen.need_revision || need?.basis_fingerprint !== frozen.need_basis_fingerprint
        || followupContext?.context_fingerprint !== frozen.context_fingerprint)
        throw new Error('Гипотеза или показанные сообщения изменились. Проверьте их ещё раз перед подтверждением.');
      const latest = await api(`/api/audience/needs/${encodeURIComponent(frozen.need_id)}/followup-context`);
      const selected = profiles.find(profile => profile.profile_id === profileId);
      const latestProfile = (latest.profile_options ?? []).find(profile => profile.profile_id === profileId);
      if (!selected || !latestProfile || !followupProfiles(latest).some(profile => profile.profile_id === profileId)
        || followupProfileHash(latestProfile) !== followupProfileHash(selected)
        || latest.available !== true || latest.need_id !== frozen.need_id || latest.need_revision !== frozen.need_revision
        || latest.need_basis_fingerprint !== frozen.need_basis_fingerprint
        || latest.context_fingerprint !== frozen.context_fingerprint
        || !sameValue(latest.observation_heads ?? {}, frozen.observation_heads)
        || latest.scope?.version !== 2 || latest.scope?.purpose !== 'audience_current_events_v1')
        throw new Error('Гипотеза, сообщения или профиль изменились. Проверьте их ещё раз перед новым разрешением.');
      const result = await command('audience.followup_request', { need_id:frozen.need_id,
        expected_revision:frozen.need_revision, expected_basis_fingerprint:frozen.need_basis_fingerprint,
        expected_context_fingerprint:frozen.context_fingerprint, model_profile_id:profileId,
        expected_profile_hash:followupProfileHash(selected), expires_at:expiry, reason });
      selectedAssessment = result?.assessment_id ?? null;
      followupContext = null; followupContextGuard = null; followupError = '';
      await load();
    });
  }
  function openFollowupRevoke(n, requestId) {
    const row = (followupContext?.requests ?? []).find(request => request.request_id === requestId && (!request.need_id || request.need_id === n.id));
    const state = row?.state ?? row?.status;
    if (!row || !row.request_fingerprint || !['active','pending','captured','running'].includes(state))
      throw new Error('Этот запрос нельзя отозвать в показанном состоянии.');
    const frozen = { request_id:row.request_id, expected_request_fingerprint:row.request_fingerprint };
    modal('Отозвать одноразовый запрос', `<p>Отзыв остановит ожидающую работу, если она ещё не завершилась. Уже использованный вызов и его стоимость останутся в истории.</p>${field('reason','Причина отзыва','textarea')}`, async p => {
      const reason = String(p.reason ?? '').trim();
      if (!reason || reason.length > 500) throw new Error('Укажите причину отзыва длиной от 1 до 500 знаков.');
      if (selectedNeed !== n.id || need?.id !== n.id) throw new Error('Выбранная гипотеза изменилась. Обновите экран перед отзывом.');
      const latest = await api(`/api/audience/needs/${encodeURIComponent(n.id)}/followup-context`);
      const current = (latest.requests ?? []).find(request => request.request_id === frozen.request_id
        && (!request.need_id || request.need_id === n.id));
      if (!current || current.request_fingerprint !== frozen.expected_request_fingerprint
        || !['active','pending','captured','running'].includes(current.state ?? current.status))
        throw new Error('Запрос уже изменился или завершён. Обновите историю.');
      await command('audience.followup_revoke', { ...frozen, reason });
      followupContext = null; followupContextGuard = null;
      await load();
    });
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
    const contactBinding = n.first_contact ? firstContactBinding(n) : null;
    const responseImportReady = !n.first_contact || contactBinding?.valid === true
      && (contactBinding.proposal.channel === 'none'
        || contactBinding.proposal.channel === 'public_reply' && contactBinding.freshnessCurrent && contactBinding.state.state === 'approved');
    const preview = contextVersion && n.material_preview ? `<section class="material-preview"><h3>Предпросмотр предлагаемого материала</h3>
      <p><strong>${esc(n.material_preview.title ?? 'Без названия')}</strong></p>
      <pre class="workspace-pre">${esc(n.material_preview.content ?? '')}</pre>
      <p><strong>SHA-256:</strong> <code>${esc(n.preview_sha256 ?? 'не указан сервером')}</code></p>
      <p class="muted tiny">Это точный предпросмотр для рассмотрения, ещё не проверен владельцем и не является действием или отправкой.</p>
      ${(n.material_preview.evidence_event_ids ?? []).length ? `<p><strong>Цитаты материала:</strong> ${esc(n.material_preview.evidence_event_ids.join(', '))}</p>` : '<p>Цитаты материала не указаны.</p>'}
      <p><strong>Полное основание материала:</strong> ${esc((n.preview_basis_event_ids ?? []).join(', ') || 'не подтверждено сервером')}. Связанный контекст сохраняется независимо от списка цитат модели.</p>
      ${n.linked_work_case?.id ? `<p><strong>Связанное дело Work:</strong> ${esc(n.linked_work_case.id)} · ревизия ${esc(n.linked_work_case.revision ?? '—')} · ${n.linked_work_case.current === true ? 'актуально' : 'не подтверждено'}</p>` : '<p>Дело Work не связано.</p>'}
      <p class="muted tiny">Импорт добавит точный текст как предложенный материал в открытое дело Work. Он всё ещё требует проверки материала в Work и отдельного разрешения Action.</p>
      ${current && accepted && n.linked_work_case?.current === true && n.linked_work_case?.id && n.preview_sha256 && responseImportReady ? button('Импортировать предпросмотр в дело Work', 'audience-import-preview', n.id, 'secondary') : ''}</section>`
      : contextVersion ? '<section class="material-preview"><h3>Предпросмотр материала</h3><p>Предпросмотр не сохранён.</p></section>' : '';
    const firstContact = n.first_contact ? (() => {
      const binding = contactBinding, state = n.first_contact_state;
      const stateLabels = { not_proposed:'Не предложено', pending:'Ожидает отдельного решения', approved:'Текст предложения одобрен владельцем', rejected:'Предложение отклонено', stale:'Основание устарело', invalid:'Не прошло проверку' };
      const channelLabel = binding.valid && binding.proposal.channel === 'public_reply' ? 'Публичный ответ в исходном обсуждении' : 'Пока не отвечать';
      const canReject = binding.valid && binding.freshnessCurrent && current
        && ['proposed','accepted'].includes(n.status) && binding.state.state === 'pending';
      const canWithdraw = binding.valid && binding.freshnessCurrent && current && accepted && binding.state.state === 'approved';
      const canApprove = canReject && accepted && binding.proposal.channel === 'public_reply'
        && binding.freshnessCurrent && !!n.material_preview?.content;
      const stateNote = binding.valid
        ? `${stateLabels[binding.state.state] ?? 'Неизвестное состояние'} · соответствие ситуации: неизвестно · результат: не наблюдался`
        : `Предложение не прошло проверку: ${binding.reason}`;
      const freshness = binding.valid ? binding.state.target_freshness : state?.target_freshness;
      const freshnessText = freshness?.state === 'current'
        ? `Опубликовано: ${esc(freshness.published_at)} · наблюдалось: ${esc(binding.valid ? binding.target.observed_at ?? 'неизвестно' : 'не подтверждено')} · срок свежести до: ${esc(freshness.fresh_until)}${binding.valid && !binding.freshnessCurrent ? ' · срок истёк' : ''}`
        : freshness?.state === 'expired'
          ? `Опубликовано: ${esc(freshness.published_at)} · наблюдалось: ${esc(binding.valid ? binding.target.observed_at ?? 'неизвестно' : 'не подтверждено')} · срок свежести истёк ${esc(freshness.fresh_until)}`
          : freshness?.state === 'unknown' ? 'Дата публикации и срок свежести неизвестны.' : 'Дата публикации и срок свежести не подтверждены.';
      const responseText = binding.valid && binding.proposal.channel === 'none'
        ? 'Ответ не предложен.' : n.material_preview?.content ?? 'Точный текст ответа отсутствует.';
      return `<section class="first-contact-review"><h3>Возможный первый ответ · отдельное решение</h3>
        <p><strong>Предложенный канал:</strong> ${esc(channelLabel)}</p>
        <p><strong>Почему выбран этот вариант:</strong> ${esc(binding.valid ? binding.proposal.channel_reason : n.first_contact.channel_reason ?? 'Основание недоступно')}</p>
        <p><strong>Что может помочь:</strong> ${esc(binding.valid ? binding.proposal.help : n.first_contact.help ?? 'Предложение недоступно')}</p>
        <blockquote>${esc(binding.valid ? binding.proposal.target_quote : n.first_contact.target_quote ?? 'Точная цитата недоступна')}</blockquote>
        <p><strong>Источник и сообщение:</strong> ${esc(binding.valid ? binding.state.target.source_ref : state?.target?.source_ref ?? 'не подтверждены')} · событие ${esc(binding.valid ? binding.state.target.source_event_id : state?.target?.source_event_id ?? 'не подтверждено')} · сообщение ${esc(binding.valid ? binding.state.target.message_id : state?.target?.message_id ?? 'не подтверждено')}</p>
        <p><strong>Свежесть публикации:</strong> ${freshnessText}</p>
        <p><strong>Точный текст предложения:</strong></p><pre class="workspace-pre">${esc(responseText)}</pre>
        <p><strong>Неизвестно:</strong> ${esc((n.unknowns ?? []).join('; ') || 'Не указано')}</p>
        <p><strong>Актуальность основания:</strong> ${current ? 'актуально по сохранённой проверке; нерешённость вопроса неизвестна' : `не подтверждена (${esc((n.reasons ?? []).join('; ') || 'основание неактуально')})`}</p>
        <p><strong>Состояние рассмотрения:</strong> ${esc(stateNote)}${binding.valid && binding.state.review ? ` · ${esc(binding.state.review.decision)}: ${esc(binding.state.review.note)} · ${esc(sourceDate(binding.state.review.reviewed_at))}` : ''}</p>
        <p class="muted tiny">Одобрение относится только к точному тексту и предложенному публичному каналу. Оно не создаёт получателя, разрешение на контакт или отправку. Никакой ответ или результат не наблюдался.</p>
        <div class="actions">${canApprove ? button('Одобрить только это предложение', 'audience-first-contact-approve', n.id, 'primary') : ''}${canWithdraw ? button('Отозвать одобрение предложения', 'audience-first-contact-reject', n.id, 'danger') : canReject ? button('Отклонить предложение', 'audience-first-contact-reject', n.id, 'danger') : ''}</div></section>`;
    })() : '';
    return panel(n.title ?? 'Потребность', `<p>${badge(n.status)} · ревизия ${esc(n.revision ?? '—')} · ${current ? 'основание актуально' : 'основание неактуально'}</p>
      <p><strong>Эпистемический статус:</strong> ${esc(n.epistemic_status ?? 'не указан')}</p>
      <p><strong>Гипотеза:</strong> ${esc(n.hypothesis ?? '')}</p><p><strong>Почему сейчас:</strong> ${esc(n.why_now ?? 'Не указано')}</p>
      <p><strong>Возможный следующий шаг:</strong> ${esc(n.next_step ?? 'Не указан')}</p><p><strong>Основание:</strong> ${esc(n.reason ?? 'Не указано')}</p>
      <p><strong>Неизвестно:</strong> ${esc((n.unknowns ?? []).join('; ') || 'Не указано')}</p>
      <p><strong>Точные цитаты-основания:</strong></p>${quotes.map(q => `<blockquote>${esc(q.quote)}<small> · событие ${esc(q.source_event_id)}</small></blockquote>`).join('') || '<p>Цитаты отсутствуют.</p>'}
      <p><strong>Поддерживающие события:</strong></p>${refs(ev)}<p><strong>Контрсвидетельства:</strong></p>${refs(counter)}<p><strong>Связанные обмены:</strong> ${esc(exchanges.join(', ') || 'нет ссылок')}</p>
      ${context}
      ${followupContextPanel(n)}
      ${reassessmentContextPanel(n)}
      ${preview}
      ${firstContact}
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
  async function handoffLeaseCurrent(handoff) {
    const current = await api(`/api/scout/campaigns/${encodeURIComponent(handoff.campaign_id)}`);
    const candidate = (current?.candidates ?? []).find(row => row.id === handoff.candidate_id);
    const grant = candidate?.monitor_grant;
    return current?.id === handoff.campaign_id && current.status === 'active'
      && current.revision === handoff.campaign_revision && candidate?.joined === true
      && `telegram:channel:${candidate.channel_id}` === handoff.source_ref
      && grant?.id === handoff.grant_id && grant.current === true && grant.status === 'active'
      && grant.campaign_id === current.id && grant.candidate_id === candidate.id
      && grant.campaign_revision === current.revision && grant.expires_at === handoff.expires_at
      && typeof grant.expires_at === 'string' && Date.parse(grant.expires_at) > Date.now();
  }
  function createGoal(handoff = null) {
    const refs = listing.source_refs ?? [];
    if (handoff) {
      const sourceRef = handoff.source_ref;
      if (listing.enabled !== true || typeof sourceRef !== 'string' || !refs.includes(sourceRef)
        || typeof handoff.expires_at !== 'string' || Date.parse(handoff.expires_at) <= Date.now()) {
        throw new Error('Источник или его разрешение больше не доступны. Обновите раздел «Источники».');
      }
      const content = field('title', 'Название цели') + field('objective', 'Что понять или отслеживать', 'textarea')
        + `<p>Источник: <code>${esc(sourceRef)}</code>. Разрешение мониторинга действует до ${esc(handoff.expires_at)}.</p>`
        + '<p>Сохранение создаст только цель для этого источника. Сейчас не создаются модельное разрешение, запрос к модели или разрешение на контакт.</p>';
      modal('Новая цель аудитории по выбранному источнику', content, async p => {
        const title = String(p.title ?? '').trim(), objective = String(p.objective ?? '').trim();
        if (!title || !objective) throw new Error('Заполните название цели и что нужно понять.');
        if (Date.parse(handoff.expires_at) <= Date.now()) throw new Error('Разрешение источника истекло. Обновите источники перед сохранением.');
        const latest = await api('/api/audience?limit=50');
        if (latest?.enabled !== true || !Array.isArray(latest.source_refs) || !latest.source_refs.includes(sourceRef))
          throw new Error('Разрешение источника больше не действует. Цель не создана.');
        if (!(listing.source_refs ?? []).includes(sourceRef)) throw new Error('Источник больше не входит в текущий список. Цель не создана.');
        if (!await handoffLeaseCurrent(handoff)) throw new Error('Именно это разрешение источника больше не действует. Цель не создана.');
        const result = await command('audience.open', { title, objective, source_ids:[sourceRef] });
        selectedGoal = result.goal_id ?? result.id; selectedNeed = selectedAssessment = null;
        followupContext = followupContextGuard = null; followupError = '';
      });
      return;
    }
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
    if (action === 'audience-goal') { selectedGoal = id; selectedNeed = selectedAssessment = null; reassessmentContext = reassessmentContextGuard = null; reassessmentError = ''; followupContext = followupContextGuard = null; followupError = ''; await load(); return; }
    if (action === 'audience-need') { selectedNeed = id; selectedAssessment = null; reassessmentContext = reassessmentContextGuard = null; reassessmentError = ''; followupContext = followupContextGuard = null; followupError = ''; await load(); return; }
    if (action === 'audience-assessment') { selectedAssessment = id; selectedNeed = null; followupContext = followupContextGuard = null; followupError = ''; await load(); return; }
    if (action === 'audience-next') { cursor = listing?.next_cursor ?? ''; await load(); return; }
    if (!goal) throw new Error('Сначала откройте цель.');
    if (action === 'audience-renew-source') { await openSourceRenewal(id); return; }
    if (action === 'audience-followup-context') {
      if (!need || need.id !== id || selectedNeed !== id) throw new Error('Сначала откройте гипотезу.');
      followupLoading = true; followupError = '';
      try {
        const loaded = await api(`/api/audience/needs/${encodeURIComponent(need.id)}/followup-context`);
        if (loaded?.need_id !== need.id || loaded.need_revision !== need.revision
          || loaded.need_basis_fingerprint !== need.basis_fingerprint) throw new Error('Гипотеза изменилась; перечитайте её перед просмотром нового контекста.');
        followupContext = loaded;
        followupContextGuard = { goal_id:goal.id, need_id:need.id, need_revision:need.revision,
          need_basis_fingerprint:need.basis_fingerprint, context_fingerprint:loaded.context_fingerprint,
          observation_heads:structuredClone(loaded.observation_heads ?? {}) };
      } catch (e) { followupContext = null; followupContextGuard = null; followupError = e.message; }
      finally { followupLoading = false; }
      return;
    }
    if (action === 'audience-followup-request') {
      if (!need || need.id !== id || selectedNeed !== id) throw new Error('Сначала откройте гипотезу и новый текущий контекст.');
      openFollowupRequest(need); return;
    }
    if (action === 'audience-followup-revoke') {
      if (!need || !selectedNeed) throw new Error('Сначала откройте гипотезу с историей запросов.');
      openFollowupRevoke(need, id); return;
    }
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
    if (action === 'audience-first-contact-approve' || action === 'audience-first-contact-reject') {
      const decision = action.endsWith('approve') ? 'approve' : 'reject';
      const frozen = need;
      const binding = firstContactBinding(frozen);
      const isWithdrawal = decision === 'reject' && binding.valid && binding.state.state === 'approved';
      const allowed = binding.valid && binding.freshnessCurrent && frozen.id === id && selectedNeed === id && frozen.current === true
        && ['proposed','accepted'].includes(frozen.status)
        && (binding.state.state === 'pending' || isWithdrawal && frozen.status === 'accepted')
        && (decision === 'reject' || frozen.status === 'accepted' && binding.state.state === 'pending'
          && binding.proposal.channel === 'public_reply' && binding.freshnessCurrent
          && typeof frozen.material_preview?.content === 'string' && !!frozen.material_preview.content.trim());
      if (!allowed) throw new Error('Предложение нельзя рассмотреть: обновите гипотезу и проверьте её точный текст и основание.');
      modal(`${decision === 'approve' ? 'Одобрить только текст предложения' : 'Отклонить предложение первого ответа'}`,
        field('note', 'Основание решения', 'textarea'), async p => {
          const latest = need, currentBinding = firstContactBinding(latest);
          const currentWithdrawal = decision === 'reject' && currentBinding.valid && currentBinding.state.state === 'approved';
          const stillAllowed = latest?.id === frozen.id && selectedNeed === frozen.id
            && latest.revision === frozen.revision && latest.basis_fingerprint === frozen.basis_fingerprint
            && currentBinding.valid && currentBinding.freshnessCurrent
            && (currentBinding.state.state === 'pending' || currentWithdrawal && latest.status === 'accepted')
            && currentBinding.state.proposal_sha256 === binding.state.proposal_sha256
            && latest.current === true && ['proposed','accepted'].includes(latest.status)
            && (decision === 'reject' || latest.status === 'accepted' && currentBinding.state.state === 'pending'
              && currentBinding.proposal.channel === 'public_reply' && currentBinding.freshnessCurrent
              && typeof latest.material_preview?.content === 'string' && !!latest.material_preview.content.trim());
          if (!stillAllowed) throw new Error('Гипотеза или предложение изменились. Обновите страницу и проверьте снова.');
          if (!p.note?.trim()) throw new Error('Укажите основание решения.');
          await command('audience.review_first_contact', { need_id:frozen.id, expected_revision:frozen.revision,
            expected_basis_fingerprint:frozen.basis_fingerprint, expected_proposal_sha256:binding.state.proposal_sha256,
            decision, note:p.note.trim() });
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
      if (n.first_contact) {
        const binding = firstContactBinding(n);
        if (!binding.valid || binding.proposal.channel === 'public_reply' && (!binding.freshnessCurrent || binding.state.state !== 'approved'))
          throw new Error('Материал ответа можно импортировать только после отдельного одобрения при актуальной дате публикации. Обновите данные и проверьте снова.');
      }
      await command('audience.import_preview', { need_id: n.id, expected_revision: n.revision,
        expected_basis_fingerprint: n.basis_fingerprint, case_id: linked.id,
        expected_case_revision: linked.revision, expected_preview_sha256: n.preview_sha256 });
      await load(); return;
    }
    throw new Error(`Неизвестное действие Audience Intelligence: ${action}`);
  }
  async function openGoalForSource(handoff) {
    if (!listing) await load();
    if (!handoff || !/^telegram:channel:[1-9][0-9]{0,18}$/.test(String(handoff.source_ref ?? ''))
      || typeof handoff.grant_id !== 'string' || !handoff.grant_id.trim()
      || typeof handoff.campaign_id !== 'string' || !handoff.campaign_id.trim()
      || typeof handoff.candidate_id !== 'string' || !handoff.candidate_id.trim())
      throw new Error('Передан некорректный источник.');
    if (listing?.enabled !== true || !(listing.source_refs ?? []).includes(handoff.source_ref)
      || typeof handoff.expires_at !== 'string' || Date.parse(handoff.expires_at) <= Date.now())
      throw new Error('Источник или разрешение мониторинга истекло/отозвано. Цель не создана.');
    if (!await handoffLeaseCurrent(handoff)) throw new Error('Именно это разрешение источника истекло или отозвано. Цель не создана.');
    selectedGoal = selectedNeed = selectedAssessment = null;
    followupContext = followupContextGuard = null; followupError = '';
    createGoal({ ...handoff });
  }
  return { load, render, act, openGoalForSource };
}
