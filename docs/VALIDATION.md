# Проверка переноса 26.11.2026

- `node scripts/check.mjs` — успешно: синтаксис основных модулей, 19 уникальных пар, NEAR отсутствует.
- `node --test tests/core.test.mjs` — 5 тестов прошли: полная лестница DCA и TP, повтор/разрыв свечей, агрегация 45m, восстановление DCA после перерыва, краткая сводка на 06:00.
- npm в локальном PATH отсутствовал, поэтому выполнены непосредственно те же Node-команды. В обычном окружении доступны алиасы npm run check / npm test.
- Проверены шаблоны Telegram/GitHub токенов, приватных ключей и частных почтовых адресов, а также присваивания token/password/secret/chat_id. Из архивного кода удалён конкретный CHAT_ID, заменён локальный путь пользователя.
- Исторические тесты на биржевых свечах заново не выполнялись. Архивные тесты не запускались как проверка production.
- Telegram, Cloudflare и биржевые ордера не изменялись. Доступность production и текущая доставка не проверялись.

## 26.11.2026 — начало разработки, DCA-20261126-04
- Ветка dev/dca800-foundation; проверенный коммит c723a81851bc59166fd94f95e94a1612014f29d9.
- Локально Node.js v22.16.0, npm 10.9.2. git ls-remote недоступен из-за DNS; два новых файла воспроизведены локально, SHA git hash-object совпали с GitHub: cloudflare/trade-ledger.mjs a7eb154fe76c3dfee73a9e61cd9705b9ea728bab; tests/trade-ledger.test.mjs f65408c6f312eaf2d2abdd5dabf19a6580838c22.
- node --check cloudflare/trade-ledger.mjs успешно; node --test tests/trade-ledger.test.mjs: 6 passed, 0 failed.
- GitHub Actions https://github.com/smoc1983-web/Dca/actions/runs/45841081405 (job 139982579924): completed/success, шаги Baseline core tests, Syntax and watchlist, All offline tests успешны. В наборе исходные 5 + новые 6 тестов; проверка синтаксиса и списка пар успешна.
- Не проверены реальная D1/Telegram, production, исторический бэктест, расчёт плеча, денежная точность за пределами тестов и персистентное хранение. Нет изменений production.

## 26.11.2026 — постоянное хранилище, DCA-20261126-05
- Ветка dev/dca800-foundation, коммит 2f1af07a0d5053deb8035623d5dedc55f1e336d4.
- GitHub Actions https://github.com/smoc1983-web/Dca/actions/runs/45842108512, job 139986197864, completed/success: baseline core, syntax/watchlist, all offline tests прошли. Всего 18 тестов, в том числе 7 новых SQLite-интеграционных. Проверка закрытия/повторного открытия БД, идемпотентность, аудит, конкуренция и отказ невалидных операций успешны.
- Локальный node:sqlite доступен (Node 22.16.0); данный полный прогон подтверждён CI, локально новый набор отдельно не запускался. Реальный D1, production, точность decimal и интеграция Worker не проверены.

## 26.11.2026 — модельный адаптер и CSV, DCA-20261126-06
- Ветка dev/dca800-foundation, коммит 05f9a1985eb7e433e6e69b84f9fc2c63107f90ee.
- GitHub Actions https://github.com/smoc1983-web/Dca/actions/runs/45843967419, job 139992662919, completed/success. Все шаги baseline, syntax/watchlist и all offline tests пройдены. Всего 23 теста (5+6+7+5); полный модельный цикл TP/STOP на синтетических свечах с комиссией и проскальзыванием, сверка cash/qty/average/PnL, идемпотентность, отказ хранилища/неполная история и безопасное форматирование CSV.
- Новый набор отдельно локально не запускался. Настоящий D1, точная денежная арифметика, атомарность Worker/outbox/ledger, production и исторический бэктест не проверены. Нет деплоя или отправки сообщений.

## 26.11.2026 — денежная точность, DCA-20261126-08
- 5aea2a73cf0814602e08911c53147c30846c2342, https://github.com/smoc1983-web/Dca/actions/runs/45846931316: CI success; 28/28 тестов (23 прежних и 5 новых).
- 5 новых проверок fixed-point (умножение, границы, закрытие, частичные выходы, превышение количества, нереализованный PnL). Биржевые строковые входы, реальные фильтры, атомарность и D1 остаются непроверенными. Production не изменён.

## 26.11.2026 — атомарное хранение, DCA-20261126-09
- 6c659da449907ef4ed6aa288b2dcdb1c73bd3b72, https://github.com/smoc1983-web/Dca/actions/runs/45847829996: CI success; 34/34 теста (28 прежних и 6 новых).
- 6 новых SQLite-тестов, включая откат при отказе outbox, перезапуск и конкуренцию. Production, реальный D1 и миграции не проверялись.

## 26.11.2026 — строковая точность и фильтры, DCA-20261126-10
- 264be2402f74a62070bc0d9a269d6d4745092582, https://github.com/smoc1983-web/Dca/actions/runs/45848195628: completed/success, 40/40 тестов.
- 6 новых тестов; фильтры синтетические, реальный D1 и production не проверены.

## 26.11.2026 — общий бюджет, DCA-20261126-11
- efd4db1559024608324d5b63b9834c21657db129, https://github.com/smoc1983-web/Dca/actions/runs/45848733182: CI completed/success; 47/47 тестов (40 предыдущих + 7 новых).
- 7 новых синтетических тестов pure budget transitions. Настоящий D1, биржевые балансы, персистентные операции и исполнение не проверены.

## 26.11.2026 — ручной цикл, DCA-20261126-12
- 46c114b6068258ea254e6998290c12a5a1829996, https://github.com/smoc1983-web/Dca/actions/runs/45851276462: CI completed/success; 53/53 тестов (47 предыдущих + 6 новых).
- 6 новых синтетических проверок, проекция ручных исполнений, цены сигнала и исполнения. Реальный D1, баланс, транзакционная привязка к резервам и интерфейсы не проверены. Production не изменён.

## 26.11.2026 — постоянный бюджет, DCA-20261126-13
- 9eac11c9236b03a38344cc96889ddbacf7463363, https://github.com/smoc1983-web/Dca/actions/runs/45852434723: CI completed/success; 60/60 тестов (53 прежних и 7 новых).
- 7 новых SQLite-проверок, включая откат записи, конкуренцию и восстановление; реальный D1, баланс, миграция и production не проверены.

## 26.11.2026 — денежные потоки, DCA-20261126-14
- 7b32f9037ca9c5df4fa5f97467fb7b2b0cefd137, https://github.com/smoc1983-web/Dca/actions/runs/45852925486: CI completed/success; 68/68 тестов (60 прежних и 8 новых).
- 8 новых тестов чистого расчёта и SQLite-аудита; реальный биржевой остаток, D1, авторизация и production не проверены.

## 26.11.2026 — сверенное резервирование, DCA-20261126-15
- 19f8d306080a3e9dd4c13776e8e174fcbd80a8c5, https://github.com/smoc1983-web/Dca/actions/runs/45853281871: CI completed/failure; 75 проверок запланировано, новый результат не подтверждён.
- 7 новых SQLite-проверок; реальный биржевой остаток, D1, миграция и production не проверены.

## 26.11.2026 — повторная проверка сверенного резервирования, DCA-20261126-16
- 45853281871: 74/75, неверная тестовая сумма 1600 при пуле 800. Исправлена только фикстура; 731526c617673276073ff4b9691f8939a5148224, https://github.com/smoc1983-web/Dca/actions/runs/45853442532: CI completed/success; 75/75 тестов.

## 26.11.2026 — корректировки ручных исполнений, DCA-20261126-17
- 48916d19cd0b8a0195e1319d40b0de1866f3733d, https://github.com/smoc1983-web/Dca/actions/runs/45854198010: CI completed/success; 82/82 тестов (75 прежних и 7 новых).
- 7 новых SQLite-проверок; реальный D1, миграция, авторизация, реальные сделки/баланс и production не проверены.

## 2026-11-26 — DCA-20261126-18 — Маржинальный калькулятор
- Dev 42b85d3fe3b4bade02b688986ad78152546a985d; исходный 48916d1, 82/82. Добавлены cloudflare/margin-plan.mjs и tests/margin-plan.test.mjs: целое плечо 1–3, неизменный номинал, округление маржи вверх, резерв входных комиссий, последовательные DCA, иллюстративный PnL и стресс после DCA5. Рекомендации всегда отключены; liquidation/maintenance/funding неизвестны. 8 новых тестов, 90 запланировано. CI: in_progress/ожидается; https://github.com/smoc1983-web/Dca/actions/runs/45854464307.
- Следующий шаг: подтвердить CI, затем сценарии нескольких позиций и явные параметры риска. Режим счёта не согласован, реальный D1 не проверен. Production не изменён.

- Итог CI 42b85d3fe3b4bade02b688986ad78152546a985d, https://github.com/smoc1983-web/Dca/actions/runs/45854464307: completed/success, 90/90 тестов (82 прежних + 8 новых), job 140029103284. Реальный счёт, точные ликвидационные формулы, D1 и production не проверены.

## 26.11.2026 — портфельный маржинальный стресс, DCA-20261126-19
- b7db93114b7ca07864fed22b84e8c0f1e3e1f380, https://github.com/smoc1983-web/Dca/actions/runs/45855578770, job 140032928454: completed/success; npm test 98 passed, 0 failed (8 новых). Базовые тесты и синтаксис успешны. Сценарии синтетические, биржевые правила/реальный счёт/D1/production не проверены.

## 26.11.2026 — ручные фьючерсные исполнения, DCA-20261126-20
- 453f24dcff5e63f9e0c16b8bf1deab91fd82ae17, https://github.com/smoc1983-web/Dca/actions/runs/45856001874, job 140034425691: CI completed/success; 106/106 тестов (98 прежних + 8 новых).
- 8 синтетических проверок; постоянное хранилище, биржевые правила, реальный счёт, D1 и production не проверены.

## 26.11.2026 — постоянный фьючерсный журнал, DCA-20261126-21
- 2e4deef906a67845592ec8f5056cb3e9d984af58, https://github.com/smoc1983-web/Dca/actions/runs/45856381456, job 140035737651: completed/success, 114 passed, 0 failed (8 новых); baseline и синтаксис успешны. Node punycode deprecation warning в cleanup, тесты не затронуты. Только SQLite и синтетика; настоящий D1, биржевые правила, авторизация и production не проверены.

## 26.11.2026 — последовательный маржинальный стресс, DCA-20261126-22
- 31767c5d453b9707a237a36d9f95585ff73776be, https://github.com/smoc1983-web/Dca/actions/runs/45856786680, job 140037153328: completed/success, 123 passed, 0 failed (9 новых); базовые тесты/синтаксис успешны. Node punycode warning в cleanup. Синтетические сценарии, частичный START, остановка до/после DCA. Реальные правила биржи, D1, авторизация и production не проверены.

## 26.11.2026 — первый независимый офлайн-бэктест, DCA-20261126-23
- d0fbd82334da86260f068639ea94bcb4aa8824a9, https://github.com/smoc1983-web/Dca/actions/runs/45857421120, job 140039335620: completed/success, 131 passed, 0 failed (8 новых); базовые тесты и синтаксис успешны. Только синтетический однопарный replay; реальные данные, OOS, портфель и рыночная доходность не проверены. Node punycode warning в cleanup. Production не изменён.

## 26.11.2026 — импорт исторических архивов, DCA-20261126-24
- 6d7523222bced5fa7ca30a38dcbb105254fbe416, https://github.com/smoc1983-web/Dca/actions/runs/45858209317, job 140042051323: completed/success, 138 passed, 0 failed (7 новых); baseline и синтаксис успешны. Синтетические ZIP проверены, реальные архивы не получены; месячный формат и 3h отдельно ещё не проверены. Python3 stdlib. Node punycode warning в cleanup. Production не изменён.

## 26.11.2026 — матрица 19 пар, DCA-20261126-25
- fa951e7b863322cb3eba5196e8defbd408de2cdb, https://github.com/smoc1983-web/Dca/actions/runs/45860081918, job 140048512153: completed/success, 146 passed, 0 failed (8 новых); baseline и синтаксис успешны. Синтетика, 228 расчётов; реальная история/OOS/портфель/production не проверены. Node punycode warning в cleanup.

## 26.11.2026 — первый публичный архив, DCA-20261126-27
- 431c80715d000692054997db284db149bb49e184; https://github.com/smoc1983-web/Dca/actions/runs/45860692469, job 140050616844: completed/success, 151 passed, 0 failed (5 новых). https://github.com/smoc1983-web/Dca/actions/runs/45860692497, job 140050617407: completed/success, BTCUSDT 5m 2025-01-01, официальный CHECKSUM проверен, 288 свечей (200 warmup/88 evaluation), 0 сделок, 800->800 USDT; selection-overlap. SHA256 и происхождение в JOURNAL. Не OOS, не реальный общий портфель, не production. Node punycode warning в cleanup.
