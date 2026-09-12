# Audit report: HARNES2 read-only source intake v0

## Independent acceptance in the restored HARNES2 environment

**READY WITH CONDITIONS for the bounded offline intake prerequisite, NOT live
Telegram monitoring or multi-process deployment.** The Astra environment report
below is historical; its blocked suites were independently executed here, without
substitute validators, live Telegram or model/API calls.

### Provenance and environment

- Exact base / unchanged main: `1809a2ca646a5b70969c37f37077fa38deb29d1b`.
- Imported Astra HEAD: `ca0bd0ae025cbf5f5e81258feb642b662411b3c2`.
- Imported tree: `5a1e7582a51b0e5e238235c4607fcac49f4789b9`.
- Bundle verified and imported once; patch was NOT applied. All artifact sizes
  and hashes in the manifest, and all seven SHA256SUMS entries, matched.
- All six Astra commits preserved; no rebase, squash or merge into main.
- Node 24.18.1, Ajv 8.17.1, telegram 2.26.22, project Python 3.11.15.
- Hermes pinned checkout: `4810074d73d9419dc82545202d595507a73f4f0e`.
  The project `.venv` loads the actual Hermes credential pool; `uv pip check`
  confirms all 98 installed packages are compatible. Standard `uv sync --frozen
  --offline --no-dev --extra mcp --extra messaging --python 3.11` removed four
  non-lock S3 extras; no locked version upgrades or reinstalls. A second dry-run
  reports "Would make no changes"; upstream lock and package lock unchanged.

### Independently reproduced bug and fix

**Generic `source.ingest` bypassed transactional Telegram intake.** An operator
or source-scoped channel actor could write an arbitrary message/version under a
configured Telegram source while its checkpoint was current. That write had no
native update receipt and did not advance pts, yet `sourceContextState` would
accept it using the existing transport-health gate.

Fix commit: `b3ba4bc43b7e71190c0d2e66412fb8c1bf1f9eaa`.
The command boundary now rejects generic ingestion when a reader binding OR a
durable source checkpoint exists, including after binding revocation. The reader
still calls `ingestSource` inside the same transaction as receipts and checkpoint.
Unmanaged operator/fixture sources retain their previous behavior. This is a
command-boundary guard, not a sandbox against arbitrary trusted in-process code.

Three regression checks cover operator/channel attempts, revocation and unchanged
pts/receipt counts; unchanged generic fixture flow; and attempts before bootstrap.
The rejection regression first failed on Astra production code with "Missing
expected rejection", then passed with the fix. No cosmetic refactor or new layer.

### Verification results

| Command / scope | Result |
|---|---|
| `npm test` on imported Astra HEAD, before fixes | 198/198 PASS |
| `npm test` after fix | 201/201 PASS |
| `node --test tests/telegram-source.test.mjs` | 51/51 PASS |
| `node --test tests/telegram-source-integration.test.mjs` | 11/11 PASS: all 8 original real-stack scenarios + 3 regressions |
| `node --test tests/harnes2-regression.test.mjs` | 27/27 PASS: Router fixtures, Conversation Brain, approvals, disabled Telegram/runtime |
| `node --test tests/opportunity-projection.test.mjs` | 17/17 PASS |
| Consumer + consumer UI test files | 34/34 PASS |
| `node --test tests/opportunity-pipeline.test.mjs` | 30/30 PASS |
| Source-ingestion + opportunity-runtime test files | 31/31 PASS |
| `npm run test:credentials` | 5/5 PASS, actual Hermes pool and in-memory failover |
| `npm run build` | PASS: 47 JavaScript/JSON + 6 Python files |

All final suites: zero failures, cancelled tests, skips and todos. Focused counts
are subsets of the full Node total, not additional independent product scenarios.
The real-stack tests use production BusinessService/SQLite/Router validators/
Projection/Consumer/Scheduler with deterministic model-shaped outputs and synthetic
reader envelopes. They do NOT test semantic model accuracy or raw MTProto mapping.

### Boundary audit

The entire 14-file Astra diff was reviewed, plus the minimal command-boundary fix.
Account/channel scope binds even empty responses; typed decimal author IDs prevent
user/channel collisions; unknown/broadcast authors are not inferred humans.
Reply/thread IDs are peer-scoped, missing/cross-peer ancestry stays unresolved.
Native pts sequences, fingerprints, overlap/replay checks, edits, known/unknown
deletes and tombstones are transactional with the cursor. Rollback fault tests
cover invalid later updates, receipt insertion and checkpoint persistence.
Integrity collisions/TooLong remain latched across poll/restart. Health gates block
disconnected, partial, expired and revoked sources; edited/deleted evidence stales
old captures/cards. This is trusted-reader consistency, NOT live Telegram proof.

Prompt-injection text remains source data; existing exact-span/author/version and
authority validators remain unchanged. Review tasks have constant non-executable
instructions and cannot be approved/retried, listed as agent work, or used as agent
context. `contact_permission=false`, `allowed_effects=[]`; no approvals or sends
are created. New reader imports no Telegram client/session/network/send/model API;
the server still injects no source readers. Both default and effective local config:
`automatic=false`, `runtime.enabled=false`, `telegram.enabled=false`,
`telegram.liveSending=false`, `telegramSources=[]`.

Diff is zero for frozen Router module/schema/fixtures, Projection/schema, Consumer,
Conversation Brain/context/assets, Hermes runtime/worker/credential adapter,
legacy Telegram channels, contracts, dependencies and migrations. Only the existing
Store recovery, scheduler/source gates and the scoped ingest guard are extended.

### Conditions before actual live Telegram

**Exactly one HARNES2 process per DB/session is required. NOT multi-process safe.**
Independently verified using a temporary DB: while process A retained an open Store
and a running inference claim, process B called existing `recover()` and changed
A's claim to interrupted. This is a demonstrated production blocker, not an HA
success test. No model or Telegram was involved; no lease/singleton layer added.

Remaining live gates: a verified pinned raw MTProto mapper with complete ordered
delta/unsupported-content handling; consistent bounded bootstrap watermark;
TooLong/resnapshot reconciliation; peer permissions and processing authorization;
session protection; singleton deployment; disconnect/FloodWait/backoff handling;
retention/windowing/privacy erasure; authorized live failure tests. Existing
1000-message/70000-byte limits and non-exactly-once billing remain. The shipped
client research was not adopted as a dependency migration or legal clearance.

Branch publication is allowed only after green final verification. Main remains
unchanged; merging requires a separate owner command.

## Astra Environment Report (Historical)

Дата: 2026-09-12. Base SHA: `1809a2ca646a5b70969c37f37077fa38deb29d1b`.
Final HEAD, полный список новых commits, SHA-256 файлов и verification logs выдаются
в release manifest рядом с bundle/patch/source zip. Этот документ не содержит
самоссылочного final SHA коммита, в котором он хранится.

## Вердикт

**Offline source-intake слой реализован и проверен. Не production-ready live Telegram
monitoring. Не полный green всего проекта.**

Честно проверенный путь: синтетический narrowed reader → реальный SQLite → native
receipts/cursor/source.message → freshness gate. Реальный Scheduler получил точку
подключения reader в существующем automatic tick. Восьмь end-to-end тестов с настоящими
BusinessService/Router/Projection/Consumer написаны, но в этой среде заблокированы на
импорте Ajv. Поэтому фактическое создание review-card именно через новый reader здесь
НЕ подтверждено. Старые результаты чужих live/model smoke не выдаются за наши тесты.

## Исследование базы и provenance

Получены все 99 tracked файлов актуального main на указанном SHA; каждый Git blob,
root tree `81a31959e67676134dfba22f486b38a0c1f041bb` и исходный commit проверены по SHA.
Архив GitHub не удалось импортировать инструментом файлов; вместо него исходники
получены web-инструментом. Исходный commit восстановлен точно, без подмены hash.

Локальная база shallow на этом commit. Parent objects не скачаны; incremental bundle
требует существующий base в принимающем репозитории. Это не полный clone истории.
Получены метаданные всех 37 исходных commits и изучены decision docs по переходам
Router → Projection → Consumer → Auto Pipeline. Подробный кодовый аудит сосредоточен
на source/persistence/model/review/send boundaries, а не является line-by-line
сертификацией каждого из 99 файлов или всех исторических diffs.

## Реально запущенные проверки

| Проверка | Итог |
|---|---|
| Новый Telegram intake, настоящая SQLite | **51/51 PASS** |
| Исходные source-ingestion | **28/28 PASS** |
| Исходные no-tool runtime | **3/3 PASS** |
| UI/security/frozen safeguards | **10/10 PASS** |
| Совместный dependency-free прогон | **92/92 PASS**, zero skips |
| Весь Node suite | **FAIL**, 92 passing checks и 5 ошибок импорта test files |
| Новый real-stack integration test file | **BLOCKED**, Ajv отсутствует; 8 сценариев не исполнены |
| Python credentials | **FAIL**, 5 import errors: отсутствует Hermes `agent` |
| Штатный build | **FAIL**, нет project `.venv` Python |
| Ручная syntax validation | **PASS**, 35 JS + 11 JSON + 6 Python |

Четыре из пяти Node import errors уже существовали на нетронутой базе в этой среде;
пятый является новым интеграционным test file. На базе до изменений: 41 passing checks
и 4 ошибки импорта. Это средовое ограничение, не доказательство отсутствия регрессий.
Проверки не skip-нуты и валидатор не заменён суррогатом ради зелёного отчёта.

Среди реально выполненных сценариев: same-second edits, out-of-order updates, stable
identity, unknown author, broadcast identity, reply/thread/cross-peer links,
known/unknown deletes, tombstone resurrection guard, duplicate pages, pts collisions,
gaps, oversized pages, conflicting baseline, callback/cursor mismatch, partial catch-up,
checkpoint TTL, revocation, crash/reopen, отдельный последовательный Node процесс,
rollback после source insert/native receipt/cursor-write fault, injection as data.

## Независимый аудит и исправления

Было проведено два независимых review исходников. После них и self-audit исправлено:

| Finding | Результат |
|---|---|
| Empty page не была привязана к account/channel | Добавлены обязательные account_id/channel_id и проверки |
| Broadcast post мог объявлять личного/чужого автора | Неподдержанные combinations отклоняются |
| Anonymous author мог стать известным через edit | Telegram identity фиксируется, null→known тоже запрещён |
| Integrity error переименовывался в READ_FAILED | Read и intake ошибки разделены |
| Недостаточная валидация checkpoint | Строгие поля, source/account/channel/pts/phase/reason проверяются |
| Collision/TooLong мог сниматься empty poll | Latched INTEGRITY_RECONCILIATION_REQUIRED, переживает restart |
| Cursor mismatch не оставлял durable diagnosis | Проверка перенесена внутрь failure transaction и latch |
| Channel author мог связаться с personal CRM/context | Запрет CRM binding и агрегации несвязанных channel posts |
| Состояние current могло содержать integrity reason | Добавлена phase/reason consistency validation |
| Изменение Store нарушило frozen test | Обновлён только reviewed Store hash, остальные pins сохранены |

Независимый follow-up не нашёл пути обхода contiguous pts/receipt/overlap проверок
или stale-review acceptance в изученном code path. Это ограниченное code review,
не независимое исполнение полного integration/live suite.

## Открытые production blockers

**Один процесс на DB/session обязателен.** Существующий Store.recover прерывает все
running runs. Concurrent HARNES2 startup небезопасен: другой процесс может инвалидировать
живую inference и вызвать повторное billing. Singleton/lease не реализован этим slice,
не объявлен исправленным и должен быть обеспечен/проверен до live. Транзакционность
intake не означает multi-process безопасность всего HARNES2.

Реальный raw MTProto mapper ещё нужен. Сам метод readDifference не подтверждает
Telegram catch-up. Нельзя выкидывать unsupported update kinds/forward/media/TTL признаки,
выдумывать per-message pts для new_messages или выдавать DifferenceTooLong за empty.
Честный mapper должен либо выразить полный ordered delta, либо остановить источник.
Freshness сейчас означает непротиворечивость durable данных и актуальную аттестацию
доверенного reader, а не доказательство, что Telegram с той секунды не изменился.

Автоматический bounded backfill/resnapshot после TooLong, bootstrap consistency с
серверным watermark, live channel permissions, peer hydration, FloodWait/network
backoff, disconnect notifications, singleton deployment, retention/privacy erasure,
rolling source windows и повторный анализ terminal событий остаются отдельными gates.
Текущие лимиты источника (1000 сообщений, 70000 bytes контекста) сохраняются. Это
ограниченный pilot intake, не обещание бесконечного stream monitoring.

## Внешние эффекты и среда

Telegram send/DM/email/browser posting/approval/AUTOPILOT не включались. Новый module
не импортирует Telegram SDK, не читает session и не имеет RPC-send API. Старые private
Telegram adapters не менялись. Реальных Telegram или model запросов не делалось.

В среде нет настроенных secrets, Telegram SDK/Ajv/project Hermes Python и разрешённых
Computer egress domains. Устанавливать пакеты здесь запрещено. Команда `npm run build`
попыталась выполнить служебное обращение к `registry.npmjs.org:443`, оно было заблокировано
allowlist. Повторного npm network запроса не было: дополнительный build вызван через
`node scripts/build.mjs` и тоже остановился на отсутствии project Python. Для package
network доступа нужен workspace admin; это не разрешает автоматически Telegram transport.

## Приватность и условия Telegram

Публичный канал не равен разрешению на AI-анализ. До live нужна проверка Telegram API
Terms/Content Licensing, применимости согласий и retention. `processingBasis` в config
лишь ссылка/запись утверждённого основания, не проверка прав и не разрешение обращаться
к человеку. Ни одна source identity не создаёт permission или executable task.

## Приёмка после переноса

В подготовленной локальной среде: установить штатные lockfile зависимости средствами
своего проекта, поднять закреплённый Hermes environment, прогнать весь Node/Python/build
на нетронутой базе и этой ветке. Затем отдельно создать и проверить read-only mapper,
авторизацию/доступы и полный live failure matrix на разрешённом тестовом канале.
До этого корректная формулировка результата: «durable intake и безопасная точка
подключения готовы для продолжения интеграции», а не «HARNES2 уже читает живой Telegram».
