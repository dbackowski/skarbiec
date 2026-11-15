import { ACCOUNTS, positions, savings, yahooSymbol } from "./portfolio.js";
import { ror, parseNbpRefRates } from "./bonds.js";
import { readXlsx } from "./xlsx.js";
import { parseXtbReport } from "./xtb.js";

const { invoke } = window.__TAURI__.core;
const http = window.__TAURI__.http;

let data = { transactions: [], bonds: [], savings: [] };
let refRates = null; // NBP reference rate history, fetched when there are bonds
const quotes = {}; // symbol -> { price, currency }
const fxNow = { PLN: 1 }; // currency -> PLN per unit, today

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 4 });
const money = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD

function status(msg, isError = false) {
  $("#status").textContent = msg;
  $("#status").className = isError ? "error" : "";
}

async function getJson(url) {
  const r = await http.fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

// ponytail: unofficial Yahoo endpoint, no key. Swap the source here if it breaks.
async function fetchQuote(symbol) {
  let j;
  try {
    j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  } catch (e) {
    throw new Error(`Nie udało się pobrać notowań ${symbol} (${e.message ?? e})`);
  }
  const m = j?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) throw new Error(`Nie znaleziono notowań dla ${symbol}`);
  // London quotes come in pence.
  if (m.currency === "GBp") return { price: m.regularMarketPrice / 100, currency: "GBP" };
  return { price: m.regularMarketPrice, currency: m.currency };
}

// NBP table A mid rate from the last publication on or before `date`.
async function fetchFx(currency, date) {
  if (currency === "PLN") return 1;
  const end = new Date(date);
  const start = new Date(end);
  start.setDate(start.getDate() - 10); // covers weekends and holidays
  const iso = (d) => d.toISOString().slice(0, 10);
  const j = await getJson(
    `https://api.nbp.pl/api/exchangerates/rates/a/${currency.toLowerCase()}/${iso(start)}/${iso(end)}/?format=json`,
  );
  return j.rates.at(-1).mid;
}

// Persist first, then swap in-memory state, so a failed write leaves both consistent.
async function persist(patch) {
  const next = { ...data, ...patch };
  await invoke("save_data", { data: JSON.stringify(next, null, 2) });
  data = next;
}

async function fetchRefRates() {
  const r = await http.fetch("https://static.nbp.pl/dane/stopy/stopy_procentowe_archiwum.xml");
  if (!r.ok) throw new Error(`HTTP ${r.status}: stopy NBP`);
  return parseNbpRefRates(await r.text());
}

// Two clicks to delete: window.confirm is not available in every Tauri webview.
function deleteButton(onConfirm) {
  const td = document.createElement("td");
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Usuń";
  del.addEventListener("click", async () => {
    if (del.textContent === "Usuń") { del.textContent = "Na pewno?"; return; }
    try {
      await onConfirm();
    } catch (e) {
      return status(e.message ?? String(e), true);
    }
    render();
  });
  td.append(del);
  return td;
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

const sign = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");

function render() {
  const order = Object.keys(ACCOUNTS);
  const open = positions(data.transactions)
    .filter((p) => p.qty > 1e-9)
    .sort((a, b) => order.indexOf(a.account) - order.indexOf(b.account) || a.symbol.localeCompare(b.symbol));
  const rows = open.map((p) => {
    const q = quotes[p.symbol];
    const fx = fxNow[p.currency];
    const value = q ? p.qty * q.price : null;
    const valuePln = value != null && fx ? value * fx : null;
    return { p, q, value, valuePln, pl: value != null ? value - p.cost : null,
             plPln: valuePln != null ? valuePln - p.costPln : null };
  });

  $("#positions").replaceChildren(...rows.map(({ p, q, value, valuePln, pl, plPln }) => {
    const tr = document.createElement("tr");
    const dash = "–";
    tr.append(
      cell(p.symbol),
      cell(ACCOUNTS[p.account]),
      cell(num.format(p.qty)),
      cell(`${money.format(p.cost / p.qty)} ${p.currency}`),
      cell(q ? money.format(q.price) : dash),
      cell(value != null ? money.format(value) : dash),
      cell(pl != null ? money.format(pl) : dash, sign(pl)),
      cell(pl != null ? `${money.format((pl / p.cost) * 100)}%` : dash, sign(pl)),
      cell(valuePln != null ? money.format(valuePln) : dash),
      cell(plPln != null ? money.format(plPln) : dash, sign(plPln)),
    );
    return tr;
  }));

  const bondRows = renderBonds();
  const savingRows = renderSavings();
  const missing = rows.filter((r) => r.valuePln == null).length + data.bonds.length - bondRows.length
    + data.savings.length - savingRows.length;
  const parts = allocation(rows, bondRows, savingRows);
  renderDashboard(rows, parts, missing);
  $("#accounts").textContent = parts.filter((x) => x.key in ACCOUNTS && x.value > 0)
    .map((x) => `${ACCOUNTS[x.key]}: ${money.format(x.value)} PLN (zysk ${money.format(x.pl)})`).join(" · ");

  const txs = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date));
  $("#transactions").replaceChildren(...txs.map((t) => {
    const tr = document.createElement("tr");
    const td = deleteButton(async () => {
      const next = data.transactions.filter((x) => x.id !== t.id);
      positions(next); // removing a buy may leave a later sell uncovered
      await persist({ transactions: next });
    });
    tr.append(
      cell(t.date), cell(t.symbol), cell(ACCOUNTS[t.account] + (t.xtb ? " · XTB" : "")), cell(t.side === "buy" ? "Kupno" : "Sprzedaż"),
      cell(num.format(t.qty)), cell(`${money.format(t.price)} ${t.currency}`),
      cell(money.format(t.fee)), cell(num.format(t.fx)), td,
    );
    return tr;
  }));
}

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const pct = (x) => `${money.format(x * 100)}%`;
// style goes through CSSOM: the CSP blocks inline style attributes, not element.style.
const el = (tag, { style, ...props } = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  if (style) Object.assign(e.style, style);
  e.append(...children);
  return e;
};

// Fixed part order = fixed color slot per part (color follows the entity, not its rank).
function allocation(rows, bondRows, savingRows) {
  const priced = rows.filter((r) => r.valuePln != null);
  return [
    ...Object.entries(ACCOUNTS).map(([key, label]) => {
      const rs = priced.filter((r) => r.p.account === key);
      return { key, label: `ETF i akcje · ${label}`, value: sum(rs, (r) => r.valuePln),
               pl: sum(rs, (r) => r.plPln), cost: sum(rs, (r) => r.p.costPln) };
    }),
    { key: "bonds", label: "Obligacje", value: sum(bondRows, (r) => r.valuePln),
      pl: sum(bondRows, (r) => r.plPln), cost: sum(bondRows, (r) => r.cost) },
    { key: "savings", label: "Oszczędności", value: sum(savingRows, (r) => r.valuePln),
      pl: sum(savingRows, (r) => r.plPln), cost: sum(savingRows, (r) => r.cost) },
  ].map((x, i) => ({ ...x, slot: i + 1 }));
}

function renderDashboard(rows, parts, missing) {
  const total = sum(parts, (x) => x.value);
  const pl = sum(parts, (x) => x.pl);
  const cost = sum(parts, (x) => x.cost);
  $("#hero-value").textContent = `${money.format(total)} PLN`;
  $("#hero-pl").replaceChildren(
    "Zysk: ",
    el("span", { className: sign(pl), textContent: `${money.format(pl)} PLN${cost ? ` (${pct(pl / cost)})` : ""}` }),
    missing ? ` · bez kursu: ${missing}` : "",
  );

  const etf = parts.filter((x) => x.key in ACCOUNTS);
  const bonds = parts.find((x) => x.key === "bonds");
  const cash = parts.find((x) => x.key === "savings");
  const tile = (label, value, sub, cls = "") => el("div", { className: "tile" },
    el("div", { className: "label", textContent: label }),
    el("div", { className: "value", textContent: value }),
    el("div", { className: `sub ${cls}`, textContent: sub }));
  const etfPl = sum(etf, (x) => x.pl);
  $("#kpis").replaceChildren(
    tile("ETF i akcje", `${money.format(sum(etf, (x) => x.value))} PLN`, `zysk ${money.format(etfPl)} PLN`, sign(etfPl)),
    tile("Obligacje", `${money.format(bonds.value)} PLN`, `odsetki ${money.format(bonds.pl)} PLN`, sign(bonds.pl)),
    tile("Oszczędności", `${money.format(cash.value)} PLN`, `narosłe odsetki ${money.format(cash.pl)} PLN`, sign(cash.pl)),
    tile("Wpłacony kapitał", `${money.format(cost)} PLN`, "koszt zakupu otwartych pozycji"),
  );

  // Tall segmented bar: one whole split into <= 4 parts; zero parts draw nothing.
  const shown = parts.filter((x) => x.value > 0);
  const share = (x) => (total ? x.value / total : 0);
  $("#alloc-bar").setAttribute("aria-label",
    shown.map((x) => `${x.label}: ${money.format(x.value)} PLN, ${pct(share(x))}`).join("; ") || "Brak danych");
  $("#alloc-bar").replaceChildren(...shown.map((x) => el("div", {
    className: `seg s${x.slot}`,
    style: { flexGrow: String(x.value) },
    title: `${x.label}: ${money.format(x.value)} PLN (${pct(share(x))})`,
    tabIndex: 0,
    // Share printed only where it fits; the table below always has it.
    textContent: share(x) >= 0.08 ? `${Math.round(share(x) * 100)}%` : "",
  })));
  $("#alloc-legend").replaceChildren(...shown.map((x) =>
    el("li", {}, el("span", { className: `swatch s${x.slot}` }), x.label)));
  $("#alloc-table").replaceChildren(...shown.map((x) => el("tr", {},
    cell(x.label), cell(money.format(x.value)), cell(pct(share(x))), cell(money.format(x.pl), sign(x.pl)))));

  // Ranked bars, one hue: largest ETF/stock positions by PLN value.
  const top = rows.filter((r) => r.valuePln != null).sort((a, b) => b.valuePln - a.valuePln).slice(0, 8);
  const max = top[0]?.valuePln ?? 1;
  $("#top-positions").replaceChildren(...top.map((r) => el("div", { className: "rank-row" },
    el("div", { className: "rank-name", textContent: `${r.p.symbol} · ${ACCOUNTS[r.p.account]}` }),
    el("div", { className: "rank-track" }, el("div", {
      className: "rank-bar",
      style: { width: `${(r.valuePln / max) * 100}%` },
      title: `${r.p.symbol}: ${money.format(r.valuePln)} PLN, zysk ${money.format(r.plPln)} PLN`,
    })),
    el("div", { className: "rank-value", textContent: `${money.format(r.valuePln)} PLN` }),
  )));
  if (!top.length) $("#top-positions").textContent = "Brak pozycji z kursem.";
}

// Renders the bonds table; returns rows that count toward the PLN total.
function renderBonds() {
  const dash = "–";
  const counted = [];
  const bonds = [...data.bonds].sort((a, b) => b.date.localeCompare(a.date));
  $("#bonds").replaceChildren(...bonds.map((b) => {
    const tr = document.createElement("tr");
    let r = null;
    try {
      if (refRates) r = ror(b, refRates, today());
    } catch (e) {
      status(e.message, true);
    }
    if (r && !r.matured) counted.push({ valuePln: r.value, plPln: r.paid + r.accrued, cost: b.qty * 100 });
    tr.append(
      cell(b.series), cell(num.format(b.qty)), cell(b.date), cell(r ? r.maturity : dash),
      cell(r ? (r.matured ? "wykupiona" : `${r.current.period}/12`) : dash),
      cell(r?.current ? `${num.format(r.current.rate)}%` : dash),
      cell(r ? money.format(r.paid) : dash),
      cell(r ? money.format(r.accrued) : dash),
      cell(r ? money.format(r.value) : dash),
      cell(r ? money.format(r.redeemNow) : dash),
      deleteButton(() => persist({ bonds: data.bonds.filter((x) => x.id !== b.id) })),
    );
    return tr;
  }));
  return counted;
}

// Renders the savings table; returns rows that count toward the PLN total.
function renderSavings() {
  const counted = [];
  $("#savings").replaceChildren(...data.savings.map((a) => {
    const s = savings(a, today());
    const fx = fxNow[a.currency];
    if (fx) counted.push({ valuePln: s.value * fx, plPln: s.accrued * fx, cost: a.balance * fx });
    const input = el("input", { type: "number", step: "0.01", min: "0", value: String(a.balance), className: "inline" });
    const save = el("button", { type: "button", textContent: "Zapisz saldo", className: "secondary" });
    save.addEventListener("click", async () => {
      const balance = Number(input.value);
      if (!(balance >= 0)) return status("Saldo musi być ≥ 0", true);
      try {
        await persist({ savings: data.savings.map((x) => (x.id === a.id ? { ...x, balance, since: today() } : x)) });
      } catch (e) {
        return status(e.message ?? String(e), true);
      }
      render();
    });
    return el("tr", {},
      cell(a.name), cell(`${num.format(a.rate)}%`), cell(`${money.format(a.balance)} ${a.currency}`), cell(a.since),
      cell(money.format(s.accrued)), cell(money.format(s.monthly)),
      cell(fx ? money.format(s.value * fx) : "–"),
      el("td", {}, input, save),
      deleteButton(() => persist({ savings: data.savings.filter((x) => x.id !== a.id) })),
    );
  }));
  return counted;
}

async function addSavings(e) {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const name = f.get("name").trim();
  const currency = f.get("currency");
  const balance = Number(f.get("balance"));
  const rate = Number(f.get("rate"));
  if (!name) return status("Podaj nazwę konta", true);
  if (!(balance >= 0) || !(rate >= 0)) return status("Saldo i oprocentowanie muszą być ≥ 0", true);
  try {
    await persist({ savings: [...data.savings, { id: crypto.randomUUID(), name, currency, balance, rate, since: today() }] });
    form.reset();
    await refresh();
  } catch (err) {
    status(err.message ?? String(err), true);
  }
}

async function refresh() {
  const open = positions(data.transactions).filter((p) => p.qty > 1e-9);
  status("Pobieranie kursów…");
  const errors = [];
  await Promise.all([
    ...open.map((p) => fetchQuote(p.symbol)
      .then((q) => { quotes[p.symbol] = q; })
      .catch((e) => errors.push(e.message))),
    ...[...new Set([...open, ...data.savings].map((p) => p.currency))].filter((c) => c !== "PLN").map((c) => fetchFx(c, today())
      .then((r) => { fxNow[c] = r; })
      .catch((e) => errors.push(`Kurs ${c}: ${e.message}`))),
    data.bonds.length && fetchRefRates()
      .then((r) => { refRates = r; })
      .catch((e) => errors.push(`Stopy NBP: ${e.message ?? e}`)),
  ]);
  render();
  status(errors.length ? errors.join(" · ") : `Kursy z ${new Date().toLocaleTimeString("pl-PL")}`, errors.length > 0);
}

let pendingImport = null; // transactions after import, waiting for confirmation

// Reads XTB reports and shows what an import would change; nothing is saved until confirmed.
// Re-importing an XTB account replaces its earlier imported transactions; manual transactions
// for the same account and symbol are dropped so holdings are not counted twice.
async function previewXtb(e) {
  const files = [...e.target.files];
  e.target.value = ""; // allow picking the same files again
  if (!files.length) return;
  status("Wczytywanie raportów…");
  try {
    const reports = [];
    for (const f of files) reports.push(parseXtbReport(await readXlsx(await f.arrayBuffer()), f.name));
    const numbers = reports.map((r) => r.accountNumber);
    if (new Set(numbers).size !== numbers.length) throw new Error("Ten sam rachunek XTB jest w kilku plikach");

    const quotesBySymbol = new Map();
    const nbpCache = new Map();
    const cached = (map, key, load) => (map.has(key) ? map.get(key) : map.set(key, load()).get(key));
    const imported = [];
    for (const r of reports) {
      for (const t of r.trades) {
        const { currency } = await cached(quotesBySymbol, t.symbol, () => fetchQuote(t.symbol));
        const fx = currency === "PLN" ? 1
          : r.currency === "PLN" && t.cashFx ? t.cashFx // XTB's own conversion, matches the PLN it charged
          : await cached(nbpCache, `${currency}|${t.date}`, () => fetchFx(currency, t.date));
        // ponytail: commission is in account currency; converted only for PLN accounts (XTB ETF trades are mostly fee-free).
        const fee = currency === r.currency || r.currency !== "PLN" ? t.feeAccount : t.feeAccount / fx;
        imported.push({ id: crypto.randomUUID(), account: r.account, symbol: t.symbol, side: t.side, date: t.date,
                        qty: t.qty, price: t.price, fee, currency, fx, xtb: { account: r.accountNumber, position: t.position } });
      }
    }

    const keys = new Set(imported.map((t) => `${t.account}|${t.symbol}`));
    const replaced = data.transactions.filter((t) => t.xtb && numbers.includes(t.xtb.account));
    const manual = data.transactions.filter((t) => !t.xtb && keys.has(`${t.account}|${t.symbol}`));
    const next = [...data.transactions.filter((t) => !replaced.includes(t) && !manual.includes(t)), ...imported];
    positions(next); // validates sells against holdings
    pendingImport = next;

    const items = reports.map((r) => {
      const symbols = [...new Set(r.trades.map((t) => t.symbol))].join(", ") || "brak pozycji";
      const skipped = r.skipped.length ? ` · pominięte (nie BUY): ${r.skipped.join(", ")}` : "";
      return `${r.fileName}: ${ACCOUNTS[r.account]}, waluta ${r.currency}, ${r.trades.length} transakcji (${symbols})${skipped}`;
    });
    if (replaced.length) items.push(`Zastąpione wcześniej zaimportowane transakcje: ${replaced.length}`);
    if (manual.length) {
      items.push(`Usunięte ręczne transakcje tych samych symboli na tych kontach: ${
        manual.map((t) => `${t.date} ${t.symbol} (${ACCOUNTS[t.account]}) ${num.format(t.qty)} szt.`).join("; ")}`);
    }
    $("#xtb-summary").replaceChildren(...items.map((text) => el("li", { textContent: text })));
    $("#xtb-preview").hidden = false;
    status("Sprawdź podsumowanie i potwierdź import.");
  } catch (err) {
    status(`Import XTB: ${err.message ?? err}`, true);
  }
}

async function confirmXtb() {
  try {
    await persist({ transactions: pendingImport });
  } catch (err) {
    return status(`Import XTB: ${err.message ?? err}`, true);
  }
  pendingImport = null;
  $("#xtb-preview").hidden = true;
  await refresh();
}

async function addTransaction(e) {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const symbol = yahooSymbol(f.get("symbol"));
  const date = f.get("date");
  const qty = Number(f.get("qty"));
  const price = Number(f.get("price"));
  const fee = Number(f.get("fee") || 0);
  if (!(qty > 0) || !(price > 0) || fee < 0) return status("Ilość i cena muszą być > 0, prowizja ≥ 0", true);
  if (date > today()) return status("Data z przyszłości", true);

  const button = form.querySelector("button");
  button.disabled = true;
  try {
    status(`Sprawdzanie ${symbol}…`);
    const q = await fetchQuote(symbol);
    const fx = await fetchFx(q.currency, date);
    const account = f.get("account");
    if (!(account in ACCOUNTS)) throw new Error("Nieznany typ konta");
    const tx = { id: crypto.randomUUID(), account, symbol, side: f.get("side"), date, qty, price, fee, currency: q.currency, fx };
    positions([...data.transactions, tx]); // throws on overselling
    await persist({ transactions: [...data.transactions, tx] });
    quotes[symbol] = q;
    form.reset();
    form.date.value = today();
    form.account.value = account; // keep the account for the next entry
    await refresh();
  } catch (err) {
    status(err.message ?? String(err), true);
  } finally {
    button.disabled = false;
  }
}

async function addBond(e) {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const series = f.get("series").trim().toUpperCase();
  const date = f.get("date");
  const qty = Number(f.get("qty"));
  const firstRate = Number(f.get("firstRate"));
  const margin = Number(f.get("margin") || 0);
  if (!/^ROR\d{4}$/.test(series)) return status("Seria w formacie ROR1127", true);
  if (!Number.isInteger(qty) || qty <= 0) return status("Liczba obligacji: całkowita > 0", true);
  if (!(firstRate >= 0) || !(margin >= 0)) return status("Oprocentowanie i marża ≥ 0", true);
  if (date > today()) return status("Data z przyszłości", true);
  try {
    await persist({ bonds: [...data.bonds, { id: crypto.randomUUID(), type: "ROR", series, date, qty, firstRate, margin }] });
    form.reset();
    form.date.value = today();
    await refresh();
  } catch (err) {
    status(err.message ?? String(err), true);
  }
}

function showTab(name) {
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", b.dataset.tab === name);
  for (const m of document.querySelectorAll("[role=tabpanel]")) m.hidden = m.id !== `tab-${name}`;
  try { localStorage.setItem("tab", name); } catch {}
}

window.addEventListener("DOMContentLoaded", async () => {
  for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
  let tab = "dashboard";
  try { tab = localStorage.getItem("tab") ?? tab; } catch {}
  showTab(document.querySelector(`[data-tab="${tab}"]`) ? tab : "dashboard");
  $("#add").addEventListener("submit", addTransaction);
  $("#add-bond").addEventListener("submit", addBond);
  $("#add-savings").addEventListener("submit", addSavings);
  $("#xtb-import").addEventListener("click", () => $("#xtb-files").click());
  $("#xtb-files").addEventListener("change", previewXtb);
  $("#xtb-confirm").addEventListener("click", confirmXtb);
  $("#xtb-cancel").addEventListener("click", () => { pendingImport = null; $("#xtb-preview").hidden = true; status(""); });
  $("#refresh").addEventListener("click", refresh);
  for (const form of [$("#add"), $("#add-bond")]) {
    form.date.value = today();
    form.date.max = today();
  }
  try {
    data = { transactions: [], bonds: [], savings: [], ...JSON.parse(await invoke("load_data")) };
    for (const t of data.transactions) t.account ??= "regular"; // pre-account data
  } catch (e) {
    // Do not continue with empty data: the next save would overwrite the file.
    document.querySelectorAll("form button").forEach((b) => { b.disabled = true; });
    return status(`Nie udało się wczytać danych: ${e}`, true);
  }
  render();
  refresh();
});
