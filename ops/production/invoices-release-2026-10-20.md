# Выпуск раздела счетов

Этот файл — проверяемый порядок выпуска, не свидетельство выполнения production-команд.

## Проверенная основа

Рабочая папка `/Users/mustafa/.codex/worktrees/invoices-crm/Artel-CRM`, ветка `codex/invoices-crm`, Git-база `6272a6563282700c7dcf382fc84df88d4db706f4`.

576 файлов исходного архива `20261019-operator-fields-89e62b8e` проверены по `source-manifest.json` и `source-proof.json`. Во время работы опубликован `20261020-saby-multidelivery-aa4ef0fa`; его архив и manifest проверены, восемь отличающихся файлов Saby точно перенесены без изменения остальных файлов. Затем опубликован `20261020-saby-own-sender-d632fb90`: 21 файл его новой дельты перенесён побайтно, `server/local-api.ts` объединён трёхсторонним слиянием без конфликтов. **Production-основа для этого выпуска — d632fb90.**

Приватный текущий manifest источника, image ID и hash `/opt/artel-crm/release.json`: `.local/crm-transfer/crm-source-base.json` проекта счетов. Непосредственно перед переключением проверить их снова. При любом несовпадении остановить переключение и перенести новый релиз в основу.

## Конфигурация

- CRM остаётся на `127.0.0.1:18083`; Caddy, внешние порты и соседние проекты сохраняются.
- В CRM runtime добавить `ARTEL_INVOICES_URL=http://invoices:4318` и `ARTEL_INVOICES_BRIDGE_KEY_FILE=/run/secrets/invoices-bridge.key`.
- Bind mount отдельного файла ключа CRM в `/run/secrets/invoices-bridge.key:ro`. Подтверждённый UID CRM — 1000. Сам ключ — 64 hex-символа, закрытый файл; значение не включать в image, Git или argv.
- Отдельная служба счетов размещается в `/opt/artel-invoices`, alias `invoices` в существующей `artel-crm_default`, без host ports. CPU/RAM/browser ограничения задаются её Compose.
- Закрытый `owners.json` содержит только две явные пары устойчивых ID. Это перенос личной истории, а доступ задаётся обычным `sections: invoices`.
- Обновление `runtime.env` только под `/opt/artel-crm/secrets/.runtime-env.lock`, форматом raw. Существующие значения не переписывать.

## Подготовка и проверка

1. Построить frontend и оба server bundles командой `npm run build:production`. `grant-invoice-access.mjs` входит в server-render, публично недоступен.
2. Упаковать исходники по manifest без `.git`, `node_modules`, `data`, `.env*` (кроме примера), закрытых материалов и build-каталогов. Сохранить hash точных исходников, сборки, результатов тестов и source-base.
3. Новый image строить из текущего проверенного образа CRM, заменяя только `/app/app-dist` и `/app/server-render`. Создать второй образ: предыдущий UI с новым backend. Старый backend не является откатом после записи новых section и push полей.
4. Проверить оба образа на синтетическом store без production mounts и без внешних запросов: auth, разрешения, шлюз, push, persisted restart, lifetime flock и helper назначения.
5. Принять Linux Fresh/PDF в отдельном обработчике до переключения CRM. Старый локальный writer должен быть остановлен перед единственным новым writer. Старые задания не создавать повторно.
6. Сканировать публичные файлы на runtime-секреты, проверить SHA каждого публичного файла и закрытые пути.

## Переключение — только после проверок

Старые `deploy.py` из предыдущих выпусков жёстко привязаны к тому релизу. Не запускать их без нового reviewed config и adaptation. Сохранить их процедуры проверки backup, source lineage, lifetime lock, сохранности и соседних контейнеров.

1. Под lock выпуска и runtime-конфигурации снова проверить exact current image/image ID, release metadata SHA, frontend/backend и секретные файлы по hash. Зафиксировать ID/StartedAt соседних контейнеров и конфигурацию/PID Caddy.
2. `systemctl start artel-crm-backup.service`; проверить Result=success, ExecMainStatus=0, свежесть архива и `tar -tzf`. Скопировать приватный operations envelope до изменений в каталог релиза `0600`.
3. Остановить только CRM штатно с grace 630 секунд (внутренний shutdown timeout 600). До назначения сохранить State и остановленный envelope; обязательны ExitCode=0, Running=false, OOMKilled=false, пустой Error. `verify-invoice-quiescence.mjs` проверяет checksum и отсутствие любых оставшихся leases в bank/Saby/ЭТрН, включая просроченные. При нарушении остановиться для разбора; leases не удалять. Обработчик счетов уже принят отдельно.
4. Под entrypoint lifetime flock выполнить one-time grant новым образом, с `--network none`, существующими operations и read-only mapping mounts. Указать `ARTEL_INVOICES_MAINTENANCE=true`, `ARTEL_STORE_DIR` и `--expected-sha256` точного остановленного operations envelope:

   `node /app/server-render/grant-invoice-access.mjs --execute --mapping /run/secrets/invoice-owners.json --expected-sha256 <fresh-stopped-store-sha256>`

   Helper создаёт backup, добавляет только `invoices` двум существующим пользователям и увеличивает их version. Все сессии, пароли, подписки и остальные данные сохраняются. Повторное выполнение идемпотентно.
5. Атомарно обновить только согласованные runtime/Compose поля и ARTEL_IMAGE. `docker compose --project-directory /opt/artel-crm config --quiet`, затем `docker compose --project-directory /opt/artel-crm up -d --no-build --pull never --timeout 600 crm`.
6. Проверить healthy, image ID, hash backend/frontend, обычный HTTPS/401/403, отсутствие доступности внутреннего worker API, отсутствие изменений соседних контейнеров/Caddy.
7. Сохранить after-envelope и проверить `node scripts/verify-invoice-preservation.mjs <before> <after> <owners>`. Этот verifier допускает только явное добавление прав, revision и scheduler heartbeat. Иные фоновые изменения оставляет false; классифицировать по сохранённым snapshot и устойчивым ID существующими release helpers, не стирать false-флаги.
8. В авторизованном UI проверить назначение в «Сотрудники и доступ», личную историю каждого пользователя, PDF, общий bell и мобильную верстку. Приёмка не создаёт новых рабочих счетов. После UI повторить сохранность.

## Откат и неисправность

- Если новая UI требует отката — совместимый предыдущий UI **с новым backend**, актуальные данные и ключи остаются.
- Не возвращать прежний образ d632fb90 поверх хранилища с `invoices`: прежний валидатор разделов его отвергнет.
- Ошибка backend/gateway: сохранить текущие данные/снимки, исправлять новый backend либо подготовить отдельно проверенный совместимый recovery. Автоматический возврат старых данных, refresh tokens и backend запрещён.
- Остановка/недоступность worker не должна останавливать CRM: шлюз отвечает понятной ошибкой, неизвестный запрос сохраняет прежний ключ; принятые задания остаются на диске.
