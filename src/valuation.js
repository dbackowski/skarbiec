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

// Accounts where the user records deposits. Only OIPE: Finax has no export and converts PLN to EUR
// at its own rate, so deposits are the only way to get its real cost. XTB accounts get exact costs
// from the import.
export const DEPOSIT_ACCOUNTS = ["oipe"];

// Yearly OIPE contribution limit in PLN (3x the forecast average wage). Update every year;
// a limit saved by the user in data.limits takes precedence.
export const LIMITS = {
  2026: { oipe: 28260 },
};

export function limitFor(userLimits, year, account) {
  return userLimits?.[year]?.[account] ?? LIMITS[year]?.[account] ?? null;
}

// One investment account: positions, free cash and (OIPE only) deposits.
// With deposits recorded, the result is what a broker shows: value (positions + cash) - deposits,
// which includes its real FX conversion, fees and cash. Without deposits it falls back to the
// purchase cost of the positions (cash counts at its current value, so it adds no result).
export function accountSummary(key, positionRows, data, fx, asOf) {
  const rows = positionRows.filter((r) => r.p.account === key);
  const priced = rows.filter((r) => r.valuePln != null);
  const cash = (data.cash ?? []).filter((c) => c.account === key)
    .map((c) => ({ ...c, valuePln: fx[c.currency] ? c.amount * fx[c.currency] : null }));
  const deposits = DEPOSIT_ACCOUNTS.includes(key)
    ? (data.deposits ?? []).filter((d) => d.account === key).sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const positionsValue = sum(priced, (r) => r.valuePln);
  const cashValue = sum(cash.filter((c) => c.valuePln != null), (c) => c.valuePln);
  const value = positionsValue + cashValue;
  const depositsTotal = sum(deposits, (d) => d.amount);
  const byDeposits = deposits.length > 0;
  const cost = byDeposits ? depositsTotal : sum(priced, (r) => r.p.costPln) + cashValue;
  const year = asOf.slice(0, 4);
  return {
    key, label: ACCOUNTS[key], rows, cash, deposits,
    positionsValue, cashValue, value, depositsTotal, cost, pl: value - cost, byDeposits,
    year, depositsYear: sum(deposits.filter((d) => d.date.startsWith(year)), (d) => d.amount),
    limit: limitFor(data.limits, year, key),
    missing: rows.length - priced.length + cash.filter((c) => c.valuePln == null).length,
  };
}

// Fixed part order = fixed color slot per part (color follows the entity, not its rank).
// OIPE came later and takes the next slot at the end, so existing parts keep their colors;
// this order is also the one the palette was validated in (adjacent pairs).
export function allocation(accounts, bondRows, savingRows) {
  const acc = (key) => {
    const a = accounts.find((x) => x.key === key);
    return { key, label: ACCOUNTS[key], value: a?.value ?? 0, pl: a?.pl ?? 0, cost: a?.cost ?? 0 };
  };
  return [
    acc("regular"), acc("ike"), acc("ikze"),
    { key: "bonds", label: "Obligacje", value: sum(bondRows, (r) => r.valuePln),
      pl: sum(bondRows, (r) => r.plPln), cost: sum(bondRows, (r) => r.cost) },
    { key: "savings", label: "Oszczędności", value: sum(savingRows, (r) => r.valuePln),
      pl: sum(savingRows, (r) => r.plPln), cost: sum(savingRows, (r) => r.cost) },
    acc("oipe"),
  ].map((x, i) => ({ ...x, slot: i + 1 }));
}

// Everything the screens show, from the stored data and the market data in memory.
export function portfolio(data, market, asOf) {
  const positionRows = valuePositions(data.transactions, market.quotes, market.fx);
  const accounts = Object.keys(ACCOUNTS).map((key) => accountSummary(key, positionRows, data, market.fx, asOf));
  const bonds = valueBonds(data.bonds, market.refRates, asOf);
  const cash = valueSavings(data.savings, market.fx, asOf);
  const parts = allocation(accounts, bonds.counted, cash.counted);
  return {
    positionRows, accounts, bonds, cash, parts,
    total: sum(parts, (x) => x.value),
    pl: sum(parts, (x) => x.pl),
    cost: sum(parts, (x) => x.cost),
    missing: sum(accounts, (a) => a.missing) + bonds.unpriced + cash.rows.length - cash.counted.length,
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
