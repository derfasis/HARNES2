# Partner Executive v1

Реализация: 2026-09-28. Статус: **код подготовлен для review; функциональные
проверки ещё не запускались**. Executive, его модельные вызовы и autoplan по
умолчанию выключены. Живые источники, провайдеры и отправки при разработке не включались.

Ветка `codex/partner-executive-v1` построена поверх **Partner Continuity
`c91c37d1ec11708f3f7fd5626ca0904b3783e2c6`**, который находится отдельно от main.
Main на момент завершения — `b2606526aa8fb074b1eff157df89938832a3fda0`.
Это зависимая ветка: сравнение с main включает Continuity; для review только
Executive сравнивайте с `c91c37d`. Main не изменялся.

Основа: [согласованное предложение](PARTNER_EXECUTIVE_V1_PROPOSAL.md)
и [проверенные OSS-доноры](PARTNER_EXECUTIVE_DONORS.md).

## Сценарий

```text
Рабочий вопрос Continuity + текущие свидетельства
  → план владельца / один no-tool turn партнёра
  → отдельное разрешение владельца с deadline и allow_model
  → текущие версии выбранных записей / ближайшие разрешённые Browser polls
  → durable packet + квитанции
  → brief вручную / один разрешённый no-tool turn
  → review владельца
  → память интерпретации Continuity с проверяемыми ссылками
```

Модель выбирает вопрос, связь с решением, критерий завершения и полезные источники.
Код проверяет scope, версию разрешения, freshness, бюджет и форму результата.
План не запускает исследование. Принятый brief не становится независимо
подтверждённым фактом, contact permission или командой на действие.

Вкладка **«Исследования»** использует существующие operator session и commands.
Можно открыть рабочий вопрос на разрешённых источниках, задать план, разрешить
его, подготовить вывод, принять или отклонить его и отменить исследование.
Новый вопрос наблюдает новые source events; автоматического чтения старой истории нет.
API Continuity сохраняет явный выбор исторических evidence IDs.

## Состояние и лимиты

Миграция `006-partner-executive.sql` добавляет две таблицы:

| Сущность | Содержимое |
| --- | --- |
| `research_intents` | Вопрос, цель решения, критерий, выбранные логические записи и sources, basis плана, отдельный authority hash, разрешение, deadline, packet и ссылка на turn |
| `research_attempts` | Версия capability, однократный slot, версия разрешения, run ID, статус и квитанция |

До одного активного исследования на вопрос и 100 на партнёра. Выбор ограничен
32 evidence IDs, двумя Browser sources и deadline от секунды до 24 часов.
UI предлагает один час; модель для brief по умолчанию не разрешена.

Каталог фиксирован: `research.read_evidence`, `research.refresh_source`,
`research.submit_brief`, версия `1.0.0`. Планирование учитывается отдельной попыткой
`research.plan`. Нет загрузки произвольной capability, shell, URL или модели из плана.

Maintenance обрабатывает до 20 intents за проход, модельная очередь рассматривает
до 10 и готовит не более одного turn. Курсоры сохраняются в `channel_offsets`.
Общие бюджеты по UTC учитывают все runtime runs; отдельный лимит Executive —
5 turns в день по умолчанию. Неизвестная стоимость блокирует запуск при заданном
денежном пороге. Порог по учтённым расходам не является жёстким ограничением счета.
Один Hermes turn сохраняет существующую ограниченную политику внутренних retry;
он не равен гарантированно одному HTTP-запросу к модели.

## Authority, evidence и восстановление

Authority hash связывает вопрос, бизнес-цель, заметки/паузы владельца, policy
каждого watch и версию Executive. Он не включает версии прочитанных сообщений:
разрешённое обновление страницы должно иметь возможность заменить evidence.
До выдачи разрешения проверяется точный basis показанного плана. После разрешения
scope остаётся прежним: текущие версии только выбранных source/message IDs.

После capture любое изменение полного Continuity basis или выбранной версии
evidence делает результат непринимаемым. Проверка выполняется перед модельным
turn, сохранением результата и review, в том числе через прямой Continuity API.
Выбранные записи проверяются даже после выхода из короткого рабочего окна.
Edit/delete/unsupported, истечение freshness, revoke, смена policy или цели
не маскируются отсутствием новых событий. Packet содержит ограниченные цитаты,
не утверждает полноту истории и независимую истинность источника.

Browser refresh присоединяется к уже разрешённому и наступившему poll. Executive
не меняет source budget, cadence, очередь читателей, URL или checkpoint.
Telegram использует уже принятые durable events и прежние transport/access/PTS
проверки. Для него нельзя выдать Browser refresh. Source ingestion не переписан.

Отмена, revoke или изменение evidence во время model turn не позволяют сохранить
brief. Использование модели всё равно учитывается, а turn освобождается после
возврата worker. Очередные pending attempts могут продолжиться после restart
только после повторной проверки оснований. Попытки `running` переходят в
`interrupted_unknown`: без автоматического retry и превращения в успех.
Telegram checkpoint требует обычного восстановления current state после restart;
Browser checkpoint остаётся под исходной проверкой возраста.

Maintenance инвалидирует старые разрешения и при выключенном Executive.
Повторное включение source не оживляет уже отозванный watch/intent. Ошибка сохранения
результата оставляет неизвестную стоимость и не разрешает тихий retry.
Обычный автоматический Continuity turn не забирает вопрос у активного
исследования, включая план на рассмотрении. Перед созданием плана нужно завершить
review предыдущего Continuity turn; эта операция также доступна в UI.
Другие вопросы используют прежний цикл.

## OSS и импорт

Переиспользованы установленный Hermes и существующий `decide` worker без
инструментов/бизнес-токена; AJV; SQLite Store, Scheduler, Browser reader и GramJS
ingestion. Upstream revision, лицензии, зависимости и транспортные валидаторы
не изменялись. Новый workflow framework или второй LLM runtime не добавлялись.

Для OpenOutFind добавлен маленький адаптер публичного JSONL export: 1–25 строк,
до 48 КБ. Он не устанавливает и не запускает finder. Контракт проверялся на
`36cf18fc69892fff9bbf71ca9748eec4198682a7`; версия экспортера из самого JSONL
неизвестна и сохраняется как `null`, а не подменяется версией адаптера.

Записи хранятся в events как `unverified_external_candidate`: `reason` —
интерпретация донора, `qualified_at` — время qualification, а не freshness источника.
Неполная provenance явно отмечена. Неизвестные поля отбрасываются без копирования
в audit; сохраняются hash входного объекта и проекция известных полей.
Повтор проекции не создаёт второй artifact. Email/URL остаются непроверенными
строками, не исполняются и не дают contact permission. Candidate не попадает
в source truth, модельный packet, CRM или send pipeline.

Это входной мост для будущего finder. Live executor отдельно потребует проверенных
source/provider/cost scope и полного provenance envelope.

## Конфигурация и API

Новые defaults:

```json
"executive": {
  "enabled": false,
  "modelEnabled": false,
  "autoPlan": false,
  "maxModelRunsPerDay": 5
}
```

Executive требует `continuity.enabled`, `opportunity.automatic` и прежнюю read-only
границу: `runtime.enabled: false`, `telegram.liveSending: false`.
Ручной режим не требует ключа модели. Модельный режим — отдельный opt-in,
готовая конфигурация decision runtime и общие бюджеты. `continuity.modelEnabled`
может оставаться выключенным. `autoPlan` отдельно разрешает до одного предложения
на принятую актуальную память; перед исследованием всё равно нужен owner grant.
Общий Opportunity pipeline сохраняет свои условия модельного запуска: флаг
Executive не является его выключателем.

| API | Назначение |
| --- | --- |
| `GET /api/executive/intents?limit=20&cursor=…&thread_id=…` | Очередь, флаги, refresh refs и каталог |
| `GET /api/executive/intents/<id>` | План, разрешение, текущий packet, история попыток |
| `GET /api/executive/candidates?limit=20&cursor=0` | Импортированные материалы |
| `executive.propose` / `executive.request_plan` | Ручной план / запрос модельного планирования |
| `executive.authorize` | Exact revision + proposal basis, deadline, explicit allow_model |
| `executive.submit_brief` | Вывод через контракт Continuity |
| `executive.review` / `executive.cancel` | Версионированное решение владельца |
| `executive.import_candidates` | Единственное поле payload: `jsonl` |

Команды используют `POST /api/commands`, operator token и `request_id`; agent actor
не имеет доступа. Query API отвергает неизвестные и повторяющиеся параметры.
Исторические turns доступны как audit; `reviewable` определяется текущим состоянием.
Export включает новые таблицы. Import сохраняет точный table/migration/checksum/FK
контроль и принимает прежние bundles со схемами 2–5 с пустыми research tables.
Восстановление остаётся staging-only, без замены активной базы.

## Проверки и передача

Фактически выполнено 2026-09-28:

| Проверка | Результат |
| --- | --- |
| `npm run build` | PASS: синтаксис 109 JavaScript/JSON и 9 Python файлов |
| `git diff --check` / `git diff --cached --check` | PASS, включая новые файлы |
| Acceptance / convergence / full regression | NOT RUN — действует прямое ограничение владельца в AGENTS.md |
| Модель, Browser/Telegram live, отправки | Не запускались |

`tests/executive.test.mjs` и `tests/executive-ui.test.mjs` описывают manual loop,
model doubles, stale/revoke, процессный crash, cancellation race, refresh/cadence,
бюджет, automatic attention, cursor/restart, migration/restore, donor atomicity
и UI escaping. Наличие тестов не означает подтверждённый результат.
Convergence gate не изменён. Изменения старых тестов ограничены новой схемой,
legacy bundles и Store pin для дополнительных export/recovery сущностей.

После разрешения владельца порядок проверки:

```powershell
node --test tests/executive.test.mjs tests/executive-ui.test.mjs tests/continuity.test.mjs tests/discovery-convergence-gate.test.mjs
node --test tests/discovery-convergence-gate.test.mjs
npm test
npm run test:credentials
npm run build
git diff --check
```

## Граница v1

Нет произвольного web search, live finder, OAuth/tool platform, отправок,
автосогласия, draft/send, объединения идентичностей, learning/evaluation,
перестройки retention или автоматической повторной выдачи grant. Ошибка refresh
завершает исследование без brief; новый план требует решения владельца.
Критерий завершения помогает оценить результат, но не доказывает достижение цели.
Валидные IDs и точные цитаты не доказывают entailment или качество стратегии.

Независимая проверка должна подтвердить функциональный цикл, отсутствие
ложно-зелёных тестов и работу двух reasoning loops при ограниченном бюджете.
Этот commit сам по себе не разрешает merge или live rollout.
