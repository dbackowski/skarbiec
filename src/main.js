// UI glue: DOM, events and persistence. All calculations live in the imported modules.
import { ACCOUNTS, positions, yahooSymbol } from "./portfolio.js";
import { fetchFx, fetchQuote, fetchRefRates } from "./market.js";
import { DEPOSIT_ACCOUNTS, portfolio, refreshMessage, reminderTexts } from "./valuation.js";
import { readXlsx } from "./xlsx.js";
import { buildImport, importSummary, parseXtbReport } from "./xtb.js";

const { invoke } = window.__TAURI__.core;
const httpFetch = (...args) => window.__TAURI__.http.fetch(...args);

const EMPTY = { transactions: [], bonds: [], savings: [], cash: [], deposits: [], limits: {} };
let data = { ...EMPTY };
// Last fetched market data, also saved in the data file (data.cache) so the app shows the
// last known values when offline. `at` = ISO time of the fetch.
const market = { quotes: {}, fx: { PLN: 1 }, fxAt: {}, refRates: null, refRatesAt: null };
// Keys ("q:SYMBOL", "fx:EUR", "refRates") fetched by the last refresh; anything else on screen
// comes from the saved cache and is marked with "*".
let fresh = new Set();
const fmtTime = (at) => new Date(at).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 4 });
const money = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD
const pct = (x) => `${money.format(x * 100)}%`;
const sign = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const dash = "–";

function status(msg, isError = false) {
  $("#status").textContent = msg;
  $("#status").className = isError ? "error" : "";
}

// Persist first, then swap in-memory state, so a failed write leaves both consistent.
// Writes are queued and each merges into the latest data, so a background cache save
// cannot overwrite a transaction saved a moment earlier.
let saving = Promise.resolve();
function persist(patch) {
  const run = saving.then(async () => {
    const next = { ...data, ...patch };
    await invoke("save_data", { data: JSON.stringify(next, null, 2) });
    data = next;
  });
  saving = run.catch(() => {});
  return run;
}

// style goes through CSSOM: the CSP blocks inline style attributes, not element.style.
const el = (tag, { style, ...props } = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  if (style) Object.assign(e.style, style);
  e.append(...children);
  return e;
};
const cell = (text, cls) => el("td", { textContent: text, ...(cls ? { className: cls } : {}) });

// Two clicks to delete: window.confirm is not available in every Tauri webview.
function deleteButton(onConfirm) {
  const del = el("button", { type: "button", textContent: "Usuń" });
  del.addEventListener("click", async () => {
    if (del.textContent === "Usuń") { del.textContent = "Na pewno?"; return; }
    try {
      await onConfirm();
    } catch (e) {
      return status(e.message ?? String(e), true);
    }
    render();
  });
  return el("td", {}, del);
}

function render() {
  const pf = portfolio(data, market, today());
  for (const acc of pf.accounts) renderAccount(acc);
  renderBonds(pf.bonds);
  renderSavings(pf.cash);
  renderDashboard(pf);
}

const panel = (key) => document.getElementById(`tab-${key}`);

function renderAccount(acc) {
  const tab = panel(acc.key);
  const q = (sel) => tab.querySelector(sel);

  const result = `${money.format(acc.pl)} PLN${acc.cost ? ` (${pct(acc.pl / acc.cost)})` : ""}`;
  q(".account-summary").replaceChildren(
    `Wartość: ${money.format(acc.value)} PLN`,
    acc.cashValue ? ` (pozycje ${money.format(acc.positionsValue)} + gotówka ${money.format(acc.cashValue)})` : "",
    acc.byDeposits ? ` · Wpłaty: ${money.format(acc.depositsTotal)} PLN · Wynik: ` : " · Zysk z pozycji: ",
    el("span", { className: sign(acc.pl), textContent: result }),
    acc.missing ? ` · bez kursu: ${acc.missing}` : "",
  );

  const limited = DEPOSIT_ACCOUNTS.includes(acc.key);
  if (limited) q(".limit").hidden = !acc.limit;
  if (limited) {
    q(".limit-name").textContent = `Limit wpłat ${acc.year} (PLN)`;
    const input = q(".set-limit [name=limit]");
    if (document.activeElement !== input) input.value = acc.limit ?? "";
  }
  if (limited && acc.limit) {
    const over = acc.depositsYear - acc.limit;
    q(".limit-label").replaceChildren(
      `Wpłaty w ${acc.year}: ${money.format(acc.depositsYear)} z ${money.format(acc.limit)} zł (${pct(acc.depositsYear / acc.limit)})`,
      over > 0.005 ? el("span", { className: "down", textContent: ` · przekroczono limit o ${money.format(over)} zł` }) : "",
    );
    const fill = q(".meter-fill");
    fill.style.width = `${Math.min(100, (acc.depositsYear / acc.limit) * 100)}%`;
    fill.classList.toggle("over", over > 0.005);
  }

  q(".positions").replaceChildren(...acc.rows.map(({ p, q: quote, value, valuePln, pl, plPln }) => el("tr", {},
    cell(p.symbol),
    cell(num.format(p.qty)),
    cell(`${money.format(p.cost / p.qty)} ${p.currency}`),
    Object.assign(cell(quote ? `${money.format(quote.price)}${fresh.has(`q:${p.symbol}`) ? "" : " *"}` : dash),
                  { title: quote?.at ? `Kurs z ${fmtTime(quote.at)}` : "" }),
    cell(value != null ? money.format(value) : dash),
    cell(pl != null ? money.format(pl) : dash, sign(pl)),
    cell(pl != null ? pct(pl / p.cost) : dash, sign(pl)),
    cell(valuePln != null ? money.format(valuePln) : dash),
    cell(plPln != null ? money.format(plPln) : dash, sign(plPln)),
  )));

  const txs = data.transactions.filter((t) => t.account === acc.key).sort((a, b) => b.date.localeCompare(a.date));
  q(".transactions").replaceChildren(...txs.map((t) => el("tr", {},
    cell(t.date), cell(t.symbol), cell((t.side === "buy" ? "Kupno" : "Sprzedaż") + (t.xtb ? " · XTB" : "")),
    cell(num.format(t.qty)), cell(`${money.format(t.price)} ${t.currency}`),
    cell(money.format(t.fee)), cell(num.format(t.fx)),
    deleteButton(async () => {
      const next = data.transactions.filter((x) => x.id !== t.id);
      positions(next); // removing a buy may leave a later sell uncovered
      await persist({ transactions: next });
    }),
  )));

  q(".cash").replaceChildren(...acc.cash.map((c) => el("tr", {},
    cell(c.currency), cell(money.format(c.amount)), cell(c.valuePln != null ? money.format(c.valuePln) : dash),
    deleteButton(() => persist({ cash: data.cash.filter((x) => x.id !== c.id) })),
  )));

  q(".deposits")?.replaceChildren(...acc.deposits.map((d) => el("tr", {},
    cell(d.date), cell(money.format(d.amount)),
    deleteButton(() => persist({ deposits: data.deposits.filter((x) => x.id !== d.id) })),
  )));
}

function renderDashboard(pf) {
  const reminders = reminderTexts(data.bonds, today());
  $("#reminders-list").replaceChildren(...reminders.map((text) => el("li", { textContent: text })));
  $("#reminders").hidden = !reminders.length;

  $("#hero-value").textContent = `${money.format(pf.total)} PLN`;
  $("#hero-pl").replaceChildren(
    "Zysk: ",
    el("span", { className: sign(pf.pl), textContent: `${money.format(pf.pl)} PLN${pf.cost ? ` (${pct(pf.pl / pf.cost)})` : ""}` }),
    pf.missing ? ` · bez kursu: ${pf.missing}` : "",
  );

  const etf = pf.parts.filter((x) => x.key in ACCOUNTS);
  const etfValue = etf.reduce((s, x) => s + x.value, 0);
  const etfPl = etf.reduce((s, x) => s + x.pl, 0);
  const bonds = pf.parts.find((x) => x.key === "bonds");
  const cash = pf.parts.find((x) => x.key === "savings");
  const tile = (label, value, sub, cls = "") => el("div", { className: "tile" },
    el("div", { className: "label", textContent: label }),
    el("div", { className: "value", textContent: value }),
    el("div", { className: `sub ${cls}`, textContent: sub }));
  $("#kpis").replaceChildren(
    tile("Konta inwestycyjne", `${money.format(etfValue)} PLN`, `wynik ${money.format(etfPl)} PLN`, sign(etfPl)),
    tile("Obligacje", `${money.format(bonds.value)} PLN`, `odsetki ${money.format(bonds.pl)} PLN`, sign(bonds.pl)),
    tile("Oszczędności", `${money.format(cash.value)} PLN`, `narosłe odsetki ${money.format(cash.pl)} PLN`, sign(cash.pl)),
    tile("Wpłacony kapitał", `${money.format(pf.cost)} PLN`, "wpłaty lub koszt zakupu otwartych pozycji"),
  );

  // Tall segmented bar: one whole split into parts; zero parts draw nothing.
  const shown = pf.parts.filter((x) => x.value > 0);
  const share = (x) => (pf.total ? x.value / pf.total : 0);
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
  const top = pf.positionRows.filter((r) => r.valuePln != null).sort((a, b) => b.valuePln - a.valuePln).slice(0, 8);
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

function renderBonds({ rows }) {
  const error = rows.find((x) => x.error)?.error;
  if (error) status(error, true);
  $("#bonds").replaceChildren(...rows.map(({ b, r }) => el("tr", {},
    cell(b.series), cell(num.format(b.qty)), cell(b.date), cell(r ? r.maturity : dash),
    cell(r ? (r.matured ? "wykupiona" : `${r.current.period}/12`) : dash),
    cell(r?.current ? `${num.format(r.current.rate)}%` : dash),
    cell(r ? money.format(r.paid) : dash),
    cell(r ? money.format(r.accrued) : dash),
    cell(r ? money.format(r.value) : dash),
    cell(r ? money.format(r.redeemNow) : dash),
    deleteButton(() => persist({ bonds: data.bonds.filter((x) => x.id !== b.id) })),
  )));
}

function renderSavings({ rows }) {
  $("#savings").replaceChildren(...rows.map(({ a, s, valuePln }) => {
    const input = el("input", { type: "number", step: "0.01", min: "0", value: String(a.balance), className: "inline" });
    const save = el("button", { type: "button", textContent: "Zapisz saldo", className: "secondary" });
    save.addEventListener("click", async () => {
      const balance = Number(input.value);
      if (input.value === "" || !(balance >= 0)) return status("Saldo musi być ≥ 0", true);
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
      cell(valuePln != null ? money.format(valuePln) : dash),
      el("td", {}, input, save),
      deleteButton(() => persist({ savings: data.savings.filter((x) => x.id !== a.id) })),
    );
  }));
}

async function refresh() {
  const open = positions(data.transactions).filter((p) => p.qty > 1e-9);
  const currencies = [...new Set([...open, ...data.savings, ...data.cash].map((p) => p.currency))].filter((c) => c !== "PLN");
  const now = new Date().toISOString();
  fresh = new Set();
  status("Pobieranie kursów…");
  const errors = [];
  await Promise.all([
    ...open.map((p) => fetchQuote(httpFetch, p.symbol)
      .then((q) => { market.quotes[p.symbol] = { ...q, at: now }; fresh.add(`q:${p.symbol}`); })
      .catch((e) => errors.push(e.message))),
    ...currencies.map((c) => fetchFx(httpFetch, c, today())
      .then((r) => { market.fx[c] = r; market.fxAt[c] = now; fresh.add(`fx:${c}`); })
      .catch((e) => errors.push(`Kurs ${c}: ${e.message ?? e}`))),
    data.bonds.length && fetchRefRates(httpFetch)
      .then((r) => { market.refRates = r; market.refRatesAt = now; fresh.add("refRates"); })
      .catch((e) => errors.push(`Stopy NBP: ${e.message ?? e}`)),
  ]);

  // Values still shown from the saved cache because this refresh could not replace them.
  const cachedAt = [
    ...open.filter((p) => !fresh.has(`q:${p.symbol}`)).map((p) => market.quotes[p.symbol]?.at),
    ...currencies.filter((c) => !fresh.has(`fx:${c}`) && market.fx[c]).map((c) => market.fxAt[c]),
    data.bonds.length && !fresh.has("refRates") && market.refRates && market.refRatesAt,
  ].filter(Boolean).sort();
  render();

  const total = open.length + currencies.length + (data.bonds.length ? 1 : 0);
  let msg = refreshMessage({ errors, total, oldestCached: cachedAt[0], now: new Date().toLocaleTimeString("pl-PL"), fmtTime });
  if (errors.length < total) {
    try {
      await persist({ cache: {
        quotes: market.quotes,
        fx: Object.fromEntries(currencies.filter((c) => market.fx[c]).map((c) => [c, { rate: market.fx[c], at: market.fxAt[c] }])),
        refRates: market.refRates && { rates: market.refRates, at: market.refRatesAt },
      } });
    } catch (e) {
      msg += ` Nie udało się zapisać kursów: ${e.message ?? e}`;
    }
  }
  status(msg, errors.length > 0);
}

let pendingImport = null; // transactions after import, waiting for confirmation

// Reads XTB reports and shows what an import would change; nothing is saved until confirmed.
async function previewXtb(e) {
  const files = [...e.target.files];
  e.target.value = ""; // allow picking the same files again
  if (!files.length) return;
  status("Wczytywanie raportów…");
  try {
    const reports = [];
    for (const f of files) reports.push(parseXtbReport(await readXlsx(await f.arrayBuffer()), f.name));
    const result = await buildImport(reports, data.transactions, {
      quote: (symbol) => fetchQuote(httpFetch, symbol),
      fx: (currency, date) => fetchFx(httpFetch, currency, date),
      newId: () => crypto.randomUUID(),
    });
    pendingImport = result.next;
    $("#xtb-summary").replaceChildren(...importSummary(reports, result).map((text) => el("li", { textContent: text })));
    $("#xtb-preview").hidden = false;
    status("Sprawdź podsumowanie i potwierdź import.");
  } catch (err) {
    status(`Import XTB: ${err.message ?? err}`, true);
  }
}

// Local "YYYY-MM-DD_HH-MM-SS" for backup file names.
const stamp = () => new Date().toLocaleString("sv-SE").replace(" ", "_").replaceAll(":", "-");

async function exportData() {
  try {
    await saving; // include writes still in flight
    status(`Zapisano kopię danych: ${await invoke("export_data", { stamp: stamp() })}`);
  } catch (err) {
    status(`Nie udało się zapisać kopii: ${err.message ?? err}`, true);
  }
}

async function confirmXtb() {
  try {
    await saving;
    // No backup, no import: the import replaces transactions.
    await invoke("backup_data", { stamp: stamp() });
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
  if (!(qty > 0) || !(price > 0) || !(fee >= 0)) return status("Ilość i cena muszą być > 0, prowizja ≥ 0", true);
  if (date > today()) return status("Data z przyszłości", true);

  const button = form.querySelector("button");
  button.disabled = true;
  try {
    status(`Sprawdzanie ${symbol}…`);
    const q = await fetchQuote(httpFetch, symbol);
    const fx = await fetchFx(httpFetch, q.currency, date);
    const account = form.dataset.account;
    if (!(account in ACCOUNTS)) throw new Error("Nieznany typ konta");
    const tx = { id: crypto.randomUUID(), account, symbol, side: f.get("side"), date, qty, price, fee, currency: q.currency, fx };
    positions([...data.transactions, tx]); // throws on overselling
    await persist({ transactions: [...data.transactions, tx] });
    market.quotes[symbol] = { ...q, at: new Date().toISOString() };
    fresh.add(`q:${symbol}`);
    form.reset();
    form.date.value = today();
    await refresh();
  } catch (err) {
    status(err.message ?? String(err), true);
  } finally {
    button.disabled = false;
  }
}

async function setCash(e) {
  e.preventDefault();
  const form = e.target;
  const account = form.closest("[data-account]").dataset.account;
  const currency = form.currency.value;
  const amount = Number(form.amount.value);
  if (form.amount.value === "" || !(amount >= 0)) return status("Kwota gotówki musi być ≥ 0", true);
  const others = data.cash.filter((c) => !(c.account === account && c.currency === currency));
  try {
    await persist({ cash: amount > 0 ? [...others, { id: crypto.randomUUID(), account, currency, amount }] : others });
    form.amount.value = "";
    await refresh();
  } catch (err) {
    status(err.message ?? String(err), true);
  }
}

async function addDeposit(e) {
  e.preventDefault();
  const form = e.target;
  const account = form.closest("[data-account]").dataset.account;
  const amount = Number(form.amount.value);
  const date = form.date.value;
  if (!(amount > 0)) return status("Kwota wpłaty musi być > 0", true);
  if (date > today()) return status("Data z przyszłości", true);
  try {
    await persist({ deposits: [...data.deposits, { id: crypto.randomUUID(), account, date, amount }] });
    form.amount.value = "";
    render();
  } catch (err) {
    status(err.message ?? String(err), true);
  }
}

async function setLimit(e) {
  e.preventDefault();
  const form = e.target;
  const account = form.closest("[data-account]").dataset.account;
  const limit = Number(form.limit.value);
  if (!(limit > 0)) return status("Limit musi być > 0", true);
  const year = today().slice(0, 4);
  try {
    await persist({ limits: { ...data.limits, [year]: { ...data.limits[year], [account]: limit } } });
    status(`Zapisano limit ${ACCOUNTS[account]} na ${year}: ${money.format(limit)} zł`);
    render();
  } catch (err) {
    status(err.message ?? String(err), true);
  }
}

// One tab per investment account, cloned from the template.
function createAccountTabs() {
  const template = $("#account-template");
  for (const key of Object.keys(ACCOUNTS)) {
    const main = el("main", { id: `tab-${key}`, hidden: true });
    main.setAttribute("role", "tabpanel");
    main.dataset.account = key;
    main.append(template.content.cloneNode(true));
    const add = main.querySelector(".add-tx");
    add.dataset.account = key;
    add.addEventListener("submit", addTransaction);
    main.querySelector(".add-cash").addEventListener("submit", setCash);
    if (DEPOSIT_ACCOUNTS.includes(key)) {
      main.querySelector(".add-deposit").addEventListener("submit", addDeposit);
      main.querySelector(".set-limit").addEventListener("submit", setLimit);
    } else {
      main.querySelector(".deposits-section").remove(); // deposits and limits only where they matter
      main.querySelector(".limit").remove();
    }
    $("#tab-bonds").before(main);
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

function showTab(name) {
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", b.dataset.tab === name);
  for (const m of document.querySelectorAll("[role=tabpanel]")) m.hidden = m.id !== `tab-${name}`;
  try { localStorage.setItem("tab", name); } catch {}
}

window.addEventListener("DOMContentLoaded", async () => {
  createAccountTabs();
  for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
  let tab = "dashboard";
  try { tab = localStorage.getItem("tab") ?? tab; } catch {}
  showTab(document.querySelector(`[data-tab="${tab}"]`) ? tab : "dashboard");
  $("#add-bond").addEventListener("submit", addBond);
  $("#add-savings").addEventListener("submit", addSavings);
  $("#xtb-import").addEventListener("click", () => $("#xtb-files").click());
  $("#export").addEventListener("click", exportData);
  $("#xtb-files").addEventListener("change", previewXtb);
  $("#xtb-confirm").addEventListener("click", confirmXtb);
  $("#xtb-cancel").addEventListener("click", () => { pendingImport = null; $("#xtb-preview").hidden = true; status(""); });
  $("#refresh").addEventListener("click", refresh);
  for (const input of document.querySelectorAll("form [name=date]")) {
    input.value = today();
    input.max = today();
  }
  try {
    data = { ...EMPTY, ...JSON.parse(await invoke("load_data")) };
    for (const t of data.transactions) t.account ??= "regular"; // pre-account data
    const cache = data.cache ?? {};
    Object.assign(market.quotes, cache.quotes);
    for (const [c, v] of Object.entries(cache.fx ?? {})) { market.fx[c] = v.rate; market.fxAt[c] = v.at; }
    if (cache.refRates) ({ rates: market.refRates, at: market.refRatesAt } = cache.refRates);
  } catch (e) {
    // Do not continue with empty data: the next save would overwrite the file.
    document.querySelectorAll("form button").forEach((b) => { b.disabled = true; });
    return status(`Nie udało się wczytać danych: ${e}`, true);
  }
  render();
  refresh();
});
