# Независимый аудит ускорения авторизации — 09.11.2026

**Серверное ускорение подтверждено сопоставимыми сериями по10полных пар.** После публикации вход до готового обзора: медиана3,406с против6,031с, уменьшение43,52%. Выход до готовой формы после подтверждения сервера:0,964с против2,940с, уменьшение67,21%. В обеих сериях10/10входов и10/10выходов завершены, failures0. Это результат реального production HTTPS, не локальная синтетика и не только раннее появление оболочки.

Аудитор не реализовывал продуктовые изменения. Выполнил baseline, независимый read-only review, затем after и отдельную функциональную серию. Продукт/доступы/деловые записи не редактировал.

## Выпуск и методика

После: `artel-crm:20261109-auth-speed-428d0ac8`, image ID `sha256:828a9bc8cb73a9dde8712e06909fa3b279368cb3ce74bda994aeb775b2191e4b`. Commit из проверенного release config: `388f9d5072b7a8b14d447d30a742efacd18a9e52`. Измеренная before-когорта: `artel-crm:20261109-trip-delete-return-78d8868c`.

Before:10:35:45–10:37:35МСК; after runner:11:10:58–11:12:50МСК. Полные preservation captures вокруг benchmark и функциональной серии:11:10:45–11:15:14МСК. Время runner включает приватные captures, не только браузерные действия.

Одинаковые Chromium153.0.8010.12/headless1440×1000, origin`https://artel-crm.online`, route`#overview`, существующий директор, два новых контекста×5пар. Route guard отключает HTTP cache; warm означает сохранённые JS-модули в контексте. CPU/network throttling нет. Начало — capture click; конец входа — видимая `.overview-freshness`+2rAF; конец выхода — enabled`.auth-submit`+2rAF после HTTPlogout. Browser timing/attempts/revocation/cleanup часть after runner побайтно совпадает с baseline.

Изменён только snapshot loader: after использует проверенный по release config SHA256 `storage-snapshot.py`, согласованное чтение актуальных частей с проверкой WAL/latch и изолированной checksum/composition. Строго проверен pointer`artel-auth-partition-v1`. Старый `work-storage/core/operations.json` не читался как актуальная база.

## Серверные результаты

Секунды. Все n=10. p95 nearest-rank при этом n совпадает с наблюдённым максимумом; он не даёт надёжной оценки хвоста всей нагрузки.

| Метрика | Before median | After median | Уменьшение median | Before p95 | After p95 | Уменьшение p95 |
|---|---:|---:|---:|---:|---:|---:|
| Вход → готовый обзор | 6,031 | 3,406 | 43,52% | 7,463 | 5,330 | 28,58% |
| HTTP login | 3,915 | 2,233 | 42,97% | 4,685 | 3,013 | 35,68% |
| Выход → готовая форма | 2,940 | 0,964 | 67,21% | 4,231 | 3,165 | 25,21% |
| HTTP logout | 2,888 | 0,916 | 68,30% | 4,191 | 3,122 | 25,52% |

After login→обзор min–max1,378–5,330с; logout0,714–3,165с. Оболочка появляется с медианой2,257с; она отдельно от готовности обзора. HTTPsettlements после входа: медиана1,143с. HTTP duration включает сеть и сервер; server-only duration не измерена.

Cold-context after n2:1,958/3,433с, медиана2,696с. Warm-context n8:медиана3,630с. До: cold2медиана5,790с, warm8медиана6,172с. Малые группы не доказывают отдельный эффект кэша.

After benchmark:52обычных browserAPI-response200, неожиданных4xx/5xx0, JavaScript errors0, requestfailed0, blocked writes0. Каждый из10собственных старых cookies послеlogout даёт401на`GET /api/navigation`; эти ожидаемые probes выполнялись вне timing-интервала. Прежний timeout обзора не воспроизведён; причина старого отказа не установлена и исправление его причины не заявляется.

## Отдельная функциональная серия

Одна отдельная собственная сессия,11:12:56–11:14:47МСК, исключена из latency статистики. С reload открыты12страниц: Обзор, Работа, Отгрузки, Рейсы, Платежи, Балансы кабинетов, Китай, Счета, Операторская, Сотрудники и доступ, Справочники, Документы. Основное содержимое видимо, alerts0, overflow0, JS/console errors0, запрещённых writes0. Формы не сохранялись, provider refresh не нажимался. Собственныйlogout200, старыйcookie401, оставшихся сессий0.

В raw сохранены2`net::ERR_ABORTED`: фоновые GET выписок двух Сбер-подключений при переходе Платежи→Балансы кабинетов. `BankingPage.tsx` использует AbortController cleanup при размонтировании. Они классифицированы как отмены навигации; завершение загрузки именно этих двух карточек не утверждается. В сопоставимом latency benchmark отмен/ошибок запросов не было.

## Независимая сохранность

На старте after уже было **6предсуществующих сессий**. Все6и всеaccount records сохранены exact; собственных оставшихся сессий0. Инициаторы ранее появившихся чужих сессий этим аудитом не устанавливаются.

Отдельно перечитаны private migration evidence: SHA256before/migrated совпали с proof; **полные логические данные до/после миграции равны**, состав ключей и sourceSha256 сохранены, активный pointer корректен. Это проверка фактических артефактов, не только доверие boolean из отчёта.

За интервал11:10:45–11:15:14МСК полные server captures подтверждают:15fact-доменов включаяaccounts exact; documentArchive exact; банковские business данные безpolling exact;31protected files exact; контейнеры/соседи exact. Top-level изменения`revision`, `tripSaby`, `push`, `cabinets`, `banking`, `etrn` сохранены; остальные фоновые дельты здесь не атрибутированы полностью.

Worker: фактически наблюдены **11новых revocations по точным hashes наших10benchmark+1functionalсессии**. Неатрибутированных новых worker revocations внутри нашего интервала0, прежниеrevocations иidentity exact. Bearer нигде не сохранены; hashes находятся только в private evidence. Logout200 отдельно от последующего реально наблюдённого worker acknowledgment.

После аудита activeimage тот же, healthy/restart0/OOMKilled=false. Исторические`globalReviewed=false/preservationReviewRequired=true` не закрыты. Auth-аудит PASS не отменяет отрицательные raw release preservation результаты и не объясняет чужие изменения до нашего before capture.

## Повторяемые артефакты

- `.local/auth-speed-release-20261109/benchmark/independent-summary.json` — sanitized итог, четыре required flags true, before/after/проценты/worker counts.
- `benchmark/evidence-summary.json` — независимая перепроверка миграции и полного интервала.
- `benchmark/before/` и `benchmark/after/` — отдельные runner/raw/summary/log.
- `benchmark/functional/` — отдельный runner,private raw иsanitized summary.
- `benchmark/finalize-independent.py`, `verify-evidence.py`, `summarize.py` — повторяемый расчёт и проверка.
- Серверный release: `before-auth-audit-*`, `after-auth-audit-*` — приватные CRM/worker/protected captures.

Ограничения: n10наверсию, фоновые процессы не остановлены; улучшение измерено в этих условиях без гарантии каждого будущего входа. Хвост задержек сохраняется. Реальные бизнес-сохранения и все роли пользователей этим browser-аудитом не проверялись; они относятся к отдельным regression/security доказательствам выпуска.
