import { test } from "node:test";
import assert from "node:assert/strict";
import { excelDate, parseXtbReport } from "../src/xtb.js";

// Synthetic report shaped like a real xStation export (no real account data).
const head = (name, acc) => [["Account number", acc], [name, ""], ["Date from (UTC)", 46022.9], ["Date to (UTC)", 46341.4]];
const sheets = {
  "Closed Positions": [
    ...head("Closed Positions", "111"),
    ["Instrument", "Ticker", "Category", "Type", "Volume", "Open Price", "Open Time (UTC)", "Close Price",
     "Close Time (UTC)", "Product", "Profit/Loss", "Commission", "Position ID"],
    ["MSCI ACWI", "IUSQ.DE", "ETF", "BUY", 2, 100, 46100.4, 110, 46300.4, "IKE", 20, -0.5, "900"],
    ["Profit/loss"],
  ],
  "Cash Operations": [
    ...head("Cash Operations", "111"),
    ["Type", "Instrument", "Ticker", "Category", "Time", "Amount", "ID", "Comment", "Product", "Position ID"],
    ["Stock purchase", "MSCI ACWI", "IUSQ.DE", "ETF", 46290.39, -1760, "1", "OPEN BUY 4/4.5 @ 100.00", "IKE", "500"],
    ["Stock purchase", "MSCI ACWI", "IUSQ.DE", "ETF", 46290.39, -220, "2", "OPEN BUY 0.5/4.5 @ 100.00", "IKE", "500"],
    ["IKE deposit", "", "", "", 46290.3, 2000, "3", "Transfer in", "IKE", ""],
    ["Total", "", "", "", "", 20],
  ],
  "Open Positions": [
    ["Account number", "999"], ["Open Positions", ""], ["Data as of report generated", 46341.4],
    ["Product", "Metric", "Amount", "Currency"], ["IKE", "Open position value", 2000, ""], undefined,
    ["Product", "Instrument/Position", "Ticker", "Category", "Type", "Volume", "Value", "Current price",
     "Open price", "Open time (UTC)", "Open Commission"],
    ["IKE", "MSCI ACWI", "IUSQ.DE", "ETF", "", 4.5, 2000, "", 100, ""],
    ["IKE", "500", "IUSQ.DE", "", "BUY", 4.5, 2000, 105, 100, 46290.39, ""],
  ],
};

test("excel serial dates convert to Warsaw calendar dates", () => {
  assert.equal(excelDate(46318.414), "2026-10-23");
  assert.equal(excelDate(46022.958333333336), "2026-01-01"); // 23:00 UTC = midnight in Warsaw
});

test("IKE report: account from Product, number from Cash Operations, FX from cash paid", () => {
  const r = parseXtbReport(sheets, "IKE_111_2025-12-31_2026-11-15.xlsx");
  assert.equal(r.accountNumber, "111");
  assert.equal(r.account, "ike");
  assert.equal(r.currency, "PLN");
  const [open, buy, sell] = r.trades;
  assert.deepEqual(open, { position: "500", symbol: "IUSQ.DE", side: "buy", date: "2026-09-25",
                           qty: 4.5, price: 100, feeAccount: 0, cashFx: 1980 / 450 });
  assert.equal(buy.side, "buy");
  assert.equal(buy.cashFx, null); // bought before the report period, no cash row
  assert.deepEqual([sell.side, sell.qty, sell.price, sell.feeAccount], ["sell", 2, 110, 0.5]);
});

test("rejects files that are not xStation history reports", () => {
  assert.throws(() => parseXtbReport({ Sheet1: [["a"]] }, "x.xlsx"), /raport historii/);
});

// --- Real XLSX files (synthetic data, see fixtures/make_xtb_fixtures.py) -------------------

import { readFileSync } from "node:fs";
import { readXlsx } from "../src/xlsx.js";
import { buildImport, importSummary } from "../src/xtb.js";

const fixture = async (name) => {
  const b = readFileSync(new URL(`fixtures/${name}`, import.meta.url));
  return parseXtbReport(await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), name);
};
const IKE = "IKE_11111111_2026-01-01_2026-11-15.xlsx";
const EUR = "EUR_22222222_2026-01-01_2026-11-15.xlsx";

test("XLSX fixture: IKE report with fills, a closed position and escaped text", async () => {
  const r = await fixture(IKE);
  assert.equal(r.accountNumber, "11111111"); // not 99999999 from Open Positions
  assert.equal(r.account, "ike");
  assert.equal(r.currency, "PLN");
  assert.deepEqual(r.trades, [
    { position: "500", symbol: "VWCE.DE", side: "buy", date: "2026-09-25", qty: 4, price: 110, feeAccount: 0, cashFx: 4.4 },
    { position: "900", symbol: "VWCE.DE", side: "buy", date: "2026-02-02", qty: 2, price: 100, feeAccount: 0, cashFx: null },
    { position: "900", symbol: "VWCE.DE", side: "sell", date: "2026-06-01", qty: 2, price: 120, feeAccount: 1.5, cashFx: null },
  ]);
});

test("XLSX fixture: EUR account currency from the summary, open commission kept", async () => {
  const r = await fixture(EUR);
  assert.equal(r.account, "regular");
  assert.equal(r.currency, "EUR");
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].feeAccount, 2);
});

// Fakes for the network: every instrument is in EUR, NBP gives 4.3 except on 2026-06-01.
const deps = () => {
  const calls = { quote: [], fx: [] };
  let n = 0;
  return {
    calls,
    quote: async (s) => { calls.quote.push(s); return { price: 1, currency: s.endsWith(".WA") ? "PLN" : "EUR" }; },
    fx: async (c, d) => { calls.fx.push(`${c}|${d}`); return d === "2026-06-01" ? 4.5 : 4.3; },
    newId: () => `id${++n}`,
  };
};

test("import: XTB's own FX for PLN accounts, NBP otherwise; fees in instrument currency", async () => {
  const d = deps();
  const { imported, next } = await buildImport([await fixture(IKE), await fixture(EUR)], [], d);
  const by = (pos, side) => imported.find((t) => t.xtb.position === pos && t.side === side);
  assert.equal(by("500", "buy").fx, 4.4); // cash paid / (qty * price)
  assert.equal(by("900", "buy").fx, 4.3); // bought before the report, no cash row: NBP
  assert.equal(by("900", "sell").fx, 4.5);
  assert.equal(by("900", "sell").fee, 1.5 / 4.5); // 1.50 PLN commission -> EUR
  assert.equal(by("700", "buy").fx, 4.3); // EUR account: NBP
  assert.equal(by("700", "buy").fee, 2); // already in EUR
  assert.deepEqual(by("700", "buy").xtb, { account: "22222222", position: "700" });
  assert.equal(next.length, 4);
  assert.deepEqual(d.calls.quote, ["VWCE.DE", "EUNL.DE"]); // one quote per symbol
});

test("import: re-import replaces that account's XTB rows, drops manual duplicates, keeps the rest", async () => {
  const existing = [
    { id: "old", account: "ike", symbol: "VWCE.DE", side: "buy", date: "2026-01-01", qty: 9, price: 1, fee: 0, currency: "EUR", fx: 4, xtb: { account: "11111111", position: "1" } },
    { id: "other-xtb", account: "regular", symbol: "EUNL.DE", side: "buy", date: "2026-01-01", qty: 1, price: 1, fee: 0, currency: "EUR", fx: 4, xtb: { account: "33333333", position: "2" } },
    { id: "manual-dup", account: "ike", symbol: "VWCE.DE", side: "buy", date: "2026-01-01", qty: 4, price: 1, fee: 0, currency: "EUR", fx: 4 },
    { id: "manual-other", account: "ike", symbol: "CDR.WA", side: "buy", date: "2026-01-01", qty: 1, price: 1, fee: 0, currency: "PLN", fx: 1 },
  ];
  const report = await fixture(IKE);
  const result = await buildImport([report], existing, deps());
  assert.deepEqual(result.replaced.map((t) => t.id), ["old"]);
  assert.deepEqual(result.manual.map((t) => t.id), ["manual-dup"]);
  assert.deepEqual(result.next.slice(0, 2).map((t) => t.id), ["other-xtb", "manual-other"]);
  assert.equal(result.next.length, 5);
  assert.deepEqual(importSummary([report], result), [
    `${IKE}: IKE, waluta PLN, 3 transakcji (VWCE.DE)`,
    "Zastąpione wcześniej zaimportowane transakcje: 1",
    "Usunięte ręczne transakcje tych samych symboli na tych kontach: 2026-01-01 VWCE.DE (IKE) 4 szt.",
  ]);
});

test("import: rejects the same account twice and sells without holdings", async () => {
  const r = await fixture(IKE);
  await assert.rejects(buildImport([r, r], [], deps()), /Ten sam rachunek XTB/);
  const sellOnly = { ...r, trades: r.trades.filter((t) => t.side === "sell") };
  await assert.rejects(buildImport([sellOnly], [], deps()), /posiadane tylko 0/);
});

test("import summary lists skipped short positions", () => {
  const items = importSummary([{ fileName: "f.xlsx", account: "regular", currency: "PLN", trades: [], skipped: ["US500 SELL"] }],
    { replaced: [], manual: [] });
  assert.deepEqual(items, ["f.xlsx: Zwykłe, waluta PLN, 0 transakcji (brak pozycji) · pominięte (nie BUY): US500 SELL"]);
});
