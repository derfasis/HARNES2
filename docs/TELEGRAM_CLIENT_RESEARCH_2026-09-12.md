# Готовые Telegram решения: проверка 2026-09-12

## Практический выбор

Для следующего Node-only эксперимента я выбрал бы **teleproto** за совместимость с
GramJS-направлением проекта, но только после pinned-version аудита и conformance тестов.
Не заменял существующий `telegram@2.26.22` в этом slice: установить и проверить новую
зависимость здесь невозможно. Это рекомендация, не проверенная миграция.

| Решение | Проверенное состояние | Когда использовать |
|---|---|---|
| [teleproto](https://github.com/sanyok12345/teleproto) | MIT, активен, 1.229.0, release 2026-08-25 | Первый кандидат для Node без нового сервиса. Надёжность release не доказывает production SLA. |
| [tdl](https://github.com/eilvelia/tdl) + [TDLib](https://github.com/tdlib/td) | MIT wrapper + Boost 1.0 library, активны | Альтернатива для более тяжёлого deployment с native libtdjson; транспортное состояние берёт TDLib. Native events не имеют автоматически нужной этому intake pts-разметки, понадобится иной adapter mapping. |
| [Telethon](https://github.com/LonamiWebs/Telethon), [актуальный Codeberg](https://codeberg.org/Lonami/Telethon) | GitHub архивирован из-за переезда, сам проект не умер; 1.45.0 от 2026-09-10 | Сильный Python вариант, если отдельная Python граница оправдана. Для нынешнего Node slice лишний процесс не добавлял бы. |
| [GramJS](https://github.com/gram-js/gramjs) | GitHub архивирован 2026-07-14; README рекомендует teleproto | В HARNES2 уже pinned npm telegram 2.26.22. Не новая долгосрочная ставка; не путать npm package version с version в GitHub master. |
| [gotd/td](https://github.com/gotd/td) | Go MTProto, MIT | Кандидат только при осознанном выборе отдельного Go-компонента. Ради первого slice не добавлять второй стек. |

Источники миграции: https://docs.teleproto.dev/migrating-from-gramjs,
https://github.com/gram-js/gramjs/blob/master/README.md.

## Что брать готовым, а что остаётся своим

Брать готовыми protocol/auth/transport/session/reconnect primitives. НЕ писать MTProto.
Но библиотека общего назначения содержит send API и не становится read-only только
из-за обещания не вызывать sendMessage. Нужно отдельно сузить доступные capability/RPC,
проверить внутренние read receipts/joins/background effects и держать session вне
экспортов, model environment и Git. Текущий slice вообще не импортирует Telegram client.

Deduplication domain effects, transactional ACK, source-version/evidence consistency,
operator-only Consumer и freshness принадлежат HARNES2. Библиотека не заменяет эти
гарантии и не разрешает создавать новую платформу рядом с ними.

## Почему не Bot API / обычный NewMessage listener

Bot API ограничен доступом бота, не даёт общего recovery произвольной истории и
обычных удалений сообщений; сервер хранит update delivery не более 24 часов.
MTProto имеет pts/pts_count и getDifference/getChannelDifference. Reconnect сокета
не равен durable catch-up приложения. Связанные discussion group и channel являются
разными peers; message ID без peer недостаточен.

Первичные технические источники:
https://core.telegram.org/api/updates
https://core.telegram.org/method/updates.getChannelDifference
https://core.telegram.org/bots/api
https://core.telegram.org/bots/faq

## Важный gate: права на AI-обработку

Публичность Telegram-контента не является автоматическим разрешением передавать его
в AI lead-generation pipeline. API Terms §1.5 и Content Licensing/AI terms ограничивают
AI/ML use, включая deployment; исключения могут требовать индивидуального явного,
информированного, продолжающегося согласия всех соответствующих пользователей в
конкретном контексте. Не считать согласие администратора универсальным разрешением.
Нужна отдельная проверка применимости условий/согласий и приватности, не обход правил.

Первичные тексты:
https://core.telegram.org/api/terms
https://telegram.org/tos/content-licensing
