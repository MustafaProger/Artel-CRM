# Свежая серверная baseline авторизации — 09.11.2026

Независимый измеритель выполнил **10 из 10 полных пар вход/выход**, **10:35:45–10:37:35 МСК**. Отказов/незавершённых наблюдений: **0/10 входов, 0/10 выходов**. Это отдельная когорта на релизе возврата заявок09.11 до auth-оптимизации; прежние серии сюда не включены.

## Точная база

Image `artel-crm:20261109-trip-delete-return-78d8868c`, ID `sha256:360dad64276734d583b2ebfdb52c47c6847e73d2b4d0b37d5e093432c9f1f635`. До/после imageId exact, start `2026-11-09T07:15:35.313255486Z`, healthy, restart0, OOMKilled=false. Memory и memorySwap по2147483648байт без изменений. Это лимиты, не замеры фактического потребления.

## Методика

Реальный `https://artel-crm.online/#overview`, Chromium153.0.8010.12 headless,1440×1000, та же действующая учётная запись директора. Два новых изолированных контекста×5пар; первые входы cold browser context, остальные warm JS modules. Route guard отключает HTTP cache; это не обычный warm HTTP cache. CPU/network throttling отсутствуют. Секреты/cookies только в памяти процесса, не в файлах и логах.

Runner основан на исправленном `.local/auth-speed-20261109/followup/measure.mjs`. Сохранены определения: начало capture click, login-ready видимая `.overview-freshness`+2rAF, shell отдельно, logout-ready видимая enabled`.auth-submit`+2rAF после HTTP logout. Добавлены регистрация каждой попытки до запроса и проверка старого cookie GET `/api/navigation` **после измеренного logout**. Все10проверок дали401. `/api/auth/session` не подходит для401: штатно200 user:null. Revocation probes не входят в duration и должны остаться такими же в after.

HTTP duration — браузерный `request.timing().responseEnd`, включая сеть и сервер; server-only duration не измерялась. Разрешены только auth login/logout POST, остальные browser writes блокируются. Деловых записей через UI нет.

## Результаты

Значения в секундах. p95 nearest-rank по успешным наблюдениям; при n10 совпадает с максимумом и ненадёжно оценивает хвост.

| Метрика | n | Медиана | p95 | min–max |
|---|---:|---:|---:|---:|
| Вход → готовый обзор | 10 | 6,031 | 7,463 | 3,080–7,463 |
| Вход → оболочка | 10 | 3,947 | 4,702 | 1,861–4,702 |
| HTTP login | 10 | 3,915 | 4,685 | 1,836–4,685 |
| Выход → готовая форма | 10 | 2,940 | 4,231 | 1,965–4,231 |
| HTTP logout | 10 | 2,888 | 4,191 | 1,919–4,191 |
| HTTP settlements после входа | 10 | 1,897 | 2,736 | 1,184–2,736 |

Cold-context login-ready n2:5,499/6,082с, медиана5,790с. Warm-context n8:медиана6,172с. Эти подгруппы малы.

| Пара | Контекст | Вход → обзор, с | Выход, с | Старый cookie |
|---|---|---:|---:|---:|
| 1 | cold | 5,499 | 2,297 | 401 |
| 2 | warm | 7,463 | 2,563 | 401 |
| 3 | warm | 6,430 | 2,148 | 401 |
| 4 | warm | 5,564 | 2,698 | 401 |
| 5 | warm | 6,365 | 3,481 | 401 |
| 6 | cold | 6,082 | 1,965 | 401 |
| 7 | warm | 3,080 | 4,231 | 401 |
| 8 | warm | 6,813 | 3,182 | 401 |
| 9 | warm | 5,980 | 3,515 | 401 |
| 10 | warm | 5,245 | 3,748 | 401 |

## Сохранность и ограничения

52обычных browser API-response дали200; неожиданных HTTP4xx/5xx0, requestfailed0, JavaScript errors0, long tasks>50ms0, запрещённых browser writes0. Отдельные10ожидаемых401проверок отзыва не входят в browser error denominator.

Все account records и все3предсуществующие сессии exact по приватным fingerprints; новых оставшихся сессий0, весь accounts top-level hash exact. Ранее оставшаяся тестовая сессия исходного восьмого входа не отозвана: bearer утрачен, чужие сессии и пользователя не меняли.

Другие top-level hashes изменились: `revision`, `push`, `banking`, `tripSaby`. Содержимое и инициаторы дельт здесь не атрибутированы. Свои logout могут менять push/worker revocation, но вся push-дельта автоматически этим не объясняется. Полная неизменность production и закрытие исторических аудитов не утверждаются.

Timeout готового обзора из исходной серии05.11 **не воспроизведён в этих10попытках**. Это не доказательство исправления; причина по прежним ограниченным raw неизвестна. Новый runner при отказе сохраняет action/DOM/alerts и HTTP status; адресный cleanup собственным bearer не зависит от page-ready. Аварийный cleanup здесь не понадобился.

## Артефакты и after

- Runner `.local/auth-speed-release-20261109/benchmark/before/measure.mjs`, SHA256`286a166793430e89c46bcd05448a4df829513d4d34258c40dffb97633d2fc2f6`.
- Приватный raw `before/results.json`, SHA256`3b131bbf3cdd4ff30b322c1963c75595935d3d9852d9ecd04bd212232f30e4e2`.
- Безопасная сводка `before/summary.json`, лог `before/run.log`.
- Повторяемый расчёт `.local/auth-speed-release-20261109/benchmark/summarize.py`.

After: тот же браузер/viewport/user/route,2×5, те же DOM/HTTP окончания; отдельная когорта/image. При новом auth-storage адаптировать только read-only snapshot loader к точному логическому export и сохранить privacy. Изменение методики явно указать.
