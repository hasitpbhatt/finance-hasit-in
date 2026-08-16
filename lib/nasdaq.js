// Nasdaq.com quote fallback (free, no key). Used when Yahoo quote endpoints
// fail or rate-limit. Nasdaq requires a browser User-Agent; without it the API
// returns a 403. Single-symbol only — Nasdaq has no batch quote endpoint.

import { cachedJson, UA } from './cache.js';

const BASE = 'https://api.nasdaq.com/api/quote';

// Normalize "$305.93" / "28,229,611" / "+0.22%" style strings to numbers.
function num(v) {
  if (v == null || v === 'N/A' || v === '') return null;
  const n = Number(String(v).replace(/[$,%+]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Returns a normalized quote (subset of the fields the detail page needs).
// Returns null on any failure so callers can fall through to other sources.
export async function getNasdaqQuote(symbol, signal = null) {
  const url = `${BASE}/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
  try {
    const { data } = await cachedJson(url, 600, {
      'User-Agent': UA['User-Agent'],
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nasdaq.com/',
    }, null, signal);
    const d = data?.data;
    if (!d?.primaryData) return null;
    const p = d.primaryData;
    const changePct = num(p.percentageChange);
    const change = num(p.netChange);
    const price = num(p.lastSalePrice);
    return {
      symbol: (d.symbol || symbol).toUpperCase(),
      name: d.companyName || symbol,
      type: 'STOCK',
      price,
      change,
      changePercent: changePct,
      volume: num(p.volume),
      exchange: d.exchange || null,
      asOf: p.lastTradeTimestamp || null,
      degraded: true,
    };
  } catch {
    return null;
  }
}