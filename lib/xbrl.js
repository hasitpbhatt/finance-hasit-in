// SEC EDGAR XBRL companyconcept helpers (free, no key). Fetches individual
// concepts (revenue, net income) one at a time — lighter than companyfacts
// which can be 4MB+. Computes a layman "trend verdict" from 4-5 fiscal years.
// Tag fallback handles the fact that different companies use different XBRL
// tags for the same economic concept.

import { cachedJson, fromCache, store } from './cache.js';
import { getCik } from './edgar.js';

const EDGAR_UA = {
  'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  Accept: 'application/json',
};

const XBRL_TTL = 24 * 3600; // 24 hours

// Candidate XBRL tags for each concept (priority order).
const TAG_CANDIDATES = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
    'OperatingRevenue',
  ],
  netIncome: [
    'NetIncomeLoss',
    'ProfitLoss',
  ],
};

// Compact-cache key: stores the parsed { fy, value } series (tiny) instead of
// the raw companyconcept JSON (up to ~1MB). This is the big CPU saver: the
// heavyweight JSON.parse happens once per 24h; every subsequent request reads
// a ~100-byte payload that needs no parse cost beyond a trivial JSON.parse.
function compactKey(cikPadded, concept) {
  return `https://xbrl-compact/${cikPadded}/${concept}`;
}

async function fromCompact(cikPadded, concept) {
  if (typeof caches === 'undefined') return null;
  const cached = await caches.default.match(new Request(compactKey(cikPadded, concept)));
  if (!cached) return null;
  const at = Number(cached.headers.get('X-Cached-At') || '0');
  if (Date.now() - at >= XBRL_TTL * 1000) return null;
  return cached.json();
}

async function toCompact(cikPadded, concept, series) {
  if (typeof caches === 'undefined') return;
  const response = new Response(JSON.stringify(series), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Cached-At': String(Date.now()) },
  });
  await caches.default.put(new Request(compactKey(cikPadded, concept)), response);
}

// Extract annual (10-K) FY values, deduped by fiscal year, most recent 5.
function annualFacts(raw) {
  const fy = raw
    .filter(f => f.form === '10-K' && f.fy && (f.val ?? f.value) != null)
    .sort((a, b) => (b.fy ?? 0) - (a.fy ?? 0));
  const seen = new Set();
  const out = [];
  for (const f of fy) {
    if (!seen.has(f.fy)) {
      seen.add(f.fy);
      out.push({ fy: f.fy, value: f.val ?? f.value });
    }
    if (out.length >= 5) break;
  }
  return out;
}

// Compute YoY growth rates from a time series.
function yoyGrowth(series) {
  if (series.length < 2) return [];
  const results = [];
  for (let i = 0; i < series.length - 1; i++) {
    const curr = series[i].value;
    const prev = series[i + 1].value;
    if (prev && prev !== 0) {
      results.push({ fy: series[i].fy, growth: +((curr - prev) / Math.abs(prev) * 100).toFixed(1) });
    }
  }
  return results;
}

// Determine a trend verdict from a growth series.
function verdict(growthSeries) {
  if (growthSeries.length === 0) return 'unknown';
  const recent = growthSeries.slice(0, 3);
  const avg = recent.reduce((s, g) => s + g.growth, 0) / recent.length;
  if (avg > 10) return 'strong_growth';
  if (avg > 2) return 'growing';
  if (avg > -2) return 'flat';
  if (avg > -10) return 'declining';
  return 'sharply_declining';
}

function verdictLabel(v) {
  const labels = {
    strong_growth: 'Strong growth',
    growing: 'Growing',
    flat: 'Flat',
    declining: 'Declining',
    sharply_declining: 'Sharply declining',
    unknown: 'Insufficient data',
  };
  return labels[v] || 'Unknown';
}

// Fetch a single XBRL concept for a ticker and return the annual series
// [{ fy, value }] (most recent 5 years, deduped by fiscal year). Uses the
// compact cache so the raw companyconcept payload (up to ~1MB) is fetched and
// parsed at most once per 24h. Tries the first 2 tags in parallel and picks
// the one with the most recent data (companies switch XBRL tags over time).
async function fetchConcept(cik, concept, signal = null) {
  const compact = await fromCompact(cik.padded, concept);
  if (compact) return compact;

  const tags = TAG_CANDIDATES[concept];
  if (!tags || !tags.length) return [];

  const tryTags = tags.slice(0, 2);
  const results = await Promise.allSettled(
    tryTags.map(tag => cachedJson(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik.padded}/us-gaap/${tag}.json`,
      XBRL_TTL, EDGAR_UA, null, signal,
    ))
  );

  let best = [];
  let bestMaxFy = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const usd = r.value?.data?.units?.USD;
      if (usd && usd.length) {
        const maxFy = Math.max(...usd.filter(f => f.fy).map(f => f.fy));
        if (maxFy >= bestMaxFy) {
          best = usd;
          bestMaxFy = maxFy;
        }
      }
    }
  }

  const series = annualFacts(best);
  if (series.length) await toCompact(cik.padded, concept, series);
  return series;
}

// Fetch revenue and net income trends via individual companyconcept calls.
// Heavy parsing is compact-cached so each concept is parsed at most once/24h.
export async function getXbrlTrend(symbol, signal = null) {
  const cik = await getCik(symbol, signal);
  if (!cik) return null;

  // Fetch only revenue and net income (skip FCF/CapEx/EPS to save time)
  const [revenueRaw, netIncomeRaw] = await Promise.all([
    fetchConcept(cik, 'revenue', signal),
    fetchConcept(cik, 'netIncome', signal),
  ]);

  if (!revenueRaw.length && !netIncomeRaw.length) return null;

  const revenue = revenueRaw;
  const netIncome = netIncomeRaw;
  const revenueGrowth = yoyGrowth(revenue);
  const netIncomeGrowth = yoyGrowth(netIncome);

  return {
    available: true,
    symbol,
    latestFY: revenue[0]?.fy || netIncome[0]?.fy || null,
    revenue: {
      latest: revenue[0]?.value ?? null,
      years: revenue.map(r => ({ fy: r.fy, value: r.value })),
      growth: revenueGrowth,
      trend: verdict(revenueGrowth),
      trendLabel: verdictLabel(verdict(revenueGrowth)),
    },
    netIncome: {
      latest: netIncome[0]?.value ?? null,
      years: netIncome.map(r => ({ fy: r.fy, value: r.value })),
      growth: netIncomeGrowth,
      trend: verdict(netIncomeGrowth),
      trendLabel: verdictLabel(verdict(netIncomeGrowth)),
    },
  };
}
