// XTB xStation history report (XLSX: "Open Positions", "Closed Positions", "Cash Operations")
// -> trades. Pure: takes sheets from readXlsx(), no I/O.
//
// Current holdings come from Open Positions (one row per position, complete regardless of the
// report period). Each Closed Positions row becomes a buy at its open and a sell at its close.
// Cash Operations give the real account-currency cost of each buy, i.e. XTB's own FX rate.

import { ACCOUNTS, positions, yahooSymbol } from "./portfolio.js";

const PRODUCT_ACCOUNT = { IKE: "ike", IKZE: "ikze" };

// Excel serial date (UTC) -> "YYYY-MM-DD" in Warsaw time.
export const excelDate = (serial) =>
  new Date(Math.round((serial - 25569) * 86400000)).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

// Rows under the header row whose cells include all `columns`, as objects keyed by header name.
// Stops at the first empty row or a row whose first cell is a footer label.
function table(rows = [], columns) {
  const h = rows.findIndex((r) => r && columns.every((c) => r.includes(c)));
  if (h < 0) return null;
  const header = rows[h];
  const out = [];
  for (const r of rows.slice(h + 1)) {
    if (!r || r.every((v) => v === undefined || v === "")) break;
    if (["Total", "Profit/loss"].includes(r[0])) break;
    out.push(Object.fromEntries(header.map((name, i) => [name, r[i]])));
  }
  return out;
}

const num = (v) => (v === undefined || v === "" ? 0 : Number(v));

export function parseXtbReport(sheets, fileName = "") {
  const open = table(sheets["Open Positions"], ["Instrument/Position", "Ticker", "Type", "Volume", "Open price"]);
  const closed = table(sheets["Closed Positions"], ["Ticker", "Type", "Volume", "Open Price", "Close Price", "Position ID"]);
  const cash = table(sheets["Cash Operations"], ["Type", "Ticker", "Amount", "Comment", "Position ID"]);
  if (!open || !closed || !cash) throw new Error(`${fileName}: to nie wygląda na raport historii z xStation`);

  // The Open Positions sheet of IKE/IKZE reports carries the main account's number; use Cash Operations.
  const accountNumber = String(sheets["Cash Operations"][0]?.[1] ?? "");
  const prefix = fileName.split("_")[0].toUpperCase();
  const product = [...open, ...cash].map((r) => r.Product).find((p) => p) ?? prefix;
  const account = PRODUCT_ACCOUNT[product] ?? PRODUCT_ACCOUNT[prefix] ?? "regular";
  const summary = table(sheets["Open Positions"], ["Product", "Metric", "Amount", "Currency"]) ?? [];
  const currency = summary.find((r) => r.Currency)?.Currency
    ?? (account !== "regular" ? "PLN" : /^[A-Z]{3}$/.test(prefix) ? prefix : "PLN");

  // Account-currency cash paid per position vs its instrument-currency value -> XTB's FX rate.
  const paid = new Map();
  for (const r of cash) {
    const m = r.Type === "Stock purchase" && String(r.Comment).match(/OPEN BUY (?:\S+ )?([\d.]+)(?:\/[\d.]+)? @ ([\d.]+)/);
    if (!m) continue;
    const p = paid.get(r["Position ID"]) ?? { cash: 0, value: 0 };
    p.cash += -num(r.Amount);
    p.value += Number(m[1]) * Number(m[2]);
    paid.set(r["Position ID"], p);
  }
  const fxOf = (id) => {
    const p = paid.get(id);
    return p && p.value > 0 ? p.cash / p.value : null;
  };

  const trades = [];
  const skipped = [];
  for (const r of open) {
    if (!r.Type) continue; // per-instrument summary row
    if (r.Type !== "BUY") { skipped.push(`${r.Ticker} ${r.Type}`); continue; }
    const id = String(r["Instrument/Position"]);
    trades.push({
      position: id, symbol: yahooSymbol(r.Ticker), side: "buy", date: excelDate(r["Open time (UTC)"]),
      qty: num(r.Volume), price: num(r["Open price"]), feeAccount: Math.abs(num(r["Open Commission"])), cashFx: fxOf(id),
    });
  }
  for (const r of closed) {
    if (r.Type !== "BUY") { skipped.push(`${r.Ticker} ${r.Type}`); continue; }
    const id = String(r["Position ID"]);
    const base = { position: id, symbol: yahooSymbol(r.Ticker), qty: num(r.Volume) };
    trades.push({ ...base, side: "buy", date: excelDate(r["Open Time (UTC)"]), price: num(r["Open Price"]),
                  feeAccount: 0, cashFx: fxOf(id) });
    trades.push({ ...base, side: "sell", date: excelDate(r["Close Time (UTC)"]), price: num(r["Close Price"]),
                  feeAccount: Math.abs(num(r.Commission)), cashFx: null });
  }
  return { fileName, accountNumber, account, currency, trades, skipped };
}

// Turns parsed reports into the transaction list to save. `quote(symbol)` resolves the instrument
// currency, `fx(currency, date)` the NBP rate; both are injected (network in the app, fakes in tests).
// Re-importing an XTB account replaces its earlier imported transactions; manual transactions for
// the same account and symbol are dropped so holdings are not counted twice.
export async function buildImport(reports, existing, { quote, fx, newId }) {
  const numbers = reports.map((r) => r.accountNumber);
  if (new Set(numbers).size !== numbers.length) throw new Error("Ten sam rachunek XTB jest w kilku plikach");

  const memo = new Map();
  const once = (key, load) => (memo.has(key) ? memo.get(key) : memo.set(key, load()).get(key));
  const imported = [];
  for (const r of reports) {
    for (const t of r.trades) {
      const { currency } = await once(`q|${t.symbol}`, () => quote(t.symbol));
      const rate = currency === "PLN" ? 1
        : r.currency === "PLN" && t.cashFx ? t.cashFx // XTB's own conversion, matches the PLN it charged
        : await once(`fx|${currency}|${t.date}`, () => fx(currency, t.date));
      // ponytail: commission is in account currency; converted only for PLN accounts (XTB ETF trades are mostly fee-free).
      const fee = currency === r.currency || r.currency !== "PLN" ? t.feeAccount : t.feeAccount / rate;
      imported.push({ id: newId(), account: r.account, symbol: t.symbol, side: t.side, date: t.date,
                      qty: t.qty, price: t.price, fee, currency, fx: rate,
                      xtb: { account: r.accountNumber, position: t.position } });
    }
  }

  const keys = new Set(imported.map((t) => `${t.account}|${t.symbol}`));
  const replaced = existing.filter((t) => t.xtb && numbers.includes(t.xtb.account));
  const manual = existing.filter((t) => !t.xtb && keys.has(`${t.account}|${t.symbol}`));
  const next = [...existing.filter((t) => !replaced.includes(t) && !manual.includes(t)), ...imported];
  positions(next); // validates sells against holdings
  return { next, imported, replaced, manual };
}

const qtyText = (x) => x.toLocaleString("pl-PL", { maximumFractionDigits: 4 });

export function importSummary(reports, { replaced, manual }) {
  const items = reports.map((r) => {
    const symbols = [...new Set(r.trades.map((t) => t.symbol))].join(", ") || "brak pozycji";
    const skipped = r.skipped.length ? ` · pominięte (nie BUY): ${r.skipped.join(", ")}` : "";
    return `${r.fileName}: ${ACCOUNTS[r.account]}, waluta ${r.currency}, ${r.trades.length} transakcji (${symbols})${skipped}`;
  });
  if (replaced.length) items.push(`Zastąpione wcześniej zaimportowane transakcje: ${replaced.length}`);
  if (manual.length) {
    items.push(`Usunięte ręczne transakcje tych samych symboli na tych kontach: ${
      manual.map((t) => `${t.date} ${t.symbol} (${ACCOUNTS[t.account]}) ${qtyText(t.qty)} szt.`).join("; ")}`);
  }
  return items;
}
