// ROR (1-year, variable-rate retail treasury bonds), per list emisyjny 104/2026 (ROR1127):
// - 12 monthly periods starting on the purchase day-of-month, clamped to the month length
//   (30.11 -> 30.12 -> 30.01 -> 28.02 -> 30.03).
// - Period 1 rate is fixed per series; period n>1 rate = NBP reference rate (floored at 0)
//   from the working day before the 1st of the calendar month the period starts in, + margin.
// - Interest per bond O = N * r * (a/D) / 12, rounded to grosze; paid at period end.
// - Early redemption fee 0.50 PLN per bond; in period 1 capped at accrued interest.
// Dates are "YYYY-MM-DD" strings, handled in UTC to avoid DST drift.

const NOMINAL = 100;
const FEE = 0.5;

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toIso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Same day-of-month as `start`, `k` months later, clamped to that month's last day.
export function addMonths(start, k) {
  const d = toDate(start);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
}

// ponytail: skips weekends only, not Polish public holidays; matters only if an NBP
// rate change took effect on a holiday right before the 1st.
function workingDayBeforeMonth(date) {
  const d = toDate(date);
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() - 1);
  return toIso(x);
}

// refRates: [{ from: "YYYY-MM-DD", rate: percent }] sorted ascending.
export function refRateOn(refRates, date) {
  let rate = null;
  for (const r of refRates) if (r.from <= date) rate = r.rate;
  if (rate === null) throw new Error(`Brak stopy referencyjnej NBP na ${date}`);
  return Math.max(rate, 0);
}

// bond: { date, qty, firstRate, margin } (rates in percent). asOf: "YYYY-MM-DD".
export function ror(bond, refRates, asOf) {
  const maturity = addMonths(bond.date, 12);
  let paid = 0; // gross interest per bond already paid
  let accrued = 0;
  let current = null;
  for (let k = 0; k < 12; k++) {
    const start = addMonths(bond.date, k);
    const end = addMonths(bond.date, k + 1);
    if (start > asOf) break;
    const rate = k === 0 ? bond.firstRate : refRateOn(refRates, workingDayBeforeMonth(start)) + bond.margin;
    const D = daysBetween(start, end);
    if (end <= asOf) {
      paid += round2((NOMINAL * rate) / 100 / 12);
    } else {
      accrued = round2(((NOMINAL * rate) / 100) * (daysBetween(start, asOf) / D) / 12);
      current = { period: k + 1, rate, start, end };
    }
  }
  const matured = asOf >= maturity;
  const fee = current?.period === 1 ? Math.min(FEE, accrued) : FEE;
  return {
    maturity,
    matured,
    current, // null once matured
    paid: round2(paid * bond.qty),
    accrued: round2(accrued * bond.qty),
    value: matured ? 0 : round2((NOMINAL + accrued) * bond.qty),
    redeemNow: matured ? 0 : round2((NOMINAL + accrued - fee) * bond.qty),
  };
}

// Parses https://static.nbp.pl/dane/stopy/stopy_procentowe_archiwum.xml (reference rate only).
export function parseNbpRefRates(xml) {
  const out = [];
  for (const m of xml.matchAll(/obowiazuje_od="(\d{4}-\d{2}-\d{2})"([\s\S]*?)<\/pozycje>/g)) {
    const ref = m[2].match(/id="ref"\s+oprocentowanie="([\d,]+)"/);
    if (ref) out.push({ from: m[1], rate: Number(ref[1].replace(",", ".")) });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}
