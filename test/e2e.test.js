// End-to-end: the real UI (src/) in Chrome, with Tauri replaced by a fake that keeps the data
// file in memory and serves canned market data. Clock fixed at 2026-11-15 12:00 Warsaw time.
// Needs Google Chrome installed (playwright-core drives it, no browser download).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("fixtures/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const NBP_XML = `<pozycje obowiazuje_od="2025-01-01"><pozycja id="ref" oprocentowanie="5,75" /></pozycje>
  <pozycje obowiazuje_od="2025-12-04"><pozycja id="ref" oprocentowanie="4,00" /></pozycje>
  <pozycje obowiazuje_od="2026-03-05"><pozycja id="ref" oprocentowanie="3,75" /></pozycje>`;

let server, base, browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    try {
      const body = await readFile(SRC + path.slice(1));
      res.writeHead(200, { "Content-Type": TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page before main.js: fake Tauri core (data file) and http (market data).
function fakeTauri(cfg) {
  const state = { file: cfg.loadError ? null : JSON.stringify(cfg.data), invokes: [] };
  window.__state = state;
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        state.invokes.push(cmd);
        if (cmd === "load_data") {
          if (cfg.loadError) throw "permission denied";
          return state.file;
        }
        if (cmd === "save_data") { JSON.parse(args.data); state.file = args.data; return null; }
        if (cmd === "backup_data") { state.backup = state.file; return `/fake/backups/skarbiec-${args.stamp}.json`; }
        if (cmd === "export_data") return `/fake/Downloads/skarbiec-kopia-${args.stamp}.json`;
        throw new Error(`unexpected command ${cmd}`);
      },
    },
    http: {
      fetch: async (url) => {
        if (cfg.offline) throw new Error("error sending request");
        if (url.includes("finance.yahoo.com")) {
          const symbol = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
          const q = cfg.quotes[symbol];
          if (!q) return { ok: false, status: 404, json: async () => ({}) };
          return json({ chart: { result: [{ meta: { regularMarketPrice: q[0], currency: q[1] } }] } });
        }
        if (url.includes("api.nbp.pl")) {
          const cur = url.match(/rates\/a\/(\w+)\//)[1].toUpperCase();
          const end = url.match(/\/(\d{4}-\d{2}-\d{2})\/\?format/)[1];
          return json({ rates: [{ mid: cfg.fx[`${cur}|${end}`] ?? cfg.fx[cur] }] });
        }
        if (url.includes("static.nbp.pl")) return json(cfg.nbpXml);
        throw new Error(`unexpected URL ${url}`);
      },
    },
  };
}

const SEED = {
  transactions: [
    { id: "t1", account: "regular", symbol: "CDR.WA", side: "buy", date: "2026-01-10", qty: 10, price: 100, fee: 0, currency: "PLN", fx: 1 },
    { id: "t2", account: "ike", symbol: "VWCE.DE", side: "buy", date: "2026-02-10", qty: 10, price: 100, fee: 0, currency: "EUR", fx: 4 },
  ],
  bonds: [{ id: "b1", type: "ROR", series: "ROR1127", date: "2026-11-02", qty: 10, firstRate: 4, margin: 0 }],
  savings: [{ id: "s1", name: "Konto", currency: "PLN", balance: 1000, rate: 0, since: "2026-11-01" }],
};
const MARKET = {
  quotes: { "CDR.WA": [120, "PLN"], "VWCE.DE": [110, "EUR"], "PKO.WA": [50, "PLN"], "EUNL.DE": [95, "EUR"], "IS3N.DE": [45, "EUR"] },
  fx: { EUR: 4.4, "EUR|2026-11-03": 4.3 },
  nbpXml: NBP_XML,
};

async function open(cfg = {}, { tab } = {}) {
  const context = await browser.newContext({ locale: "pl-PL", timezoneId: "Europe/Warsaw" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-11-15T12:00:00+01:00"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(fakeTauri, { data: structuredClone(SEED), ...MARKET, ...cfg });
  if (tab) await page.addInitScript((t) => localStorage.setItem("tab", t), tab);
  await page.goto(base);
  if (!cfg.loadError) await page.waitForFunction(() => /Kursy z|odświeżyć/.test(document.querySelector("#status").textContent));
  const saved = async () => page.evaluate(() => JSON.parse(window.__state.file));
  const status = () => page.textContent("#status");
  const rows = (sel) => page.$$eval(`${sel} tr`, (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  return { page, saved, status, rows, errors, close: () => context.close() };
}

test("dashboard: totals, tiles, allocation and top positions from all asset types", async () => {
  const app = await open();
  const { page } = app;
  // 1200 (CDR) + 4840 (VWCE 1100 EUR x 4.4) + 1001.40 (ROR, 13 days at 4%) + 1000 (savings)
  assert.equal(await page.textContent("#hero-value"), "8041,40 PLN");
  assert.equal(await page.textContent("#hero-pl"), "Zysk: 1041,40 PLN (14,88%)");
  assert.deepEqual(await page.$$eval("#kpis .value", (els) => els.map((e) => e.textContent)),
    ["6040,00 PLN", "1001,40 PLN", "1000,00 PLN", "7000,00 PLN"]);
  assert.deepEqual(await app.rows("#alloc-table"), [
    ["Maklerskie", "1200,00", "14,92%", "200,00"],
    ["IKE", "4840,00", "60,19%", "840,00"],
    ["Obligacje", "1001,40", "12,45%", "1,40"],
    ["Oszczędności", "1000,00", "12,44%", "0,00"],
  ]);
  assert.deepEqual(await page.$$eval(".rank-name", (els) => els.map((e) => e.textContent)), ["VWCE.DE · IKE", "CDR.WA · Maklerskie"]);
  assert.equal(await page.isHidden("#reminders"), true);
  assert.deepEqual(app.errors, []);
  await app.close();
});

const tabRows = (app, key, part) => app.rows(`#tab-${key} .${part}`);
const form = (key, cls) => `#tab-${key} .${cls}`;

test("account tabs: each shows only its positions and transactions, summary from purchase cost", async () => {
  const app = await open({}, { tab: "regular" });
  assert.deepEqual(await tabRows(app, "regular", "positions"), [
    ["CDR.WA", "10", "100,00 PLN", "120,00", "1200,00", "200,00", "20,00%", "1200,00", "200,00"],
  ]);
  assert.equal(await app.page.textContent("#tab-regular .account-summary"), "Wartość: 1200,00 PLN · Zysk z pozycji: 200,00 PLN (20,00%)");
  for (const key of ["regular", "ike", "ikze"]) { // deposits and limits exist only on OIPE
    assert.equal(await app.page.locator(`#tab-${key} :is(.limit, .deposits-section)`).count(), 0, key);
  }
  assert.equal(await app.page.locator("#tab-oipe :is(.limit, .deposits-section)").count(), 2);

  await app.page.click("[data-tab=ike]");
  assert.deepEqual(await tabRows(app, "ike", "positions"), [
    ["VWCE.DE", "10", "100,00 EUR", "110,00", "1100,00", "100,00", "10,00%", "4840,00", "840,00"],
  ]);
  assert.deepEqual((await tabRows(app, "ike", "transactions")).map((r) => r.slice(0, 3)), [["2026-02-10", "VWCE.DE", "Kupno"]]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("add transaction: goes to the tab's account; XTB symbol mapped; NBP rate of the trade date", async () => {
  const app = await open({}, { tab: "ikze" });
  const { page } = app;
  const f = form("ikze", "add-tx");
  await page.fill(`${f} [name=symbol]`, "eunl.de");
  await page.fill(`${f} [name=date]`, "2026-11-03");
  await page.fill(`${f} [name=qty]`, "2");
  await page.fill(`${f} [name=price]`, "90");
  await page.click(`${f} button[type=submit]`);
  await page.waitForFunction(() => document.querySelectorAll("#tab-ikze .positions tr").length === 1);
  const tx = (await app.saved()).transactions.at(-1);
  assert.deepEqual({ ...tx, id: undefined },
    { id: undefined, account: "ikze", symbol: "EUNL.DE", side: "buy", date: "2026-11-03", qty: 2, price: 90, fee: 0, currency: "EUR", fx: 4.3 });

  await page.click("[data-tab=regular]");
  const r = form("regular", "add-tx");
  await page.fill(`${r} [name=symbol]`, "pko.pl");
  await page.fill(`${r} [name=qty]`, "1");
  await page.fill(`${r} [name=price]`, "50");
  await page.click(`${r} button[type=submit]`);
  await page.waitForFunction(() => document.querySelectorAll("#tab-regular .positions tr").length === 2);
  assert.deepEqual((await app.saved()).transactions.at(-1).symbol, "PKO.WA");
  assert.equal((await app.saved()).transactions.at(-1).account, "regular");
  await app.close();
});

test("OIPE: Finax ticker, EUR cash and PLN deposits give the broker's result; limit bar", async () => {
  const app = await open({}, { tab: "oipe" });
  const { page } = app;
  const f = form("oipe", "add-tx");
  await page.fill(`${f} [name=symbol]`, "IS3N.GR");
  await page.fill(`${f} [name=date]`, "2026-11-03");
  await page.fill(`${f} [name=qty]`, "10");
  await page.fill(`${f} [name=price]`, "40");
  await page.click(`${f} button[type=submit]`);
  await page.waitForFunction(() => document.querySelectorAll("#tab-oipe .positions tr").length === 1);
  const tx = (await app.saved()).transactions.at(-1);
  assert.deepEqual([tx.account, tx.symbol, tx.currency, tx.fx], ["oipe", "IS3N.DE", "EUR", 4.3]);
  // Without deposits: cost 400 EUR x 4.30 = 1720 PLN; value 450 EUR x 4.40 = 1980 PLN
  assert.equal(await page.textContent("#tab-oipe .account-summary"), "Wartość: 1980,00 PLN · Zysk z pozycji: 260,00 PLN (15,12%)");

  await page.selectOption(`${form("oipe", "add-cash")} [name=currency]`, "EUR");
  await page.fill(`${form("oipe", "add-cash")} [name=amount]`, "10");
  await page.click(`${form("oipe", "add-cash")} button`);
  await page.waitForFunction(() => document.querySelectorAll("#tab-oipe .cash tr").length === 1);
  await page.fill(`${form("oipe", "add-deposit")} [name=date]`, "2026-11-02");
  await page.fill(`${form("oipe", "add-deposit")} [name=amount]`, "1800");
  await page.click(`${form("oipe", "add-deposit")} button`);
  await page.waitForFunction(() => document.querySelectorAll("#tab-oipe .deposits tr").length === 1);

  // 1980 + 10 EUR x 4.40 = 2024; result vs 1800 deposited
  assert.equal(await page.textContent("#tab-oipe .account-summary"),
    "Wartość: 2024,00 PLN (pozycje 1980,00 + gotówka 44,00) · Wpłaty: 1800,00 PLN · Wynik: 224,00 PLN (12,44%)");
  assert.deepEqual(await tabRows(app, "oipe", "cash"), [["EUR", "10,00", "44,00", "Usuń"]]);
  assert.equal(await page.textContent("#tab-oipe .limit-label"), "Wpłaty w 2026: 1800,00 z 28\u00a0260,00 zł (6,37%)");

  await page.click("[data-tab=dashboard]");
  assert.deepEqual((await app.rows("#alloc-table")).at(-1), ["OIPE", "2024,00", "20,11%", "224,00"]);
  assert.equal(await page.getAttribute("#alloc-bar .seg:last-child", "class"), "seg s6");
  assert.equal(await page.textContent("#hero-value"), "10\u00a0065,40 PLN"); // Polish group separator: no-break space
  await app.close();
});

test("cash: saving a currency again replaces it, 0 removes it, delete works", async () => {
  const app = await open({}, { tab: "ike" });
  const { page } = app;
  const f = form("ike", "add-cash");
  const setCash = async (currency, amount) => {
    await page.selectOption(`${f} [name=currency]`, currency);
    await page.fill(`${f} [name=amount]`, amount);
    await page.click(`${f} button`);
    await page.waitForFunction(() => !/Pobieranie/.test(document.querySelector("#status").textContent));
  };
  await setCash("PLN", "100");
  await setCash("EUR", "5");
  await setCash("PLN", "250");
  assert.deepEqual((await app.saved()).cash.map((c) => [c.account, c.currency, c.amount]), [["ike", "EUR", 5], ["ike", "PLN", 250]]);
  await setCash("EUR", "0");
  assert.deepEqual((await app.saved()).cash.map((c) => c.currency), ["PLN"]);
  await page.locator("#tab-ike .cash button").click();
  await page.locator("#tab-ike .cash button").click();
  await page.waitForFunction(() => document.querySelectorAll("#tab-ike .cash tr").length === 0);
  assert.deepEqual((await app.saved()).cash, []);
  await app.close();
});

test("OIPE limit: over-limit warning, user override; last year's deposits not counted", async () => {
  const data = structuredClone(SEED);
  data.deposits = [{ id: "d1", account: "oipe", date: "2026-02-01", amount: 30000 },
                   { id: "d2", account: "oipe", date: "2025-12-20", amount: 5000 }];
  const app = await open({ data }, { tab: "oipe" });
  const { page } = app;
  assert.equal(await page.textContent("#tab-oipe .limit-label"),
    "Wpłaty w 2026: 30\u00a0000,00 z 28\u00a0260,00 zł (106,16%) · przekroczono limit o 1740,00 zł");
  assert.equal(await page.getAttribute("#tab-oipe .meter-fill", "class"), "meter-fill over");

  await page.fill(`${form("oipe", "set-limit")} [name=limit]`, "40000");
  await page.click(`${form("oipe", "set-limit")} button`);
  await page.waitForFunction(() => /Zapisano limit/.test(document.querySelector("#status").textContent));
  assert.deepEqual((await app.saved()).limits, { 2026: { oipe: 40000 } });
  assert.equal(await page.textContent("#tab-oipe .limit-label"), "Wpłaty w 2026: 30\u00a0000,00 z 40\u00a0000,00 zł (75,00%)");
  assert.equal(await page.getAttribute("#tab-oipe .meter-fill", "class"), "meter-fill");
  await app.close();
});

test("add transaction: selling more than held is refused and nothing is saved", async () => {
  const app = await open({}, { tab: "regular" });
  const { page } = app;
  const f = form("regular", "add-tx");
  await page.fill(`${f} [name=symbol]`, "CDR.WA");
  await page.selectOption(`${f} [name=side]`, "sell");
  await page.fill(`${f} [name=qty]`, "11");
  await page.fill(`${f} [name=price]`, "130");
  await page.click(`${f} button[type=submit]`);
  await page.waitForFunction(() => document.querySelector("#status").className === "error");
  assert.match(await app.status(), /CDR\.WA \(Maklerskie\): sprzedaż 11 szt\. .*posiadane tylko 10/);
  assert.equal((await app.saved()).transactions.length, 2);
  await app.close();
});

test("add transaction: unknown symbol is reported", async () => {
  const app = await open({}, { tab: "regular" });
  const { page } = app;
  const f = form("regular", "add-tx");
  await page.fill(`${f} [name=symbol]`, "NOPE");
  await page.fill(`${f} [name=qty]`, "1");
  await page.fill(`${f} [name=price]`, "1");
  await page.click(`${f} button[type=submit]`);
  await page.waitForFunction(() => document.querySelector("#status").className === "error");
  assert.match(await app.status(), /Nie udało się pobrać notowań NOPE \(HTTP 404/);
  assert.equal((await app.saved()).transactions.length, 2);
  await app.close();
});

test("delete needs two clicks; deleting a buy that a sell depends on is refused", async () => {
  const data = structuredClone(SEED);
  data.transactions.push({ id: "t3", account: "regular", symbol: "CDR.WA", side: "sell", date: "2026-05-01", qty: 4, price: 150, fee: 0, currency: "PLN", fx: 1 });
  const app = await open({ data }, { tab: "regular" });
  const { page } = app;
  const button = (date) => page.locator("#tab-regular .transactions tr", { hasText: date }).locator("button");

  await button("2026-01-10").click();
  assert.equal(await button("2026-01-10").textContent(), "Na pewno?");
  await button("2026-01-10").click();
  assert.match(await app.status(), /sprzedaż 4 szt\. 2026-05-01, a posiadane tylko 0/);
  assert.equal((await app.saved()).transactions.length, 3);

  await button("2026-05-01").click();
  await button("2026-05-01").click();
  await page.waitForFunction(() => document.querySelectorAll("#tab-regular .transactions tr").length === 1);
  assert.deepEqual((await app.saved()).transactions.map((t) => t.id), ["t1", "t2"]);
  await app.close();
});

test("bonds: add ROR, table shows period, rate, accrued interest; delete", async () => {
  const app = await open({}, { tab: "bonds" });
  const { page } = app;
  await page.fill("#add-bond [name=series]", "ror1127");
  await page.fill("#add-bond [name=date]", "2026-11-14");
  await page.fill("#add-bond [name=qty]", "20");
  await page.fill("#add-bond [name=firstRate]", "4");
  await page.click("#add-bond button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll("#bonds tr").length === 2);
  assert.deepEqual(await app.rows("#bonds"), [
    // 1 day of 4%: 0.01 per bond; the early-redemption fee in month 1 is capped at accrued interest
    ["ROR1127", "20", "2026-11-14", "2027-11-14", "1/12", "4%", "0,00", "0,20", "2000,20", "2000,00", "Usuń"],
    ["ROR1127", "10", "2026-11-02", "2027-11-02", "1/12", "4%", "0,00", "1,40", "1001,40", "1000,00", "Usuń"],
  ]);
  assert.equal((await app.saved()).bonds.at(-1).series, "ROR1127");

  await page.fill("#add-bond [name=series]", "EDO1136");
  await page.fill("#add-bond [name=qty]", "1");
  await page.fill("#add-bond [name=firstRate]", "6");
  await page.click("#add-bond button[type=submit]");
  assert.equal(await app.status(), "Seria w formacie ROR1127");

  await page.locator("#bonds tr", { hasText: "2026-11-02" }).locator("button").click();
  await page.locator("#bonds tr", { hasText: "2026-11-02" }).locator("button").click();
  await page.waitForFunction(() => document.querySelectorAll("#bonds tr").length === 1);
  assert.equal((await app.saved()).bonds.length, 1);
  await app.close();
});

test("bond reminders on the dashboard: upcoming and matured", async () => {
  const data = structuredClone(SEED);
  data.bonds.push({ id: "b2", type: "ROR", series: "ROR1126", date: "2025-11-20", qty: 3, firstRate: 5.75, margin: 0 },
                  { id: "b3", type: "ROR", series: "ROR1026", date: "2025-10-08", qty: 1, firstRate: 5.75, margin: 0 });
  const app = await open({ data });
  assert.deepEqual(await app.page.$$eval("#reminders-list li", (els) => els.map((e) => e.textContent)), [
    "ROR1026 (1 szt.): wykupiona 2026-10-08. Możesz ją usunąć z zakładki Obligacje.",
    "ROR1126 (3 szt.): wykup 2026-11-20, za 5 dni. Wróci 300,00 zł plus odsetki za ostatni miesiąc. Zdecyduj, czy wypłacić, czy zamienić na nową serię.",
  ]);
  assert.doesNotMatch(await app.page.textContent("#hero-pl"), /bez kursu/); // matured bond is not "unpriced"
  await app.close();
});

test("savings: add EUR account valued in PLN, update balance resets the date", async () => {
  const app = await open({}, { tab: "savings" });
  const { page } = app;
  await page.fill("#add-savings [name=name]", "Gotówka EUR");
  await page.selectOption("#add-savings [name=currency]", "EUR");
  await page.fill("#add-savings [name=balance]", "100");
  await page.fill("#add-savings [name=rate]", "2");
  await page.click("#add-savings button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll("#savings tr").length === 2);
  const row = page.locator("#savings tr", { hasText: "Gotówka EUR" });
  assert.equal(await row.locator("td").nth(6).textContent(), "440,00");

  const konto = page.locator("#savings tr", { hasText: "Konto" });
  await konto.locator("input").fill("1500");
  await konto.locator("button", { hasText: "Zapisz saldo" }).click();
  await page.waitForFunction(() => document.querySelector("#savings tr td:nth-child(4)").textContent === "2026-11-15");
  const saved = (await app.saved()).savings.find((s) => s.id === "s1");
  assert.deepEqual([saved.balance, saved.since], [1500, "2026-11-15"]);
  await app.close();
});

test("tabs: switching shows one panel and survives a reload", async () => {
  const app = await open();
  const { page } = app;
  await page.click("[data-tab=bonds]");
  assert.deepEqual(await page.$$eval("[role=tabpanel]", (ps) => ps.filter((p) => !p.hidden).map((p) => p.id)), ["tab-bonds"]);
  assert.equal(await page.getAttribute("[data-tab=bonds]", "aria-selected"), "true");
  await page.reload();
  await page.waitForSelector("#tab-bonds:not([hidden])");
  await app.close();
});

test("refresh saves market data; offline start shows it marked as cached", async () => {
  const online = await open();
  const cache = (await online.saved()).cache;
  assert.deepEqual(Object.keys(cache.quotes).sort(), ["CDR.WA", "VWCE.DE"]);
  assert.equal(cache.fx.EUR.rate, 4.4);
  assert.equal(cache.refRates.rates.length, 3);
  const file = await online.saved();
  await online.close();

  const app = await open({ data: file, offline: true }, { tab: "ike" });
  assert.equal(await app.status(), "Brak połączenia, nic nie udało się odświeżyć. Pokazuję zapisane dane z 15.11.2026, 12:00 (oznaczone *).");
  assert.deepEqual((await tabRows(app, "ike", "positions")).map((r) => [r[3], r[7]]), [["110,00 *", "4840,00"]]);
  assert.equal(await app.page.textContent("#hero-value"), "8041,40 PLN");
  await app.close();
});

test("offline without saved data: values missing, nothing invented", async () => {
  const app = await open({ offline: true });
  assert.match(await app.page.textContent("#hero-pl"), /bez kursu: 3/); // 2 ETFs + 1 bond (no NBP rates); PLN savings need no rate
  await app.close();
});

test("XTB import: preview, backup before saving, positions from the reports", async () => {
  const data = structuredClone(SEED);
  data.transactions.push({ id: "m1", account: "ike", symbol: "VWCE.DE", side: "buy", date: "2026-09-25", qty: 4, price: 110, fee: 0, currency: "EUR", fx: 4.4 });
  const app = await open({ data, fx: { EUR: 4.4, "EUR|2026-02-02": 4.2, "EUR|2026-06-01": 4.25, "EUR|2026-03-10": 4.3 } }, { tab: "dashboard" });
  const { page } = app;
  await page.setInputFiles("#xtb-files", [
    `${FIXTURES}IKE_11111111_2026-01-01_2026-11-15.xlsx`, `${FIXTURES}EUR_22222222_2026-01-01_2026-11-15.xlsx`]);
  await page.waitForSelector("#xtb-preview:not([hidden])");
  assert.deepEqual(await page.$$eval("#xtb-summary li", (els) => els.map((e) => e.textContent)), [
    "IKE_11111111_2026-01-01_2026-11-15.xlsx: IKE, waluta PLN, 3 transakcji (VWCE.DE)",
    "EUR_22222222_2026-01-01_2026-11-15.xlsx: Maklerskie, waluta EUR, 1 transakcji (EUNL.DE)",
    "Usunięte ręczne transakcje tych samych symboli na tych kontach: 2026-02-10 VWCE.DE (IKE) 10 szt.; 2026-09-25 VWCE.DE (IKE) 4 szt.",
  ]);
  assert.equal((await app.saved()).transactions.length, 3); // nothing saved before confirming

  await page.click("#xtb-confirm");
  await page.waitForSelector("#xtb-preview", { state: "hidden" });
  const state = await page.evaluate(() => window.__state);
  assert.ok(state.invokes.indexOf("backup_data") < state.invokes.lastIndexOf("save_data"));
  assert.equal(JSON.parse(state.backup).transactions.length, 3); // backup holds the pre-import data
  const saved = await app.saved();
  assert.deepEqual(saved.transactions.filter((t) => !t.xtb).map((t) => t.id), ["t1"]);
  assert.equal(saved.transactions.filter((t) => t.xtb).length, 4);
  // VWCE.DE on IKE: 4 still open + 2 bought and sold = 4
  assert.deepEqual((await tabRows(app, "regular", "positions")).map((r) => r.slice(0, 2)), [["CDR.WA", "10"], ["EUNL.DE", "10"]]);
  assert.deepEqual((await tabRows(app, "ike", "positions")).map((r) => r.slice(0, 2)), [["VWCE.DE", "4"]]);
  await app.close();
});

test("XTB import: cancel saves nothing; a wrong file is reported", async () => {
  const app = await open({}, { tab: "ike" });
  const { page } = app;
  await page.setInputFiles("#xtb-files", `${FIXTURES}IKE_11111111_2026-01-01_2026-11-15.xlsx`);
  await page.waitForSelector("#xtb-preview:not([hidden])");
  await page.click("#xtb-cancel");
  assert.equal(await page.isHidden("#xtb-preview"), true);
  assert.equal((await app.saved()).transactions.length, 2);

  await page.setInputFiles("#xtb-files", { name: "notatki.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("nie xlsx") });
  await page.waitForFunction(() => document.querySelector("#status").className === "error");
  assert.match(await app.status(), /Import XTB: To nie jest plik XLSX/);
  await app.close();
});

test("export writes a copy and reports where", async () => {
  const app = await open();
  await app.page.click("#export");
  await app.page.waitForFunction(() => /Zapisano kopię/.test(document.querySelector("#status").textContent));
  assert.equal(await app.status(), "Zapisano kopię danych: /fake/Downloads/skarbiec-kopia-2026-11-15_12-00-00.json");
  await app.close();
});

test("unreadable data file: forms are disabled so nothing can overwrite it", async () => {
  const app = await open({ loadError: true });
  await app.page.waitForFunction(() => document.querySelector("#status").className === "error");
  assert.equal(await app.status(), "Nie udało się wczytać danych: permission denied");
  const disabled = await app.page.$$eval("form button", (bs) => bs.map((b) => b.disabled));
  assert.equal(disabled.length, 4 + 3 * 2 + 2); // OIPE 4 forms, other accounts 2, bonds, savings
  assert.ok(disabled.every(Boolean));
  const state = await app.page.evaluate(() => window.__state);
  assert.ok(!state.invokes.includes("save_data"));
  await app.close();
});
