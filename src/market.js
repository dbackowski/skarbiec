// Market data over HTTP. `fetch` is passed in (Tauri's http plugin in the app, a fake in tests),
// so these functions have no other dependencies.

import { parseNbpRefRates } from "./bonds.js";

async function getJson(fetch, url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

// ponytail: unofficial Yahoo endpoint, no key. Swap the source here if it breaks.
export async function fetchQuote(fetch, symbol) {
  let j;
  try {
    j = await getJson(fetch, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  } catch (e) {
    throw new Error(`Nie udało się pobrać notowań ${symbol} (${e.message ?? e})`);
  }
  const m = j?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) throw new Error(`Nie znaleziono notowań dla ${symbol}`);
  // London quotes come in pence.
  if (m.currency === "GBp") return { price: m.regularMarketPrice / 100, currency: "GBP" };
  return { price: m.regularMarketPrice, currency: m.currency };
}

// NBP table A mid rate from the last publication on or before `date` ("YYYY-MM-DD").
export async function fetchFx(fetch, currency, date) {
  if (currency === "PLN") return 1;
  const end = new Date(`${date}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 10); // covers weekends and holidays
  const iso = (d) => d.toISOString().slice(0, 10);
  const j = await getJson(fetch,
    `https://api.nbp.pl/api/exchangerates/rates/a/${currency.toLowerCase()}/${iso(start)}/${iso(end)}/?format=json`);
  const rate = j?.rates?.at(-1)?.mid;
  if (!(rate > 0)) throw new Error(`Brak kursu NBP ${currency} na ${date}`);
  return rate;
}

export async function fetchRefRates(fetch) {
  const r = await fetch("https://static.nbp.pl/dane/stopy/stopy_procentowe_archiwum.xml");
  if (!r.ok) throw new Error(`HTTP ${r.status}: stopy NBP`);
  const rates = parseNbpRefRates(await r.text());
  if (!rates.length) throw new Error("Pusta lista stóp NBP");
  return rates;
}
