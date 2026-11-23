// The partner's own notebook, as the owner sees it. Reading never changes anything, and there
// is deliberately no approve button: the owner objects or sets his own stop; the partner decides.
export function createNotebookView({ api, command, esc, panel, button, empty, field, modal }) {
  let view = null;
  const day = value => value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
  const STATUS = {
    hypothesis: ['гипотеза', 'purple'], confirmed: ['подтверждено', 'green'], retired: ['снято', ''], active: ['действует', 'green'],
    open: ['ждёт', 'purple'], closed: ['закрыто', ''], untested: ['не проверено', 'purple'], tried: ['проверено на себе', 'green'],
    discarded: ['отложено', ''], answered: ['есть ответ', 'green'],
  };
  const VERDICT = { matched: ['совпало', 'green'], missed: ['не совпало', 'red'], unknown: ['неизвестно', ''] };
  const STANCE = { agree: ['согласен', 'green'], partly: ['согласен частично', 'purple'], disagree: ['не согласен', 'red'] };
  const SCOPE = { move: 'планы и задачи', message: 'тексты людям', any: 'планы и тексты' };
  const pill = (map, key) => { const [text, tone] = map[key] ?? [key, '']; return badge(text, tone); };
  const block = (label, text) => text ? `<p><strong>${esc(label)}:</strong> ${esc(text)}</p>` : '';
  const refs = list => list?.length ? `<small class="muted">Основание: ${esc(list.join(', '))}</small>` : '';
  const head = (entry, badges) => `<div class="panel-head"><h3>${esc(entry.id)} · ${esc(entry.title)}</h3><span>${badges}</span></div>`;
  const object = entry => button('Возразить', 'notebook-note-new', entry.id);
  const section = name => view.sections[name];
  const broken = name => section(name).error ? `<p class="badge red">${esc(section(name).error)}</p>` : '';
  const body = (name, render, none) => broken(name) + (section(name).entries.length ? section(name).entries.slice().reverse().map(render).join('') : section(name).error ? '' : none);

  async function load() { view = await api('/api/notebook'); }
  function render() {
    if (!view) return empty('Тетрадь партнёра', 'Загружаем записи.');
    const now = Date.now();
    let html = `<div class="section-note">${esc(view.authority)} Файлы тетради: <code>${esc(view.directory)}</code></div>`;
    if (!view.enabled) html += '<div class="section-note">Тетрадь выключена в настройках: партнёр её не читает и не ведёт. Сохранённые записи показаны для просмотра.</div>';
    const canWrite = view.enabled;
    html += panel('Ваши возражения и его ответы', body('notes', entry => `<article class="lesson">${head(entry, pill(STATUS, entry.meta.status) + (entry.meta.stance ? pill(STANCE, entry.meta.stance) : ''))}
      ${block('Вы', entry.fields.owner)}${block('Партнёр', entry.fields.answer)}
      <small class="muted">${esc(day(entry.meta.created_at))}${entry.meta.answered_at ? ` · ответ ${esc(day(entry.meta.answered_at))}` : ' · ответит в ближайшем собственном запуске'}</small></article>`,
    empty('Возражений нет', 'Не согласны с записью партнёра — напишите ему. Он ответит по существу и может остаться при своём.')),
    canWrite ? button('Написать партнёру', 'notebook-note-new', '', 'primary') : '');
    html += panel('Правила партнёра', body('rules', entry => `<article class="lesson">${head(entry, pill(STATUS, entry.meta.status) + (entry.meta.status === 'confirmed' ? badge(`×${entry.meta.confirmations}`) : ''))}
      ${block('Правило', entry.fields.rule)}${block('Когда применять', entry.fields.applies_to)}${block('Почему изменил', entry.fields.change_note)}${block('Почему снял', entry.fields.retired_reason)}
      ${refs(entry.meta.evidence)}<div class="actions">${canWrite && entry.meta.status !== 'retired' ? object(entry) : ''}</div></article>`,
    empty('Правил пока нет', 'Первое появится, когда партнёр сравнит своё ожидание с тем, что вышло.')));
    html += panel('Стоп-лист: так больше не делаю', body('stops', entry => `<article class="lesson">${head(entry, pill(STATUS, entry.meta.status) + badge(entry.meta.author === 'owner' ? 'ваш запрет' : 'решение партнёра', entry.meta.author === 'owner' ? 'purple' : ''))}
      ${block('Почему', entry.fields.reason)}${block('Срабатывает на', entry.meta.patterns.map(item => `«${item}»`).join(', '))}${block('Где действует', SCOPE[entry.meta.applies_to] ?? entry.meta.applies_to)}${block('Почему снято', entry.fields.retired_reason)}
      ${refs(entry.meta.evidence)}<div class="actions">${!canWrite || entry.meta.status !== 'active' ? '' : entry.meta.author === 'owner' ? button('Снять свой запрет', 'notebook-stop-remove', entry.id, 'danger') : object(entry)}</div></article>`,
    empty('Стоп-лист пуст', 'Сюда попадает то, к чему партнёр решил не возвращаться, и ваши собственные запреты.')),
    canWrite ? button('Поставить свой запрет', 'notebook-stop-new') : '');
    html += panel('Журнал: ждал — получил', body('journal', entry => {
      const due = entry.meta.status === 'open' && Date.parse(entry.meta.check_at) <= now;
      return `<article class="lesson">${head(entry, entry.meta.status === 'open' ? badge(due ? 'срок наступил' : 'ждёт', due ? 'red' : 'purple') : pill(VERDICT, entry.meta.verdict))}
      ${block('Ход', entry.fields.move)}${block('Ждал', entry.fields.expectation)}${block('На чём основано', entry.fields.basis)}${block('Вышло', entry.fields.result)}${block('Вывод', entry.fields.lesson)}
      <small class="muted">${entry.meta.status === 'open' ? `Проверит: ${esc(day(entry.meta.check_at))}${entry.meta.rechecks ? ` · срок переносился: ${esc(entry.meta.rechecks)}` : ''}` : `Закрыто: ${esc(day(entry.meta.closed_at))}`}</small>
      <div class="actions">${canWrite && entry.meta.status === 'open' ? button('Сообщить, что вышло', 'notebook-note-new', entry.id) : ''}</div></article>`;
    }, empty('Журнал пуст', 'Перед собственным ходом партнёр записывает, чего ждёт и когда проверит.')));
    html += panel('Прочитанное и советы', body('library', entry => `<article class="lesson">${head(entry, pill(STATUS, entry.meta.status))}
      ${block('Источник', entry.fields.source)}${block('Что там сказано', entry.fields.text)}${block('Что хочет проверить', entry.fields.to_test)}${block('Что вышло', entry.fields.outcome)}
      ${entry.meta.tried_in ? `<small class="muted">Проба: ${esc(entry.meta.tried_in)}</small>` : ''}</article>`,
    empty('Пока ничего', 'Чужой опыт хранится отдельно и не считается правилом, пока партнёр не попробовал сам.')));
    return html;
  }
  async function act(action, id) {
    if (action === 'notebook-note-new') {
      const about = typeof id === 'string' && id ? id : null;
      modal(about ? `Написать партнёру про ${about}` : 'Написать партнёру',
        `<p>Партнёр прочитает это в ближайшем собственном запуске и ответит: согласен, частично или нет. Запись он меняет сам.</p>${field('text', about?.startsWith('J-') ? 'Что вышло на самом деле' : 'Ваше возражение или наблюдение', 'textarea')}`,
        async values => { await command('notebook.owner_note', { text: values.text, ...(about ? { about } : {}) }); });
    } else if (action === 'notebook-stop-new') {
      modal('Ваш запрет для партнёра',
        `<p>Партнёр не сможет снять этот запрет. Код остановит его планы и тексты, где встретится признак, в том числе с другим окончанием слов.</p>
        ${field('title', 'Коротко: что запрещено')}${field('reason', 'Почему', 'textarea')}${field('patterns', 'Признаки, по одному в строке (до 5)', 'textarea')}
        ${field('applies_to', 'Где действует', 'select', 'any', Object.entries(SCOPE))}`,
        async values => { await command('notebook.owner_stop', { op: 'add', title: values.title, reason: values.reason, applies_to: values.applies_to,
          patterns: String(values.patterns ?? '').split('\n').map(line => line.trim()).filter(Boolean) }); });
    } else if (action === 'notebook-stop-remove') {
      const entry = view?.sections.stops.entries.find(item => item.id === id);
      if (!entry) return;
      modal(`Снять запрет ${entry.id}`, `<p>${esc(entry.title)}</p>${field('confirm', 'Снять этот запрет?', 'select', 'no', [['no', 'Нет, оставить'], ['yes', 'Да, снять']])}`,
        async values => { if (values.confirm === 'yes') await command('notebook.owner_stop', { op: 'remove', stop_id: entry.id }); });
    }
  }
  return { load, render, act };
}
