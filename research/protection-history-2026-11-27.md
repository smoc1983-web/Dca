# Историческое сравнение защитной маржи — 27.11.2026
Источник: [CI 45952480246](https://github.com/smoc1983-web/Dca/actions/runs/45952480246), job 140351284258, commit 215246e2414c3ca9112d17df5635bd9c1b54e771. Все 24 строки извлечены из PROTECTION_PROXY в логах. 11 пар, 01.02.2025–31.10.2026 UTC, 1443 фиксированных spot fills, 800 USDT, 5×140 + 100, cap 20/цикл, 2 bps, условные funding 0.01%, maintenance 0.5%, fee 0.1%.

| Номинал | Плечо | Ответ | Статус | События | Циклы | Добавлено USDT | Пик залога | Доходность % | Close DD % | Первая причина |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| fixed-notional | 1 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 1 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 1 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 1 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 2 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 2 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 2 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 2 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 3 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 3 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 3 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| fixed-notional | 3 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| scaled-notional | 1 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| scaled-notional | 1 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| scaled-notional | 1 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| scaled-notional | 1 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 0.00 | 26.1505 | 8.5452 | — |
| scaled-notional | 2 | none | stopped-at-proxy-risk | 752/1443 | 264 | 0.00 | 0.00 | — | 15.7375 | PROXY_RESERVE_DEFICIT ATOMUSDT 2025-10-10T21:24:59.999Z |
| scaled-notional | 2 | next-close | stopped-at-proxy-risk | 752/1443 | 264 | 8.00 | 8.00 | — | 15.7375 | PROXY_RESERVE_DEFICIT ATOMUSDT 2025-10-10T21:24:59.999Z |
| scaled-notional | 2 | two-closes | stopped-at-proxy-risk | 752/1443 | 264 | 7.00 | 7.00 | — | 15.7375 | PROXY_RESERVE_DEFICIT ATOMUSDT 2025-10-10T21:24:59.999Z |
| scaled-notional | 2 | reject | stopped-at-proxy-risk | 752/1443 | 264 | 0.00 | 0.00 | — | 15.7375 | PROXY_RESERVE_DEFICIT ATOMUSDT 2025-10-10T21:24:59.999Z |
| scaled-notional | 3 | none | stopped-at-proxy-risk | 23/1443 | 0 | 0.00 | 0.00 | — | 20.9307 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | next-close | stopped-at-proxy-risk | 23/1443 | 0 | 16.56 | 16.56 | — | 20.9307 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | two-closes | stopped-at-proxy-risk | 23/1443 | 0 | 15.54 | 15.54 | — | 20.9307 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | reject | stopped-at-proxy-risk | 23/1443 | 0 | 0.00 | 0.00 | — | 20.9307 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |

16/24 завершили фиксированный путь, 8/24 остановились. Fixed nominal ×1/2/3 и scaled ×1: +26.15046%, DD 8.54517%, 508 закрытых, 0 пополнений. Scaled ×2: все 4 остановились на ATOM DCA4, 752/1443, 264 закрытых, дефицит 30.04814 USDT, spot low 0.001 (экстремальная свеча, отдельно проверить качество и futures mark). Пополнено 8/7 USDT в next/two close; остановка не отложена. Scaled ×3: все 4 остановились на ADA DCA4, 23/1443, 0 закрытых, дефицит 3.51461; пополнено 16.56/15.54 USDT, pending 6.10 в next-close. Ни одна остановка не является подтверждённой ликвидацией; причина во всех 8 — reserve deficit, а не maintenance breach. При остановке итоговая доходность null; DD только до остановки, не сравнивать как полный период. Пополнения ранее могли быть в иных циклах; не интерпретировать накопительную сумму как защиту конкретной позиции. Плечо при фиксированном номинале и полном выделении базового залога не меняет PnL, модель не проверяет реальные ограничения эффективного плеча. Funding прежний условный календарь, не фактическая история. Нет OOS и разрешения на сделки. Нужен отдельный sensitivity к cap/pool, проверка экстремального low и фактического mark, экономически корректное сравнение залога; не оптимизировать правила по этим результатам без нового периода.
