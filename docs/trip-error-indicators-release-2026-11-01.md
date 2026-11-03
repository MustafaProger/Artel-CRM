# Индикация ошибок ЭТрН — опубликовано 01.11.2026

Выпуск `artel-crm:20261101-trip-errors-0f6b2bac` опубликован поверх `20261030-carrier-recovery-61925206`. Переключение exit0; healthy, restart0. Новая база `/opt/artel-crm/releases/20261101-trip-errors-0f6b2bac`; перед следующим выпуском обязательна свежая сверка, старый backend/store не возвращать.

Красная подложка только под значком машины и названием рейса. Короткое действие слева от «Изменить рейс», подробности внутри Saby. Фон остальной карточки обычный. Ошибки вычисляются из сохранённого состояния без новых внешних запросов и записей. Обычное ожидание подписи не является ошибкой.

## Проверки

- Свежий серверный source manifest: 782 файла. Узкий патч: 12 файлов. Все остальные исходники, включая carrier recovery, сохранены. Файлы задачи совпадают с Git commit `e5ce91c`.
- Lint, TypeScript/build:production PASS. API580, unit656, bank3; target144 — подмножество. 40 legacy fixture-файлов исключены явно в qa-plan.json.
- Chromium/WebKit 375/1440 на синтетике: оформление, обе схемы ЭТрН, очистка отметки, отсутствие переполнения и ошибок JS PASS.
- Оба Linux-образа: 7 групп smoke каждый, network none, helpers в отдельных 512MiB cgroup; candidate/recovery совпадают. Копия текущих данных exact, внешних запросов0.
- Плановая и остановленная резервные копии проверены. HTTPS42 файла/21 маршрут/5 заголовков PASS. Дополнительный GET с Mac через en0 HTTP200.
- Историческая квитанция45 захвачена и восстановлена exact, SHA47de72f2…; provider/store calls0. Первоначальный локальный отказ из-за старого имени выпуска в guard сохранён. Guard адресно адаптирован, тесты4 PASS; серверных действий при отказе не было.

## Сохранность и границы

На переключении raw4, независимая классификация0: reviewedBusinessInvariantsPreserved=true. После проверки в 11:53 МСК raw45/classified6: пять lastError в tripSaby очищены, один phase изменился; инициатор не установлен. Все14 fact-коллекций, accounts, documentArchive и банковские business records exact; защищённые файлы, worker-контейнер и соседние сервисы сохранены. Worker bridge менял проверяемый runtime nonce; другие worker-файлы exact.

Финальная metadata: taskPassed=true/deploymentChecksPassed=true, globalReviewed=false/preservationReviewRequired=true. Raw-аудиты сохранены, исторические отрицательные аудиты не переписаны. Финализация только metadata, без повторного переключения, восстановления данных и rollback.

Авторизованный Chrome ещё до выпуска показывал ERR_TIMED_OUT; reload после публикации также завершился таймаутом. authenticatedProductionUiVerified=false. Сетевые/VPN-настройки не менялись. HTTPS и точные опубликованные assets подтверждены независимо. Реальные рейсы/документы для теста не создавались, подписи и обмен Saby вручную не запускались.

## Материалы

Локально `.local/trip-error-release-20261101/`: свежий baseline, source, task-files.json, final-qa, packages, prepared.json, логи сборки/переключения, receipt proofs, server-result.json, final-check.json. Приватные данные и квитанции не включены в Git.
