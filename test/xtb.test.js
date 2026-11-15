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
