const runBtn = document.getElementById("runBtn");
const dryRunBtn = document.getElementById("dryRunBtn");
const limitEl = document.getElementById("limit");
const statusEl = document.getElementById("status");

document.getElementById("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

runBtn.addEventListener("click", () => {
  const maxPerRun = Math.max(0, Number(limitEl.value) || 0);
  run({ dryRun: false, maxPerRun });
});
dryRunBtn.addEventListener("click", () => run({ dryRun: true }));

function run(overrides) {
  runBtn.disabled = true;
  dryRunBtn.disabled = true;
  statusEl.textContent = overrides.dryRun ? "Dry run: собираю список..." : "Проверяю алерты...";

  chrome.runtime.sendMessage({ type: "RUN_NOW", overrides }, (response) => {
    runBtn.disabled = false;
    dryRunBtn.disabled = false;

    if (chrome.runtime.lastError || !response) {
      statusEl.textContent = "Нет ответа от background script.\n" + (chrome.runtime.lastError?.message ?? "");
      return;
    }
    if (!response.ok) {
      statusEl.textContent = "Ошибка: " + response.error;
      return;
    }

    const r = response.result;
    if (r.reason === "no-tab") {
      statusEl.textContent = "Открой www.tradingview.com (залогиненный) в этом же браузере и повтори.";
      return;
    }
    if (r.reason === "no-user") {
      statusEl.textContent =
        "Не удалось определить аккаунт TradingView.\nОткрой залогиненный www.tradingview.com, открой панель Alerts и повтори.";
      return;
    }

    let text =
      `Всего алертов: ${r.total}\n` +
      `К продлению: ${r.expiring}\n` +
      (r.attempted != null && r.attempted < r.expiring ? `Взято за прогон: ${r.attempted}\n` : "") +
      `Продлено: ${r.extended}`;

    if (r.reason === "dry-run") {
      text =
        `DRY RUN\nВсего алертов: ${r.total}\n` +
        `К продлению: ${r.expiring}` +
        (r.skippedTriggered ? `\nПропущено (сработавшие): ${r.skippedTriggered}` : "");
      if (r.wouldExtend?.length) text += "\n\nБудет продлено:\n- " + r.wouldExtend.join("\n- ");
      if (r.total === 0) text += "\n\nСписок пуст — проверь консоль расширения:\nсырой ответ list_alerts выведен туда.";
    }
    if (r.failures?.length) {
      text += `\n\nОшибки (${r.failures.length}):\n- ` + r.failures.join("\n- ");
    }

    statusEl.textContent = text;
  });
}
