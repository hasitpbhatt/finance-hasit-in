import { getQuotes, getFundamentalsBatch, searchSymbols } from '../lib/yahoo.js';
import { UNIVERSE } from '../lib/universe.js';
import { json, corsPreflight } from '../lib/http.js';

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

const PRESETS = {
  compounder: { peMax: 25, roeMin: 0.15, earningsGrowthMin: 0.1, limit: 20 },
  cash: { dividendYieldMin: 2, deMax: 1, peMax: 20, limit: 20 },
  turnaround: { peMax: 15, earningsGrowthMin: 0.05, limit: 20 },
};

function parseNlToParams(nl) {
  const out = {};
  const lower = nl.toLowerCase();
  if (lower.includes('big cap') || lower.includes('large cap') || lower.includes('mega')) out.marketCapMin = 2e11;
  else if (lower.includes('mid cap') || lower.includes('medium')) { out.marketCapMin = 1e10; out.marketCapMax = 2e11; }
  else if (lower.includes('small cap')) out.marketCapMax = 1e10;
  if (lower.includes('etf')) out.type = 'ETF';
  if (lower.includes('stock')) out.type = 'STOCK';
  const debtM = lower.match(/debt\s*(?:under|below|less than|<)\s*([\d.]+)/);
  if (debtM) out.deMax = parseFloat(debtM[1]);
  const yieldM = lower.match(/yield\s*(?:above|over|more than|>)\s*([\d.]+)/);
  if (yieldM) out.dividendYieldMin = parseFloat(yieldM[1]);
  const roeM = lower.match(/roe\s*(?:above|over|more than|>)\s*([\d.]+)/);
  if (roeM) out.roeMin = parseFloat(roeM[1]);
  const peM = lower.match(/pe\s*(?:under|below|less than|<)\s*([\d.]+)/);
  if (peM) out.peMax = parseFloat(peM[1]);
  if (lower.includes('tech') || lower.includes('technology')) out.sector = 'technology';
  if (lower.includes('health')) out.sector = 'healthcare';
  if (lower.includes('profitable') || lower.includes('profit')) out.roeMin = 0.05;
  if (lower.includes('no debt') || lower.includes('debt free')) out.deMax = 0.1;
  if (lower.includes('growing') || lower.includes('growth')) out.earningsGrowthMin = 0.05;
  return out;
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request) {
  const url = new URL(request.url);
  const p = url.searchParams;

  let resolved = {};
  const presetName = (p.get('preset') || '').trim().toLowerCase();
  const nlQuery = (p.get('nl') || '').trim();

  if (presetName && PRESETS[presetName]) {
    resolved = { ...PRESETS[presetName] };
  } else if (nlQuery) {
    resolved = parseNlToParams(nlQuery);
  }

  const q = (p.get('q') || '').trim().toLowerCase();
  const typeFilter = (p.get('type') || resolved.type || 'all').toUpperCase();
  const marketCapMin = num(p.get('marketCapMin')) ?? resolved.marketCapMin ?? null;
  const marketCapMax = num(p.get('marketCapMax')) ?? resolved.marketCapMax ?? null;
  const sector = (p.get('sector') || resolved.sector || '').trim().toLowerCase();
  const peMax = num(p.get('peMax')) ?? resolved.peMax ?? null;
  const dyMin = num(p.get('dividendYieldMin')) ?? resolved.dividendYieldMin ?? null;
  const pbMax = num(p.get('pbMax')) ?? resolved.pbMax ?? null;
  const roeMin = num(p.get('roeMin')) ?? resolved.roeMin ?? null;
  const deMax = num(p.get('deMax')) ?? resolved.deMax ?? null;
  const currentRatioMin = num(p.get('currentRatioMin')) ?? resolved.currentRatioMin ?? null;
  const betaMax = num(p.get('betaMax')) ?? resolved.betaMax ?? null;
  const earningsGrowthMin = num(p.get('earningsGrowthMin')) ?? resolved.earningsGrowthMin ?? null;
  const limit = Math.min(Math.max(num(p.get('limit')) || resolved.limit || 50, 1), 200);

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
      if (typeFilter !== 'ALL' && (r.type || '').toUpperCase() !== typeFilter) return false;
      if (marketCapMin != null && (r.marketCap == null || r.marketCap < marketCapMin)) return false;
      if (marketCapMax != null && (r.marketCap == null || r.marketCap > marketCapMax)) return false;
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
