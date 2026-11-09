# Ускорение входа и выхода — 09.11.2026

Опубликован **`artel-crm:20261109-auth-speed-428d0ac8`**, старт **11:07:24 МСК**, финальная сверка **11:17:35 МСК**: healthy, restart0, OOM0. Код **`388f9d5072b7a8b14d447d30a742efacd18a9e52`**, ветка `codex/auth-speed-20261109`, commit/push до server build. Backend image ID `sha256:828a9bc8cb73a9dde8712e06909fa3b279368cb3ce74bda994aeb775b2191e4b`.

Реальные сопоставимые серии подтвердили сокращение медианы входа до готового обзора на **43,52%**, выхода на **67,21%**. Независимый auth-аудит PASS. Полный preservation review остаётся открытым; `deploymentChecksPassed=true/authChecksPassed=true/taskPassed=false/globalReviewed=false/preservationReviewRequired=true`.

## Изменение

Данные accounts/directories/push физически выделены в `auth-storage/auth.json`; бизнес-данные и Work сохраняют единую транзакционную блокировку и redo WAL. Вход, выход, проверка сессии и GET push/config читают небольшой актуальный auth-раздел. Scrypt, gate4, лимиты, повторная проверка прав после KDF, разграничение CRM/Logistics, защита вкладок и подтверждение выхода после durable commit сохранены. Выход атомарно удаляет свою сессию/push и сохраняет очередь отзыва worker.

Миграция только offline, pointer устанавливается последним; старый backend от нового формата отказывается. Текущий экспорт и merge сохраняют актуальные данные. Entrypoint сохраняет lifetime flock и очищает только stale locks; WAL остаётся для recovery. Штатный backup поддерживает новый формат через согласованный полный экспорт.

Исходники перенесены на фактически активную базу `20261109-trip-delete-return-78d8868c`, возврат и повторное использование заявок сохранены. Основной checkout не заменялся. 25 файлов задачи, 841 файл пакета; 816 остальных исходников точны. Все 42 frontend-файла побайтно прежние.

## Серверные измерения

Baseline 10:35:45–10:37:35 МСК, image `20261109-trip-delete-return-78d8868c`: 10 пар в двух Chromium-контекстах, 1440×1000, отдельный директор, один origin и готовый Обзор. HTTP cache отключён одинаковым route guard. Время измерено в браузере от клика до готового DOM и двух animation frames; HTTP отдельно. После каждого выхода старый cookie проверяется защищённым GET вне измеренного интервала.

Baseline: вход до Обзора median 6,0309 с / p95 7,4634 с; HTTP login 3,915077 / 4,684888 с. Выход до формы median 2,9399 / p95 4,2314 с; HTTP logout 2,888471 / 4,191362 с. Отказов0/10 входов и0/10 выходов, старый cookie401 10/10. Accounts и три предсуществовавшие сессии exact, тестовых остатков0.

| Метрика | Медиана до → после, с | p95 до → после, с | Сокращение медианы |
|---|---:|---:|---:|
| Вход до готового обзора | 6,031 → 3,406 | 7,463 → 5,330 | 43.52% |
| HTTP login | 3,915 → 2,233 | 4,685 → 3,013 | 42.97% |
| Выход до готовой формы | 2,940 → 0,964 | 4,231 → 3,165 | 67.21% |
| HTTP logout | 2,888 → 0,916 | 4,191 → 3,122 | 68.30% |

After: 11:10:58–11:12:50 МСК, 10/10 пар, failures0. Все52обычных API-response200, JS/request errors0, oldcookie401 10/10. Холодных контекстов2: median5,790→2,696с; тёплых8:6,172→3,630с. HTTP включает сеть и сервер, отдельное server-only время не измерялось. Диапазон после: вход1,378–5,330с, выход0,714–3,165с. Общая блокировка с бизнес-транзакциями остаётся, нулевой хвост задержек не обещается.

[Независимый отчёт](auth-speed-2026-11-09-independent-audit.md): отдельная11-я собственная сессия проверила12страниц, logout200/старыйcookie401. Две фоновые загрузки Сбера отменены при уходе со страницы; завершение именно этих карточек не утверждается. В latency-серии отмен не было.

В интервале независимого аудита11:10:45–11:15:14 сохранены все6предсуществующих сессий,16account records,15fact-доменов, documentArchive, банковские business данные и31protected file; собственных сессий не осталось. Worker подтвердил11отзывов по точным hashes10benchmark+1functionalсессии; иных новых revocations внутри этого интервала0. Аудитор отдельно перечитал фактические migration evidence и подтвердил полное логическое равенство.

p95 при n=10 совпадает с максимумом и не является надёжной оценкой редкого хвоста. Ранний timeout из серии на образе05.11 не объединён с этой когортой и не объявлен исправленным. Ручные значения пользователя не подменяют сопоставимую автоматизированную baseline.

## Проверки

- Legacy regression: 1383 PASS, 1 прежний skip; 38 исторических исключений файлов сохранены.
- Auth-layout regression: 656 PASS, 1 прежний skip. Целевые65 PASS; SIGKILL/multiprocess17 PASS — пересекающиеся наборы, не суммируются.
- Финальные lint, TypeScript, production build PASS.
- Source+built Chromium/WebKit на новом storage: по184 наблюдения страниц и16форм, роли/права/login/logout/401, external0; built также CSP/PDF download.
- Точный production bundle/CLI synthetic smoke: auth audiences, admin/driver revocation, durable logout/push/worker outbox, другая сессия, restart/export/currentmerge PASS.
- Ops локально33 сценария PASS.

Первый кандидат `94fa1723` не активирован. Оба Linux-тега прошли9групп, неизменённая текущая копия прошла migrate/export/start/stop/merge exact с пиком1064656896байт из1610612736 и OOM0. Дополнительная modified-copy фикстура сохранила `passwordCiphertext: undefined` в памяти, а JSON опустил поле; отказ сравнения возник до запуска runtime. Исправлены только фикстура и безопасный вывод ошибок, исходные логи и no-switch marker сохранены. Новый пакет `428d0ac8` имеет тот же production backend, новую фикстуру и новый source commit.

## Границы сохранности

Полный начальный capture начался10:39:39МСК, после baseline. Он не включал backup.py в прежний список30protected; switch capture включает31. Эти границы не скрываются. Исторические `globalReviewed=false/preservationReviewRequired=true` этим выпуском не закрываются.

Приватные реальные данные, credentials и bearer не включены в Git или публичные артефакты. Деловые записи для проверки на production не создавались.

## Серверный выпуск и финальная сохранность

Новый пакет прошёл обе Linux-группы по9сценариев, включая17SIGKILL/многопроцессных сценариев на каждом теге, synthetic exact backend auth/CLI и lifetime lease. Отдельный exact bundle smoke возврата двух заявок/reuse/restart выполнен до и после switch, external0. Предыдущий actual exporter сначала прочитал flat копию, затем отказал на auth pointer без изменения файлов; новый exporter вернул точные данные.

Изолированная неизменённая копия: migrate/start/stop/export/currentmerge exact, peak1064353792из1610612736байт. Отдельная изменённая копия37078067байт, из них архив29584817байт: заменены только accounts на synthetic; auth login/logout401, чтение, mixed auth+Work WAL и все прочие поля проверены. Peak1174065152из1610612736байт, OOM0/external0. Эти локальные внутри сервера времена не выдаются за пользовательскую скорость.

Резервная копия1059файлов exact с первого прохода, SHA256 `bea0924b6b5f1d030b48782487d62c226ce78e20b0e32c96443770adf339eecb`. Старый runtime завершился штатноexit0. Одно переключение, rollback/restart recovery0. Offline migration подтверждена полным логическим равенством; различие порядка ключей/физического формата не объявляется побайтным равенством старого и нового envelope. HTTPS42файла exact,21route/5securityheaders PASS. Штатный backup после миграции success.

Heap1536MiB, memory/swap2GiB, env/mounts/HostConfig/соседи прежние. После switch наблюдались healthy/restart0/OOM0; полный непрерывный мониторинг утечек не заявляется. Защищённый backup.py обновлён ровно на проверенный совместимый вариант, остальные30protected files exact.

Switch helper завершилсяexit1 после healthy на строгом preservation assertion. Повторного compose up, отката или восстановления данных не было; финализированы только metadata. Первичный CRM raw1(bank job) независимо classified0; worker новая1revocation и дополнительные сессии уже появились до независимой серии, инициатор не установлен.

Switch→final: CRM raw1/classified1 — `amountMinor` одного кабинета;14business fact-доменов exact, accounts отличаются сессионной активностью, account business/права exact, documentArchive/банки/workflow documents+authorization exact. Worker добавил14revocations;11точно принадлежат независимому аудитору, остальные3не атрибутированы этим выпуском. Initial10:39→final raw10/classified10:4Saby observation-поля и6сумм/детализаций кабинетов; worker15новых revocations,11наших,4не атрибутированы. Суммы/наблюдения не исправлялись и не подменялись старым snapshot.

Исходные отрицательные raw и metadata сохранены. Ускорение и deploy checks прошли, но полный `taskPassed` остаётсяfalse из-за preservation review. Независимый auth PASS этого не отменяет.

Новая обязательная база: `/opt/artel-crm/releases/20261109-auth-speed-428d0ac8`; формат `artel-auth-partition-v1`. Перед следующим выпуском fresh drift. Старый backend поверх этого pointer не возвращать. Для аварийного восстановления — тот же совместимый candidate/recovery code либо проверенный offline merge **текущего** состояния, без возврата старой базы/токенов.

Доказательства: `.local/auth-speed-release-20261109/{source,git,packages,checks,server-proofs,benchmark}`; final-summary.json, final-review-paths.json, health-observations.jsonl. На сервере raw CRM/worker snapshots остаются приватными. Дополнительная независимая проверка сохранена в `independent-evidence-supplement.json`. Основной checkout и чужие правки сохранены.
