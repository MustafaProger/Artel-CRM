# Индикация незаполненных данных рейсов — исправление 01.11.2026

Опубликован `artel-crm:20261101-trip-input-alerts-1c74c22f` поверх `20261101-trip-errors-0f6b2bac`. На 12:24 МСК: switch exit 0, healthy, 0 restart, backup success. Git `fbeb29fdb87444de50960027658b75a8c0ffb641` отправлен в `codex/trip-error-indicators-20261101`; PR #1 обновлён.

## Результат

Красная подложка только под значком машины и названием; короткая кнопка слева от «Изменить рейс» открывает существующий Saby. Незаполненные поля и массы проверяются при первом GET списка, без необходимости раскрывать панель. Список и панель используют одинаковую серверную проекцию. Удалены добавленные блок «Требуется внимание», длинные красные повторы под этапами и дополнительное выделение этапов. Прежний список «Что мешает автоматическому обмену» и правила работы обмена сохранены.

Проверка использует существующие чистые валидаторы подготовки, без Saby requests, intent или записи хранилища. Завершённые документы не проверяются заново по справочникам; «ЭТрН не нужна» исключены. Обычное ожидание подписи не считается ошибкой.

## Проверка

- Lint, TypeScript/frontend/server build; API 582, unit 656, bank 3; target 144 — подмножество. 40 старых fixture-зависимых файлов явно исключены из плана, полный legacy suite не заявляется.
- Новый API-тест: первый список до открытия Saby, совпадение результата панели, снятие индикатора после исправления, неизменность хранилища и 0 provider calls. Отдельно проверены исключённые доставки, direct и completed.
- Chromium/WebKit 375/1440: предупреждение до workflow-запроса, кнопка слева, отсутствие дубликатов, исправление после reload, отсутствие переполнения/JS ошибок. Синтетический стенд обновлён на 5197.
- Оба Linux-образа: 7 групп; копия текущего split-хранилища exact, external calls 0, остановленный backup проверен; HTTPS 42 файла/21 маршрут/5 security headers.
- **Рабочий Chrome/Egor после reload:** №55 и №57 имеют фон rgb(255,216,212), короткую кнопку слева и закрытый Saby. №57 после раскрытия: добавленных warning-блоков/текстов под этапами 0, прежний список причин есть. Console errors 0, вход сохранён. №52 без индикатора: массы сохранены, Saby ожидает подпись АРТЭЛЬ. Новые записи/подписи/отправки при UI-проверке не выполнялись. Физический телефон не проверялся.
- Начальные ошибки синтетической fixture и зависимостей preview устранены; ранние QA/UI попытки сохранены. Финальный исходный fingerprint неизменен на всём прогоне.

## Сохранность и границы аудита

На switch: raw 4 / classified 0, reviewed invariants true. На after-ui: raw 40 / classified 1 — очищен `tripSaby/trips/#381c4af8d542/lastError`, инициатор не установлен. Сохранены **taskPassed=true, deploymentChecksPassed=true, globalReviewed=false, preservationReviewRequired=true**. Исходные отрицательные аудиты не переписаны; metadata финализирована отдельно, повторного switch или rollback нет.

Все 14 fact-коллекций и accounts exact; documentArchive exact. Банковские 1581 операции и 240 дней business exact (polling metadata менялись). Ключи/защищённые файлы/worker container/соседи прежние; worker bridge изменил только nonce journal. Историческая квитанция рейса45 перенесена exact, provider/storecalls 0. Полная побайтная неизменность runtime не заявляется.

## Следующее продолжение

Новая база `/opt/artel-crm/releases/20261101-trip-input-alerts-1c74c22f`; перед выпуском fresh drift. Старый backend/store не возвращать.

Source `.local/trip-input-alerts-20261101/source`, package manifest790, task11, остальные779 исходников exact. Основной checkout и чужие правки сохранены. Патч: `docs/patches/trip-input-alerts-20261101.patch`.

Доказательства: `.local/trip-input-alerts-20261101/final-qa/`, `ui/report.json`, `production-ui-proof.json`, `server-result.json`, `final-check.json`, `receipt-capture-result.json`, `receipt-restore-result.json`; соответствующие серверные proofs в release.

Backend SHA256: `d4d71b746fbdb50996fe2bf52b73d6ade49186aeb5917abf43e16576688673a8`.
