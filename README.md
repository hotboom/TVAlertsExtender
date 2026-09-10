# TV Alert Extender

Firefox-расширение, которое автоматически продлевает истекающие алерты
TradingView через внутренний API — чтобы не платить за Premium ради
одной функции "бессрочный алерт".

TradingView не даёт делать алерты бессрочными ниже тарифа Premium —
алерт живёт максимум ~2 месяца, дальше его нужно вручную продлевать.
Расширение раз в сутки само дёргает внутренний API TradingView через
уже залогиненную в браузере сессию и продлевает всё, что скоро истечёт
или уже истекло.

Запросы к `pricealerts.tradingview.com` выполняются не из background
(там Origin был бы `moz-extension://…` → 403), а инжектятся через
`chrome.scripting.executeScript` в **MAIN-мир** открытой вкладки
`www.tradingview.com` — там Origin и куки сессии естественные.
`Content-Type: text/plain` и отсутствие кастомных заголовков — чтобы
не ловить CORS-preflight (сервер его не разрешает).

## Структура проекта

- `manifest.json` — MV3, `background.scripts` = `[config.js, background.js]`
  (не service worker — Firefox его не поддерживает; и не модули —
  скрипты делят общую глобальную область). `strict_min_version: 128`
  (нужно для `world: "MAIN"` в `scripting.executeScript`). permissions:
  `storage`, `alarms`, `notifications`, `scripting`, `tabs`;
  host_permissions на `www.tradingview.com` и `pricealerts.tradingview.com`.
- `config.js` — дефолты + чтение/запись настроек в `chrome.storage.sync`
  (`thresholdDays`, `extendByDays`, `maxPerRun`, `checkIntervalMinutes`).
  Аккаунт (username / user_id) здесь НЕ хранится — берётся со страницы.
- `background.js` — вся логика: alarm по интервалу, поиск открытой
  вкладки tradingview.com, инжект `pageListAlerts`/`pageExtendAlert`
  в её **MAIN-мир** через `executeScript` (чтобы `fetch` шёл с
  `Origin: https://www.tradingview.com` и куками сессии).
- `popup.html` / `popup.js` — кнопка "Проверить и продлить сейчас"
  (использует лимит `maxPerRun` из настроек), статус, ссылка на настройки.
- `options.html` / `options.js` — пороги, интервал, `maxPerRun`.
- `icon.png` — плейсхолдер-иконка.

## Настройки

Открываются из popup → «Настройки» (или `about:addons` → «Параметры»).
Хранятся в `chrome.storage.sync`, значения по умолчанию — в `config.js`.

| Настройка | По умолч. | Что делает |
|---|---|---|
| **Запас до истечения (дней)** — `thresholdDays` | `5` | Продлевать алерт, если он уже истёк или истечёт в ближайшие N дней. `0` — только уже истёкшие. |
| **Продлевать на (дней)** — `extendByDays` | `30` | Новый срок жизни: `сейчас + N дней`. |
| **Максимум продлений за один прогон** — `maxPerRun` | `0` | Ограничитель на один запуск (и alarm, и ручной). `0` — без лимита. Полезно `1` на первый прогон. |
| **Интервал автопроверки (минут)** — `checkIntervalMinutes` | `1440` | Период `chrome.alarms`. 1440 = раз в сутки. Применяется со следующего запуска расширения. |

Аккаунт (`log_username` / `user_id`) и `build_time` в настройках
**отсутствуют** — определяются автоматически со страницы TradingView
(`pageGetContext`).

## Как загрузить в Firefox (временно, для теста)

1. `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on" → выбрать `manifest.json`
3. Открой tradingview.com в этом же Firefox, залогинься, открой панель
   Alerts (иконка будильника справа). Аккаунт настраивать не нужно.
4. (Опц.) Иконка → **Настройки** → `maxPerRun` = 1 для первого прогона.
5. Иконка расширения → **Проверить и продлить сейчас**. Проверь в
   фоновой консоли, что `modify_restart_alert` вернул `{s:"ok"}` и
   алерт снова `Active`. Потом верни `maxPerRun` = 0 (все).
6. Логи: `about:debugging` → "Inspect" у расширения → вкладка Console
   (всё через `console.log("[TV Alert Extender]", ...)`)

(Temporary Add-on слетает при перезапуске Firefox — для постоянной
установки нужно подписать через AMO или включить
`xpinstall.signatures.required = false` в Firefox Developer/ESR.)

## Логика работы

- По интервалу (`checkIntervalMinutes`, дефолт 1440 = раз в сутки)
  срабатывает `chrome.alarms`
- Ищет открытую вкладку `www.tradingview.com`, определяет аккаунт
- В её MAIN-мире запрашивает `list_alerts`
- Отбирает алерты по времени: уже истёкшие + те, что истекут в
  ближайшие `thresholdDays` дней (дефолт 5; `0` = только истёкшие)
- Из них **исключает «Stopped — Triggered»** (сработавшие) —
  `isTriggeredStop()`: `last_stop_reason` про firing, либо
  `active === false && last_fire_time`. Остаются «Stopped — Expired»
  и активные, которым скоро конец
- Для каждого собирает whitelist-payload (`buildExtendPayload`) и шлёт
  `modify_restart_alert` с новым `expiration` (+`extendByDays`, дефолт
  30), пауза 500 мс между запросами
- `maxPerRun` (дефолт 0 = все) ограничивает число продлений за прогон —
  и для alarm, и для ручного запуска из popup
- Шлёт системное уведомление, сколько продлено / сколько ошибок
- Ручной запуск кнопкой в popup — без ожидания alarm

## Статус

Работает. Прогон 10.09.2026: из 27 продлено 25, `modify_restart_alert`
отвечает `200 {s:"ok"}`, `expiration` сдвигается, алерты снова `Active`.

2 отказа — `{"s":"error","err":{"code":"max_complex_alerts_count_exceeded"}}`:
это **лимит тарифа TradingView** на число активных indicator-алертов, не
баг. Расширение продлевает всё, что влезает в квоту; лишнее физически
не может быть активным на текущем тарифе.

## Оставшиеся TODO в коде

- Проверить не-Stochastic алерты (чистая цена, %change) — вдруг
  `conditions` у них другой формы и `cleanConditions` что-то ломает.
- `icon.png` — заменить плейсхолдер.
