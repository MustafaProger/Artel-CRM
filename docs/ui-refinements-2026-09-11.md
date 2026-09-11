# Интерфейс и иконка приложения — 11 сентября 2026

## Поведение

- В «Работе» панель получила внутренние отступы и упорядоченные строки на десктопе. При достаточной ширине все элементы располагаются в одну строку. Мобильная раскладка сохраняется.
- «В архив задач» и «Вернуть в работу» сразу сохраняют карточку, включая введённые комментарии и прикреплённые файлы. После успешного ответа карточка закрывается и список обновляется.
- Задачи, заметки и рабочие записи компаний можно удалить из карточки. Перед удалением показывается подтверждение. API проверяет права и версию записи, поэтому чужую или устаревшую карточку удалить нельзя.
- В отгрузках на десктопе столбцы шире по умолчанию. Границу заголовка можно перетаскивать мышью. Настройки сохраняются отдельно для каждого вида таблицы бензовозов и АЗС в браузере. Двойной щелчок сбрасывает один столбец, кнопка «Сбросить ширину столбцов» — текущий вид. Доступны стрелки клавиатуры, Home, End и Enter. На сенсорных устройствах и при ширине окна меньше 1100 px регулировка отсутствует; сохранённые размеры десктопа не применяются.
- В «Китае» четыре столбца одинаковой ширины, дата и значения одного кегля. Таблица адаптируется до окна 425 px, затем сохраняет минимальную ширину 375 px внутри контейнера и прокручивается горизонтально. Страница целиком не прокручивается вбок.
- В справочниках увеличены отступы вокруг поиска и кнопки добавления. На телефоне элементы располагаются один под другим. У поиска есть кнопка очистки.

## Иконка

Подключение сверено с `/Users/mustafa/finance/index.html` и его манифестом: PNG favicon, отдельный Apple Touch Icon 180×180, иконки 192×192 и 512×512, отдельная запись maskable и standalone-манифест. Дополнительно добавлены PNG 1024×1024 и корневой `/apple-touch-icon.png`.

Все ссылки в HTML, манифесте и уведомлениях получили версию `20260911`. Фон PNG непрозрачный; знак помещается в центральной безопасной области. Скругление установленного приложения применяет система. Ранее добавленный ярлык может сохранить старый значок; если это произошло, его нужно добавить заново. Физическая установка на iPhone и в Dock не автоматизировалась.

Мастер: `assets/artel-app-icon.png`. Файлы приложения: `web/public/icons/`. Пересоздание размеров на macOS: `node scripts/generate_app_icons.mjs`.

Создано встроенным инструментом imagegen. Итоговый промпт:

> Use case: logo-brand. Asset type: production app icon for Artel CRM installed on iPhone and macOS. Generate one square 1024x1024 full-bleed icon asset, not a mockup. Apple-style restrained premium app icon: a single centered ivory-white sculptural geometric A mark, like an upward chevron with a triangular notch at the base, NO crossbar, based on two broad diagonals. Deep forest emerald green background with a subtle luminous green gradient, softly beveled satin/glass white symbol, tiny realistic internal shading, precise symmetrical shape, calm and minimal. Symbol occupies the central 58% of the canvas to stay inside maskable icon safe area. Background fills all corners completely, no rounded exterior corners, no outside margin, no frame, no transparency, no devices, no letters or text besides this A-shaped symbol, no Apple logo. Sharp recognizable silhouette at favicon sizes. The OS will apply the final rounded shape.

## Проверки

- `npm run typecheck`, `npm run build`, `npm run lint`.
- `npm run test:api`: 93 теста прошли, включая удаление, версии, права и недоступность файлов удалённых задач.
- `npm run test:work-ui`: создание, передача между сотрудниками, комментарии и файлы, архивирование одним нажатием, возврат, удаление задач и заметок, перезагрузка.
- `npm run test:design-ui`: 9 разделов на пяти ширинах, редакторы, клавиатура, reduced motion, автоматическая проверка доступности без нарушений.
- `node scripts/verify_ui_refinements.mjs`: размеры 320–1920 px, перетаскивание границы, сохранение размеров и изоляция видов, прокрутка «Китая», отступы, поиск и размеры PNG. Скриншоты и итоговый отчёт: `qa/ui-refinements-2026-09-11/`.

WebKit проверяется в профилях iPhone 390 px, iPad 834 px, iPad в альбомной ориентации 1366 px и Mac 1440 px. В настольном headless WebKit service worker отключён из-за зависания тестового runtime; проверка доставки push в этот прогон не входит. На мобильных профилях service worker не блокируется.

Все тестовые записи создаются на отдельном локальном сервере во временном хранилище; production не используется для записей QA. Проверка локальных данных исключает только время фоновой проверки push и счётчик транзакций: отдельный dev-сервер меняет их каждые 30 секунд.
