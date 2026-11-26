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
