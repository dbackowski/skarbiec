import { test } from "node:test";
import assert from "node:assert/strict";
import { positions, savings, yahooSymbol } from "../src/portfolio.js";

const tx = (o) => ({ symbol: "AAPL", currency: "USD", fee: 0, fx: 4, ...o });

test("average cost, partial sell, realized P/L in USD and PLN", () => {
  const [p] = positions([
    tx({ side: "sell", date: "2024-03-01", qty: 5, price: 150, fx: 4.2 }),
    tx({ side: "buy", date: "2024-01-01", qty: 10, price: 100, fee: 2 }),
    tx({ side: "buy", date: "2024-02-01", qty: 10, price: 120, fx: 3.9 }),
  ]);
  // cost 1002 + 1200 = 2202 for 20 shares, sell 5 removes a quarter
  assert.equal(p.qty, 15);
  assert.ok(Math.abs(p.cost - 2202 * 0.75) < 1e-9);
  assert.ok(Math.abs(p.realized - (750 - 550.5)) < 1e-9);
  const costPln = 1002 * 4 + 1200 * 3.9;
  assert.ok(Math.abs(p.realizedPln - (750 * 4.2 - costPln / 4)) < 1e-9);
});

test("selling more than held is rejected", () => {
  assert.throws(() => positions([
    tx({ side: "buy", date: "2024-01-01", qty: 1, price: 1 }),
    tx({ side: "sell", date: "2024-01-02", qty: 2, price: 1 }),
  ]), /posiadane tylko 1/);
});

test("positions are split per account; selling is checked per account", () => {
  const buyIke = tx({ account: "ike", side: "buy", date: "2024-01-01", qty: 3, price: 10 });
  const buyReg = tx({ side: "buy", date: "2024-01-01", qty: 1, price: 12 });
  const ps = positions([buyIke, buyReg]);
  assert.deepEqual(ps.map((p) => [p.account, p.qty]), [["ike", 3], ["regular", 1]]);
  assert.throws(() => positions([buyIke, buyReg,
    tx({ side: "sell", date: "2024-02-01", qty: 2, price: 11 })]), /Maklerskie/);
});

test("savings accrue simple daily interest since the balance date", () => {
  const acc = { balance: 10000, rate: 6, since: "2026-11-01" };
  assert.deepEqual(savings(acc, "2026-11-15"), { accrued: 23.01, value: 10023.01, monthly: 50 });
  assert.equal(savings(acc, "2026-10-01").accrued, 0); // balance date in the future
});

test("XTB symbols map to Yahoo", () => {
  assert.equal(yahooSymbol("etfpzuw20m40.pl"), "ETFPZUW20M40.WA");
  assert.equal(yahooSymbol("AAPL.US"), "AAPL");
  assert.equal(yahooSymbol("IWDA.UK"), "IWDA.L");
  assert.equal(yahooSymbol("VWCE.DE"), "VWCE.DE");
  assert.equal(yahooSymbol("CDR.WA"), "CDR.WA");
});

test("Finax (Bloomberg-style) symbols map to Yahoo, Germany to XETRA", () => {
  assert.equal(yahooSymbol("IS3N.GR"), "IS3N.DE");
  assert.equal(yahooSymbol("xsx6.gr"), "XSX6.DE");
  assert.equal(yahooSymbol("SXR8.GY"), "SXR8.DE");
  assert.equal(yahooSymbol("VUSA.LN"), "VUSA.L");
  assert.equal(yahooSymbol("IWDA.NA"), "IWDA.AS");
  assert.equal(yahooSymbol("CW8.FP"), "CW8.PA");
  assert.equal(yahooSymbol("SWDA.IM"), "SWDA.MI");
  assert.equal(yahooSymbol("ETFBW20TR.PW"), "ETFBW20TR.WA");
});

test("OIPE is its own account: no selling OIPE units from IKE", () => {
  const buy = tx({ account: "oipe", side: "buy", date: "2026-01-01", qty: 2, price: 45 });
  assert.deepEqual(positions([buy]).map((p) => [p.account, p.qty]), [["oipe", 2]]);
  assert.throws(() => positions([buy, tx({ account: "ike", side: "sell", date: "2026-02-01", qty: 1, price: 50 })]), /IKE/);
});
