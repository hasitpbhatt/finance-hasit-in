// Nasdaq.com quote + chart fallback (free, no key). Used when Yahoo endpoints
// fail or rate-limit. Nasdaq requires a browser User-Agent; without it the API
// returns a 403. Single-symbol only — Nasdaq has no batch quote endpoint.
// Strictly a fallback; never the primary source.

import { cachedJson, UA } from './cache.js';

const BASE = 'https://api.nasdaq.com/api/quote';

// Nasdaq endpoints need a browser-like User-Agent + Referer or they 403.
const NASDAQ_HEADERS = {
  'User-Agent': UA['User-Agent'],
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nasdaq.com/',
};

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
    const { data } = await cachedJson(url, 600, NASDAQ_HEADERS, null, signal);
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

// Free no-key historical OHLCV layer for charts. The historical endpoint
// returns tradesTable rows with MM/DD/YYYY date strings and "$1,234.56" price
// strings — normalized to the { series: [{t,c,d}] } shape getChart produces.
// 6h TTL; strictly a fallback. Returns null on any failure.
export async function getNasdaqChart(symbol, range = '2y', signal = null) {
  const now = new Date();
  const todate = now.toISOString().slice(0, 10);
  const days = range === 'max' ? 3650 : range === '1y' ? 366 : range === '6mo' ? 183 : 731;
  const fromdate = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const url =
    `${BASE}/${encodeURIComponent(symbol)}/historical?assetclass=stocks` +
    `&fromdate=${fromdate}&todate=${todate}&limit=9999`;
  try {
    const { data } = await cachedJson(url, 21600, NASDAQ_HEADERS, null, signal);
    const rows = data?.data?.tradesTable?.rows || [];
    if (!rows.length) return null;
    const series = [];
    for (const r of rows) {
      const close = num(r.close);
      if (close == null || !r.date) continue;
      const t = Date.parse(r.date + 'T00:00:00') / 1000;
      if (!Number.isFinite(t)) continue;
      series.push({ t, c: close, d: r.date });
    }
    if (!series.length) return null;
    return { series };
  } catch {
    return null;
  }
}