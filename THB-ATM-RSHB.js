// ============================================
// THB ATM RSHB v2.0
// UnionPay CNY -> THB Calculator
// ============================================

const ATM_FEE = 250.0;       // THB
const RSHB_PERCENT = 0.04;   // 4%
const RSHB_MIN = 70.0;       // CNY

//------------------------------------------------

function ymd(d) {
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
}

function formatDate(s) {
  return `${s.slice(6,8)}.${s.slice(4,6)}.${s.slice(0,4)}`;
}

function money(x) {
  return Number(x).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

//------------------------------------------------

async function getRate() {

  for (let i = 0; i < 2; i++) {

    const d = new Date();
    d.setDate(d.getDate() - i);

    const date = ymd(d);

    const url =
      `https://www.unionpayintl.com/upload/jfimg/${date}.json`;

    try {

      const req = new Request(url);
      const json = await req.loadJSON();

      for (const item of json.exchangeRateJson) {

        if (
          item.baseCur === "CNY" &&
          item.transCur === "THB"
        ) {

          return {
            date,
            rate: 1 / Number(item.rateData),
            yesterday: i === 1
          };

        }

      }

    } catch(e) {}

  }

  throw new Error("Не удалось получить курс UnionPay");

}

//------------------------------------------------

const input = new Alert();

input.title = "🇹🇭 THB ATM RSHB";
input.message = "Сколько бат хотите снять?";

input.addTextField("THB", "30000");

input.addAction("Рассчитать");
await input.present();

const amount =
  Number(input.textFieldValue(0).replace(",", "."));

if (isNaN(amount) || amount <= 0) {
  Script.complete();
  return;
}

const info = await getRate();

const totalTHB = amount + ATM_FEE;

const cny = totalTHB / info.rate;

const fee =
  Math.max(cny * RSHB_PERCENT, RSHB_MIN);

const total = cny + fee;

const effectiveRate = amount / total;

//------------------------------------------------

const out = new Alert();

out.title = "🇹🇭 THB ATM RSHB";

out.message =

`${info.yesterday ? "⚠ Используется вчерашний курс\n\n" : ""}` +

`📅 ${formatDate(info.date)}

` +

`💱 1 CNY = ${info.rate.toFixed(6)} THB

` +

`────────────────────

` +

`💵 Получить
${money(amount)} THB

` +

`🏧 ATM
${money(ATM_FEE)} THB

` +

`────────────────────

` +

`💰 Всего
${money(totalTHB)} THB

` +

`💳 UnionPay
${money(cny)} CNY

` +

`🏦 РСХБ
${money(fee)} CNY

` +

`════════════════════

` +

`💸 Итого
${money(total)} CNY

` +

`📈 Эффективный курс

1 CNY = ${effectiveRate.toFixed(4)} THB`;

out.addAction("OK");

await out.present();

Script.complete();
