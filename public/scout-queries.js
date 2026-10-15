const label = value => ({
  queued: 'В очереди', running: 'Выполняется', completed: 'Завершено', done: 'Завершено',
  failed: 'Ошибка', blocked: 'Заблокировано', stale: 'Устарело', proposed: 'На проверке',
  approved: 'Материал одобрен для просмотра', rejected: 'Отклонено', active: 'Действует',
  expired: 'Истекло', revoked: 'Отозвано',
}[value] ?? value ?? 'неизвестно');
const date = value => value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const classes = {
  own_business_request: 'Автор говорит о запросе своего бизнеса',
  provider_offer: 'Автор предлагает услуги или продукт',
  third_party_context: 'Речь о третьем лице или приведённой цитате',
  unclear: 'Авторство или смысл неясны',
  other: 'Другая категория',
};

export function renderScoutQueries({ detail, disabled, esc, button, area, input }) {
  const queries = detail?.message_queries ?? [];
  const candidates = detail?.candidates ?? [];
  const configQueries = detail?.config?.queries ?? [];
  const canRead = !disabled && detail?.status === 'active' && detail?.authority?.scout?.current === true;
  const canAssess = canRead && detail?.revision !== undefined;
  const start = button('Запросить сообщения', 'scout-query-start', detail?.id ?? '', 'secondary');
  const forms = candidates.length ? `${canRead ? start : '<small class="muted">Сначала выдайте действующее разрешение аудита для чтения.</small>'}${queries.length || configQueries.length ? '' : '<small class="muted">Добавьте поисковые запросы в настройках кампании.</small>'}` : '<small class="muted">Сначала добавьте источник в панели «Кандидаты и доказательства».</small>';
  const contents = queries.length ? queries.map(q => renderQuery(q, esc, button, area, input, canAssess)).join('')
    : `<div class="empty"><strong>Запросов сообщений пока нет</strong><p>Запрос запускается отдельно по выбранным источникам и поисковым словам кампании.</p></div>`;
  return `<section class="panel"><div class="panel-head"><h2>Поиск сообщений по запросу</h2></div><div class="section-note">Каждый запуск читает одну ограниченную страницу по точному запросу. Пустой результат не означает, что в источнике нет подходящей темы. Результат не измеряет качество или полноту источника.</div><div class="actions">${forms}</div>${contents}</section>`;
}

function renderQuery(query, esc, button, area, input, canAssess) {
  const sourceName = query.source?.title || (query.source?.username ? `@${query.source.username}` : query.source?.channel_id) || 'Источник';
  const receipts = query.receipts ?? [];
  const receiptMarkup = receipts.length ? receipts.map(receipt => renderReceipt(query, receipt, esc, button, area, input, canAssess)).join('') : '';
  const attemptMarkup = Number.isInteger(query.attempts) && query.attempts >= 0 ? `<small>Попыток задания: ${esc(query.attempts)}</small>` : '';
  return `<article class="scout-card"><div class="panel-head"><div><h3>${esc(sourceName)}</h3><small>Запрос: ${esc(query.query ?? '')} · ${esc(query.from ?? '—')} — ${esc(query.until ?? '—')} · максимум ${esc(query.limit ?? '—')}</small>${attemptMarkup}</div><span class="badge">${esc(label(query.status))}</span></div>${query.reason ? `<p>${esc(query.reason)}</p>` : ''}${receiptMarkup}</article>`;
}

function renderReceipt(query, receipt, esc, button, area, input, canAssess) {
  const selection = receipt.selection ?? {};
  const messages = receipt.messages ?? [];
  const proposals = receipt.proposals ?? [];
  const requests = receipt.model_requests ?? [];
  const messageMarkup = messages.length ? messages.map(message => `<div class="scout-evidence"><small>Сообщение ${esc(message.message_id ?? '—')} · опубликовано ${esc(date(message.date))}${message.edit_date ? ` · изменено ${esc(date(message.edit_date))}` : ''}${message.unsupported ? ` · текст недоступен: ${esc(message.unsupported)}` : ''}${message.reply_to ? ` · ответ на ${esc(message.reply_to.message_id ?? message.reply_to)}` : ''}${message.link && /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/[1-9][0-9]*$/.test(message.link) ? ` · <a href="${esc(message.link)}" target="_blank" rel="noopener noreferrer">Открыть сообщение</a>` : ''}</small>${message.text ? `<blockquote>${esc(message.text)}</blockquote>` : ''}</div>`).join('')
    : `<div class="empty"><strong>Ничего не найдено по этому запросу</strong><p>Это результат одной страницы поиска. Он не доказывает отсутствие таких запросов или потребностей в источнике.</p></div>`;
  const truncation = selection.truncated === true || Number(selection.omitted_count) > 0
    ? `<p class="review-error">Часть результатов не показана: получено ${esc(selection.received_count ?? 'неизвестно')}, показано ${esc(selection.returned_count ?? messages.length)}, пропущено ${esc(selection.omitted_count ?? 'неизвестно')}. Выборка не является полной историей.</p>` : '';
  const proposalMarkup = proposals.map(proposal => renderProposal(proposal, esc, button, area)).join('');
  const requestMarkup = requests.map(request => `<small>Оценка: ${esc(label(request.status))}${request.expires_at ? ` · до ${esc(date(request.expires_at))}` : ''}${request.purpose ? ` · ${esc(request.purpose)}` : ''}${request.spent === true ? ' · попытка использована' : ''}</small>`).join('');
  const assess = canAssess && receipt.current === true && button('Разрешить одну оценку', 'scout-query-assess', receipt.id, 'secondary');
  return `<div class="scout-audit"><strong>Результат запроса</strong><small>${esc(date(receipt.retrieved_at))} · ${receipt.current === true ? 'текущая запись' : 'текущность не подтверждена'} · сообщений: ${esc(selection.returned_count ?? messages.length)} · покрытие полной истории: неизвестно</small><small>Текущность проверяется по локальным событиям; удалённые правки, не отражённые в этих данных, могут быть не видны.</small>${selection.kind ? `<small>Получено ${esc(selection.received_count ?? 'неизвестно')} · опущено ${esc(selection.omitted_count ?? 'неизвестно')} · лимит ${esc(selection.limit ?? 'неизвестно')}</small>` : ''}${truncation}${messageMarkup}${requestMarkup}${assess ? `<div class="actions">${assess}</div>` : ''}${proposalMarkup}</div>`;
}

function renderProposal(proposal, esc, button, area) {
  const items = proposal.items ?? [];
  const itemMarkup = items.map(item => `<div class="scout-evidence"><small>Сообщение ${esc(item.message_id ?? '—')} · ${esc(classes[item.classification] ?? classes.unclear)}</small>${item.quoted_text ? `<blockquote>${esc(item.quoted_text)}</blockquote>` : ''}${item.interpretation ? `<p>${esc(item.interpretation)}</p>` : ''}${item.missing_context?.length ? `<small>Не хватает контекста: ${esc(item.missing_context.join('; '))}</small>` : ''}${item.suggested_public_reply ? `<p><strong>Возможный публичный ответ — только материал для просмотра</strong></p><blockquote>${esc(item.suggested_public_reply)}</blockquote>` : ''}</div>`).join('');
  const decisions = proposal.current === true && (proposal.status === 'proposed' || proposal.status === 'pending')
    ? `<div class="actions">${button('Одобрить материал для просмотра', 'scout-query-review-approve', proposal.id)}${button('Отклонить материал', 'scout-query-review-reject', proposal.id, 'danger')}</div>` : '';
  return `<div class="scout-audit"><strong>Предложенная интерпретация · ${esc(label(proposal.status))}</strong>${proposal.summary ? `<p>${esc(proposal.summary)}</p>` : ''}${itemMarkup}${proposal.unknowns?.length ? `<p>Неизвестно: ${esc(proposal.unknowns.join('; '))}</p>` : ''}${proposal.note ? `<small>Заметка проверки: ${esc(proposal.note)}</small>` : ''}<p class="muted">Текущий интерес, соответствие предложению и разрешение на контакт остаются неизвестными. Одобрение относится только к материалу для просмотра; оно не создаёт черновик и не разрешает отправку.</p>${decisions}</div>`;
}

export async function handleScoutQueryAction({ action, id, campaign, detail, api, command, modal, esc, input, area }) {
  const base = { campaign_id: campaign.id, revision: campaign.revision };
  if (action === 'scout-register') {
    modal('Добавить источник без чтения истории', `<p>Источник будет разрешён по указанной публичной ссылке. Это действие не читает сообщения, не запускает поиск и не вызывает модель.</p>${input('reference', 'Публичная ссылка t.me/@username')}`, async p => {
      const reference = p.reference?.trim();
      if (!reference) throw new Error('Укажите публичный источник.');
      const current = await api(`/api/scout/campaigns/${encodeURIComponent(campaign.id)}`);
      if (current?.id !== campaign.id || current.revision !== campaign.revision || current.authority?.scout?.current !== true) throw new Error('Кампания или разрешение аудита изменились. Обновите экран.');
      return command('scout.register', { ...base, reference });
    });
    return;
  }
  if (action === 'scout-query-start') {
    const candidates = detail?.candidates ?? [];
    const queries = campaign.config?.queries ?? [];
    if (campaign.status !== 'active' || campaign.authority?.scout?.current !== true) throw new Error('Для чтения нужно действующее разрешение аудита.');
    if (!candidates.length || !queries.length) throw new Error('Нужны добавленный источник и запросы в настройках кампании.');
    const candidateFields = candidates.map((candidate, index) => `<label class="scout-source"><input type="checkbox" name="candidate_${index}" value="yes">${esc(candidate.title || (candidate.username ? `@${candidate.username}` : candidate.channel_id) || 'Источник')} · ${esc(candidate.channel_id ?? '')}</label>`).join('');
    const queryFields = queries.map((query, index) => `<label class="scout-source"><input type="checkbox" name="query_${index}" value="yes">${esc(query)}</label>`).join('');
    modal('Запросить сообщения', `<p>Поиск выполнится по выбранным источникам и только по словам, уже сохранённым в этой кампании. Нужны действующее разрешение аудита и доступный лимит чтения. Будет прочитана одна страница; это не полная история.</p><strong>Источники</strong>${candidateFields}<strong>Запросы кампании</strong>${queryFields}${input('window_days', 'Окно поиска в днях', '30', 'number')}${input('limit', 'Максимум сообщений на пару', '10', 'number')}<p class="muted">Можно выбрать не более 20 пар «источник — запрос». Запуск не оценивает качество источника и не разрешает контакт.</p>`, async p => {
      const candidate_ids = candidates.filter((_, index) => p[`candidate_${index}`] === 'yes').map(candidate => candidate.id);
      const selectedQueries = queries.filter((_, index) => p[`query_${index}`] === 'yes');
      const window_days = Number(p.window_days), limit = Number(p.limit);
      if (!candidate_ids.length || !selectedQueries.length) throw new Error('Выберите хотя бы один источник и один запрос кампании.');
      if (candidate_ids.length > 10 || selectedQueries.length > 10) throw new Error('Выберите не более 10 источников и 10 запросов.');
      if (candidate_ids.length * selectedQueries.length > 20) throw new Error('Выбрано более 20 пар. Сократите выбор источников или запросов.');
      if (!Number.isInteger(window_days) || window_days < 1 || window_days > 30) throw new Error('Окно должно быть от 1 до 30 дней.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Лимит страницы должен быть от 1 до 100 сообщений.');
      const current = await api(`/api/scout/campaigns/${encodeURIComponent(campaign.id)}`);
      if (current?.id !== campaign.id || current.revision !== campaign.revision || current.status !== 'active' || current.authority?.scout?.current !== true)
        throw new Error('Кампания или разрешение аудита изменились. Обновите экран.');
      const currentIds = new Set((current.candidates ?? []).map(candidate => candidate.id));
      if (candidate_ids.some(candidateId => !currentIds.has(candidateId)) || selectedQueries.some(query => !(current.config?.queries ?? []).includes(query)))
        throw new Error('Источник или запрос изменился. Обновите экран.');
      return command('scout.query_messages', { ...base, candidate_ids, queries: selectedQueries, window_days, limit });
    });
    return;
  }
  if (action === 'scout-query-assess') {
    const receipt = (detail?.message_queries ?? []).flatMap(query => query.receipts ?? []).find(row => row.id === id);
    const latest = await api('/api/scout');
    const current = await api(`/api/scout/campaigns/${encodeURIComponent(campaign.id)}`);
    const currentReceipt = (current?.message_queries ?? []).flatMap(query => query.receipts ?? []).find(row => row.id === id);
    if (!receipt || !currentReceipt || receipt.digest !== currentReceipt.digest || currentReceipt.current !== true
      || current.revision !== campaign.revision || current.authority?.scout?.current !== true || !latest.model_scoped_available)
      throw new Error('Текущий результат, разрешение аудита или ограниченная модель недоступны. Обновите экран.');
    const profiles = (latest.model_profiles ?? []).filter(profile => profile.state === 'available' && !profile.block_reasons?.length && typeof profile.definition_hash === 'string');
    if (!profiles.length) throw new Error('Нет доступного профиля модели.');
    const choices = `<label>Профиль модели<select name="model_profile_id">${profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.label)} · ${esc(profile.model_config?.model)}</option>`).join('')}</select></label>`;
    const expiry = new Date(Date.now() + 30 * 60 * 1000); expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset());
    const defaultExpiry = expiry.toISOString().slice(0, 16);
    modal('Разрешить одну оценку результата', `<p>Это отдельное разрешение на один возможный платный вызов модели по точному результату ${esc(currentReceipt.id)}. Запрос не выполняется при открытии этой формы. Потерянный ответ не будет автоматически повторён.</p><p>Истечение по умолчанию через 30 минут. Текущий интерес и соответствие предложения остаются неизвестными; контакт не разрешается.</p>${choices}${input('expires_at', 'Истекает', defaultExpiry, 'datetime-local')}${area('purpose', 'Цель этой оценки')}`, p => {
      const profile = profiles.find(row => row.id === p.model_profile_id), expiresAt = new Date(p.expires_at);
      if (!profile || !p.expires_at || !Number.isFinite(expiresAt.valueOf()) || expiresAt <= new Date() || expiresAt > Date.now() + 24 * 60 * 60 * 1000 || !p.purpose?.trim())
        throw new Error('Укажите профиль, цель и будущий срок не более 24 часов.');
      return command('scout.request_query_assessment', { ...base, receipt_id: currentReceipt.id, expected_receipt_digest: currentReceipt.digest,
        model_profile_id: profile.id, expected_model_profile_hash: profile.definition_hash, expires_at: expiresAt.toISOString(), purpose: p.purpose.trim() });
    });
    return;
  }
  if (action === 'scout-query-review-approve' || action === 'scout-query-review-reject') {
    const proposal = (detail?.message_queries ?? []).flatMap(query => query.receipts ?? []).flatMap(receipt => receipt.proposals ?? []).find(row => row.id === id);
    if (!proposal || proposal.current !== true || !['proposed', 'pending'].includes(proposal.status)) throw new Error('Материал устарел или уже рассмотрен. Обновите экран.');
    const decision = action.endsWith('approve') ? 'approve' : 'reject';
    modal(decision === 'approve' ? 'Одобрить материал для просмотра' : 'Отклонить материал', `<p>Решение относится только к предложенной интерпретации и возможному публичному ответу. Оно не создаёт черновик и не разрешает контакт или отправку.</p>${area('note', 'Основание решения')}`, p => {
      if (!p.note?.trim()) throw new Error('Укажите основание решения.');
      return command('scout.review_query', { ...base, proposal_id: proposal.id, decision, note: p.note.trim() });
    });
    return;
  }
  throw new Error(`Неизвестное действие запроса сообщений: ${action}`);
}
