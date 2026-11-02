# Удаление дублирующей метки сервиса — 02.11.2026

По прямому поручению пользователя в форме операции удалена отдельная метка сервиса под выпадающим списком. Название выбранного сервиса и окраска поля сохранены. Общая форма создания/редактирования, скидка, расчёт суммы и сохранение операции не менялись.

Изменён только `web/src/OperatorPage.tsx`: удалены JSX метки и неиспользуемый default import. Остальные 797 из 798 исходников свежей серверной базы `20261102-saby-ui-52b9a550` точны. Серверный bundle побайтно прежний (`d0126f41b336317f66e4ff76f68f97db60c79987e4fe75781c75c43cc838a836`).

Локальные исходники: `.local/operator-service-label-20261102/source`; Git worktree: `.local/operator-service-label-20261102/git`. Основной старый checkout не заменялся. Commit `6ecaf44` опубликован в `codex/operator-service-label-20261102` до серверной сборки; все 653 code-файла совпадают с пакетом. [Патч](patches/operator-service-label-20261102.patch).

Проверки: lint/TypeScript/build PASS. Source+built Chromium/WebKit, 375/1440: 8 сценариев × 5 сервисов, отдельной метки нет, цвет/скидка/расчёт сохранены, axe0, browser business mutations0. Данные изолированные учебные. Первые два UI-прогона не прошли из-за отсутствующего учебного активного задания и неправильного axe selector; исправлен только внешний QA helper, исходные логи сохранены. Полный API/unit suite для удаления JSX повторно не запускался.

Пакет `20261102-operator-service-label-a2936566`. Оба Linux-тега одного image ID: 7 групп проверок каждый PASS, сеть отключена. Совместимость на копии текущего store: fullDataExact=true/externalRequests=0. Все production source/backend pins сверены перед сборкой и переключением. Согласованный пользовательский выпуск выполняется отдельным systemd unit.

Первый исходный read-only snapshot не получил стабильное поколение на работающем сервере; исходный отказ сохранён. Повторная ограниченная прямая сверка успешна, recovery/store/provider calls0. Исторический stage6 guard с двумя carrier aliases не переписан: UI deployment сохраняет его baseline/after false и отдельно требует точного равенства frozen проекций.

Локальный стенд: http://127.0.0.1:5201/#operator, учебный логин `review`, пароль `LocalReview2026!`; это только синтетические данные, внешние интеграции отключены.

В авторизованной рабочей вкладке Chrome/Egor нет активных заданий, кнопка «Новая операция» отключена. Реальные тестовые задания не создавались; форма проверена на точной сборке с учебными данными. Доступность авторизованной production-формы не заявляется.

Предыдущие отрицательные аудиты сохранности не закрываются. Окончательные результаты выпуска и свежего аудита приведены ниже.

## Опубликовано и проверено — 16:22 МСК

Активный образ `artel-crm:20261102-operator-service-label-a2936566`, healthy/0restart; systemd switch exit0, однократная активация. Backup 1059 файлов exact, одна попытка. HTTPS42 файлов/21 маршрут/5 security headers PASS. Историческая квитанция №45 перенесена exact, без provider/store calls.

После reload в отдельной Chrome-вкладке авторизация Egor сохранена; операторская загружается, активных заданий0/кнопка новой операции disabled. Рабочую вкладку пользователя не меняли. Локальная форма и точная опубликованная сборка проверены синтетически; реальная форма не открывалась.

Сверка switch→final: все15 fact-коллекций, включая operator и accounts, documentArchive и frozen52/54 exact. Raw2/classified0, reviewed invariants PASS. За всю задачу initial→final raw39/classified0, reviewed invariants PASS. Защищённые файлы/соседи/worker identity сохранены; worker nonce journal классифицирован штатно. Исторические незавершённые аудиты не закрыты: taskPassed=true/globalReviewed=false/preservationReviewRequired=true; authenticatedProductionUiVerified=false с явным ограничением формы, formVerifiedOnExactBuild=true. Повторного switch/rollback/data restore нет.

Новая база `/opt/artel-crm/releases/20261102-operator-service-label-a2936566`; перед следующим выпуском требуется свежая сверка. Доказательства в `.local/operator-service-label-20261102/`: prepared.json, git-code-proof.json, final-qa/, ui/, server-verification.json, final-check.json, receipt-*-result.json. Полные исходные аудиты сохранены на сервере.
