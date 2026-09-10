# TV Alert Extender

Firefox-расширение, которое автоматически продлевает истекающие алерты
TradingView через внутренний API — чтобы не платить за Premium ради
одной функции "бессрочный алерт".

## Контекст задачи (коротко, для быстрого ввода в курс — в т.ч. в Claude Code)

TradingView не даёт делать алерты бессрочными ниже тарифа Premium —
алерт живёт максимум ~2 месяца, дальше нужно вручную продлевать.
Апгрейд тарифа ради этого невыгоден. Решение — расширение, которое само
дёргает внутренний (недокументированный) API TradingView через уже
залогиненную в браузере сессию.

### Что уже подтверждено реальным трафиком (DevTools → Network)

- Эндпоинт продления:
  `POST https://pricealerts.tradingview.com/modify_restart_alert`
  с query-параметрами `log_username`, `maintenance_unset_reason=initial_operated`, `build_time`.
- Тело запроса — **полный объект алерта целиком** (`conditions`, `symbol`,
  `resolution`, `message`, `sound_file`, `popup`, `email`, `mobile_push`,
  `web_hook`, `alert_id` и т.д.), обёрнутый в `{"payload": {...}}`.
  Продление = переотправка того же объекта с новым `expiration` и новым
  `client_id` (формат `update_<Date.now()>_<Date.now()>`, это не секрет,
  просто метка запроса).
- `Content-Type: text/plain;charset=UTF-8` — намеренно не
  `application/json`, чтобы избежать CORS-preflight.
- Ответ сервера содержит `access-control-allow-origin: https://www.tradingview.com`
  (НЕ wildcard) — значит запрос обязан идти именно с этим Origin.
  Поэтому фетч выполняется не из background-скрипта расширения (там
  Origin был бы `moz-extension://...` → 403), а инжектится через
  `chrome.scripting.executeScript` прямо в открытую вкладку
  `www.tradingview.com` — там Origin и куки естественные,
  `credentials: "include"` без ручного вытаскивания кук.
- Реальный пойманный пример (alert_id 5308487987, BATS:AMZN,
  Stochastic 14/1/3, expiration продлён примерно на 30 дней) уже
  учтён в коде `pageExtendAlert()`.

### Список алертов — ПОДТВЕРЖДЁН (DevTools → Network, 10.09.2026)

```
GET https://pricealerts.tradingview.com/list_alerts
    ?log_username=<username>
    &maintenance_unset_reason=initial_operated
    &user_id=<id>
```

Простой GET, **без кастомных заголовков** (`X-Requested-With` ловит
CORS-preflight и запрос отклоняется). Ответ:

```
{ "s": "ok", "r": [ <alert>, ... ] }
```

Форма `<alert>` (сокращённо): `alert_id`, `symbol`
(`={"adjustment":"splits","currency-id":"USD","symbol":"BATS:TSM"}`),
`resolution`, `condition`, `conditions`, `expiration`,
`expiration_policy`, `message`, `sound_file`, `sound_duration`, `popup`,
`auto_deactivate`, `email`, `sms_over_email`, `mobile_push`, `web_hook`,
`name`, `active`, `type`, `last_stop_reason`, `last_fire_time`,
`presentation_data`, `kinds`, `pro_symbol`, …

### Продление — ПОДТВЕРЖДЕНО реальным запросом (Restart в UI, 10.09.2026)

```
POST https://pricealerts.tradingview.com/modify_restart_alert
     ?log_username=<username>
     &maintenance_unset_reason=initial_operated
     &build_time=<build_time сайта, напр. 2026-09-09T09:00:09>
Content-Type: text/plain;charset=UTF-8
{ "payload": { ...строгий whitelist полей... } }
```

Тело — **НЕ весь объект из list_alerts**, а whitelist (см.
`EXTEND_FIELDS` + `buildExtendPayload` в `background.js`):
`conditions` (без condition-level `cross_interval` и без
`inputs.__fast_calc`), `symbol`, `resolution`, `message`, `sound_file`,
`sound_duration`, `popup`, `auto_deactivate`, `email`, `sms_over_email`,
`mobile_push`, `web_hook`, `name`, `alert_id`, `expiration` (новая, ISO
**с миллисекундами**), `active: true`, `ignore_warnings: true`,
`client_id: "update_<ms>_<ms>"`.

`username` / `user_id` / `build_time` определяются автоматически
(`pageGetContext`): из `window.user` на странице, иначе парсятся из
собственных запросов сайта к `pricealerts.tradingview.com`
(`performance.getEntriesByType("resource")`). Ручных настроек нет.

Первый прогон стоит делать с полем «Продлить за раз» = 1 и смотреть
фоновую консоль (`about:debugging` → Inspect у расширения).

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
- `popup.html` / `popup.js` — кнопка "Проверить и продлить сейчас",
  поле «Продлить за раз», статус, ссылка на настройки.
- `options.html` / `options.js` — пороги, интервал, `maxPerRun`.
- `icon.png` — плейсхолдер-иконка.

## Как загрузить в Firefox (временно, для теста)

1. `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on" → выбрать `manifest.json`
3. Открой tradingview.com в этом же Firefox, залогинься, открой панель
   Alerts (иконка будильника справа). Аккаунт настраивать не нужно.
4. Иконка расширения → в поле «Продлить за раз» поставь `1` →
   **Проверить и продлить сейчас**. Проверь в фоновой консоли, что
   `modify_restart_alert` вернул `{s:"ok"}` и алерт снова `Active`.
5. Дальше ставь `0` (все) — либо просто жди суточный alarm.
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
- `maxPerRun` (дефолт 0 = все) ограничивает число продлений за прогон;
  в popup есть отдельное поле «Продлить за раз» для ручного запуска
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
