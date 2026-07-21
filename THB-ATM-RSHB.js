// Variables used by Scriptable.
// icon-color: deep-green; icon-glyph: baht-sign;
//
// thb-atm-rshb v3 — стоимость снятия THB в Таиланде с UnionPay РСХБ.
// Shortcuts input: "rub 30000" или "cny 30000".
// Дополнительно: "refresh" (обновить кэш), "json" (вернуть JSON).

const SETTINGS = {
  THAI_ATM_FEE_THB: 250,
  UNIONPAY_CACHE_MS: 6 * 60 * 60 * 1000,
  RSHB_CACHE_MS: 15 * 60 * 1000,
  MAX_STALE_MS: 7 * 24 * 60 * 60 * 1000,
  CACHE_FILE: "thb-atm-rshb-v5-thailand-cache.json",
  UNIONPAY_DAILY_URL: "https://www.unionpayintl.com/upload/jfimg",
  RSHB_FOREIGN_CARD_RATES_URL: "https://www.rshb.ru/api/v1/temporaryRates",
  RSHB_APP_RATES_URL: "https://www.rshb.ru/api/v1/ratescards",
  FEES: {
    rub: { percent: 0.015, minimum: 250, currency: "RUB" },
    cny: { percent: 0.04, minimum: 70, currency: "CNY" },
  },
};

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), SETTINGS.CACHE_FILE);

await main();

async function main() {
  const shortcutInput = args.shortcutParameter;
  const rawInput = config.runsInWidget ? args.widgetParameter : shortcutInput;
  const input = parseInput(rawInput);
  let card = input.card;
  let withdrawalThb = input.withdrawalThb;

  if (!config.runsInWidget && (shortcutInput === undefined || shortcutInput === null)) {
    card = await chooseCard();
    if (!card) return;
    withdrawalThb = await askWithdrawalAmount();
    if (!withdrawalThb) return;
  }

  if (!card || !(withdrawalThb > 0)) {
    const message = "Укажите карту и сумму: rub 30000 или cny 30000.";
    await finishWithError(message, config.runsInWidget, shortcutInput !== undefined && shortcutInput !== null);
    return;
  }

  try {
    const rates = await loadRates(input.refresh, card);
    const result = calculate(card, withdrawalThb, rates);
    if (config.runsInWidget) {
      Script.setWidget(buildWidget(result));
    } else if (shortcutInput !== undefined && shortcutInput !== null) {
      Script.setShortcutOutput(input.json ? JSON.stringify(result.json) : result.text);
    } else {
      Pasteboard.copyString(result.text);
      const alert = new Alert();
      alert.title = result.title;
      alert.message = result.body;
      alert.addAction("Готово");
      await alert.presentAlert();
    }
  } catch (error) {
    await finishWithError(`Не удалось рассчитать снятие. ${error.message || error}`, config.runsInWidget, shortcutInput !== undefined && shortcutInput !== null);
  }
  Script.complete();
}

function parseInput(value) {
  const text = String(value || "").trim().toLowerCase();
  const amountMatch = text.match(/\d[\d\s,\.\u00a0]*/);
  return {
    card: text.includes("rub") || text.includes("руб") ? "rub" : text.includes("cny") || text.includes("юан") ? "cny" : null,
    withdrawalThb: amountMatch ? asNumber(amountMatch[0]) : null,
    refresh: text.includes("refresh") || text.includes("reload") || text.includes("update") || text.includes("обнов"),
    json: text.includes("json"),
  };
}

async function chooseCard() {
  const alert = new Alert();
  alert.title = "Карта РСХБ";
  alert.message = "С какой карты снимаете баты в Таиланде?";
  alert.addAction("Рублёвая карта (RUB)");
  alert.addAction("Юаневая карта (CNY)");
  alert.addCancelAction("Отмена");
  const choice = await alert.presentAlert();
  return choice === 0 ? "rub" : choice === 1 ? "cny" : null;
}

async function askWithdrawalAmount() {
  const alert = new Alert();
  alert.title = "Сумма выдачи";
  alert.message = "Введите сумму, которую выдаст банкомат, в THB. Доплата ATM 250 THB будет добавлена автоматически.";
  alert.addTextField("Например, 30000", "30000");
  alert.addAction("Рассчитать");
  alert.addCancelAction("Отмена");
  const choice = await alert.presentAlert();
  return choice === -1 ? null : asNumber(alert.textFieldValue(0));
}

async function loadRates(forceRefresh, card) {
  const cache = readCache();
  const [unionPay, rshbForeign, rshbApp] = await Promise.all([
    resolveSource("UnionPay", cache.unionPay, SETTINGS.UNIONPAY_CACHE_MS, forceRefresh, fetchUnionPayThbCny),
    resolveSource("РСХБ: снятие за рубежом", cache.rshbForeign, SETTINGS.RSHB_CACHE_MS, forceRefresh, fetchRshbForeignCardRate),
    card === "cny"
      ? resolveSource("РСХБ: покупка CNY", cache.rshbApp, SETTINGS.RSHB_CACHE_MS, forceRefresh, fetchRshbAppCnyRate)
      : Promise.resolve(null),
  ]);
  writeCache({ version: 4, unionPay: unionPay.entry, rshbForeign: rshbForeign.entry, rshbApp: rshbApp?.entry || cache.rshbApp });
  return { unionPay: unionPay, rshbForeign: rshbForeign, rshbApp: rshbApp };
}

async function resolveSource(name, cached, ttl, forceRefresh, loader) {
  if (!forceRefresh && isFresh(cached, ttl)) return { entry: cached, source: "cache" };
  try {
    return { entry: { value: await loader(), fetchedAt: Date.now() }, source: "network" };
  } catch (error) {
    if (isUsableStale(cached)) return { entry: cached, source: "stale-cache" };
    throw new Error(`${name}: ${error.message || error}`);
  }
}

async function fetchUnionPayThbCny() {
  // UnionPay publishes daily rate tables as /upload/jfimg/YYYYMMDD.json.
  // For this pair rateData is the CNY amount debited for 1 THB. Its inverse
  // is the familiar displayed rate: THB per 1 CNY.
  let lastError = "UnionPay не вернул курс THB/CNY";
  for (let offset = 0; offset < 2; offset++) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    try {
      const dateKey = toCompactDate(date);
      const request = new Request(`${SETTINGS.UNIONPAY_DAILY_URL}/${dateKey}.json`);
      request.timeoutInterval = 20;
      const payload = await request.loadJSON();
      const item = (payload.exchangeRateJson || []).find((rate) => rate.baseCur === "CNY" && rate.transCur === "THB");
      const thbCny = asNumber(item?.rateData);
      if (thbCny > 0) return { thbCny: thbCny, cnyThb: 1 / thbCny, settlementDate: dateKey, yesterday: offset === 1 };
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  throw new Error(lastError);
}

async function fetchRshbForeignCardRate() {
  // The current RSHB page labels temporaryRates as the rate for card
  // operations outside the bank network, including foreign ATMs.
  const request = new Request(SETTINGS.RSHB_FOREIGN_CARD_RATES_URL);
  request.headers = { Accept: "application/json" };
  request.timeoutInterval = 20;
  const payload = JSON.parse(await request.loadString());
  const rows = Array.isArray(payload?.[0]) ? payload[0] : Array.isArray(payload) ? payload : [];
  const cny = rows.find((item) => String(item.currencyPair || "").startsWith("CNY/RUB"));
  const sellCnyRub = asNumber(cny?.sellRate);
  if (!(sellCnyRub > 0)) throw new Error("РСХБ не вернул внешний карточный курс CNY/RUB");
  return { sellCnyRub: sellCnyRub, updatedAt: cny.lastUpdatedAt || null };
}

async function fetchRshbAppCnyRate() {
  const request = new Request(SETTINGS.RSHB_APP_RATES_URL);
  request.headers = { Accept: "application/json" };
  request.timeoutInterval = 20;
  const payload = JSON.parse(await request.loadString());
  const rows = Array.isArray(payload?.[0]) ? payload[0] : Array.isArray(payload) ? payload : [];
  const cny = rows.find((item) => String(item.currencyPair || "").startsWith("CNY/RUB"));
  const sellCnyRub = asNumber(cny?.sellRate);
  if (!(sellCnyRub > 0)) throw new Error("не удалось получить курс покупки CNY");
  return { sellCnyRub: sellCnyRub, updatedAt: cny.lastUpdatedAt || null };
}

function calculate(card, withdrawalThb, rates) {
  const unionPay = rates.unionPay.entry.value;
  const rshbForeign = rates.rshbForeign.entry.value;
  const rshbApp = rates.rshbApp?.entry.value;
  const totalThb = withdrawalThb + SETTINGS.THAI_ATM_FEE_THB;
  const settlementCny = totalThb * unionPay.thbCny;
  const fee = SETTINGS.FEES[card];
  const baseInAccountCurrency = card === "cny" ? settlementCny : settlementCny * rshbForeign.sellCnyRub;
  const rshbCashFee = Math.max(baseInAccountCurrency * fee.percent, fee.minimum);
  const totalDebit = baseInAccountCurrency + rshbCashFee;
  const rublesToBuyCny = card === "cny" ? totalDebit * rshbApp.sellCnyRub : null;
  const cardName = card === "rub" ? "Рублёвая карта РСХБ" : "Юаневая карта РСХБ";
  const accountCurrency = fee.currency;
  const convertedLine = card === "rub"
    ? `💱 РСХБ: снятие за рубежом\n1 CNY = ${formatRate(rshbForeign.sellCnyRub)} RUB\n\n💳 До комиссии\n${format(baseInAccountCurrency, "RUB")}\n\n`
    : "";
  const rubPurchaseLine = card === "cny"
    ? `\n\n💴 Купить ${format(totalDebit, "CNY")}\nв приложении РСХБ\n1 CNY = ${formatRate(rshbApp.sellCnyRub)} RUB\n${format(rublesToBuyCny, "RUB")}`
    : "";
  const yesterdayWarning = unionPay.yesterday ? "⚠ Используется вчерашний курс UnionPay\n\n" : "";
  const title = "🇹🇭 THB ATM RSHB";
  const body =
`${cardName}\n\n` +
`${yesterdayWarning}` +
`📅 ${formatCompactDate(unionPay.settlementDate)}\n\n` +
`💱 1 CNY = ${formatRate(unionPay.cnyThb)} THB\n\n` +
`────────────────────\n\n` +
`💵 Получить\n${format(withdrawalThb, "THB")}\n\n` +
`🏧 ATM\n${format(SETTINGS.THAI_ATM_FEE_THB, "THB")}\n\n` +
`────────────────────\n\n` +
`💰 Всего\n${format(totalThb, "THB")}\n\n` +
`💳 UnionPay\n${format(settlementCny, "CNY")}\n\n` +
convertedLine +
`🏦 Комиссия РСХБ\n${format(rshbCashFee, accountCurrency)} (${fee.percent * 100}%, мин. ${format(fee.minimum, accountCurrency)})\n\n` +
`════════════════════\n\n` +
`💸 Итого\n${format(totalDebit, accountCurrency)}` +
rubPurchaseLine;
  return {
    title: title,
    body: body,
    text: `${title}\n${body}`,
    json: {
      cardCurrency: accountCurrency,
      withdrawalThb: withdrawalThb,
      thaiAtmFeeThb: SETTINGS.THAI_ATM_FEE_THB,
      totalAtmDebitThb: totalThb,
      unionPay: { thbCny: unionPay.thbCny, settlementCny: settlementCny, settlementDate: unionPay.settlementDate, cache: rates.unionPay.source },
      rshb: {
        foreignCardCnyRubSell: rshbForeign.sellCnyRub,
        appCnyRubSell: rshbApp?.sellCnyRub || null,
        cashWithdrawalFee: rshbCashFee,
        rublesToBuyCny: rublesToBuyCny,
        foreignCardCache: rates.rshbForeign.source,
        appRateCache: rates.rshbApp?.source || null,
      },
      totalDebit: totalDebit,
      totalDebitCurrency: accountCurrency,
      generatedAt: new Date().toISOString(),
    },
  };
}

function buildWidget(result) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("123B2A");
  widget.setPadding(14, 14, 14, 14);
  const title = widget.addText(result.title);
  title.font = Font.semiboldSystemFont(13);
  title.textColor = Color.white();
  widget.addSpacer(7);
  const bodyLines = result.body.split("\n");
  const totalIndex = bodyLines.indexOf("💸 Итого");
  const total = widget.addText(totalIndex >= 0 ? bodyLines[totalIndex + 1] : "");
  total.font = Font.boldSystemFont(16);
  total.textColor = new Color("D5F2D4");
  widget.addSpacer(5);
  const detail = widget.addText(result.body.split("\n").slice(0, 5).filter(Boolean).join(" · "));
  detail.font = Font.systemFont(9);
  detail.textColor = new Color("E7EEE8");
  return widget;
}

async function finishWithError(message, isWidget, isShortcut) {
  if (isWidget) {
    const widget = new ListWidget();
    widget.backgroundColor = new Color("6B1D1D");
    const text = widget.addText(message);
    text.textColor = Color.white();
    text.font = Font.systemFont(11);
    Script.setWidget(widget);
  } else if (isShortcut) {
    Script.setShortcutOutput(message);
  } else {
    const alert = new Alert();
    alert.title = "thb-atm-rshb v3";
    alert.message = message;
    alert.addAction("OK");
    await alert.presentAlert();
  }
  Script.complete();
}

function readCache() {
  try { return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : {}; } catch (_) { return {}; }
}

function writeCache(value) {
  try { fm.writeString(cachePath, JSON.stringify(value)); } catch (_) {}
}

function isFresh(entry, ttl) {
  return entry?.value && Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < ttl;
}

function isUsableStale(entry) {
  return entry?.value && Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < SETTINGS.MAX_STALE_MS;
}

function cacheLabel(source) {
  const label = source.source === "network" ? "обновлено" : source.source === "cache" ? "кэш" : "устаревший кэш";
  return `${label} ${new Date(source.entry.fetchedAt).toLocaleString("ru-RU")}`;
}

function format(value, currency) {
  const digits = currency === "THB" ? 0 : 2;
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function formatRate(value) {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
}

function asNumber(value) {
  if (typeof value === "number") return value;
  const normalized = String(value || "").replace(/\u00a0/g, " ").trim().replace(/\s/g, "").replace(",", ".");
  return Number(normalized);
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toCompactDate(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function formatCompactDate(value) {
  const date = String(value || "");
  return /^\d{8}$/.test(date) ? `${date.slice(6, 8)}.${date.slice(4, 6)}.${date.slice(0, 4)}` : date;
}
