import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, maturityReminders, ror, parseNbpRefRates } from "../src/bonds.js";

test("periods clamp to month end like the list emisyjny table", () => {
  const ends = [1, 2, 3, 4].map((k) => addMonths("2026-11-30", k));
  assert.deepEqual(ends, ["2026-12-30", "2027-01-30", "2027-02-28", "2027-03-30"]);
});

const rates = [{ from: "2025-12-04", rate: 4.0 }, { from: "2026-03-05", rate: 3.75 }, { from: "2027-01-08", rate: 3.5 }];
const bond = { date: "2026-11-15", qty: 10, firstRate: 4.0, margin: 0 };

test("period 1: accrued interest, fee capped at accrued", () => {
  const r = ror(bond, rates, "2026-11-18");
  // 100 * 4% * 3/30 / 12 = 0.0333 -> 0.03 per bond
  assert.equal(r.current.period, 1);
  assert.equal(r.accrued, 0.3);
  assert.equal(r.redeemNow, 1000); // fee min(0.50, 0.03) eats the accrued interest
});

test("later periods use NBP rate from before the month start, full fee", () => {
  const r = ror(bond, rates, "2027-02-15");
  // p1 4% -> 0.33, p2 (starts Dec, rate on 30.11) 3.75% -> 0.31,
  // p3 (starts Jan, rate on 31.12) 3.75% -> 0.31; Jan 8 cut applies from p4 (Feb)
  assert.equal(r.paid, round(10 * (0.33 + 0.31 + 0.31)));
  assert.equal(r.current.period, 4);
  assert.equal(r.current.rate, 3.5);
  assert.equal(r.accrued, 0);
  assert.equal(r.redeemNow, 995);
});

test("matured bond has no value left", () => {
  const r = ror(bond, rates, "2027-11-15");
  assert.equal(r.matured, true);
  assert.equal(r.value, 0);
});

test("maturity reminders: within 30 days or already matured, soonest first", () => {
  const bonds = [
    { series: "ROR0128", qty: 5, date: "2027-01-20" }, // matures 2028-01-20, far away
    { series: "ROR1227", qty: 3, date: "2026-12-10" }, // matures 2027-12-10, 25 days
    { series: "ROR1027", qty: 2, date: "2026-10-01" }, // matured 2027-10-01
  ];
  assert.deepEqual(maturityReminders(bonds, "2027-11-15").map((r) => [r.series, r.daysLeft]),
    [["ROR1027", -45], ["ROR1227", 25]]);
});

test("parses NBP XML", () => {
  const xml = `<pozycje obowiazuje_od="2026-03-05"><pozycja id="ref" oprocentowanie="3,75" /><pozycja id="lom" oprocentowanie="4,25" /></pozycje>`;
  assert.deepEqual(parseNbpRefRates(xml), [{ from: "2026-03-05", rate: 3.75 }]);
});

function round(x) { return Math.round(x * 100) / 100; }
