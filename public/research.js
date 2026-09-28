// Uses the existing operator session/commands. Source text is always escaped.
export function createResearchView({ api, command, esc, panel, button, empty, field, modal, refresh }) {
  let threads = null, intents = null, candidates = null, thread = null, intent = null, turn = null, threadTurn = null;
  let candidateCursor = '0';
  let selectedThread = null, selectedIntent = null, threadCursor = '', intentCursor = '';
  const terminal = new Set(['completed','rejected','cancelled','superseded','failed','interrupted_unknown','no_research']);
  const statuses = { plan_requested: 'План ожидает модели', planning: 'Партнёр составляет план', proposed: 'Нужно разрешение',
    waiting_sources: 'Ожидает разрешённого чтения', ready: 'Evidence готово', reasoning: 'Партнёр готовит вывод',
    brief_proposed: 'Вывод на рассмотрении', completed: 'Вывод рассмотрен', rejected: 'Отклонено', cancelled: 'Отменено',
    superseded: 'Основание изменилось', failed: 'Не завершено', interrupted_unknown: 'Прервано — нужна сверка', no_research: 'Дополнительная работа не предложена' };
  const boxes = (name, entries, checked = false) => entries.map(([value, label], i) =>
    `<label class="research-choice"><input type="checkbox" name="${name}${i}" value="${esc(value)}"${checked ? ' checked' : ''}> ${esc(label)}</label>`).join('');
  const picks = (p, prefix) => Object.entries(p).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  const refs = d => [...new Map([...d.evidence, ...d.memory_evidence].map(e => [e.source_event_id, e])).values()];
  const listing = (rows, action, title) => rows.map(r => `<article class="lesson"><h3>${esc(title(r))}</h3>
    <p>${esc(statuses[r.status] ?? r.status)}</p>${button('Открыть', action, r.id)}</article>`).join('');
  async function load() {
    threads = await api(`/api/continuity/threads?limit=20${threadCursor ? `&cursor=${encodeURIComponent(threadCursor)}` : ''}`);
    intents = await api(`/api/executive/intents?limit=20${selectedThread ? `&thread_id=${encodeURIComponent(selectedThread)}` : ''}${intentCursor ? `&cursor=${encodeURIComponent(intentCursor)}` : ''}`);
    candidates = await api(`/api/executive/candidates?limit=20&cursor=${encodeURIComponent(candidateCursor)}`);
    thread = selectedThread ? await api(`/api/continuity/threads/${encodeURIComponent(selectedThread)}`) : null;
    threadTurn = thread?.latest_turn ? await api(`/api/continuity/turns/${encodeURIComponent(thread.latest_turn.id)}`) : null;
    intent = selectedIntent ? await api(`/api/executive/intents/${encodeURIComponent(selectedIntent)}`) : null;
    turn = intent?.turn_id ? await api(`/api/continuity/turns/${encodeURIComponent(intent.turn_id)}`) : null;
  }
  function render() {
    if (!threads || !intents) return empty('Исследования', 'Загружаем рабочие вопросы.');
    const enabled = intents.enabled && threads.enabled;
    const notice = !enabled ? '<div class="section-note">Исследования выключены в конфигурации. Сохранённая работа доступна для просмотра.</div>' :
      !intents.model_enabled ? '<div class="section-note">Модельные вызовы выключены. Можно задать исследование и подготовить вывод вручную.</div>' :
      '<div class="section-note">Партнёр может предложить исследование. Получение данных и модельный вывод требуют отдельного разрешения на задание.</div>';
    let body = notice + panel('Рабочие вопросы', listing(threads.items, 'research-thread', r => r.title)
      || empty('Задайте вопрос партнёру', 'Выберите уже разрешённые источники и опишите, что нужно выяснить.'),
      enabled ? button('+ Рабочий вопрос', 'research-new', '', 'primary') : '');
    body += `<div class="actions">${threadCursor ? button('В начало вопросов', 'research-thread-first') : ''}
      ${threads.next_cursor ? button('Следующие вопросы', 'research-thread-next') : ''}${selectedThread ? button('Все исследования', 'research-all') : ''}</div>`;
    if (thread) {
      const pending = threadTurn && ['captured','running','proposed'].includes(threadTurn.status);
      body += panel(thread.title, `<p>${esc(thread.objective)}</p><p><strong>Результат:</strong> ${esc(thread.success_condition)}</p>
        <p>Состояние: ${esc(thread.status)}. Текущих свидетельств: ${refs(thread).length}.</p>
        ${thread.memory ? `<p><strong>Рассмотренное понимание:</strong> ${thread.memory.current ? esc(thread.memory.content.summary.text) : 'Устарело; требуется пересмотр.'}</p><small>Интерпретация, не независимо подтверждённый факт.</small>` : ''}
        ${!thread.ready ? '<p>Для нового исследования нужны доступные текущие данные. Ожидаем чтения источников.</p>' : ''}
        ${pending ? '<p>Сначала завершите рассмотрение текущего вывода по этому вопросу.</p>' : ''}
        <div class="actions">${enabled && thread.ready && !pending ? button('Задать исследование', 'research-propose', thread.id) : ''}
        ${enabled && thread.ready && !pending && intents.model_enabled ? button('Попросить партнёра предложить план', 'research-plan', thread.id) : ''}
        ${enabled && thread.status !== 'CLOSED' ? button('Уточнить цель', 'research-note', thread.id) : ''}</div>`);
      if (threadTurn?.output && !threadTurn.packet?.research && ['proposed','stale'].includes(threadTurn.status)) {
        body += panel('Текущий вывод по вопросу', `<p>${esc(threadTurn.output.summary.text)}</p>
          <p><strong>Неизвестно:</strong> ${esc(threadTurn.output.unknowns.join(' '))}</p>
          <details><summary>Цитаты и полный вывод</summary><pre class="code">${esc(JSON.stringify(threadTurn.output, null, 2))}</pre></details>
          <div class="actions">${enabled && threadTurn.reviewable ? button('Принять понимание', 'research-memory-accept', threadTurn.id) : ''}
          ${button('Отклонить вывод', 'research-memory-reject', threadTurn.id)}</div>`);
      }
    }
    body += panel('Исследования', listing(intents.items, 'research-intent', r => r.question || 'Подготовка плана') || empty('Заданий пока нет', 'Откройте рабочий вопрос.'));
    body += `<div class="actions">${intentCursor ? button('В начало исследований', 'research-intent-first') : ''}
      ${intents.next_cursor ? button('Следующие исследования', 'research-intent-next') : ''}</div>`;
    if (intent) {
      const packet = intent.packet;
      body += panel(intent.question || 'Подготовка исследования', `<p><strong>${esc(statuses[intent.status] ?? intent.status)}</strong></p>
        <p>${esc(intent.decision_to_inform ?? '')}</p><p><strong>Критерий завершения:</strong> ${esc(intent.completion_criterion ?? 'Ещё не предложен')}</p>
        <p>Лимит обновлений: ${intent.limits.refresh_reads}; модельных выводов: ${intent.limits.brief_model_runs}.
        ${intent.deadline ? `Срок: ${esc(new Date(intent.deadline).toLocaleString('ru-RU'))}.` : ''}</p>
        ${intent.current_reason ? '<p>Основание или доступность данных изменились. Старое разрешение не даёт права продолжить.</p>' : ''}
        ${intent.reason ? `<p>${esc(intent.reason)}</p>` : ''}
        <details><summary>Разрешённые источники (${new Set(intent.selection.map(s => s.source_ref)).size})</summary>
          <ul>${[...new Set(intent.selection.map(s => s.source_ref))].map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>
        ${packet ? `<details open><summary>Текущие свидетельства</summary>${packet.evidence.map(e => `<article class="lesson">
          <small>${esc(e.source_ref)} · версия ${e.message_version}</small><blockquote>${esc(e.text)}</blockquote>
          ${e.truncated ? '<small>Показан фрагмент, текст обрезан.</small>' : ''}</article>`).join('')}</details>` : ''}
        <div class="actions">${enabled && intent.current && intent.status === 'proposed' ? button('Разрешить исследование', 'research-authorize', intent.id, 'primary') : ''}
        ${enabled && intent.current && intent.status === 'ready' ? button('Подготовить вывод вручную', 'research-brief', intent.id) : ''}
        ${!terminal.has(intent.status) ? button('Отменить задание', 'research-cancel', intent.id) : ''}</div>`);
      if (turn?.output) body += panel('Результат исследования', `<p>${esc(turn.output.summary.text)}</p>
        <p><strong>Гипотезы:</strong> ${esc(turn.output.hypotheses.map(h => h.text).join(' '))}</p>
        <p><strong>Неизвестно:</strong> ${esc(turn.output.unknowns.join(' '))}</p>
        <p><strong>Следующий шаг:</strong> ${esc(turn.output.next.reason)}</p>
        <small>Это сохранённый вывод; возможность принять его проверяется по текущему состоянию.</small>
        <div class="actions">${enabled && intent.reviewable && turn.reviewable ? button('Принять понимание', 'research-accept', intent.id, 'primary') : ''}
        ${['proposed','stale'].includes(turn.status) ? button('Отклонить вывод', 'research-reject', intent.id) : ''}</div>`);
      body += panel('Выполнение', intent.attempts.map(a => `<div class="activity"><div>${esc(a.capability_id)}
        <small>${esc(a.status)}${a.receipt?.outcome ? ` · ${esc(a.receipt.outcome)}` : ''}</small></div></div>`).join(''));
    }
    body += panel('Внешние исследовательские материалы',
      '<p>Импорт OpenOutFind сохраняет кандидатов для просмотра. Его экспорт не доказывает актуальность исходных сведений и не разрешает контакт.</p>'
      + (candidates?.items ?? []).map(r => `<article class="lesson"><h3>${esc(r.candidate.full_name || [r.candidate.first_name, r.candidate.last_name].filter(Boolean).join(' ') || r.candidate.company || r.candidate.lead_id)}</h3>
        <p>${esc(r.candidate.reason)}</p><p>${esc(r.candidate.company ?? '')} ${esc(r.candidate.title ?? '')}</p>
        <small>Интерпретация внешнего исследователя. Источники неполные, актуальность неизвестна.</small>
        <details><summary>Сохранённые поля</summary><pre class="code">${esc(JSON.stringify(r.candidate, null, 2))}</pre></details></article>`).join(''),
      enabled ? button('Импорт JSONL', 'research-import') : '');
    body += `<div class="actions">${candidateCursor !== '0' ? button('В начало материалов', 'research-candidate-first') : ''}
      ${candidates?.next_cursor ? button('Следующие материалы', 'research-candidate-next') : ''}</div>`;
    return body;
  }
  async function act(action, itemId) {
    if (action === 'research-thread') { selectedThread = itemId; selectedIntent = null; intentCursor = ''; }
    else if (action === 'research-intent') selectedIntent = itemId;
    else if (action === 'research-all') { selectedThread = null; intentCursor = ''; selectedIntent = null; }
    else if (action === 'research-thread-next') threadCursor = threads.next_cursor || threadCursor;
    else if (action === 'research-thread-first') threadCursor = '';
    else if (action === 'research-intent-next') intentCursor = intents.next_cursor || intentCursor;
    else if (action === 'research-intent-first') intentCursor = '';
    else if (action === 'research-candidate-next') candidateCursor = candidates.next_cursor || candidateCursor;
    else if (action === 'research-candidate-first') candidateCursor = '0';
    else if (action === 'research-import') {
      modal('Импорт материалов OpenOutFind', '<p>Вставьте от 1 до 25 строк JSONL (до 48 КБ). Сведения сохраняются как непроверенные внешние материалы.</p>'
        + field('jsonl', 'JSONL', 'textarea'), async p => { await command('executive.import_candidates', { jsonl: p.jsonl }); candidateCursor = '0'; }); return;
    }
    else if (action === 'research-new') {
      modal('Новый рабочий вопрос', field('title', 'Название') + field('objective', 'Что нужно выяснить', 'textarea')
        + field('success_condition', 'Как понять, что результат полезен', 'textarea')
        + '<p>Источники (до четырёх). Наблюдение начинается с новых данных.</p>'
        + boxes('source_', threads.source_refs.map(s => [s, s])), async p => {
          const r = await command('continuity.open', { title: p.title, objective: p.objective, success_condition: p.success_condition,
            source_ids: picks(p, 'source_'), max_age_seconds: 604800 }); selectedThread = r.thread_id; selectedIntent = null;
        }); return;
    } else if (action === 'research-propose') {
      const d = thread, evidence = refs(d).slice(0, 32);
      const refreshable = d.watches.filter(w => intents.refreshable_source_refs.includes(w.source_ref));
      modal('Исследование', field('question', 'Вопрос', 'textarea') + field('decision_to_inform', 'Какому решению это поможет', 'textarea')
        + field('completion_criterion', 'Что должно получиться', 'textarea') + '<p>Свидетельства для проверки:</p>'
        + boxes('evidence_', evidence.map(e => [e.source_event_id, `${e.source_ref}: ${e.text.slice(0, 130)}`]), true)
        + '<p>Какие страницы перечитать (до двух, по обычному расписанию):</p>' + boxes('refresh_', refreshable.map(w => [w.source_ref, w.source_ref])),
        async p => { const r = await command('executive.propose', { thread_id: d.id, expected_basis_fingerprint: d.basis_fingerprint,
          plan: { question: p.question, decision_to_inform: p.decision_to_inform, completion_criterion: p.completion_criterion,
            evidence_event_ids: picks(p, 'evidence_'), refresh_source_ids: picks(p, 'refresh_') } }); selectedIntent = r.intent_id; }); return;
    } else if (action === 'research-plan') {
      const d = thread;
      modal('Предложить план', '<p>Партнёр выполнит один модельный запуск в пределах общего бюджета. План сам по себе не разрешает исследование.</p>',
        async () => { const r = await command('executive.request_plan', { thread_id: d.id, expected_basis_fingerprint: d.basis_fingerprint }); selectedIntent = r.intent_id; }); return;
    } else if (action === 'research-authorize') {
      const d = intent;
      modal('Разрешить ограниченное исследование', `<p>${esc(d.question)}</p><p>Будут прочитаны текущие версии выбранных свидетельств;
        до ${d.refresh_source_ids.length} обновлений страниц по обычному расписанию. Разрешение действует один час.</p>`
        + field('allow_model', 'Подготовка вывода', 'select', 'false', [['false','Вручную, без модельного вызова'], ...(intents.model_enabled ? [['true','Разрешить один модельный вызов']] : [])]),
        p => command('executive.authorize', { intent_id: d.id, expected_revision: d.revision,
          expected_basis_fingerprint: d.proposal_basis_fingerprint, allow_model: p.allow_model === 'true', deadline: new Date(Date.now() + 3600000).toISOString() })); return;
    } else if (action === 'research-note') {
      const d = thread; modal('Уточнить рабочий вопрос', field('text','Уточнение','textarea'), p => command('continuity.note', {
        thread_id: d.id, expected_revision: d.revision, text: p.text })); return;
    } else if (action === 'research-cancel') {
      const d = intent; modal('Отменить исследование', field('reason','Причина','textarea'), p => command('executive.cancel', {
        intent_id: d.id, expected_revision: d.revision, reason: p.reason })); return;
    } else if (action === 'research-brief') {
      const d = intent, evidence = d.packet.evidence;
      modal('Вывод владельца', field('summary','Что удалось выяснить','textarea')
        + field('source','Свидетельство для вывода','select', evidence[0].source_event_id, evidence.map(e => [e.source_event_id, `${e.source_ref}: ${e.text.slice(0, 90)}`]))
        + field('quote','Точная цитата','textarea', evidence[0].text) + field('unknowns','Что осталось неизвестным (по строке)','textarea')
        + field('next_reason','За чем наблюдать дальше','textarea'), p => command('executive.submit_brief', {
          intent_id: d.id, expected_revision: d.revision, output: { summary: { text: p.summary, evidence_event_ids: [p.source] },
            claims: [{ source_event_id: p.source, quote: p.quote }], hypotheses: [], unknowns: p.unknowns.split('\n').map(s => s.trim()).filter(Boolean),
            next: { kind: 'observe', reason: p.next_reason, wake_at: null, owner_question: null } } })); return;
    } else if (action === 'research-memory-accept' || action === 'research-memory-reject') {
      const d = threadTurn; modal(action === 'research-memory-accept' ? 'Принять понимание вопроса' : 'Отклонить вывод по вопросу',
        field('note','Основание решения','textarea'), p => command('continuity.review', { turn_id: d.id,
          expected_basis_fingerprint: d.basis_fingerprint, decision: action === 'research-memory-accept' ? 'accept' : 'reject', note: p.note })); return;
    } else if (action === 'research-accept' || action === 'research-reject') {
      const d = intent; modal(action === 'research-accept' ? 'Принять понимание' : 'Отклонить вывод',
        field('note','Основание решения','textarea'), p => command('executive.review', { intent_id: d.id, expected_revision: d.revision,
          decision: action === 'research-accept' ? 'accept' : 'reject', note: p.note })); return;
    }
    await refresh();
  }
  return { load, render, act };
}
