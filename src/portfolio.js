export const ACCOUNTS = { regular: "Zwykłe", ike: "IKE", ikze: "IKZE" };

// Pure portfolio math, no I/O, so it runs in the webview and under `node --test`.
//
// Transaction: { id, account: keyof ACCOUNTS, symbol, side: "buy"|"sell",
//                date: "YYYY-MM-DD", qty, price, fee, currency, fx }
// Positions are per (account, symbol): shares bought on IKE cannot be sold from a regular account.
// price and fee are in the instrument currency, fx is PLN per 1 unit of it
// on the trade date (NBP table A).
//
// ponytail: average-cost method. Polish tax (PIT-38) uses FIFO; add a FIFO
// variant when tax reporting is needed.
export function positions(transactions) {
  const map = new Map();
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const account = t.account ?? "regular";
    const key = `${account}|${t.symbol}`;
    const p = map.get(key) ?? {
      account, symbol: t.symbol, currency: t.currency,
      qty: 0, cost: 0, costPln: 0, realized: 0, realizedPln: 0,
    };
    const gross = t.qty * t.price;
    if (t.side === "buy") {
      p.qty += t.qty;
      p.cost += gross + t.fee;
      p.costPln += (gross + t.fee) * t.fx;
    } else {
      if (t.qty > p.qty + 1e-9) {
        throw new Error(`${t.symbol} (${ACCOUNTS[account]}): sprzedaż ${t.qty} szt. ${t.date}, a posiadane tylko ${p.qty}`);
      }
      const share = t.qty / p.qty;
      const out = p.cost * share;
      const outPln = p.costPln * share;
      p.realized += gross - t.fee - out;
      p.realizedPln += (gross - t.fee) * t.fx - outPln;
      p.qty -= t.qty;
      p.cost -= out;
      p.costPln -= outPln;
    }
    map.set(key, p);
  }
  return [...map.values()];
}

// XTB symbol suffix -> Yahoo suffix. Unknown suffixes (e.g. .DE) pass through unchanged.
const XTB_TO_YAHOO = { PL: "WA", US: "", UK: "L", FR: "PA", NL: "AS", IT: "MI", ES: "MC", CH: "SW", PT: "LS", BE: "BR", DK: "CO", SE: "ST", NO: "OL", FI: "HE" };

export function yahooSymbol(symbol) {
  const s = symbol.trim().toUpperCase();
  const m = s.match(/^(.+)\.([A-Z]{2})$/);
  if (!m || !(m[2] in XTB_TO_YAHOO)) return s;
  const suffix = XTB_TO_YAHOO[m[2]];
  return suffix ? `${m[1]}.${suffix}` : m[1];
}

// Savings account: { id, name, currency, balance, rate (% p.a.), since: "YYYY-MM-DD" (balance date) }.
// ponytail: simple daily interest on the last entered balance, no compounding or tax; the user
// re-enters the balance (which then includes paid interest) to resync.
export function savings(acc, asOf) {
  const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(acc.since)) / 86400000));
  const r = acc.rate / 100;
  const accrued = Math.round(acc.balance * r * (days / 365) * 100) / 100;
  return { accrued, value: acc.balance + accrued, monthly: Math.round((acc.balance * r) / 12 * 100) / 100 };
}
