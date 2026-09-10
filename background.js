// TV Alert Extender — background script (MV3 event page; Firefox)
//
// Подключается вместе с config.js через "background": { "scripts": [...] },
// поэтому getConfig / DEFAULT_CONFIG из config.js видны напрямую.
//
// ВАЖНО: запросы к pricealerts.tradingview.com делаются НЕ отсюда, а через
// chrome.scripting.executeScript в MAIN-мире открытой вкладки
// www.tradingview.com. Сервер отдаёт
// access-control-allow-origin: https://www.tradingview.com (не wildcard),
// плюс НЕ разрешает кастомные заголовки в CORS-preflight — поэтому запросы
// должны быть "простыми" (без X-Requested-With и т.п.) и уходить именно
// со страницы tradingview.com (там Origin и куки естественные).
//
// Подтверждено реальным трафиком (DevTools → Network):
//   GET https://pricealerts.tradingview.com/list_alerts
//       ?log_username=<username>
//       &maintenance_unset_reason=initial_operated
//       &user_id=<id>
//   Ответ: { "s": "ok", "r": [ <alert>, ... ] }
//   <alert>: { alert_id, symbol("={...}"), resolution, condition, conditions,
//             expiration("...Z"), expiration_policy:{time,policy}, message,
//             sound_file, popup, email, mobile_push, web_hook, active, type, ... }
//   + read-only поля, которые обратно слать нельзя (STRIP_ON_EXTEND ниже).

const TV_TAB_URL_PATTERN = "https://www.tradingview.com/*";
const ALERTS_API = "https://pricealerts.tradingview.com";
const LIST_ALERTS_URL = `${ALERTS_API}/list_alerts`;
const EXTEND_URL = `${ALERTS_API}/modify_restart_alert`;

const ALARM_NAME = "check-alerts";

// Тело modify_restart_alert — строгий whitelist (по реальному запросу).
// list_alerts отдаёт кучу лишних read-only полей — берём только эти.
const EXTEND_FIELDS = [
  "symbol",
  "resolution",
  "message",
  "sound_file",
  "sound_duration",
  "popup",
  "auto_deactivate",
  "email",
  "sms_over_email",
  "mobile_push",
  "web_hook",
  "name",
  "alert_id",
];

chrome.runtime.onInstalled.addListener(() => scheduleAlarm());
chrome.runtime.onStartup.addListener(() => scheduleAlarm());

async function scheduleAlarm() {
  const { checkIntervalMinutes } = await getConfig();
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: checkIntervalMinutes });
  log(`alarm scheduled every ${checkIntervalMinutes} min`);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runCheck().catch((err) => log("runCheck failed: " + err));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "RUN_NOW") {
    runCheck(msg.overrides)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
    return true; // async response
  }
});

async function runCheck(overrides = {}) {
  const cfg = { ...(await getConfig()), ...overrides };

  const tab = await findTradingViewTab();
  if (!tab) {
    notify("Нет открытой вкладки", "Открой www.tradingview.com (залогиненный) и повтори.");
    return { reason: "no-tab", total: 0, expiring: 0, extended: 0 };
  }

  // username / user_id / build_time определяются автоматически со страницы.
  const ctx = await execInPage(tab.id, pageGetContext, []);
  const logUsername = ctx?.username || "";
  const userId = String(ctx?.id || "");
  const buildTime = ctx?.buildTime || "";
  log(
    `ctx: ${logUsername || "?"} / ${userId || "?"} / build_time=${buildTime || "?"} ` +
      `[источник: ${ctx?.source ?? "нет"}]`
  );

  if (!logUsername || !userId) {
    notify(
      "Не удалось определить аккаунт",
      "Открой залогиненный www.tradingview.com и открой панель Alerts, затем повтори."
    );
    return { reason: "no-user", total: 0, expiring: 0, extended: 0 };
  }

  const listParams = {
    log_username: logUsername,
    maintenance_unset_reason: "initial_operated",
    user_id: userId,
  };
  const listRes = await execInPage(tab.id, pageListAlerts, [LIST_ALERTS_URL, listParams]);
  if (!listRes.ok) {
    throw new Error("list_alerts failed: " + listRes.error);
  }

  const alerts = normalizeAlertList(listRes.raw);
  log(`list_alerts: объектов ${alerts.length}, статус "${listRes.raw?.s ?? "?"}"`);

  if (alerts.length === 0) {
    log("RAW list_alerts (обрезано):");
    log(JSON.stringify(listRes.raw)?.slice(0, 20000));
  }

  const byTime = alerts.filter((a) => needsExtension(a, cfg.thresholdDays));
  const triggered = byTime.filter(isTriggeredStop);
  const expiring = byTime.filter((a) => !isTriggeredStop(a));
  log(
    (cfg.thresholdDays > 0
      ? `истёкшие + истекают в ${cfg.thresholdDays} дн.: ${byTime.length}`
      : `уже истёкшие: ${byTime.length}`) +
      ` | к продлению: ${expiring.length}, пропущено (Stopped — Triggered): ${triggered.length}`
  );

  // maxPerRun: 0/undefined = без ограничения. Полезно на первом прогоне.
  const limit = cfg.maxPerRun > 0 ? cfg.maxPerRun : expiring.length;
  const batch = expiring.slice(0, limit);
  if (batch.length < expiring.length) {
    log(`ограничение maxPerRun=${cfg.maxPerRun}: продлеваем ${batch.length} из ${expiring.length}`);
  }

  let extended = 0;
  const failures = [];
  for (const alert of batch) {
    const payload = buildExtendPayload(alert, cfg.extendByDays);
    const res = await execInPage(tab.id, pageExtendAlert, [
      EXTEND_URL,
      { logUsername, buildTime },
      payload,
    ]);
    if (res.ok) {
      extended++;
      log(`продлён ${describeAlert(alert)} → ${res.newExpiration}`);
    } else {
      failures.push(`${describeAlert(alert)}: ${res.error}`);
      log(`НЕ продлён ${describeAlert(alert)}: ${res.error}`);
      log(`  ↳ HTTP ${res.status ?? "?"}, тело ответа: ${res.body ?? "(нет)"}`);
      log(`  ↳ отправляли payload: ${JSON.stringify(payload).slice(0, 2000)}`);
    }
    await sleep(500); // не долбить API подряд
  }

  if (extended > 0) {
    notify("TV Alert Extender", `Продлено: ${extended}` + (failures.length ? `, ошибок: ${failures.length}` : ""));
  } else if (failures.length > 0) {
    notify("TV Alert Extender", `Не удалось продлить: ${failures.length}. Подробности в консоли.`);
  }

  return {
    reason: "ok",
    total: alerts.length,
    expiring: expiring.length,
    attempted: batch.length,
    extended,
    failures,
  };
}

async function findTradingViewTab() {
  const tabs = await chrome.tabs.query({ url: TV_TAB_URL_PATTERN });
  return tabs.find((t) => t.status === "complete") ?? tabs[0] ?? null;
}

// Запуск func в MAIN-мире вкладки (fetch там имеет правильный Origin и куки).
async function execInPage(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return result;
}

// --- Разбор / фильтрация (в background) -----------------------------------

function normalizeAlertList(raw) {
  if (Array.isArray(raw)) return raw;
  const arr = raw?.r ?? raw?.d ?? raw?.data ?? raw?.result ?? raw?.alerts ?? raw?.payload;
  if (Array.isArray(arr)) return arr;
  if (arr && typeof arr === "object") return Object.values(arr);
  return [];
}

// Собирает тело modify_restart_alert из объекта list_alerts —
// строго по форме реального запроса (whitelist + чистка conditions).
function buildExtendPayload(alert, extendByDays) {
  const now = Date.now();
  const newExpiration = new Date(now + extendByDays * 864e5).toISOString(); // с миллисекундами, как в реальном запросе

  const payload = {
    conditions: cleanConditions(alert.conditions),
  };
  for (const k of EXTEND_FIELDS) {
    if (k in alert) payload[k] = alert[k];
  }
  payload.expiration = newExpiration;
  payload.active = true;
  payload.ignore_warnings = true;
  payload.client_id = `update_${now}_${now}`;
  return payload;
}

// В conditions из list_alerts есть поля, которых нет в реальном запросе
// (condition-level cross_interval, inputs.__fast_calc) — убираем.
function cleanConditions(conditions) {
  if (!Array.isArray(conditions)) return conditions;
  return conditions.map((c) => {
    const { cross_interval, ...rest } = c;
    return {
      ...rest,
      series: Array.isArray(c.series)
        ? c.series.map((s) => {
            if (s && s.type === "study" && s.inputs && typeof s.inputs === "object") {
              const { __fast_calc, ...inputs } = s.inputs;
              return { ...s, inputs };
            }
            return s;
          })
        : c.series,
    };
  });
}

function alertExpirationMs(alert) {
  const exp = alert.expiration ?? alert.expiration_policy?.time;
  if (!exp) return NaN;
  return typeof exp === "number" ? (exp < 1e12 ? exp * 1000 : exp) : new Date(exp).getTime();
}

// thresholdDays = 0 → только уже истёкшие (ms в прошлом).
// thresholdDays > 0 → плюс те, что истекут в ближайшие N дней.
function needsExtension(alert, thresholdDays) {
  const ms = alertExpirationMs(alert);
  if (Number.isNaN(ms)) return false;
  return ms < Date.now() + thresholdDays * 864e5;
}

// Алерт остановлен потому, что СРАБОТАЛ ("Stopped — Triggered") — такие
// не восстанавливаем. Отличаем от "Stopped — Expired" (истёк по времени).
function isTriggeredStop(alert) {
  const reason = String(alert.last_stop_reason || "").toLowerCase();
  if (/(fir|trigger|condition|complete)/.test(reason)) return true;
  if (/expir/.test(reason)) return false;
  // остановлен (не активен) и хотя бы раз срабатывал → это триггер, не истечение
  if (alert.active === false && (alert.last_fire_time || alert.last_fire_bar_time)) return true;
  return false;
}

function prettySymbol(alert) {
  const raw = alert.pro_symbol ?? alert.symbol ?? "";
  const m = /"symbol"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : (typeof raw === "string" ? raw.slice(0, 40) : "?");
}

function describeAlert(alert) {
  const id = alert.alert_id ?? alert.id ?? "?";
  const name = alert.message ?? alert.name ?? "без имени";
  const exp = alert.expiration ?? alert.expiration_policy?.time ?? "?";
  return `#${id} ${prettySymbol(alert)} — ${name} (до ${exp})`;
}

function notify(title, message) {
  chrome.notifications?.create({ type: "basic", iconUrl: "icon.png", title, message });
}

function log(msg) {
  console.log("[TV Alert Extender]", msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Выполняется в MAIN-мире страницы tradingview.com --------------------
//     Самодостаточные функции: внешняя область видимости недоступна.

function pageGetContext() {
  const out = { id: null, username: null, buildTime: null, source: null };

  // 1) глобалы страницы — user
  try {
    const candidates = [
      window.user,
      window.initData && window.initData.user,
      window.__initialData && window.__initialData.user,
      window.TVXWidgetUserInfo,
    ];
    for (const u of candidates) {
      if (u && (u.id || u.username)) {
        out.id = u.id ?? u.user_id ?? null;
        out.username = u.username ?? u.name ?? null;
        out.source = "window.user";
        break;
      }
    }
  } catch (_) {}

  // 2) вытащить log_username / user_id / build_time из собственных
  //    запросов сайта к pricealerts (сайт их уже сделал на этой странице).
  try {
    const entries = performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("pricealerts.tradingview.com"))
      .reverse();
    for (const e of entries) {
      const q = new URL(e.name).searchParams;
      if (!out.username && q.get("log_username")) {
        out.username = q.get("log_username");
        out.source = out.source || "performance";
      }
      if (!out.id && q.get("user_id")) {
        out.id = q.get("user_id");
        out.source = out.source || "performance";
      }
      if (!out.buildTime && q.get("build_time")) out.buildTime = q.get("build_time");
    }
  } catch (_) {}

  // 3) build_time из глобалов, если в запросах не нашли
  if (!out.buildTime) {
    try {
      out.buildTime =
        window.TradingView?.buildTime ||
        window.TradingView?.build_time ||
        (window.initData && window.initData.build_time) ||
        null;
    } catch (_) {}
  }

  return out;
}

function pageListAlerts(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  // Простой GET, без кастомных заголовков — иначе CORS-preflight отклонит.
  return fetch(url.toString(), { method: "GET", credentials: "include" })
    .then(async (res) => {
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      if (!res.ok) return { ok: false, error: "HTTP " + res.status, raw: json ?? text };
      return { ok: true, raw: json ?? text };
    })
    .catch((err) => ({ ok: false, error: String(err), raw: null }));
}

function pageExtendAlert(extendUrl, opts, payload) {
  const url = new URL(extendUrl);
  url.searchParams.set("log_username", opts.logUsername);
  url.searchParams.set("maintenance_unset_reason", "initial_operated");
  if (opts.buildTime) url.searchParams.set("build_time", opts.buildTime);

  return fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    // именно text/plain — простой запрос, без preflight
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ payload }),
  })
    .then(async (res) => {
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      const errMsg = json
        ? (json.err?.code || json.errmsg || json.error || json.s || JSON.stringify(json))
        : text;
      if (!res.ok) {
        return { ok: false, status: res.status, body: text.slice(0, 800), error: `HTTP ${res.status} · ${String(errMsg).slice(0, 300)}` };
      }
      if (json && json.s && json.s !== "ok") {
        return { ok: false, status: res.status, body: text.slice(0, 800), error: String(errMsg).slice(0, 300) };
      }
      return { ok: true, status: res.status, newExpiration: payload.expiration };
    })
    .catch((err) => ({ ok: false, error: String(err) }));
}
