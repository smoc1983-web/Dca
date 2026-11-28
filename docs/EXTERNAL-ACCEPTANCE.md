# Приёмка журнала и бюджета DCA800 на выделенной D1

Этапы 01 и 03. Локальная проверка подтверждена на `109e11a`. Для внешней приёмки зафиксируйте SHA сборки из `dev/dca800-foundation`, версию Wrangler и окно проверки. Запуск проводится после отдельного согласования выделенного стенда. [Исходный прогон D1](https://github.com/smoc1983-web/Dca/actions/runs/46095889525)

## Подготовка

1. Создайте отдельный тестовый Worker и две новые D1, по одной на тестовый счёт. Сверьте ID ресурсов и привязок с карточкой стенда до применения схем. В конфигурации используйте `DEV_LEDGER_MODE=synthetic`, `cloudflare/development-ledger.mjs` и выделенные привязки с префиксом `DEV_LEDGER_DB_`. Вход в Worker ограничьте тестовым адресом за Cloudflare Access. Отключите `workers_dev`, `preview_urls` и cron. Достаточно HTTP-обработчика журнала. Пример `cloudflare/wrangler.example.json` относится к другому обработчику.
2. На каждой пустой D1 последовательно примените `trade-ledger-schema.sql`, `development-ledger-account-schema.sql`, `budget-store-schema.sql`, `cash-store-schema.sql` из каталога `cloudflare`. Вставьте единственную отметку владельца параметризованной командой `INSERT INTO dev_ledger_account(singleton,account_id) VALUES(1,?)`. Значение должно совпасть с `id` соответствующего тестового счёта. Схемы отделены от рабочих моделей и истории. Перезапуск прогона с чистого листа требует новой пустой D1. [Документация D1](https://developers.cloudflare.com/d1/build-with-d1/)
3. Для каждого счёта создайте отдельный временный токен из 32 случайных байт в base64url без заполнения. Каждый элемент каталога включает `id`, `binding`, `token`, `budgeted: true` и `canWrite` (`true` для A и `false` для B). Храните каталог как JSON в секрете `DEV_LEDGER_ACCOUNTS_JSON`. В отдельной точке входа стенда разберите секрет и передайте массив как `DEV_LEDGER_ACCOUNTS`. Обработчик проверяет массив и при пустой или недопустимой конфигурации возвращает 503. Ключи доступа к стенду, токены и временные конфигурации хранятся вне Git. [Секреты Worker](https://developers.cloudflare.com/workers/configuration/secrets/)
4. В локальном конфиге администратора укажите только новую D1 счёта A через `remote: true` и её точный `database_id`. Используйте учётные данные для согласованного стенда. Каталог привязок внешнего Worker и локальный конфиг должны указывать на одну и ту же тестовую D1 для счёта A. [Удалённые привязки](https://developers.cloudflare.com/workers/development-testing/#remote-bindings) · [Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)

Временная точка входа в корне тестовой копии преобразует секрет в массив и подключает проверенный обработчик.

```js
import ledger from './cloudflare/development-ledger.mjs';

export default {
  fetch(request, env) {
    let accounts;
    try {
      accounts = JSON.parse(env.DEV_LEDGER_ACCOUNTS_JSON);
    } catch {
      accounts = [];
    }
    return ledger.fetch(request, {...env, DEV_LEDGER_ACCOUNTS: accounts});
  },
};
```

## Прогон

Сначала выполните локальную репетицию той же версии кода через `npm run check`, `npm test` и `node scripts/check-development-trade-cycle.mjs` с Miniflare из CI. На внешнем стенде до записи вызовите `GET /ledger/budget` под обоими токенами. Каждый ответ должен содержать только свой `accountId`, ревизии `budgetRevision: null`, `ledgerRevision: 0`, `cashRevision: 0` и `Cache-Control: no-store`. При сомнении в привязке остановите прогон.

Для полного цикла используйте `runTradeCycleAcceptance` из [скрипта приёмки](../scripts/run-trade-cycle-acceptance.mjs). Функция принимает D1 счёта A, его ID, HTTP-транспорт и функцию повторного открытия привязки. В Node после установки Wrangler схема вызова выглядит так. Все аргументы конфигурации выдаются оператору через защищённые средства.

```js
import {getPlatformProxy} from 'wrangler';
import {runTradeCycleAcceptance} from './scripts/run-trade-cycle-acceptance.mjs';

function setting(name) {
  const value = process.env['DCA_ACCEPTANCE_' + name];
  if (!value) throw Error('Missing acceptance setting ' + name);
  return value;
}
const origin = new URL(setting('ORIGIN'));
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw Error('Expected the approved HTTPS origin of the test Worker');
}
const headers = {
  Authorization: 'Bearer ' + setting('TOKEN'),
  'CF-Access-Client-Id': setting('ACCESS_ID'),
  'CF-Access-Client-Secret': setting('ACCESS_SECRET'),
};
const request = (path, body) => fetch(new URL(path, origin), {
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
  ...(body ? {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {headers}),
});
const open = () => getPlatformProxy({
  configPath: setting('WRANGLER_CONFIG'),
  remoteBindings: true,
  persist: false,
});
const binding = setting('D1_BINDING');
const accountId = setting('ACCOUNT_ID');
let platform = await open();
try {
  const reconnect = async () => {
    const previous = platform;
    platform = null;
    await previous.dispose();
    platform = await open();
    return platform.env[binding];
  };
  const result = await runTradeCycleAcceptance({
    db: platform.env[binding], accountId, request, reconnect,
  });
  console.log(JSON.stringify(result));
} finally {
  await platform?.dispose();
}
```

Сценарий выполняет резервирование, завершение ступеней и сверку через штатные хранилища, а пять исполнений — через защищённый HTTP. Повторное открытие привязки проверяет сохранность в D1 после разрыва клиентской сессии. Перезапуск облачного Worker этой проверкой не подтверждается.

## Критерии приёмки

| Проверка | Ожидаемый результат |
| --- | --- |
| Изоляция | Каждый токен видит только свой `accountId`, а счёт B остаётся пустым до и после цикла. При действующем пропуске Cloudflare Access запрос без токена счёта получает 401, запись от B — 403. |
| Резерв | Из 800 USDT удержано 520,05078125 USDT, свободный лимит 279,94921875 USDT. Частичные START не продвигают ступень до подтверждения. |
| Частичная продажа и закрытие | После частичного выхода остаются 0,3 единицы и себестоимость 29,27925 USDT. Удержание сохраняется после закрытия до подтверждения отмены оставшихся ордеров и нового наблюдения. |
| Освобождение | Сверка завершена, резерв равен 0 USDT, прибыль после комиссий 4,917 USDT, остаток 804,917 USDT. Лимит бюджета равен 800 USDT. |
| Повтор и конфликт | Повтор после нового подключения не добавляет исполнений. Изменение тела сохранённого запроса с тем же `opId` получает 409. Бюджет, журнал и остаток остаются на тех же ревизиях. |

Запишите только SHA, версию Wrangler, время, результаты проверок, синтетические контрольные суммы и статусы HTTP. Публикуйте в `JOURNAL.md` итоги без конфигов, токенов, выписок и содержимого служебных запросов. При расхождении сохраните частный отчёт, ограничьте доступ к тестовому Worker и разберите причину до нового запуска. После приёмки закройте доступ и отзовите временные токены.

Подтверждение исправлений и откат при искусственном сбое остаются отдельными проверками из [локального сценария доступа](../scripts/check-development-ledger-access.mjs). Эта процедура проверяет запись в удалённой D1 и работу выделенного HTTP-маршрута на синтетических данных. Миграция реальных данных, допуск рабочего Worker и проверка доставки оформляются отдельно.
