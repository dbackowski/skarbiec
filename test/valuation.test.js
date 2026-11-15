import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocation, portfolio, refreshMessage, reminderTexts, valueBonds, valuePositions, valueSavings,
} from "../src/valuation.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg ?? ""} ${a} != ${b}`);
const tx = (o) => ({ account: "regular", side: "buy", fee: 0, fx: 1, currency: "PLN", ...o });
const rates = [{ from: "2025-01-01", rate: 5.75 }, { from: "2025-12-04", rate: 4.0 }, { from: "2026-03-05", rate: 3.75 }];

test("EUR position: PLN result includes the currency gain since purchase", () => {
  // Bought for 5000 EUR at 4.24 PLN, now worth 4200 EUR at 4.40 PLN.
  const [r] = valuePositions(
    [tx({ symbol: "ETF.DE", qty: 100, price: 50, currency: "EUR", fx: 4.24 })],
    { "ETF.DE": { price: 42, currency: "EUR" } }, { PLN: 1, EUR: 4.4 });
  close(r.value, 4200);
  close(r.pl, -800);
  close(r.valuePln, 18480);
  close(r.plPln, 18480 - 21200); // -2720, not -800 * 4.40 = -3520
});

test("PLN account with foreign ETF: cost uses the stored rate per purchase", () => {
  const [r] = valuePositions([
    tx({ account: "ike", symbol: "ETF.DE", qty: 4, price: 100, currency: "EUR", fx: 4.4 }),
    tx({ account: "ike", symbol: "ETF.DE", qty: 6, price: 110, currency: "EUR", fx: 4.3, date: "2026-02-01" }),
  ].map((t) => ({ date: "2026-01-01", ...t })), { "ETF.DE": { price: 120 } }, { EUR: 4.35 });
  close(r.p.costPln, 4 * 100 * 4.4 + 6 * 110 * 4.3);
  close(r.plPln, 1200 * 4.35 - (1760 + 2838));
});

test("positions: missing quote or FX leaves PLN fields empty; sorted by account, then symbol", () => {
  const rows = valuePositions([
    tx({ account: "ike", symbol: "B", qty: 1, price: 1, date: "2026-01-01" }),
    tx({ symbol: "Z", qty: 1, price: 1, currency: "USD", date: "2026-01-01" }),
    tx({ symbol: "A", qty: 1, price: 1, date: "2026-01-01" }),
    tx({ symbol: "SOLD", qty: 1, price: 1, date: "2026-01-01" }),
    tx({ symbol: "SOLD", side: "sell", qty: 1, price: 2, date: "2026-01-02" }),
  ], { A: { price: 2 }, B: { price: 3 }, Z: { price: 5 } }, { PLN: 1 });
  assert.deepEqual(rows.map((r) => `${r.p.account}:${r.p.symbol}`), ["regular:A", "regular:Z", "ike:B"]);
  const z = rows[1];
  assert.equal(z.value, 5);
  assert.equal(z.valuePln, null);
  assert.equal(z.plPln, null);
});

test("bonds: unpriced without NBP rates, matured worth 0 and not unpriced, errors captured", () => {
  const bonds = [
    { id: "a", series: "ROR1127", date: "2026-11-02", qty: 10, firstRate: 4, margin: 0 },
    { id: "b", series: "ROR1026", date: "2025-10-08", qty: 5, firstRate: 5.75, margin: 0 },
  ];
  assert.deepEqual(valueBonds(bonds, null, "2026-11-15").unpriced, 2);

  const v = valueBonds(bonds, rates, "2026-11-15");
  assert.equal(v.unpriced, 0);
  assert.equal(v.counted.length, 1); // matured ROR1026 is not counted
  assert.deepEqual(v.counted[0], { valuePln: 1001.4, plPln: 1.4, cost: 1000 }); // 13/30 of a month at 4%: 0.14 per bond
  assert.equal(v.rows[1].r.matured, true);

  const broken = valueBonds([{ ...bonds[0], date: "2020-01-01" }], rates.slice(1), "2020-03-01");
  assert.equal(broken.unpriced, 1);
  assert.match(broken.rows[0].error, /Brak stopy referencyjnej NBP/);
});

test("savings: EUR account valued at today's rate, unknown currency is not counted", () => {
  const v = valueSavings([
    { name: "PLN", currency: "PLN", balance: 1000, rate: 0, since: "2026-11-01" },
    { name: "EUR", currency: "EUR", balance: 100, rate: 3.65, since: "2026-11-01" },
    { name: "CHF", currency: "CHF", balance: 50, rate: 0, since: "2026-11-01" },
  ], { PLN: 1, EUR: 4.4 }, "2026-11-11");
  assert.equal(v.counted.length, 2);
  close(v.rows[1].valuePln, (100 + 0.1) * 4.4); // 100 * 3.65% * 10/365 = 0.10
  close(v.rows[1].plPln, 0.1 * 4.4);
  assert.equal(v.rows[2].valuePln, null);
});

test("allocation: fixed slots per part, sums per account", () => {
  const p = (account, valuePln, plPln, costPln) => ({ p: { account, costPln }, valuePln, plPln });
  const parts = allocation(
    [p("regular", 100, 10, 90), p("ike", 200, 20, 180), p("ike", 50, -5, 55), p("ikze", null, null, 10)],
    [{ valuePln: 1000, plPln: 3, cost: 1000 }],
    [{ valuePln: 500, plPln: 1, cost: 499 }]);
  assert.deepEqual(parts.map((x) => [x.key, x.slot, x.value, x.pl, x.cost]), [
    ["regular", 1, 100, 10, 90], ["ike", 2, 250, 15, 235], ["ikze", 3, 0, 0, 0],
    ["bonds", 4, 1000, 3, 1000], ["savings", 5, 500, 1, 499],
  ]);
});

test("portfolio: totals, cost and missing count across all asset types", () => {
  const data = {
    transactions: [tx({ symbol: "A", qty: 10, price: 10, date: "2026-01-01" }),
                   tx({ symbol: "NOQUOTE", qty: 1, price: 5, date: "2026-01-01" })],
    bonds: [{ id: "a", series: "ROR1127", date: "2026-11-02", qty: 10, firstRate: 4, margin: 0 }],
    savings: [{ name: "S", currency: "PLN", balance: 1000, rate: 0, since: "2026-11-01" },
              { name: "X", currency: "CHF", balance: 1, rate: 0, since: "2026-11-01" }],
  };
  const pf = portfolio(data, { quotes: { A: { price: 12 } }, fx: { PLN: 1 }, refRates: rates }, "2026-11-15");
  close(pf.total, 120 + 1001.4 + 1000);
  close(pf.pl, 20 + 1.4);
  close(pf.cost, 100 + 1000 + 1000);
  assert.equal(pf.missing, 2); // NOQUOTE + CHF savings
});

test("reminder texts for upcoming, today and matured bonds", () => {
  const texts = reminderTexts([
    { series: "ROR1227", qty: 3, date: "2025-12-10" },
    { series: "ROR1127", qty: 1, date: "2025-11-15" },
    { series: "ROR1027", qty: 2, date: "2025-10-01" },
    { series: "ROR1128", qty: 2, date: "2025-11-16" },
  ], "2026-11-15");
  assert.deepEqual(texts, [
    "ROR1027 (2 szt.): wykupiona 2026-10-01. Możesz ją usunąć z zakładki Obligacje.",
    "ROR1127 (1 szt.): wykup dzisiaj, 100,00 zł plus odsetki za ostatni miesiąc.",
    "ROR1128 (2 szt.): wykup 2026-11-16, za 1 dzień. Wróci 200,00 zł plus odsetki za ostatni miesiąc. Zdecyduj, czy wypłacić, czy zamienić na nową serię.",
    "ROR1227 (3 szt.): wykup 2026-12-10, za 25 dni. Wróci 300,00 zł plus odsetki za ostatni miesiąc. Zdecyduj, czy wypłacić, czy zamienić na nową serię.",
  ]);
});

test("refresh message: success, partial failure, offline with cached data", () => {
  const fmtTime = (at) => `T(${at})`;
  assert.equal(refreshMessage({ errors: [], total: 3, oldestCached: null, now: "12:00:00", fmtTime }), "Kursy z 12:00:00");
  assert.equal(refreshMessage({ errors: ["Kurs EUR: x"], total: 3, oldestCached: "a", now: "", fmtTime }),
    "Nie udało się odświeżyć: Kurs EUR: x. Pokazuję zapisane dane z T(a) (oznaczone *).");
  assert.equal(refreshMessage({ errors: ["a", "b"], total: 2, oldestCached: "t0", now: "", fmtTime }),
    "Brak połączenia, nic nie udało się odświeżyć. Pokazuję zapisane dane z T(t0) (oznaczone *).");
  assert.equal(refreshMessage({ errors: ["only one"], total: 1, oldestCached: null, now: "", fmtTime }),
    "Nie udało się odświeżyć: only one");
});
