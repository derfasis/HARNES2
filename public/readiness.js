const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);

export function renderActivationCard(state, esc = escapeHtml) {
  const release = state?.release ?? {};
  const activation = state?.activation ?? null;
  const config = state?.configuration ?? {};
  const readers = state?.scheduler?.source_readers ?? {};
  const telegram = state?.telegram ?? {};
  const verified = release.verified === true && release.dirty !== true;
  const codeState = release.dirty === true ? 'Рабочее дерево изменено; соответствие исходникам выпуска не подтверждено.'
    : verified ? 'Текущий процесс привязан к подтверждённому выпуску.' : 'Текущий процесс не подтверждён как управляемый выпуск.';
  const active = activation?.phase === 'active'
    && typeof activation.expires_at === 'string' && Date.parse(activation.expires_at) > Date.now();
  const modelCapable = verified && active && activation?.mode === 'scoped_reasoning'
    && activation?.model_capability_available === true;
  const sourceConnection = Number.isSafeInteger(readers.active_readers)
    ? `${readers.active_readers} активных читателя из ${Number.isSafeInteger(readers.configured_sources) ? readers.configured_sources : 'неизвестного числа'}`
    : 'состояние читателей не подтверждено';
  const sourceAvailability = readers.missing_readers > 0
    ? `Отсутствуют читатели: ${readers.missing_readers}.`
    : readers.configured_sources === 0
      ? 'Публичные читатели не настроены; свежесть источников неизвестна.'
      : 'Подключение не подтверждает свежесть: она проверяется отдельно для каждого источника и цели.';
  const prereqs = [
    [config.audience_enabled, 'Audience'],
    [config.scout_enabled, 'Scout'],
    [config.control_plane_enabled, 'Control Plane'],
    [config.opportunity_automatic, 'автоматический публичный контур'],
    [config.model_endpoint_allowlisted, 'разрешённый модельный endpoint'],
    [config.public_source_configured, 'разрешённый публичный источник'],
  ];
  const missing = prereqs.filter(([ready]) => ready === false).map(([, name]) => name);
  const unknown = prereqs.filter(([ready]) => ready === undefined || ready === null).map(([, name]) => name);
  const expiry = activation?.expires_at ? esc(activation.expires_at) : 'нет активации';
  const mode = !active ? activation?.mode ? 'активация не действует' : 'активация отсутствует'
    : activation.mode === 'read_only' ? 'только чтение'
    : activation.mode === 'scoped_reasoning' ? 'ограниченная модельная возможность' : 'режим неизвестен';
  const capability = activation?.mode === 'read_only'
    ? 'Модельные вызовы закрыты в режиме только чтения.'
    : modelCapable
      ? 'Модельная возможность доступна; каждый вызов всё ещё требует отдельного конечного разрешения.'
      : 'Модельная возможность закрыта или не подтверждена.';
  const fences = [
    `Глобальный runtime: ${config.runtime_enabled === true ? 'включён' : 'выключен'}`,
    `Отправка: ${telegram.live_sending === true ? 'включена' : 'выключена'}`,
    `Контакт: ${activation?.contact_permission === true ? 'разрешён отдельно' : 'не разрешён этой активацией'}`,
  ].join(' · ');
  return `<section class="activation-card" aria-label="Готовность и режим партнёра">
    <div class="activation-card-head"><div><span class="eyebrow">ГОТОВНОСТЬ УСТАНОВКИ</span><h2>${verified ? 'Подтверждённый выпуск' : 'Код выпуска не подтверждён'}</h2></div>
      <span class="badge ${verified ? 'green' : 'red'}">${verified ? 'проверен' : 'не проверен'}</span></div>
    <p class="activation-identity">${esc(codeState)} SHA <code>${esc(release.code_sha ?? 'не указан')}</code> · ${esc(release.mode ?? 'режим запуска неизвестен')} · PID ${esc(release.pid ?? 'неизвестен')} · порт ${esc(release.port ?? 'неизвестен')}${release.instance_id ? ` · экземпляр ${esc(release.instance_id)}` : ''}${release.deployment_id ? ` · профиль ${esc(release.deployment_id)}` : ''}${release.code_root ? ` · корень кода ${esc(release.code_root)}` : ''}</p>
    <div class="activation-columns">
      <div><strong>Наблюдение за источниками</strong><p>Публичный источник: ${esc(config.public_source_configured === true ? 'разрешён' : config.public_source_configured === false ? 'не настроен' : 'состояние неизвестно')}.</p>
        <p>${esc(sourceConnection)}. ${esc(sourceAvailability)}</p></div>
      <div><strong>Модель и разрешение</strong><p>${activation?.label ? `Профиль активации: ${esc(activation.label)} · ` : ''}Режим: ${esc(mode)} · состояние: ${esc(activation?.phase ?? 'нет')} · срок: ${expiry}</p><p>${esc(capability)}</p>
        <p>${activation?.explicit_authority_required === true
          ? activation.mode === 'read_only' ? 'Для модельного вызова потребовалось бы отдельное явное разрешение цели, но текущий режим вызовы блокирует.' : 'Отдельное явное разрешение обязательно.'
          : 'Статус отдельного разрешения неизвестен.'}</p></div>
    </div>
    ${missing.length ? `<p class="activation-blocked"><strong>Не хватает настройки:</strong> ${missing.map(esc).join(', ')}. Панель не меняет конфигурацию и не запускает работу.</p>` : ''}
    ${unknown.length ? `<p class="muted tiny">Неизвестное состояние настройки: ${unknown.map(esc).join(', ')}.</p>` : ''}
    <p class="activation-fences">${esc(fences)}</p>
    <p class="muted tiny">SHA относится к работающему процессу; соответствие открытой рабочей копии здесь не проверяется. Статус выпуска не подтверждает hosted CI, полноту источников или актуальность отдельной гипотезы. Здесь нет команды запуска, продления разрешения или отправки.</p>
  </section>`;
}
