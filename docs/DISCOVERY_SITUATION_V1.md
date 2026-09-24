# ADR: Durable Discovery Situation v1

- **Статус:** integration gate green; ready for final merge-readiness review; main not merged
- **Worktree:** `D:/HARNES2-worktrees/durable-discovery-v1-local`
- **Базовая линия:** `0cde893` (`fix: retain analyzed opportunities during source catch-up`)
- **Review branch:** `codex/durable-discovery-v1-review-r23`
- **Reviewed HEAD:** `8ebbcd16af8b504bfa2f1abc3e52e209182f5083`
- **Дата проверки:** 2026-09-24
- **Коммиты/push/merge:** review commit pushed; main not merged
- **Режим проверки:** full offline Node regression, Python credential/failover, focused Discovery, build и diff check; model, Hermes runtime, Telegram и live traffic не запускались

## 1. Purpose

Durable Discovery — тонкий pre-interaction слой между уже существующими слоями:

```text
Source truth
  → Discovery Situation
  → operator review
  → existing Persistent Engagement
```

Он нужен для накопления нескольких наблюдений в одну ограниченную ситуацию, не превращая каждое новое сообщение в новый «лид» и не запуская внешнее действие автоматически.

Цель slice — доказать целостность и границы состояния, а не доказать качество поиска возможностей.

## 2. Почему Discovery находится между Source и Engagement

Source ingestion отвечает за то, что произошло на входе: он принимает и нормализует source message, сохраняет его как неизменяемое событие и поддерживает transactional source receipts/checkpoints.

Situation Router/Opportunity Projection отвечает за bounded semantic decision в конкретном source snapshot.

Persistent Engagement уже отвечает за работу с человеком после появления допустимой conversation basis: hypotheses, claims, WAIT, ACT, HANDOFF, STOP, permissions, commitments и outcomes.

Discovery заполняет ограниченную промежуточную границу:

- несколько независимых source observations относятся к одной situation scope;
- situation имеет историю, revision, TTL и freshness;
- evidence ссылается на immutable source events и не дублирует текст;
- ситуация может быть рассмотрена оператором;
- только явно проверенный current candidate может быть передан в существующий Engagement.

Это не третий runtime и не второй CRM.

## 3. Non-goals

Discovery v1 не даёт и не пытается давать:

- permission или typed contact grant;
- draft реального сообщения;
- approval отправки;
- send/delivery;
- person identity из source author;
- cross-channel identity linking;
- lead score или вероятность покупки;
- вечную память человека;
- отдельный LLM planner;
- автоматический контакт с новым человеком;
- вторую систему beliefs/decisions/WAIT/HANDOFF/STOP;
- отдельную очередь jobs;
- доказательство recall, precision или business usefulness.

## 4. Почему только две таблицы

В slice добавлены только:

1. `discovery_situations` — bounded durable scope и lifecycle одной ситуации;
2. `discovery_evidence` — ссылки из ситуации на immutable `source.message` events.

Всё остальное использует существующую инфраструктуру:

- assessments и opening proposals — immutable events;
- recovery markers — events `discovery.observation.pending`, `discovery.observation.applied`, `discovery.observation.failed`;
- operator review — обычная строка `tasks` с kind `discovery_review`, но review не является executable task;
- source/command idempotency — существующий `command_receipts` и source event log;
- operator decisions и transfer — `BusinessService` и существующий EngagementLoop.

Причина — не создавать параллельную CRM, память или agent runtime.

## 5. Situation identity и scope

Situation identity задаётся bounded scope:

```text
partner
source_ref
source_kind
subject_ref
context_key
purpose
offer_fingerprint
```

`subject_ref` — source-scoped author reference, а не `person_id`. Он не продвигает identity и не означает, что источник уже связан с CRM-человеком.

`context_key` нормализует thread/context boundary: отсутствие thread представлено стабильным значением `none:`, а непустой thread — как `thread:<thread_id>`. Старый вход `root` допускается только как совместимый alias для `none:`; реальный thread с ID `root` получает отдельный ключ `thread:root`.

Одна ситуация может накапливать разные message IDs и source event IDs, если они принадлежат тому же scope. Новый message не превращается автоматически в нового человека или новую ситуацию.

Для live situations используется partial unique index, а `expires_at` проверяется при выборе live scope. Это не даёт expired situation навсегда блокировать создание новой.

## 6. State machine

Допустимые состояния:

```text
OBSERVING
  → CANDIDATE       (approve current CANDIDATE review)
  → DISMISSED       (review reject или assessment DISMISS)
  → STALE           (material source supersession/delete/unsupported, SOURCE_REVOKED, EVIDENCE_LIMIT_REACHED, TTL, offer или purpose invalidation)

CANDIDATE
  → OBSERVING       (new evidence или new OBSERVE/CANDIDATE assessment)
  → DISMISSED       (new assessment DISMISS)
  → STALE            (material source supersession/delete/unsupported, SOURCE_REVOKED, EVIDENCE_LIMIT_REACHED, TTL, offer или purpose invalidation)
  → TRANSFERRED      (явный transfer)

DISMISSED, STALE, TRANSFERRED
  → terminal для этой situation generation
```

Временный transport freshness failure (например, ещё не current checkpoint) — это operation fence: `fresh()` возвращает false и approve/transfer блокируются, но situation не переводится в `STALE` и может снова стать current после восстановления source. Постоянный `SOURCE_NOT_ALLOWED` — material policy invalidation (`SOURCE_REVOKED`): situation переходит в `STALE`, review отменяется, quota освобождается. В `STALE` переходят также material source invalidation, `EVIDENCE_LIMIT_REACHED`, TTL, offer/purpose change и terminal source outcomes.

`CANDIDATE` assessment сам по себе оставляет situation в `OBSERVING`; статус `CANDIDATE` появляется только после approve. Review reject относится к proposed task в состоянии `OBSERVING`; у уже утверждённой `CANDIDATE` нет активного reject task. Новое evidence или новая assessment переводят situation обратно в `OBSERVING` и отменяют старый proposed review перед созданием нового. Прямой переход `OBSERVING → TRANSFERRED` невозможен.

`TRANSFERRED` означает только открытие нового Persistent Engagement для переданной situation. Перед transfer проверяется, что у conversation никогда ранее не было Engagement (`engagement.managed()` проверяет всю историю, а не только live). Это **не** означает:

- что сообщение отправлено;
- что человек ответил;
- что permission существует;
- что встреча состоялась.

## 7. Source truth и derived projection

Source и Discovery разделены по failure domain:

```text
TX1:
  source.message
  discovery.observation.pending (только для disposition=registered, если discovery.enabled)
  command_receipts
  COMMIT

Для Telegram transport тот же pending marker создаётся атомарно внутри
`saveMessage`/native delete/snapshot intake, а не позже через generic
`source.ingest`. Перед TX2 transport-owned pending может быть применён только
когда source остаётся в `opportunity.allowedSourceRefs`, source checkpoint
находится в `current` и проходит freshness boundary.

Bootstrap history с disposition `bootstrap_context_only` остаётся только
контекстом Source: для этих historical events Discovery pending не создаётся,
а identical snapshot не может воскресить их как signal. Revoked source ref
одинаково блокирует fresh/review/transfer и pending projection.

TX2:
  проверить applied marker
  применить/инвалидировать situation
  записать mutation
  записать discovery.observation.applied
  COMMIT

TX3 при ошибке TX2:
  записать sanitized discovery.observation.failed
  COMMIT
```

`source.ingest` receipt содержит только source result (`source_event_id`, `duplicate`, `disposition`). Derived state не записывается в source receipt и читается через `discovery.detail`. Replay с тем же request ID и `ignored_out_of_order` не создают retroactive pending: projection запускается только для уже существующего marker. Pending marker хранит intake-time `offer_fingerprint` и `purpose`; при basis mismatch `ensureDiscoveryApplied()` завершает event как `configuration_changed` без situation/evidence. `ensureDiscoveryApplied()` без marker возвращает deferred и не создаёт его. Malformed non-array/non-string `allowedSourceRefs` и malformed `telegramSources` (extra keys, non-object entries, >19-digit IDs) отвергаются shared config helpers на loadConfig/startup до Store; тот же exact policy helper применяется generic Source и Telegram intake.

Если TX2 падает, source truth, pending marker и command receipt уже сохранены. Повтор запроса или bounded reconciliation может догнать projection. Source-transport pending, который ещё не current/fresh, остаётся deferred без `failed`-аудита; terminal domain no-op (`configuration_changed`, `source_revoked`, `source_expired`, `source_obsolete`, `source_superseded`, `subject_unavailable`) завершается applied с безопасным disposition. Pending source event того же source/subject/context и basis немедленно делает текущую situation non-current (`DISCOVERY_PENDING_SOURCE_CHANGE`), поэтому approve/transfer ждут reconciliation; internal `discovery.observe` доступен только system actor.

`pending` и `failed` не означают `applied`. Только `applied` завершает derived application для конкретного `source_event_id`.

## 8. Evidence accumulation и supersession

`discovery_evidence` не копирует source text. Она хранит только:

- situation ID;
- source event ID;
- message ID;
- message version;
- timestamp появления reference.

Несколько независимых observations с одинаковым scope добавляются в одну situation. Evidence fingerprint вычисляется сервером из situation identity и отсортированного canonical evidence reference set. Достижение `maxEvidence` не является retryable failure: заполненная situation переводится в `STALE` с причиной `EVIDENCE_LIMIT_REACHED`, её proposed review отменяется, а следующий source event создаёт новую generation и прикрепляется к ней. Исключение для delayed `DISCOVERY_OPEN_LIMIT`: если event старше newest evidence уже полной live generation, он завершается terminal `source_obsolete` и не откатывает новую generation назад. TTL первой generation считается от `source.message` observation time, а не от момента поздней reconciliation; истёкший delayed event получает terminal `source_expired` без создания situation.

Source supersession semantics:

- `v1 upsert → v2 upsert/edit`: evidence v1 становится stale, situation получает STALE; v2 может быть новой current observation;
- `delete` или `unsupported` revision: dependent situation становится STALE; новое evidence не добавляется как usable content;
- late `v1` после current `v2`: source ingestion возвращает `ignored_out_of_order`, существующий source event ID и discovery state не меняются.

Если Discovery был выключен во время source change, pending marker не создаётся. При следующем включённом observation materially superseded evidence (event ID, version или operation больше не current) сначала переводит affected active situation в `STALE`, отменяет proposed review и освобождает quota до live-scope lookup. Постоянный `SOURCE_NOT_ALLOWED` считается material policy invalidation и также освобождает quota; transient `SOURCE_TRANSPORT_*`/pending fences остаются reversible.

Immutable source events сохраняются. Stale — это статус применимости, а не удаление истории.

## 9. Revision и fingerprint fences

Assessment требует одновременно:

- `expected_revision`;
- `expected_evidence_fingerprint`;
- evidence IDs, принадлежащие текущей situation и текущему evidence set.

Записываются:

- `evidence_fingerprint` — canonical fingerprint текущего evidence set;
- `assessment_fingerprint` — fingerprint situation/revision/evidence/content assessment; includes the canonical sorted selected `evidence_event_ids`, not only the full situation evidence set. Freshness and assessment reuse one batched current-state map per involved source.

При новом evidence старая assessment, opening proposal и review становятся историей и не могут быть current без нового review. Pending source event того же scope также fence-ит situation до применения TX2. Изменение configured `discovery.purpose` делает старую situation не-current с причиной `DISCOVERY_PURPOSE_CHANGED`; ближайшая Discovery-команда или source observation переводит её в `STALE`, отменяет review и освобождает quota.

Operator approve разрешён только для current `CANDIDATE` assessment. `OBSERVE` и `DISMISS` не создают executable discovery review path; при текущем API approve non-candidate не проходит. `discovery.observe` — internal system-only action; operator не может обойти pending/applied lifecycle.

## 10. Recovery: pending/applied/failed

`discovery.observation.pending` создаётся в source TX1 только для нового registered source event и фиксирует intake-time offer fingerprint/purpose. Duplicate и ignored-out-of-order receipts не создают retroactive pending; replay может продолжить только уже существующий marker.

`discovery.observation.applied` пишется в той же TX2, что и situation/evidence mutation.

`discovery.observation.failed` — отдельный sanitized audit event после rollback TX2. В нём нет raw exception stack, raw Telegram message или credentials.

`reconcileDiscoveryPending(limit=50)` — callable bounded reconciliation path, not an unconditional startup guarantee. В automatic branch scheduler сначала выполняет bounded transport poll, затем reconciliation; отдельные entrypoints должны вызвать его явно. Он:

- выбирает pending без applied;
- bounded выбирает source_ref groups с durable rotating cursor в `channel_offsets`, затем загружает pending queues per source; wrap ограничен source_ref <= cursor и deduplicated;
- внутри source queue never-attempted и transient-failed events сохраняют source_event_id ASC; только failed audit с `code='DISCOVERY_OPEN_LIMIT'` откладывается за ними, чтобы quota failure не создавал head-of-line blocking;
- пропускает transient groups, которые сейчас не проходят source-access/current-fresh fence, поэтому deferred transport не monopolizes bounded working batch; permanent `SOURCE_NOT_ALLOWED` groups terminalize their pending rows as `source_revoked`;
- обрабатывает source event IDs по возрастанию внутри каждого source;
- использует отдельную короткую transaction на каждый event;
- продолжает после независимого failure;
- failure audit дедуплицируется по `(source_event_id, code)`;
- terminal domain no-op (`configuration_changed`, `source_revoked`, `source_expired`, `source_obsolete`, `source_superseded`, `subject_unavailable`) записывает applied без evidence;
- material-stale cleanup проходит отдельной committed transaction с absolute cap 1000 active rows, не зависит от текущего maxOpen и не откатывается при quota failure новой observation;
- cleanup перечитывает current source state не более одного раза на каждый involved source, фильтрует только referenced message IDs, освобождает state source-by-source и имеет absolute evidence-row cap 100000, поэтому стоимость bounded O(distinct sources + evidence rows);
- повторный запуск applied marker повторно не применяет.

Ограничение: selection scan остаётся bounded; durable rotating cursor в `channel_offsets` переживает restart и гарантирует eventual consideration конечного числа source refs, но не обещает справедливость для произвольного бесконечного множества refs.

Это bounded reconciliation, а не новая job queue.

## 11. Review и task boundary

`discovery_review` — operator attention card, не executable job. В ordinary work queue он исключён вместе с `opportunity_review`; UI не показывает для него executable approve/retry/cancel controls.

Generic `task.approve`, `task.retry` и `task.cancel` не могут менять такой card. Его lifecycle доступен только через typed discovery review actions. Approve требует fresh situation; reject остаётся разрешённым после transient access/transport fence или expiry, включая уже materialized TTL cleanup, и закрывает card без внешних эффектов.

Review card:

- не попадает в agent context;
- не попадает в `partner_list_work`;
- не выбирается scheduler;
- не может породить draft, permission или send.

## 12. TTL и maxOpen boundedness

Перед live-scope lookup и quota check истёкшие situations переводятся в `STALE`, situations с materially superseded evidence также переводятся в `STALE`, а pending review отменяется. Ситуации со старым `offer_fingerprint` или `purpose` также переводятся в `STALE` и освобождают quota до следующего source observation. `maxEvidence` ограничивает одну generation: переполнение закрывает generation без `failed`-аудита и открывает следующую.

`maxEvidence`, `maxOpenSituations` и `ttlSeconds` ограничены конфигурацией. Expired situations не должны:

- занимать live unique slot;
- считаться в maxOpen;
- оставаться reviewable/transferable.

## 13. Transfer boundary

`discovery.transfer` разрешён только при:

- fresh situation;
- current `CANDIDATE` assessment;
- approved current review;
- existing conversation, указанной оператором;
- exact inbound message из этой conversation;
- explicit operator basis;
- current offer fingerprint;
- отсутствии любого исторического Engagement для этой conversation.

Transfer не создаёт:

- person;
- conversation;
- permission;
- draft;
- approval;
- delivery attempt;
- outbound message.

Он открывает новый Persistent Engagement через существующий `EngagementLoop`, затем отправляет exact inbound как `inbound` signal: это создаёт/coalesces только bounded `engagement_evaluate` attention с тем же `message_id`. Это не permission, draft или send. `TRANSFERRED` не равен contacted/sent.

## 14. Import generations

Importer поддерживает migration prefixes:

```text
v2: core tables
v3: core + engagement tables
v4: core + engagement + discovery tables
```

Старые v2 regression fixtures удаляют также Discovery tables перед построением bundle; migration-count assertions учитывают четыре миграции. Frozen Store pin использует нормализованный LF Git-blob hash, чтобы CRLF checkout не менял проверку.

Focused suite доказал только clean v3→v4 import path. Полная совместимость v2→v4 и v4 round-trip в этом запуске не проверялась.

v3 fixture должен происходить из чистой pre-discovery database. Нельзя вырезать discovery rows из уже загрязнённого v4 export и считать его исторически честным v3 bundle.

Импорт v3 в v4 применяет migration 004 и оставляет discovery tables пустыми, если в v3 bundle их не было. FK integrity проверяется после импорта.

## 15. Proven offline invariants

Focused suite `tests/discovery-integrity.test.mjs` доказала:

- source receipt и derived projection разделены;
- TX2 failure не теряет source truth;
- Store restart/recover и reconciliation восстанавливают pending;
- одинаковый и разный request ID не создают duplicate evidence;
- late out-of-order source version — semantic no-op;
- replay и ignored-out-of-order receipt не создают retroactive pending после disabled intake;
- pending фиксирует intake-time offer/purpose basis и не переинтерпретируется после restart/config drift;
- Telegram transport intake создаёт pending в своей TX1 и не применяет его до current/fresh checkpoint;
- source allowlist revocation блокирует existing review и pending projection;
- delayed pending source observation применяется только до его observation-time TTL; истёкший event закрывается applied с `source_expired` без situation/evidence;
- истёкший delayed event не присоединяется к уже существующей более свежей generation того же scope;
- internal `discovery.observe` отклоняет operator и не обходит pending/applied lifecycle;
- pending same-scope observation fence-ит approve/transfer до reconciliation;
- bootstrap `bootstrap_context_only` history не становится Discovery signal;
- terminal `source_superseded` и `subject_unavailable` pending закрываются applied без retry poisoning;
- deterministic capacity failure audit дедуплицируется по `(source_event_id, code)`;
- deferred source groups не monopolize bounded working batch, когда есть ready source;
- rotating source-group cursor не допускает starvation ready source при конечном числе deferred refs;
- durable cursor в channel_offsets сохраняет rotation across restart;
- revoked pending observation terminalizes как source_revoked и не resurrects после re-allow;
- startup/reconcile invalidates active revoked situations even without pending events;
- startup/reconcile terminalizes revoked pending observations before they can resurrect;
- material-stale cleanup использует absolute bounded cap и не зависит от текущего maxOpen;
- постоянно revoked source освобождает maxOpen, transient transport fence остаётся reversible;
- material-stale cleanup batch-ит current source state по distinct sources, фильтрует referenced IDs и освобождает state source-by-source, а не сканирует sourceRows для каждого evidence row;
- старый OPEN_LIMIT event завершается `source_obsolete` и не откатывает newer full generation;
- never-attempted pending events идут перед retryable quota-failed events, а transient-failed события сохраняют source order;
- source change во время `discovery.enabled=false` не оставляет materially stale generation consuming maxOpen после re-enable;
- transfer создаёт ровно одно engagement attention с exact inbound basis и не создаёт external effects;
- discovery review cards скрыты из ordinary work queue UI;
- upsert edit/delete/unsupported инвалидируют dependent situation;
- cross-context edit инвалидирует старую situation независимо от нового scope;
- `none:` и `thread:root` являются разными canonical context scopes;
- evidence-cap exhaustion закрывает generation без failed audit и открывает следующую;
- purpose change переводит старые active situations в `STALE`, отменяет review и освобождает maxOpen;
- offer change переводит старые active situations в `STALE`, отменяет review и освобождает maxOpen;
- несколько independent observations накапливаются в одной situation через restart;
- evidence fingerprint меняется только при изменении canonical evidence set;
- candidate-only approve работает и сохраняет assessment provenance;
- assessment fingerprint различает canonical sorted selected evidence subsets;
- freshness и assessment используют one batched current-state map на involved source;
- malformed allowlist даёт configuration error и не превращается в source_revoked;
- loadConfig/startup валидирует allowlist до Store/recover mutations;
- durable cursor wrap не дублирует исчезнувший source_ref;
- Telegram transport policy использует тот же strict allowlist helper;
- startup fail-fast проверяет malformed telegramSources до Store/recover;
- exact Telegram policy keys и 19-digit numeric limits совпадают startup/runtime;
- stale/transiently fenced discovery review можно reject без external effects, включая после TTL cleanup;
- новая assessment отменяет старый proposed review и оставляет ровно один current card;
- generic review task boundaries закрыты;
- TTL/maxOpen очищаются, включая доказанный quota gate;
- transfer не создаёт permission/draft/approval/delivery/outbound;
- clean v3 bundle импортируется в v4 с пустым Discovery state;
- pending reconciliation bounded и повторно безопасен;
- `PRAGMA foreign_key_check` остаётся пустым.

Последний зафиксированный результат:

```text
51 tests
51 pass
0 fail
0 cancelled
0 skipped
```

Синтаксическая сборка также прошла:

```text
64 JavaScript/JSON files
9 Python files
```

Integration gate:

```text
full Node regression: 491/491
Python credential/failover: 8/8
Durable Discovery focused: 51/51
git diff --check: clean
```

## 16. Что этот slice намеренно НЕ доказывает

Не проверены:

- реальное поведение модели;
- Hermes runtime;
- Telegram/live traffic;
- multi-process safety;
- Astra/main review;
- production rollout;
- business recall/precision;
- реальная полезность discovery candidates;
- качество opening proposals;
- конверсия или доход;
- cross-channel identity;
- multi-tenant isolation под нагрузкой;
- crash после каждого отдельного commit boundary;
- долговременная эксплуатация и retention.

51/51 focused, 491/491 full Node и 8/8 Python — это доказательство offline integrity, а не доказательство того, что Discovery хорошо находит реальные возможности. В частности, gate не доказывает v2→v4 или v4 round-trip imports, automatic recovery на каждом startup entrypoint, global Router/Engagement regression, multi-process safety, model/runtime/live behavior, Astra/main approval или business usefulness.

## 17. Rollout и текущий статус

Review branch сохранён отдельно:

- `codex/durable-discovery-v1-review-r23`, reviewed HEAD `8ebbcd16af8b504bfa2f1abc3e52e209182f5083`;
- commit и push выполнены; `main` не merged;
- `discovery.enabled` по умолчанию `false`;
- production Router v1, Persistent Engagement и Hermes semantics не переписываются;
- model/runtime/Telegram/live execution не выполнялась.

Следующий шаг — final merge-readiness review этого ADR и review branch; новые production features до отдельного решения не добавляются.

## 18. Decision record

**Решение:** оставить Durable Discovery Situation v1 как тонкий opt-in pre-interaction слой с двумя таблицами и existing events/tasks/Engagement infrastructure.

**Причина:** он закрывает реальный пробел накопления нескольких source observations, не создавая второго агента, CRM, permission engine или send path.

**Следующее действие:** final merge-readiness review ADR и GitHub compare `0cde893...codex/durable-discovery-v1-review-r23`. Новые production features не добавляются до отдельного решения; `main` не merged.
