// config.js подключён раньше в options.html — DEFAULT_CONFIG/getConfig/setConfig
// доступны из общей глобальной области.

const fields = ["thresholdDays", "extendByDays", "maxPerRun", "checkIntervalMinutes"];
// поля, где допустим 0
const zeroOk = new Set(["thresholdDays", "maxPerRun"]);
// минимально допустимые значения
const minValue = { extendByDays: 1, checkIntervalMinutes: 15 };

async function load() {
  const cfg = await getConfig();
  for (const f of fields) document.getElementById(f).value = cfg[f];
}

async function save() {
  const patch = {};
  for (const f of fields) {
    const n = Number(document.getElementById(f).value.trim());
    const floor = zeroOk.has(f) ? 0 : (minValue[f] ?? 1);
    patch[f] = Number.isFinite(n) && n >= floor ? Math.floor(n) : DEFAULT_CONFIG[f];
  }

  await setConfig(patch);

  // перепланировать alarm под новый интервал
  chrome.alarms.create("check-alerts", { periodInMinutes: patch.checkIntervalMinutes });

  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
