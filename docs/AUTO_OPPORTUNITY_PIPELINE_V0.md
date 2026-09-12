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
