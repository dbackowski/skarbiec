// Pure valuation in PLN: what the tables and the dashboard show. No DOM, no I/O.

import { ACCOUNTS, positions, savings } from "./portfolio.js";
import { maturityReminders, ror } from "./bonds.js";

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const ACCOUNT_ORDER = Object.keys(ACCOUNTS);

// quotes: symbol -> { price, currency }; fx: currency -> PLN per unit (PLN: 1).
// Missing quote or FX leaves the PLN fields null ("bez kursu").
export function valuePositions(transactions, quotes, fx) {
  return positions(transactions)
    .filter((p) => p.qty > 1e-9)
    .sort((a, b) => ACCOUNT_ORDER.indexOf(a.account) - ACCOUNT_ORDER.indexOf(b.account) || a.symbol.localeCompare(b.symbol))
    .map((p) => {
      const q = quotes[p.symbol];
      const rate = fx[p.currency];
      const value = q ? p.qty * q.price : null;
      const valuePln = value != null && rate ? value * rate : null;
      return { p, q, value, valuePln,
               pl: value != null ? value - p.cost : null,
               plPln: valuePln != null ? valuePln - p.costPln : null };
    });
}

// rows: every bond with its ror() result (null when NBP rates are missing or invalid);
// counted: unmatured bonds for totals; unpriced: bonds that could not be valued.
export function valueBonds(bonds, refRates, asOf) {
  const rows = [...bonds].sort((a, b) => b.date.localeCompare(a.date)).map((b) => {
    let r = null;
    let error = null;
    if (refRates) {
      try {
        r = ror(b, refRates, asOf);
      } catch (e) {
        error = e.message;
      }
    }
    return { b, r, error };
  });
  return {
    rows,
    counted: rows.filter(({ r }) => r && !r.matured)
      .map(({ b, r }) => ({ valuePln: r.value, plPln: r.paid + r.accrued, cost: b.qty * 100 })),
    unpriced: rows.filter(({ r }) => !r).length,
  };
}

export function valueSavings(accounts, fx, asOf) {
  const rows = accounts.map((a) => {
    const s = savings(a, asOf);
    const rate = fx[a.currency];
    return { a, s, valuePln: rate ? s.value * rate : null, plPln: rate ? s.accrued * rate : null,
             cost: rate ? a.balance * rate : null };
  });
  return { rows, counted: rows.filter((r) => r.valuePln != null) };
}

// Fixed part order = fixed color slot per part (color follows the entity, not its rank).
export function allocation(positionRows, bondRows, savingRows) {
  const priced = positionRows.filter((r) => r.valuePln != null);
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

// Everything the dashboard shows, from the stored data and the market data in memory.
export function portfolio(data, market, asOf) {
  const positionRows = valuePositions(data.transactions, market.quotes, market.fx);
  const bonds = valueBonds(data.bonds, market.refRates, asOf);
  const cash = valueSavings(data.savings, market.fx, asOf);
  const parts = allocation(positionRows, bonds.counted, cash.counted);
  return {
    positionRows, bonds, cash, parts,
    total: sum(parts, (x) => x.value),
    pl: sum(parts, (x) => x.pl),
    cost: sum(parts, (x) => x.cost),
    missing: positionRows.filter((r) => r.valuePln == null).length + bonds.unpriced
      + cash.rows.length - cash.counted.length,
  };
}

const plMoney = (x) => x.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function reminderTexts(bonds, asOf) {
  return maturityReminders(bonds, asOf).map((r) => {
    const amount = `${plMoney(r.qty * 100)} zł`;
    if (r.daysLeft > 0) {
      return `${r.series} (${r.qty} szt.): wykup ${r.maturity}, za ${r.daysLeft} ${r.daysLeft === 1 ? "dzień" : "dni"}. `
        + `Wróci ${amount} plus odsetki za ostatni miesiąc. Zdecyduj, czy wypłacić, czy zamienić na nową serię.`;
    }
    if (r.daysLeft === 0) return `${r.series} (${r.qty} szt.): wykup dzisiaj, ${amount} plus odsetki za ostatni miesiąc.`;
    return `${r.series} (${r.qty} szt.): wykupiona ${r.maturity}. Możesz ją usunąć z zakładki Obligacje.`;
  });
}

// Status line after a refresh. errors: messages; total: number of fetches; oldestCached: ISO time
// of the oldest value still shown from the saved cache (or null); fmtTime formats it.
export function refreshMessage({ errors, total, oldestCached, now, fmtTime }) {
  let msg = !errors.length ? `Kursy z ${now}`
    : errors.length === total && total > 1 ? "Brak połączenia, nic nie udało się odświeżyć"
    : `Nie udało się odświeżyć: ${errors.join(" · ")}`;
  if (oldestCached) msg += `. Pokazuję zapisane dane z ${fmtTime(oldestCached)} (oznaczone *).`;
  return msg;
}
