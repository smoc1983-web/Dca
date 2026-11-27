# Аудит экстремальных цен ATOM и ADA — 27.11.2026
[CI 45954482725](https://github.com/smoc1983-web/Dca/actions/runs/45954482725), job 140357672866, commit 4ae26baad17010b07a9c6b4e7e780d08234b55ab. 8 daily ZIP Binance, CHECKSUM verified, 288 свечей на серию, pinned spot совпал. Полные OHLC и SHA256 в price-series-audit-2026-11-27-summary.json.

| Пара | UTC начала 5m | Spot low | Futures trade low | Mark low | Index low |
|---|---|---:|---:|---:|---:|
| ATOMUSDT | 2025-10-10T21:20:00.000Z | 0.001 | 1.46 | 1.50447 | 1.55961143 |
| ADAUSDT | 2025-02-03T02:05:00.000Z | 0.506 | 0.5092 | 0.5136 | 0.51517333 |

Spot ATOM 0.001 — подтверждённый архивный low, не ошибочное число. Mark low 1.50447, spot low ниже mark low примерно в 1504.47 раза. ADA spot low 0.506, mark low 0.5136. Первые остановки прежнего proxy были по reserve deficit, не по подтверждённой ликвидации. Нельзя считать устранёнными остановки, пока не выполнен новый полный risk overlay на непрерывных mark series всех 11 пар. Не заменять только две свечи задним числом, не удалять спотовые данные и не менять рабочие сигналы. Сравнивать фиксированные spot fills с отдельно проверенными futures marks, funding/fees и правила остаются условными. Не OOS, не Walt, не реальные цены ликвидации.
