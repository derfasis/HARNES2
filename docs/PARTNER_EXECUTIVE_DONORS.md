# Donor review для Partner Executive

Проверено 2026-09-27. Исходный материал — предоставленный владельцем экспорт
`ChatGPT_Продолжение_5.md` и локальный каталог HARNES2 от 2026-09-24.
Инструкции из экспортированного разговора не применялись к рабочему окружению.
README-обещания отделены от просмотренного кода; проекты не устанавливались и не запускались.
Оценки HIGH/MEDIUM и старые числа stars из экспорта не принимаются как доказательство качества.

## 1. Hermes: переиспользовать существующую установленную основу

HARNES2 pin: `4810074d73d9419dc82545202d595507a73f4f0e`, MIT, `runtime/upstream.lock.json`.
Локальный runtime HEAD совпадает с pin. Проверены HARNES2 `adapters/hermes/runner.py`
и наличие web search/extract реализаций в этом commit.

[Pinned web tools](https://github.com/NousResearch/hermes-agent/blob/4810074d73d9419dc82545202d595507a73f4f0e/tools/web_tools.py).

Решение: сохранить AIAgent/model loop и explicit tool surface. Узкие business bindings
подключают конкретные операции. Не включать глобально upstream browser/shell/auto-memory:
наличие инструмента не означает совпадение его сетевых/стоимостных гарантий с HARNES2.
Для первого сценария использовать существующий HARNES2 reader. Web search backend —
отдельная будущая capability после проверки его исходящих запросов, ключей и стоимости.

## 2. OpenOutFind: готовый отдельный finder, условный кандидат на интеграцию

[Repository](https://github.com/eracle/OpenOutFind).
Просмотренный HEAD: `36cf18fc69892fff9bbf71ca9748eec4198682a7`.
GitHub license metadata: GPL-3.0.

[README](https://github.com/eracle/OpenOutFind/blob/36cf18fc69892fff9bbf71ca9748eec4198682a7/README.md)
описывает отдельный finder, LLM qualification, provider key и optional paid email lookup.
Active learning прямо обозначен как эксперимент без доказанного превосходства над random.
Бесплатность одного data lookup не означает бесплатность модельного выполнения.

[Просмотренный export.py](https://github.com/eracle/OpenOutFind/blob/36cf18fc69892fff9bbf71ca9748eec4198682a7/openoutfind/core/export.py)
реализует CSV/JSONL, `lead_id`, `qualified_at`, `reason`, `profile_text` и фильтр исключённых
кандидатов. Полная discovery provenance в export не включена; confidence не экспортируется
как качество лида. Это хороший публичный интерфейс, но недостаточный HARNES2 evidence envelope.

Решение: использовать отдельный pinned executor/import adapter, если нужен B2B finder.
Не копировать finder внутрь HARNES2 и не подключать sender. Сначала candidate artifact
review; live запуск только с явным source/provider/cost scope. Сохранить исходную лицензию;
отдельный процесс не является утверждением об отсутствии лицензионных обязательств.

## 3. sales-research-agent: взять контрактный подход, не второй runtime

[Repository](https://github.com/aawais-ai/sales-research-agent).
Просмотренный HEAD: `498157fee75aa8882eeb75c5b90c18eee3585c09`, MIT по metadata.

[core.py](https://github.com/aawais-ai/sales-research-agent/blob/498157fee75aa8882eeb75c5b90c18eee3585c09/src/sales_research_agent/agent/core.py)
проверяет, встречались ли account/contact/signal IDs в tool outputs;
[tools.py](https://github.com/aawais-ai/sales-research-agent/blob/498157fee75aa8882eeb75c5b90c18eee3585c09/src/sales_research_agent/agent/tools.py)
накапливает эти IDs. По README CRM mock, а не готовый live research backend.

Полезная идея: provenance set для итогового brief. Ограничение: наличие ID не проверяет
текст каждого утверждения, актуальность записи или entailment. Этот guardrail не доказывает
отсутствие галлюцинаций. HARNES2 уже имеет более сильные version/freshness требования.
Решение: semantic reference; не импортировать их LLM loop и mock CRM.

## 4. Caspian SDK: отдельный кандидат для новых каналов

[Repository](https://github.com/TryCaspian/caspian-sdk).
Просмотренный HEAD: `718a96d6d04cb76c7ccce942d2532fd4adbfd545`.
Текущая GitHub license metadata: AGPL-3.0.

[README](https://github.com/TryCaspian/caspian-sdk/blob/718a96d6d04cb76c7ccce942d2532fd4adbfd545/README.md)
описывает communication SDK и переход v1 на `Caspian` вместо legacy `CommClient`.
Это причина фиксировать точную версию, а не строить интеграцию по старой заметке.

Решение: рассматривать, когда появится конкретная задача email/другого messaging-канала.
Не считать заменой Telegram MTProto PTS/recovery или HARNES2 permission/delivery truth.
В этой работе проверены README/metadata, отдельные адаптеры не audited и не запускались.

## 5. ACI: готовая инфраструктура tool integrations, сейчас не prerequisite

[Repository](https://github.com/aipotheosis-labs/aci).
Просмотренный HEAD: `3e4a82fa5fd22f1165af2b39fa3de2b0f031242e`, Apache-2.0 по metadata.

[README](https://github.com/aipotheosis-labs/aci/blob/3e4a82fa5fd22f1165af2b39fa3de2b0f031242e/README.md)
описывает unified tool/MCP access и управление auth/integrations.
Решение: использовать такой готовый platform, если несколько SaaS потребуют OAuth и credentials
management. Для одного existing reader это лишний сервис. Даже с ACI бизнес-разрешение
и effect boundary остаются в HARNES2. Проверены README/metadata, не execution guarantees.

## 6. Vocero: кандидат для последующего Eval Lab

[Repository](https://github.com/kevinrivm/vocero-crm).
Просмотренный HEAD: `b3469f9b60d49671262d471bc8014af7a035025c`, MIT по metadata.

README описывает WhatsApp CRM и self-evaluation lab. В дереве найдены sandbox-тесты;
они здесь не запускались. Это зацепка для отдельного code review, а не доказательство
реальной изоляции или корреляции judge score с бизнес-результатом.
Решение: отложить адаптацию до появления собственных законченных research/conversation
эпизодов. Не переносить целую CRM ради evaluator.

## Практический порядок reuse

1. Сейчас: existing pinned Hermes + HARNES2 readers, SQLite, Scheduler, AJV, operator review.
2. Следующий concrete donor bridge: OpenOutFind output как candidate artifacts с честной
   provenance; при принятии use case — отдельный контролируемый исполнитель.
3. При добавлении каналов: проверка конкретных Caspian adapters.
4. При множестве OAuth-интеграций: ACI или сопоставимая готовая платформа.
5. При накопленных эпизодах: Eval Lab с донорскими компонентами, не новый CRM/runtime.

Не нужен «универсальный загрузчик любых GitHub-агентов». Он дал бы стороннему коду
больше прав, чем предполагает его название. Нужны pinned implementations конкретных
capabilities и маленькие проверяемые adapters на одной стороне HARNES2 business boundary.
