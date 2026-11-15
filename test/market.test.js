import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFx, fetchQuote, fetchRefRates } from "../src/market.js";

// Fake fetch: routes by URL substring, records requested URLs.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const [, body] = hit;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
  return { fetch, calls };
}

const yahoo = (price, currency) => ({ chart: { result: [{ meta: { regularMarketPrice: price, currency } }] } });

test("quote: price and currency from Yahoo meta", async () => {
  const { fetch, calls } = fakeFetch({ "chart/CDR.WA": yahoo(212.4, "PLN") });
  assert.deepEqual(await fetchQuote(fetch, "CDR.WA"), { price: 212.4, currency: "PLN" });
  assert.match(calls[0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/CDR\.WA\?/);
});

test("quote: London prices in pence become GBP", async () => {
  const { fetch } = fakeFetch({ "chart/IWDA.L": yahoo(9250, "GBp") });
  assert.deepEqual(await fetchQuote(fetch, "IWDA.L"), { price: 92.5, currency: "GBP" });
});

test("quote: unknown symbol and network errors name the symbol", async () => {
  const { fetch } = fakeFetch({ "chart/EMPTY": { chart: { result: null } }, "chart/DOWN": new Error("offline") });
  await assert.rejects(fetchQuote(fetch, "NOPE"), /Nie udało się pobrać notowań NOPE \(HTTP 404/);
  await assert.rejects(fetchQuote(fetch, "EMPTY"), /Nie znaleziono notowań dla EMPTY/);
  await assert.rejects(fetchQuote(fetch, "DOWN"), /Nie udało się pobrać notowań DOWN \(offline\)/);
});

test("fx: PLN is 1 without a request", async () => {
  const { fetch, calls } = fakeFetch({});
  assert.equal(await fetchFx(fetch, "PLN", "2026-11-15"), 1);
  assert.equal(calls.length, 0);
});

test("fx: last NBP rate in a 10-day window ending on the date (weekends, holidays)", async () => {
  const { fetch, calls } = fakeFetch({ "rates/a/eur/": { rates: [{ mid: 4.2 }, { mid: 4.25 }] } });
  assert.equal(await fetchFx(fetch, "EUR", "2026-11-15"), 4.25);
  assert.match(calls[0], /api\.nbp\.pl\/api\/exchangerates\/rates\/a\/eur\/2026-11-05\/2026-11-15\//);
});

test("fx: missing rate is an error, not undefined", async () => {
  const { fetch } = fakeFetch({ "rates/a/usd/": { rates: [] } });
  await assert.rejects(fetchFx(fetch, "USD", "2026-11-15"), /Brak kursu NBP USD/);
});

test("NBP reference rates: parsed, empty list rejected", async () => {
  const xml = `<pozycje obowiazuje_od="2026-03-05"><pozycja id="ref" oprocentowanie="3,75" /></pozycje>`;
  assert.deepEqual(await fetchRefRates(fakeFetch({ stopy: xml }).fetch), [{ from: "2026-03-05", rate: 3.75 }]);
  await assert.rejects(fetchRefRates(fakeFetch({ stopy: "<html/>" }).fetch), /Pusta lista/);
  await assert.rejects(fetchRefRates(fakeFetch({}).fetch), /HTTP 404/);
});
