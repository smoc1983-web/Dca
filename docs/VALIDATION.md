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
