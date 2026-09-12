# Auto Opportunity Pipeline v0

## Архитектурное решение до кода

База: main 9f1ff1d1e4006e493eeb26b7c1dba3c06187efac, merge consumer
8beab00c640be603da9959a926442f7018f0bb49. Все 93 blobs и Git tree
7f44254dd0a981cd1ff723d475a3c765cc60fe1b проверены по Git SHA.
Локальный commit object восстановлен только после совпадения точного SHA;
checkout shallow. История upstream не изменена.

Существующие Telegram Bot API / GramJS adapters принимают только private inbound.
Они используют person.create + message.record, а последний создаёт executable reply
для Conversation Brain. Этот путь непригоден для public discovery. Opportunity
capture/consume сейчас являются раздельными operator-only offline командами.
Автоматический переход между ними отсутствует.

Нужен source-neutral read-only путь: source.ingest -> immutable source.message
в events -> scheduler -> существующий no-tool Situation Router worker с Opportunity
контекстом -> валидаторы Projection/Router -> существующий Consumer -> review task.
Новые DB, task kinds, timers, credential pools, agents и approval engines не нужны.
Runs без task_id учитывают inference, а НЕ превращают review в agent task.
Результат inference сохраняется перед consumer transaction для восстановления без
повторного model call после rollback. Source event считается обработанным только
в одной транзакции с candidate/task или с явным terminal disposition.

Нормализованный boundary обязан хранить source/message/author/thread/reply/version,
upsert/delete и точный текст. Неизвестный author остаётся null и не анализируется
как известный человек. CRM link только из локального явного source-author binding,
никогда из display name или model output. Tombstones, version rollback/collision,
поздний inference, policy/offer/goal/ownership/suppression проверяются кодом.

В v0 automatic=true занимает существующий scheduler исключительно для no-tool
анализа; runtime.enabled=false и telegram.enabled/liveSending=false обязательны.
Это prerequisite для подключения реального адаптера, не утверждение live ingress.
Чтение Telegram transport требует отдельно проверенной public normalization и
reconnect/backfill/delete semantics; private adapters не переключаются на public
простым снятием фильтра.

## Ограничения среды

Нет настроенных model/Telegram credentials; нет установленных ajv, telegram,
upstream Hermes и .venv. Установка пакетов недоступна. Baseline Node, credential
suite и штатный build запускаются с сохранением ошибок. Новые тесты не означают
прохождение полного regression. Merge: NOT READY до независимой интеграции.

## Что реализовано

Normalized source event автоматически выбирается существующим scheduler,
проходит один no-tool turn Projection + Router и существующий Consumer. Только
валидный ненулевой hypothesis или HANDOFF создаёт opportunity_review. IGNORE/WAIT
без hypothesis сохраняют terminal disposition без засорения операторской очереди.
Реальная интеграция этого пути требует regression в среде с зависимостями.

Новые production-модули: source-ingestion.mjs и opportunity-pipeline.mjs.
Остальное является небольшими изменениями существующих Consumer, scheduler,
runtime, команд и UI. Новых таблиц, migrations, очередей задач, таймеров,
семантических классификаторов, agent tools и систем credentials нет.

## Настройка и подключение source boundary

Не включать автоматический режим в production до интеграционной проверки.
В config/local.json используются существующие runtime settings и opportunity:

```json
{
  "runtime": {"enabled": false},
  "telegram": {"enabled": false, "liveSending": false},
  "scheduler": {"enabled": true},
  "opportunity": {
    "automatic": true,
    "allowedSourceRefs": ["public:approved-source"],
    "activeOffer": {
      "id": "operator-offer", "version": "v1", "text": "Operator supplied offer",
      "criteria": ["Operator supplied criterion"], "exclusions": []
    },
    "goalText": "Operator supplied review goal",
    "allowedChannels": ["public"],
    "maxAgeSeconds": 86400,
    "authorBindings": []
  }
}
```

Это только иллюстрация конфигурации, не активированный источник или реальный offer.
Модель/baseUrl и PARTNER_MODEL_API_KEY берутся из существующей настройки runtime.
Secondary/tertiary credentials и EphemeralCredentialPool не изменены.
Строка automatic=true занимает scheduler для анализа, НЕ включает agent runtime.
Обычный HermesAdapter.run в этом режиме также отвергается. Загрузка business tools
для decide отсутствует; используется существующий scripts/situation_router_worker.py,
maxIterations=1, tools=[], без business_url, run token, Telegram или ambient API keys.

Source adapter вызывает только существующий service.command:

```javascript
await service.command('source.ingest', normalizedEvent, stableRequestId, {
  kind: 'channel', sourceId: normalizedEvent.source_id
});
// Cursor advance permitted only after successful durable command.
```

В существующем локальном /api/commands эта же команда доступна только оператору
за x-partner-token. Не создавался открытый webhook или новый adapter credential.
Future adapter сам проверяет публичность, права доступа и membership allowlist;
модель не может менять этот список. source_id точно совпадает с allowedSourceRefs.

Все поля normalizedEvent обязательны:

```json
{
  "source_id": "public:approved-source", "source_kind": "sanitized_fixture",
  "message_id": "m-101", "author_id": "a-42", "display_name": "Visible name",
  "thread_id": "thread-7", "reply_to_id": null, "version": 1,
  "operation": "upsert", "text": "Exact public source text",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

source_kind: sanitized_fixture или live_snapshot. Последнее является metadata
поставщика, НЕ доказательством live-проверки. Идентификаторы message/author/thread/reply
соответствуют frozen Router ID syntax. Адаптер обязан стабильно нормализовать ID,
например signed Telegram ID с префиксом, а не обрезать, hash по имени или угадывать.
source_id задаёт namespace. author_id, display_name, thread_id и reply_to_id могут
быть null; неизвестный автор сохраняется null, inference для него запрещён.
Версия положительная monotonic integer до 2147483647, не arrival order. Два edits
с одинаковым timestamp требуют различимых upstream revisions; коллизия блокируется.
created_at неизменен; updated_at не уменьшается. delete требует text=null и более
новую версию, известная author identity сохраняется; resurrection не поддерживается.

Optional authorBindings: [{source_id,author_id,conversation_id}], исключительно
явное локальное утверждение оператора. Это не верификация личности и не permission.
Без binding CRM suppression/ownership неизвестны, что явно показано в review.
С binding проверяются существующие person.suppressed и conversation ownership/revision.
Никакие persons, channel_identities или inbound reply tasks автоматически не создаются.

## Транзакции и восстановление

1. source.message + command audit + receipt записываются текущим BusinessService
   в BEGIN IMMEDIATE. Duplicate возвращает первоначальный source_event_id.
2. Scheduler выбирает unfinished source.message, не tasks. Snapshot + run intent
   сохраняются вместе. runs.task_id/conversation_id=null, runtime=hermes-opportunity.
3. Inference идёт вне транзакции. Успешный ограниченный ответ сохраняется как
   analyzed, без provider exceptions, raw messages, business tools или секретов.
4. Следующая транзакция проверяет freshness и validators, создаёт candidate/task,
   записывает terminal event и завершает run. Fault откатывает всё это вместе;
   analyzed остаётся, следующий tick или restart не требуют нового model call.
5. Crash во время inference: существующий Store.recover помечает run interrupted.
   Повтор возможен после bounded delay, до 3 attempts на source event. Это не
   exactly-once model billing: потерянный ответ может потребовать повторный вызов.
6. Fault при сохранении model result освобождает только собственный run в interrupted.
   Если сама БД недоступна, очередь не подтверждается; нужен recovery после restart.
7. Cancelled review остаётся дедуплицированной. task.approve/retry запрещены.
   scheduler, contextFor и partner_list_work не выдают review как agent instructions.

Shared usage accounting сохраняет дневные лимиты. Неизвестная стоимость при заданном
budget останавливает новые вызовы, включая retries. Это намеренная fail-closed политика,
не доказательство бесплатного timeout. На следующий день старые snapshots могут истечь.

## Freshness и bounded context

Fingerprint учитывает все scoped source event IDs, anchor, offer, goal, каналы и
CRM link. Текущие scoped dependencies пересчитываются перед consumption и чтением UI.
Unrelated thread/author не делает карточку stale; другая версия или удаление relevant
parent делает. Нельзя оживить старый anchor при наличии более позднего relevant текста.
Полные тексты/parent IDs передаются frozen buildOpportunityContext, где действуют
существующие maxMessages=32, maxCharacters=24000 и parent-depth=8.

Pilot ограничен 1000 distinct messages на source и 70000 UTF-8 bytes relevant raw
records до frozen projection. Переполнение явно отклоняется, без silent truncation.
Ограничения source scans рассчитаны на pilot, не на крупный мониторинг.

## Self-audit и сознательные ограничения

- Исправлена излишняя source-wide invalidation: auto capture проверяет scoped
  immutable versions; unrelated thread не инвалидирует правильный candidate.
- Устранено повторение stable digest и учёта usage, не создан общий framework.
- Усилен contextFor: прямой аргумент opportunity_review также отвергается,
  кроме уже существующих SQL filters для work/context.
- Scope source adapter проверяется ДО возврата command receipt, чтобы повтор
  request_id не обходил проверку sourceId. Agent не имеет source.ingest.
- No-tool runtime не импортирует business tools и не получает токен для них.
- Сохранённые analyzed results продолжаются даже без model readiness/budget;
  повторный inference для уже сохранённого результата не нужен.
- Сквозные fault/ownership/semantic validator проверки написаны, но в этой среде
  НЕ выполнены. Статический self-audit не является независимым внешним аудитом.
- Frozen validators доказывают provenance и authority shape, НЕ семантическую
  полноту: модель может ошибочно классифицировать quote/refusal или пропустить
  contradiction. Операторская проверка остаётся обязательной.
- Неполная identity, неизвестный автор в relevant context, overflow и старый anchor
  дают явный terminal disposition. Это fail-closed false negatives, не auto guesses.
- Терминальный source event НЕ открывается автоматически после изменения offer/goal,
  позднего появления missing parent или уточнения binding. Новая версия/новое сообщение
  создаёт следующий trigger; старый candidate становится stale. Не построен replay engine.
- Удаление invalidates evidence, но immutable audit history не стирается. Это не
  реализация privacy retention/erasure; перед live пилотом нужна соответствующая политика.
- Нет live fetch, reconnect/backfill, ingestion cursor mapping, public Telegram
  normalization или корректной multi-edit/deletion гарантии от Telegram transport.
- Existing private Telegram adapters НЕ переключены и не включались. До реального
  monitoring нужна проверенная read-only public normalization с durable cursor,
  author/thread/reply IDs, edits/deletes, gap/backfill semantics и разрешённым аккаунтом.
- Нет автоматического feedback-learning или lifecycle исполнения HANDOFF. HANDOFF
  остаётся только review, без ownership mutation и уведомления человеку.

## Обязательные сценарии и уровень доказательства

| Требование | Проверка | Статус в этой среде |
|---|---|---|
| 1 новое подходящее сообщение | pipeline: automatic review | Написана, import blocked |
| 2 нерелевантное сообщение | pipeline: no opportunity | Написана, import blocked |
| 3 чужой автор | source identity + pipeline evidence rejection | Source выполнена; validator blocked |
| 4 reply ancestry | source ancestry/missing + pipeline coverage | Source выполнена; integration blocked |
| 5 explicit refusal | pipeline closed opening + existing Projection | Написана, import blocked |
| 6 prompt injection | source exact data; runtime no-tool; UI escaping; pipeline | Source/runtime/UI выполнены; integration blocked |
| 7 duplicate delivery | 17 deliveries, one source event | Выполнена |
| 8 edited source | version supersession + pipeline review | Source выполнена; integration blocked |
| 9 delete/superseded | tombstone, no resurrection, parent deletion | Source выполнена; integration blocked |
| 10 same-version collision | latest и historical collision | Выполнена |
| 11 changed offer | mid-inference freshness | Написана, import blocked |
| 12 changed caller goal | mid-inference freshness | Написана, import blocked |
| 13 forbidden DM | frozen output validation | Написана, import blocked |
| 14 owner request HANDOFF | model-shaped HANDOFF → review | Написана, import blocked |
| 15 restart ingestion/inference | source reload + integrated resume | Source выполнена; integration blocked |
| 16 timeout/retry | delay, attempt limit, budget pause | Написана, import blocked |
| 17 repeated model output | consumer duplicate + cancelled review | Написана, import blocked |
| 18 transaction failure | ingress rollback + consumer/result persistence faults | Source выполнена; integration blocked |
| 19 HUMAN_OWNED | before/during inference | Написана, import blocked |
| 20 suppression | linked person stopped | Написана, import blocked |
| 21 stale after newer version | source state + late model output | Source выполнена; integration blocked |
| 22 same visible names | source/author isolation + distinct cards | Source выполнена; integration blocked |

## Merge recommendation

**NOT READY.** Это передача реализации prerequisite для независимого integration
аудита, не объявление выполненного критерия «живой источник → правильная карточка».
Нужно получить zero failures/zero unexpected skips с настоящими зависимостями,
проверить no-tool Hermes path с минимальным разрешённым model smoke, затем подключать
конкретный read-only source. Sending не нужен и не допускается для этих проверок.

## Independent integration audit: 2026-09-12

This section supersedes the blocked verification and merge status above. Astra's
original environment report is retained as history, not new regression evidence.
The owner authorized exact bundle import, independent audit, offline tests and a
minimal real no-tool smoke, followed by branch publication only after green.

- Base/main: `9f1ff1d1e4006e493eeb26b7c1dba3c06187efac`.
- Imported Astra: `4697623b948362d3375d586f400418d75ac50f3c`.
- Branch: `astra/live-opportunity-pipeline-v0`; four original commits are intact:
  `d88eb4c`, `ea9b65a`, `7e78f78`, `4697623`.
- Additional regression commit: `1b75682`.
- No rebase, squash, main modification, merge or production fix was needed.
- Dependencies already provisioned: ajv 8.17.1, telegram 2.26.22, pinned Hermes
  `4810074d73d9419dc82545202d595507a73f4f0e`; no install or lock change.

### Independent findings

No production defect requiring a fix was found. Production remains identical in
Git to the imported Astra implementation. Three missing verification boundaries
were covered by focused tests: concurrent delivery/ticks, terminal run-update
rollback AFTER card/marker creation, and recovery of an in-flight inference claim.
These are deterministic integration checks, not an OS-crash or multi-process
load test. No behavior was changed merely to make a test pass.

| Critical question | Finding |
| --- | --- |
| Public text becomes agent instruction? | Ingestion stores data, not business messages/tasks. No-tool context separates trusted instructions from source text; consumer instructions are fixed. Direct contextFor(review) rejects. |
| Review enters agent work? | Global and conversation SQL filters exclude the kind; direct context guard is also tested. |
| Scheduler executes review? | Automatic branch selects source events and returns before agent/autopilot code. Ordinary selector still excludes review even with corrupted pending status. |
| JSON escalates authority? | Unchanged strict Projection/Router validation rejects permission, effects, approval/authorization, wrong recipient and DM. PUBLIC_REPLY remains a JSON proposal, not a drafts row. |
| Display-name identity confusion? | IDs are scoped by source; names are display-only. Exact author/version/span validation and explicit operator-only CRM bindings are retained. |
| Source-version race/collision? | Ingestion and receipt are in existing exclusive BEGIN IMMEDIATE. Historical same-version changes fail, unseen older updates do not replace current state, tombstones cannot resurrect. |
| Duplicate-card race? | Durable running claim prevents a competing scheduler inference. Candidate uses existing reserved task dedupe. Concurrent delivery/ticks, duplicate result, cancellation and restart tests pass. |
| Crash leaves half-written state? | Capture/run intent commit together. Result checkpoint commits separately; candidate/task/terminal/run completion commit together. Fault after marker/card creation rolls all final writes back. |
| Retry infers unnecessarily? | Analyzed output is consumed without model readiness or another call. Failed/interrupted inference has bounded delay and at most three attempts; unknown budget cost pauses it. |
| Late result creates stale card? | Rechecks anchor/context event IDs, allowlist, offer content, goal/channels, binding and CRM state before consumption. Source edits/deletes and ownership changes discard late results. |
| analyzed -> consumer -> terminal rollback? | Failed task creation and failed terminal run update leave analyzed output, no card/marker, unchanged receipts. Restart completes the same stored result with one total stub inference. |
| Parallel runtime/store/task path? | New runtime is a tag in existing runs, not an engine. Same scheduler, Store/events/tasks, usage limits, HermesAdapter, existing no-tool worker and credential pool. No new DB/schema/timer/CLI/reviewer/approval mechanism. |

Frozen Router v1 and Projection modules/schemas, Store/migrations, Brain assets,
Python workers/credential code, Telegram adapters and upstream/package locks have
an empty Git diff against base. Runtime deliberately adds decide/no-tool dispatch;
it does not advertise business tools, URL or run token in that envelope.

### Actually executed regression

All commands exited 0, with zero failures, cancellations and skips. Counts overlap.

| Command/suite | Observed result |
| --- | --- |
| npm test | 139/139 |
| node --test "tests/*opportunity*.test.mjs" | 84/84 |
| HARNES2/Router regression | 27/27, including all tracked frozen Router fixtures and Brain context |
| Projection | 17/17 |
| Consumer | 34/34: 24 real integration + 10 UI/static/blob checks |
| Auto Pipeline | 30/30: all 27 Astra cases + 3 independent recovery/race checks |
| Source ingestion | 28/28 |
| Runtime envelope | 3/3 |
| npm run test:credentials | 5/5 against the real pinned Hermes credential module with synthetic clients |
| npm run build | 44 JavaScript/JSON and 6 Python files syntax-compiled |
| git diff BASE..HEAD --check | Clean |

### Real model smoke, not a model-shaped stub

One synthetic normalized event executed the genuine path: source.ingest -> stored
source/snapshot -> HermesAdapter.decide -> installed situation_router_worker.py ->
existing ephemeral credential pool -> model -> unchanged validators -> Consumer ->
review card. The external audit harness observed the genuine child/envelope; it
did not replace the worker, credential pool, model or validators.
No scheduler timer or real source transport was started. Store was a temporary
synthetic instance, not the active business database. Credentials came only from
the existing model environment; ambient/Telegram credentials were stripped and
the real child was checked for tools=[], maxIterations=1, no business_url/token.

Sanitized observed result:

```json
{
  "model": "free/gpt-5.6-luna",
  "adapter_turns": 1,
  "child_launches": 1,
  "hermes_api_calls": 1,
  "success": true,
  "disposition": "review_created",
  "decision": "PUBLIC_REPLY",
  "hypothesis": "The author's explicit public question creates a supported opening for a cautious public reply that explains only the general format and limits of a wellness partnership, without income or health promises.",
  "evidence": [{
    "message_id": "smoke-question", "author_id": "invented-author-1", "version": 1,
    "span": "I am considering a wellness partnership. What does the format involve, and what are its limits? I only need public information about the format, without income or health promises.",
    "kind": "question", "attribution": "author_statement"
  }],
  "contradictions": [],
  "unknowns": [
    "Whether the operator has authorized public format content beyond the high-level description.",
    "Whether the author seeks a general explanation or a specific partnership review.",
    "Whether any eligibility, regulatory, or product constraints apply to the proposed public reply."
  ],
  "contact_permission": false, "allowed_effects": [], "executable": false, "fresh": true
}
```

API-call count is Hermes's reported count, not independent wire-level SDK retry
instrumentation. Only one adapter inference and one child launch were performed;
no benchmark, failover probe or additional model smoke was run.
Repeat delivery and another tick did not infer again. Approve/retry rejected;
cancellation persisted without reactivation. Persons, conversations, messages,
drafts, approvals, delivery_attempts, outcome_events and tool_calls stayed at zero.

### Observed end-to-end scenarios

The first row used the real model; other rows used hand-authored responses with
real scheduler/Store/validators/Consumer. They do not measure semantic accuracy.

| Scenario | Observed output |
| --- | --- |
| Explicit public question + fixture offer, real Luna | One fresh PUBLIC_REPLY review, exact author/version/span, false permission and empty effects. |
| Irrelevant source | Valid IGNORE result, terminal marker, no card/draft. |
| Refusal with fabricated positive claim | Actual validator rejects; no card. |
| Same display name, different author IDs | Two distinct review subjects a1/a2, no guessed person. |
| Edit/delete and late result | Old evidence becomes stale; deleted trigger does not infer; newer-version arrival prevents stale card. |
| Consumer or terminal transaction fault | No half-written card/marker; analyzed retry succeeds without another inference. |
| Concurrent delivery/ticks | One source event, one claimed inference, one review/terminal marker. |

### Safety and conditions

Actual local/default configuration retains automatic=false, runtime.enabled=false,
telegram.enabled=false and telegram.liveSending=false. Only the disposable smoke
configuration set automatic=true in memory. No live agent path, source adapter,
Telegram/DM/email/browser posting/comments, approval, AUTOPILOT, permission or effect
grant was activated. Model API access and Git publication are not business effects.

READY WITH CONDITIONS for a disabled-by-default source-neutral offline prerequisite.
Before real source data, require processing allowance and retention/erasure policy;
tombstones invalidate but do not erase immutable history. Before live monitoring,
review the actual public adapter, namespace/version/edit/delete guarantees, durable
cursor and reconnect/backfill/gap behavior. Event scans/capacity are bounded-pilot
tradeoffs, not proven scale. Terminal events do not automatically reevaluate after
policy/offer/goal/parent changes. CRM links and semantic completeness require a
human; one positive smoke proves plumbing, not product value or detection quality.
Lost in-flight responses can require another paid call after recovery; exactly-once
billing is not promised. UI/HTTP authorization remain source/markup checks, not a
new browser/HTTP integration execution. No main merge was performed in this audit.
