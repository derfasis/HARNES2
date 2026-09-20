# Передача coding-agent: Persistent Engagement v1

## Спочатку прочитайте

Це виконані зміни коду на основі `376ffc3f31e4ed1d94821129b1d33fed5ba25a43`,
не лише проєкт архітектури. GitHub/main не змінювався. Архітектура описана в
`docs/PERSISTENT_ENGAGEMENT.md`, обмеження перевірок у
`docs/PERSISTENT_ENGAGEMENT_VALIDATION.md`.

Повний regression suite у середовищі розробки не зелений через відсутні залежності.
Перед merge потрібен штатний запуск без test mocks. Не видавайте isolated suite
за перевірку Hermes, Ajv, GramJS, HTTP API або реального browser workflow.

## Вміст переносимого комплекту

`implementation.patch` є головним способом інтеграції. `changed/` містить той самий
набір нових і змінених файлів. `full-source/` містить повний вихідний snapshot із
цими змінами, але без .git історії, node_modules, .venv, встановленого upstream
Hermes, секретів і робочої БД. `BASE_BLOBS.json` містить оригінальне дерево GitHub;
усі 124 вихідні blobs були перевірені за Git SHA-1. `MANIFEST.json` містить SHA-256
і базові blob-хеші змінених файлів. `validation/` містить журнали, включно з невдалими
штатними запусками, а не тільки успішні тести.

## Безпечне застосування

У власному checkout створіть окрему гілку саме від зазначеної бази. Якщо main уже
пішов уперед, не накладайте changed/ поверх нього без аналізу конфліктів.

````sh
git switch -c persistent-engagement-v1 376ffc3f31e4ed1d94821129b1d33fed5ba25a43
git apply --check /path/to/package/implementation.patch
git apply /path/to/package/implementation.patch
git diff --check
````

Зупиніть застосунок перед роботою з production DB. Зробіть окрему перевірену резервну
копію SQLite узгодженим способом, враховуючи WAL; не копіюйте лише .sqlite файл під
час активного запису. Перевіряйте міграцію спочатку на копії. Store автоматично
виконає додаткову `003-persistent-engagement.sql`. Міграції 001 і 002 не змінені;
старі рядки не переписуються. Нові таблиці починають порожніми, grants не виводяться
зі старих permission strings. Down migration немає: rollback даних означає
відновлення pre-migration backup, не запуск старого коду на новій схемі.

Імпорт підтримує точний legacy bundle з двома початковими міграціями та новий bundle
з трьома. Невідомі набори таблиць/колонок/міграцій відхиляються. Restore лише в нову
staging-директорію, як раніше; активна БД не замінюється.

## Перевірка в нормальному середовищі

Використайте штатний setup репозиторію для його вже pinned dependencies і upstream
runtime. Нових бібліотек цей increment не вимагає. Тести використовують node:sqlite;
у локальній перевірці використано Node 24.16.0. Experimental module mocks потрібні
лише для окремого isolated runner, не для production запуску.

````sh
npm run build
npm run test:regression
npm run test:engagement
````

Також виконайте штатні Python regression tests із встановленим Hermes. Для
фокусованого вертикального сценарію після встановлення dependencies:

````sh
node --test --test-name-pattern="one complete persistent-partner episode" tests/engagement.test.mjs
````

Якщо середовище так само не має dependencies, можна відтворити лише ізольований
зріз, чітко зберігаючи його обмеження:

````sh
node scripts/test-engagement-isolated.mjs
````

## Увімкнення й smoke scenario

Найбезпечніший rollout: залишити `engagement.enabled=false`, відкрити одну синтетичну
розмову в локальній панелі та натиснути «Відкрити справу». Це явний opt-in незалежно
від глобального прапора. Можна ввімкнути auto-open для нових inbound через local.json:

````json
{"engagement":{"enabled":true}}
````

Це не вмикає модель, Telegram або liveSending. Для enrolled розмов AUTOPILOT не може
відправляти, навіть якщо старий conversation.mode мав таке значення.

Відтворіть на тестовій БД:

1. Запишіть inbound, відкрийте справу, зафіксуйте reply grant із реальним джерелом
   згоди, межами й строком. Не вигадуйте згоду для реальних контактів.
2. Запишіть CLAIM із точної цитати та, за потреби, HYPOTHESIS. Оберіть ACT.
3. Перевірте, що pending draft нічого не відправив і commitments лише proposed.
4. Схваліть текст. Підтверджуйте manual delivery тільки якщо реально надіслали його,
   або використайте контрольований transport smoke на окремому дозволеному чаті.
5. Зафіксуйте WAIT(operator_response), перезапустіть застосунок, перевірте відсутність
   нового model run без відповідної події.
6. Додайте operator_response. Перевірте HANDOFF, HUMAN_OWNED і requested/accepted.
7. Під час HUMAN_OWNED нове inbound не повинно запускати AI. Повернення лише явне.
8. Запишіть справжній outcome із decision_id. call_accepted не є call_attended.
9. Створіть candidate lesson, оцініть evidence/контрприклади/обмеження, активуйте
   локальну version. Перевірте незмінність permission і suppression.
10. Окремо повторіть STOP, permission revoke, редагування approved draft та
    delivery_unknown. Не дозволяйте автоматичний resend unknown.

## Command/API карта

Усі зміни проходять через існуючий authenticated `POST /api/commands` з envelope
`{request_id, action, payload}`. При повторі тієї самої операції використовуйте той
самий request_id; інший payload із тим самим ID відхиляється. Деталь справ і grants
повертається в `GET /api/conversations/:id`, episode у `GET /api/decisions/:id`.

| Команди | Ключові payload поля |
| --- | --- |
| engagement.open | conversation_id, topic, current_need, close_condition, optional unknowns[] |
| engagement.update | engagement_id, expected_revision, current_need/topic/unknowns/close_condition |
| engagement.wake | engagement_id, event, evidence |
| engagement.close | engagement_id, evidence |
| belief.record | engagement_id, expected_revision, kind, text, evidence[{type,id}], optional counterevidence/supersedes_id/expires_at; VERIFIED_FACT вимагає verification й оператора |
| belief.reject | engagement_id, belief_id |
| decision.commit | engagement_id, expected_revision, kind, reason, expected_next, evidence; ACT: action{purpose,text,explained?,commitments?}; WAIT: wait_for[] та/або wake_at; optional state{current_need,unknowns} |
| permission.grant | conversation_id, purpose reply/follow_up, granted_by, evidence, valid_from, expires_at |
| permission.revoke | conversation_id, permission_id, evidence |
| handoff.accept | engagement_id, handoff_id |
| handoff.resolve | engagement_id, handoff_id, resolution return/close, evidence |
| commitment.record | engagement_id, text (точна outbound-цитата), owner AI/HUMAN, source_message_id, optional due_at |
| commitment.resolve | engagement_id, commitment_id, status fulfilled/cancelled, evidence |
| explanation.record | engagement_id, text (точна outbound-цитата), source_message_id |
| outcome.record | існуючий payload плюс optional decision_id; draft_id автоматично встановлює відповідне рішення, конфлікт відхиляється |
| learning.propose | engagement_id, title, text, applicability, outcome_ids[]; для agent ще expected_revision |
| learning.review | lesson_id, decision activate/reject/retire, evaluation, limitations, optional counterexample_ids[] |

Модель бачить три додаткові tools: partner_record_belief, partner_commit_decision,
partner_propose_episode_lesson. Вони доступні лише у conversation run із engagement
snapshot. Legacy draft/fact/task/lesson tools у цьому scope приховані; business
layer додатково перевіряє повноваження. Typed permission, approvals, outcomes і
strategy activation не є інструментами моделі.

## Що особливо перевірити reviewer-у

Перевірте межу validApproved у двох adapters, точність tool discovery з реальним
Ajv, мінливість конверсій conversation.revision / engagement.revision, manual
operator attribution, а також відсутність leakage стратегій між розмовами.

Зміна frozen-хешів у opportunity-consumer-ui.test.mjs навмисна лише для трьох файлів:
store.mjs (нові export tables), runtime.mjs (engagement scope), runner.py (системна
engagement-інструкція). Решта frozen source/router/transport/identity/old migration
pins не змінені. Число міграцій в існуючому regression test оновлено з 2 до 3.
Це не заміна перевірки поведінки простим переписуванням тестів: нові guard-тести
присутні окремо.

Перед merge потрібні зелений повний suite, реальний browser smoke і контрольований
Hermes run із liveSending=false. Зовнішню автономність цим increment не розширювати.
