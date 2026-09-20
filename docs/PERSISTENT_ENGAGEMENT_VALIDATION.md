# Перевірки Persistent Engagement v1

## Незалежна інтеграційна перевірка HARNES2

20 вересня 2026 increment застосовано до чистого worktree від точного
`376ffc3f31e4ed1d94821129b1d33fed5ba25a43`. Зовнішній ZIP і всі внутрішні файли
звірено з SHA-256 manifest; patch пройшов `git apply --check`. Використано штатні
pinned залежності: Node 24.18.1, Python 3.11.15, Ajv 8.17.1, telegram 2.26.22 та
Hermes `4810074d73d9419dc82545202d595507a73f4f0e`.

| Запуск інтегратора | Фактичний результат |
| --- | --- |
| Focused engagement suite | 48 passed, 0 failed, 0 skipped. |
| Повний Node regression | 436 passed, 0 failed, 0 skipped. |
| Python credential/failover | 8 passed, 0 failed. |
| Build | 61 JavaScript/JSON і 9 Python файлів скомпільовано. |
| Browser smoke | Реальний Edge headless на desktop і mobile; ACT, typed permission, pending draft та restart persistence пройшли; horizontal overflow відсутній. |
| Controlled Hermes smoke | `claude-sonnet-4-6`, fresh disposable DB: completed ACT, durable decision і один pending draft; `failure_cause=null`, approvals/delivery/outbound/Telegram effects = 0. |

Під час незалежної перевірки виправлено три integration defects: історична
CLOSED/STOPPED справа більше не падає назад у legacy reply flow; UI вимагає явного
відкриття нової справи; Hermes отримує санітизовану schema-помилку з path/keyword,
щоб виправити невалідний tool call без послаблення validator. Також decision contract
тепер відхиляє несумісні поля замість мовчазного ігнорування. Усі виправлення мають
окремі regression tests.

Telegram live calls і зовнішні write effects у цій інтеграційній перевірці не
виконувалися. Default `runtime.enabled`, `telegram.enabled`, `telegram.liveSending`
та `opportunity.automatic` залишаються false.

## Первинна перевірка переносимого пакета

Середовище: Комп’ютер, Linux, Node 24.16.0. Перевірено точну базу
`376ffc3f31e4ed1d94821129b1d33fed5ba25a43`: 124/124 Git blobs збігаються.
GitHub write/push, реальні контакти, model/provider requests і живі доставки не виконувалися.

## Результати

| Запуск | Фактичний результат |
| --- | --- |
| Новий фокусований isolated suite | 44 passed, 0 failed: 40 бізнес/SQLite/scheduler/transport/migration тестів і 4 VM UI тести. |
| Штатний Node suite на незміненій базі | 109 passed, 8 failed через відсутній ajv. Це контроль середовища, не зелена база. |
| Штатний Node suite після змін | 113 passed, 9 failed через відсутній ajv. Додатковий blocked test file: engagement.test.mjs без isolation. |
| Порівняння успішних штатних тестів | Усі 109 успішних на базі тестів успішні й після змін; додалися 4 UI тести. |
| Python unittest discover | 3 passed, 5 errors: credential tests не можуть імпортувати невстановлений upstream agent.credential_pool. |
| Статична перевірка | 49 JS/MJS файлів: node --check; 9 Python файлів: AST parse; 24 JSON файли: parse. Усі успішні. |
| Старі міграції | 001/002 незмінні, live database upgrade 2→3 перевірено на синтетичних історичних рядках. |
| Export/restore | Новий bundle та точний legacy bundle відновлено в окремі staging DB; PRAGMA foreign_key_check порожній. |

`npm run build` як повна команда тут не завершився: очікує `.venv/bin/python` із
установленого середовища. Окремо перевірено синтаксис усіх JS/Python/JSON без
встановлення пакетів. Це не виконання runtime dependency imports.

Повний suite НЕ оголошується успішним. Відсутність ajv також означає, що фактична
компіляція нових tool schemas, server startup/API smoke і нормальний Hermes tool
path мають бути повторені у штатному середовищі. telegram/GramJS і upstream Hermes
тут не встановлені; їхніх живих integration guarantees немає.

## Що підмінено в isolated suite

Використовується Node test module mocking лише для двох не задіяних у цьому зрізі
optional модулів: opportunity-consumer і opportunity-pipeline. Їхні заглушки
кидають помилку при виклику. Немає заміни Ajv підробленим валідатором.

Справжні Store, SQL migrations, BusinessService, EngagementLoop, context builder,
Scheduler і TelegramChannel виконуються як production code. Зовнішній model runtime
і мережевий метод TelegramChannel синтетичні. Для scheduler readiness тест локально
імітує наявність Python executable і synthetic configuration. Існуюча SQLite-БД,
command transactions, constraints, revisions, receipts і delivery transitions
не підмінені.

UI tests виконують справжні rendering/handler функції у Node VM із DOM/network
межами-заглушками. Вони перевіряють escaping і payload, не пікселі чи повний браузер.

## Властивості, які покрито

- CLAIM як точна inbound-цитата, відокремлення hypotheses, заборона model verification.
- Scope evidence, run та permissions; заборона cross-person evidence.
- Явні ACT/WAIT/IGNORE/HANDOFF/STOP, одна current decision на вхідну версію стану.
- Транзакційний rollback, duplicate events, duplicate commands, receipt після restart.
- Coalescing consecutive inbound, скасування старого run, combined context наступного.
- WAIT після restart, matching/nonmatching wake, одноразовий deadline і 100 idle ticks
  без нового runtime call. Це перевірка поведінки, не оцінка production throughput.
- Interrupted-run recovery без тихого replay; committed WAIT не виконується вдруге.
- Grant scope, follow_up окремо від reply, revoke, expiry, human approval і AUTOPILOT deny.
- Proposed commitment не дорівнює даній обіцянці; delivered exact quotes; human edits
  не підтверджують автоматично обіцянки моделі.
- Передача ownership до acceptance, operator return, STOP понад попередні наміри.
- Unknown delivery зберігається після restart, блокує новий ACT до reconciliation,
  production Bot API adapter із synthetic I/O не робить blind resend.
- Decision→draft versions→approval→attempts→actual messages→outcome projection;
  accepted call не стає attended, human-assisted association не стає causal credit.
- Candidate lesson із observed outcome, counterexamples, review history, local versions,
  retirement і незмінність permissions.
- Історична закрита справа не може змінити нову; STOP відкликає навіть старі grants.
- Наскрізний синтетичний сценарій зі збереженням справи через кілька restart.

## Не доведено цими тестами

Не доведені якість рішень живої LLM, доречність MLM-офера, статистична ефективність
стратегії, юридична достатність permission evidence, правильність зовнішньої
операторської атестації, production навантаження, crash consistency файлової системи
при фізичній втраті живлення, multi-process concurrency, мережеві межі реального
провайдера та UI end-to-end. Програмне закриття/відкриття Store і recovery не є
випробуванням вимкнення живлення під час fsync.

Журнали всіх перелічених запусків включено до `validation/` переносимого комплекту.
Штатний regression suite треба повторити без HARNES_ENGAGEMENT_ISOLATED перед merge.
