import { getQuotes, getFundamentalsBatch, searchSymbols } from '../_lib/yahoo.js';
import { UNIVERSE } from '../_lib/universe.js';
import { json, corsPreflight } from '../_lib/http.js';

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(context.request.url);
  const p = url.searchParams;

  const q = (p.get('q') || '').trim().toLowerCase();
  const typeFilter = (p.get('type') || 'all').toUpperCase();
  const marketCapMin = num(p.get('marketCapMin'));
  const sector = (p.get('sector') || '').trim().toLowerCase();
  const peMax = num(p.get('peMax'));
  const dyMin = num(p.get('dividendYieldMin'));
  const pbMax = num(p.get('pbMax'));
  const roeMin = num(p.get('roeMin'));
  const deMax = num(p.get('deMax'));
  const currentRatioMin = num(p.get('currentRatioMin'));
  const betaMax = num(p.get('betaMax'));
  const earningsGrowthMin = num(p.get('earningsGrowthMin'));
  const limit = Math.min(Math.max(num(p.get('limit')) || 50, 1), 200);

  try {
    const deepRequested =
      roeMin != null || deMax != null || currentRatioMin != null || earningsGrowthMin != null;

    let quotes;
    let order = null;
    let outsideUniverse = false;

    if (q) {
      const hits = await searchSymbols(q, 10);
      if (!hits.length) {
        return json(
          { count: 0, results: [], outsideUniverse: true, degraded: false },
          { headers: { 'Cache-Control': 's-maxage=600' } },
        );
      }
      const tickers = hits.map((h) => h.symbol);
      order = new Map(tickers.map((t, i) => [t, i]));
      outsideUniverse = hits.some((h) => !UNIVERSE.includes(h.symbol));
      quotes = deepRequested
        ? await getFundamentalsBatch(tickers)
        : await getQuotes(tickers);
    } else {
      quotes = deepRequested
        ? await getFundamentalsBatch(UNIVERSE)
        : await getQuotes(UNIVERSE);
    }

    let rows = quotes.filter((r) => {
      if (typeFilter !== 'ALL' && r.type !== typeFilter) return false;
      if (marketCapMin != null && (r.marketCap == null || r.marketCap < marketCapMin)) return false;
      if (sector && (r.sector || '').toLowerCase().indexOf(sector) === -1) return false;
      if (peMax != null && (r.pe == null || r.pe <= 0 || r.pe > peMax)) return false;
      if (dyMin != null && (r.dividendYield == null || r.dividendYield < dyMin)) return false;
      if (pbMax != null && (r.priceToBook == null || r.priceToBook <= 0 || r.priceToBook > pbMax)) return false;
      if (roeMin != null && (r.returnOnEquity == null || r.returnOnEquity < roeMin)) return false;
      if (deMax != null && (r.debtToEquity == null || r.debtToEquity < 0 || r.debtToEquity > deMax)) return false;
      if (currentRatioMin != null && (r.currentRatio == null || r.currentRatio < currentRatioMin)) return false;
      if (betaMax != null && (r.beta == null || r.beta > betaMax)) return false;
      if (earningsGrowthMin != null && (r.earningsQuarterlyGrowth == null || r.earningsQuarterlyGrowth < earningsGrowthMin)) return false;
      return true;
    });

    rows.sort((a, b) =>
      order
        ? (order.get(a.symbol) ?? 999) - (order.get(b.symbol) ?? 999)
        : (b.marketCap || 0) - (a.marketCap || 0),
    );
    rows = rows.slice(0, limit);

    return json(
      { count: rows.length, results: rows, outsideUniverse, degraded: false },
      { headers: { 'Cache-Control': 's-maxage=600' } },
    );
  } catch (e) {
    return json(
      { count: 0, results: [], outsideUniverse: false, degraded: true, error: e.message },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
