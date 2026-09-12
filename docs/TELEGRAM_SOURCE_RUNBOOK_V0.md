# Read-only Telegram source intake v0

Independent local acceptance: **READY WITH CONDITIONS** for offline intake only.
See [restored-environment audit and regression results](TELEGRAM_SOURCE_AUDIT_V0.md).
The development-environment verification section below is the historical Astra run.

## Статус и граница результата

Реализован и проверен на настоящем SQLite ограниченный слой приёма событий от
доверенного Telegram reader. Живой Telegram client и mapper сырых MTProto difference
ответов НЕ реализованы. Сервер не подключает источник сам. Никакие credentials,
session, live-чаты или платные модели при разработке не использовались.

Существующий Scheduler принимает необязательный четвёртый аргумент `sourceReaders=[]`.
В automatic-ветке он сначала вызывает reader, затем существующий Auto Opportunity
Pipeline. В серверной сборке список остаётся пустым. Новый таймер/очередь не создаётся.

## Что переиспользовано

`Store.transaction`, `events`, `channel_offsets`, `ingestSource`, source freshness,
`Scheduler`, no-tool Projection/Router и Consumer. Миграций и зависимостей не добавлено.
Legacy `business/channels/telegram*.mjs` не изменены: они относятся к частным CRM
разговорам и содержат send-методы, поэтому для этого слоя не подходят.

Единственное изменение Store: `recover()` инвалидирует source checkpoints после
перезапуска, сохраняя integrity latch. В pinned-тесте намеренно обновлён только hash
Store. Все прочие frozen-компоненты и проверки сохранены.

## Программный интерфейс

Конфигурация добавляется локально, не в публичный default:

````json
{
  "opportunity": {
    "automatic": true,
    "allowedSourceRefs": ["telegram:channel:100"],
    "telegramSources": [{
      "sourceId": "telegram:channel:100",
      "accountId": "999",
      "channelId": "100",
      "sourceKind": "sanitized_fixture",
      "processingBasis": "Только придуманные данные для offline-теста",
      "maxLagSeconds": 120
    }]
  }
}
````

Числа 100/999 являются вымышленными примерами, не реальными разрешёнными источниками.
Для модели по-прежнему нужны activeOffer и штатная runtime-конфигурация. Обязательны
`runtime.enabled=false`, `telegram.enabled=false`, `telegram.liveSending=false`.
`live_snapshot` обозначает происхождение, но НЕ подтверждает consent или live-проверку.
`processingBasis` является записью решения оператора, не юридическим разрешением.

````js
import { bootstrapTelegramSource } from './business/sources/telegram-readonly.mjs';
import { Scheduler } from './business/scheduler.mjs';

// trustedReader должен быть отдельно реализован и проверен. Здесь его нет.
// baseline должен быть получен согласованно с watermark; история не заявлена полной.
await bootstrapTelegramSource(service, sourceId, { pts: baselinePts, history });
const scheduler = new Scheduler(service, runtime, undefined, [
  { sourceId, transport: trustedReader }
]);
// Старт только после настройки действительного разрешённого read-only transport.
````

Reader реализует ровно `readDifference({accountId,channelId,pts,limit})` и возвращает
собственный проверенный адаптерный envelope, НЕ сырой MTProto объект:

````json
{
  "kind": "difference",
  "account_id": "999",
  "channel_id": "100",
  "from_pts": 10,
  "to_pts": 11,
  "final": true,
  "updates": [{
    "kind": "new",
    "channel_id": "100",
    "pts": 11,
    "pts_count": 1,
    "message": {
      "id": 1,
      "channel_id": "100",
      "from_id": {"kind":"user", "id":"10"},
      "post": false,
      "text": "Пример сообщения",
      "date": 1767225600
    }
  }]
}
````

`kind`: `difference` или `empty`; `too_long` вызывает latched блокировку. `new/edit`
содержат `message`, `delete` содержит только `message_ids`. В `message` разрешены
также `edit_date`, `reply_to_msg_id`, `reply_to_top_id`, `reply_to_channel_id`.
Отсутствующий автор в группе остаётся null. Broadcast post допускает только identity
самого канала. Личные подписи и сложные варианты атрибуции требуют отдельной проверки.
Channel identity нельзя связать с личной CRM conversation; несвязанные broadcast posts
не объединяются как контекст одного человека. Display name и username не используются как identity. ID передаются точными decimal
строками, message ID/pts целыми числами до 2147483647.

## Транзакции, версии и recovery

Все source.message, native update fingerprints, unknown-delete tombstones и новый pts
фиксируются в одной `BEGIN IMMEDIATE` транзакции. Возврат успеха является ACK. До него
reader не должен продвигать свой durable cursor. SQLite failure откатывает весь batch.
Отдельная failure-транзакция делает прежний checkpoint недостоверным.

Generic `source.ingest` cannot populate a source owned by a Telegram reader binding
or durable checkpoint, even after binding revocation. Use this transactional intake
interface instead; generic operator/fixture sources outside that scope are unchanged.

`version=pts`, не `edit_date` и не номер прибытия. Поэтому две правки за одну секунду
не сливаются. В пределах страницы события сортируются по pts. Пропуск в pts_count,
неучтённый прирост pts или пересекающая cursor страница отклоняются. Исторический
replay принимается только при совпадении уже сохранённого native fingerprint.
Один pts соответствует одной native update единице; multi-delete является одной такой
единицей. Произвольные MTProto updates нельзя механически выдавать за этот контракт.

Bootstrap ограничен 100 сообщениями. Его история сохраняется как `bootstrap_context_only`,
без самостоятельного создания возможностей. Пока difference не подтверждён как final,
новые события не допускаются к анализу. Неполные/отсутствующие родители сохраняются как
unresolved links; действующие Projection validators запрещают активный ход при неполноте.
Cross-peer reply ID не смешивается с локальным ID, внешний parent не загружается скрыто.

Delete известного сообщения использует его неизменяемую identity и tombstone, старые
карточки становятся stale. Delete неизвестного сообщения сохраняется как native
надгробие без выдуманного author/date/body и запрещает последующее воскрешение.
Telegram не присылает дату удаления: normalized updated_at остаётся последним известным;
момент получения отдельно доступен в event.created_at, он не выдаётся за дату удаления.

Disconnect/read error/restart/partial catch-up/истечение maxLagSeconds блокируют source
freshness. Empty response обязан совпасть по account/channel/cursor. Это утверждение
ДОВЕРЕННОГО mapper, не криптографическое доказательство от Telegram. Лживый mapper может
выдумать любой envelope; именно поэтому реальный mapper требует conformance и live-тестов.

Коллизия pts/version, смена identity, попытка resurrection, откат source time,
DifferenceTooLong и повреждение checkpoint приводят к
`INTEGRITY_RECONCILIATION_REQUIRED`. Empty poll и restart НЕ снимают эту блокировку.
Автоматического сброса/перезаписи доказательств здесь нет. Нужен отдельный проверяемый
operator reconciliation/resnapshot workflow; нельзя просто удалить offset и продолжить.

## Что намеренно не построено

Нет MTProto-криптографии, нового Telegram клиента, discover/join, Bot API polling,
истории без границ, media/forward/service/TTL content, auto-enrichment identity, DM,
send, read receipts, reactions, auto approval, AUTOPILOT и executable opportunity_review.
Неизвестные поля/контент fail closed, не пропускаются с продвижением cursor. Реальный
mapper ОБЯЗАН сохранять признаки unsupported контента и не выкидывать их для обхода guard.

Поддерживается только ограниченный channel/supergroup intake. Basic groups, private
chats, global pts/qts/seq, linked-discussion hydration, native message TTL и все варианты
`updates.getChannelDifference` пока не покрыты. `new_messages`, `other_updates`,
`users/chats`, DifferenceTooLong и снимки без per-message pts требуют честного mapper,
а не выдумывания per-message версий. Это существенная часть оставшейся работы.

## Эксплуатационные границы

Один HARNES2 процесс на SQLite database/session. Multi-process inference recovery НЕ
поддерживается: существующий Store.recover глобально прерывает running runs. Конкурентный
старт другого процесса может потерять результат/повторить model billing. Production
должен обеспечить singleton или получить отдельный lease/ownership fix до live-запуска.
Тест с новым Node процессом последовательный, не HA/multi-process доказательство.

Существующий лимит 1000 current source messages/70000 bytes relevant context сохраняется.
Долгоживущий поток его исчерпает; бесконечный мониторинг без retention/windowing не обещан.
Events не удаляются физически: tombstone не равен privacy erasure. Политика хранения,
минимизации и удаления персональных данных обязательна до настоящего потока.
Автоматическое переоткрытие уже terminal событий после восстановления контекста не
добавлялось. Потерянный in-flight model результат не означает exactly-once billing.

## Проверки в среде разработки

51 новых offline-тестов intake проходят на Node 24.16.0 и настоящем SQLite, включая
rollback, restart, pts collisions и отдельный новый Node процесс. Совместно с 28 source,
3 runtime и 10 UI-тестами проходят 92 проверок. Network/send/обычный child spawn в этих
проверках запрещены guards; отдельный Node для restart-теста запускается явно.

8 новых real-stack интеграционных сценариев подготовлены, но не исполнились:
импорт настоящего Ajv отсутствует. Валидатор не заменялся stub-ом. Полный Node suite
имеет 92 passing checks и 5 ошибок загрузки файлов (4 исходных + 1 новый), НЕ green.
Python credential tests: 5 ошибок из-за отсутствующего Hermes module `agent`.
`npm run build`: exit 1 из-за отсутствующего project `.venv` Python. Отдельно системным
Python и `node --check` прошла syntax-проверка 35 JS + 11 JSON + 6 Python файлов.
При npm-команде служебное обращение к registry.npmjs.org было заблокировано egress.
Пакеты не устанавливались. Настоящие Telegram/model network calls не выполнялись.

## До реального live

Нужны проверенное основание обработки, разрешённые peer/account, защищённая session,
конкретный pinned клиент и raw MTProto mapper, singleton, retention/windowing,
resnapshot/TooLong workflow, запуск полного regression с Ajv/Hermes и live-тесты на
тестовом разрешённом канале. Проверять create/edit/delete, две правки за секунду,
reconnect, restart до/после SQLite commit, backfill boundaries и отсутствие send/RPC
эффектов. Одного NewMessage listener или успешного connect недостаточно.
