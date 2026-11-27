# Исторический Mark Price risk overlay — 27.11.2026
[CI 45958961984](https://github.com/smoc1983-web/Dca/actions/runs/45958961984), job 140372621716, commit 1289a90306b18aeddc4a2f0460e71cc28c1aa2e7. 11 пар, 01.02.2025–31.10.2026 UTC, 1443 pinned spot fills. Источник риска: Binance USD-M Mark Price, агрегация к исходным TF. Все 231 месячных ZIP и 11 дневных repairs проверены по CHECKSUM; 3168 отсутствующих строк восстановлено без интерполяции, перекрытия проверены. Полный provenance и 24 результата в JSON.

| Пара | TF | Свечи | Пропуски monthly | Daily repairs |
|---|---|---:|---:|---:|
| BTCUSDT | 5m | 183744 | 288 | 1 |
| UNIUSDT | 15m | 61248 | 288 | 1 |
| ZECUSDT | 5m | 183744 | 288 | 1 |
| ATOMUSDT | 5m | 183744 | 288 | 1 |
| DOTUSDT | 30m | 30624 | 288 | 1 |
| ADAUSDT | 5m | 183744 | 288 | 1 |
| LDOUSDT | 30m | 30624 | 288 | 1 |
| DOGEUSDT | 15m | 61248 | 288 | 1 |
| XRPUSDT | 45m | 20416 | 288 | 1 |
| TRXUSDT | 15m | 61248 | 288 | 1 |
| LINKUSDT | 5m | 183744 | 288 | 1 |

| Номинал | Плечо | Ответ | Статус | События | Циклы | Пополнено USDT | Доходность % | Close DD % | Первая причина |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| fixed-notional | 1 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 1 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 1 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 1 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 2 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 2 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 2 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 2 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 3 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 3 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 3 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| fixed-notional | 3 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| scaled-notional | 1 | none | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| scaled-notional | 1 | next-close | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| scaled-notional | 1 | two-closes | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| scaled-notional | 1 | reject | completed-fixed-schedule | 1443/1443 | 508 | 0.00 | 26.13736 | 8.55786 | — |
| scaled-notional | 2 | none | stopped-at-proxy-risk | 752/1443 | 264 | 0.00 | — | 16.19323 | PROXY_RESERVE_DEFICIT UNIUSDT 2025-10-10T21:29:59.999Z |
| scaled-notional | 2 | next-close | stopped-at-proxy-risk | 752/1443 | 264 | 8.00 | — | 16.19323 | PROXY_RESERVE_DEFICIT UNIUSDT 2025-10-10T21:29:59.999Z |
| scaled-notional | 2 | two-closes | stopped-at-proxy-risk | 752/1443 | 264 | 7.00 | — | 16.19323 | PROXY_RESERVE_DEFICIT UNIUSDT 2025-10-10T21:29:59.999Z |
| scaled-notional | 2 | reject | stopped-at-proxy-risk | 752/1443 | 264 | 0.00 | — | 16.19323 | PROXY_RESERVE_DEFICIT UNIUSDT 2025-10-10T21:29:59.999Z |
| scaled-notional | 3 | none | stopped-at-proxy-risk | 23/1443 | 0 | 0.00 | — | 20.92550 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | next-close | stopped-at-proxy-risk | 23/1443 | 0 | 15.31 | — | 20.92550 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | two-closes | stopped-at-proxy-risk | 23/1443 | 0 | 14.00 | — | 20.92550 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |
| scaled-notional | 3 | reject | stopped-at-proxy-risk | 23/1443 | 0 | 0.00 | — | 20.92550 | PROXY_RESERVE_DEFICIT ADAUSDT 2025-02-03T02:09:59.999Z |

16/24 полных путей: fixed ×1/2/3 и scaled ×1: +26.13736%, DD 8.55786%, 508 циклов, 0 topups. Scaled ×2: 752 событий/264 закрытия, UNI DCA4, reserve deficit 11.4622593 USDT, mark low 2.2981619; ранее spot proxy ATOM. Scaled ×3: 23 событий/0 закрытий, ADA DCA4, reserve deficit 2.2245264 USDT, mark low 0.5136; next-close добавлено 15.31, pending 6.28; two-closes 14.00. Все 8 остановок — дефицит резерва, не maintenance breach; итоговая доходность null. При фиксированном номинале одинаковый залог и одинаковый размер позиции дают одинаковый PnL. Условный slot 140, pool 100, cap 20, 800 USDT, target 10, adverse 20%, fees/funding/maintenance синтетические. Не проверены фактическая цена исполнения фьючерсов, exchange tiers, historical funding, Walt, OOS. Не доказана реальная ликвидация или безопасность плеча. Следующий шаг: sensitivity ограниченного залога/резерва и задержек, учитывать отдельно minimum maintenance и reserve deficit, не оптимизировать на этой же истории без OOS. Production не изменён.
