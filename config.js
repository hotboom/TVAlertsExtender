// Общие настройки расширения. Значения по умолчанию + чтение/запись в
// chrome.storage.sync. Классический скрипт (не модуль): подключается
// первым в background.scripts и через <script src> в popup/options,
// имена ниже видны в общей глобальной области.
//
// username / user_id НЕ хранятся — определяются автоматически со страницы
// tradingview.com (см. pageGetUser в background.js).

const DEFAULT_CONFIG = {
  // Продлевать уже истёкшие + те, что истекут в ближайшие N дней.
  // 0 = только уже истёкшие.
  thresholdDays: 5,
  extendByDays: 30, // на сколько дней продлевать
  checkIntervalMinutes: 1440, // как часто проверять (alarm)
  maxPerRun: 0, // 0 = без ограничения; иначе не больше N продлений за прогон
  dryRun: false, // true — только показать, что было бы продлено, без запросов на продление
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

async function setConfig(patch) {
  await chrome.storage.sync.set(patch);
}
