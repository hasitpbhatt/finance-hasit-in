// SEC EDGAR XBRL companyconcept helpers (free, no key). Fetches individual
// concepts (revenue, net income) one at a time — lighter than companyfacts
// which can be 4MB+. Computes a layman "trend verdict" from 4-5 fiscal years.
// Tag fallback handles the fact that different companies use different XBRL
// tags for the same economic concept.

import { cachedJson } from './cache.js';
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

// Try candidate tags in order; return the first one that has data.
function findConcept(usGaap, candidates) {
  for (const tag of candidates) {
    const raw = usGaap[tag]?.units?.USD;
    if (raw && raw.length) return raw;
  }
  return [];
}

// Extract annual (10-K) FY values, deduped by fiscal year, most recent 5.
function annualFacts(raw) {
  const fy = raw
    .filter(f => f.form === '10-K' && f.fy && f.value != null)
    .sort((a, b) => (b.fy ?? 0) - (a.fy ?? 0));
  const seen = new Set();
  const out = [];
  for (const f of fy) {
    if (!seen.has(f.fy)) {
      seen.add(f.fy);
      out.push({ fy: f.fy, value: f.value });
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

// Fetch a single XBRL concept for a ticker.
async function fetchConcept(cik, concept) {
  const tags = TAG_CANDIDATES[concept];
  if (!tags) return [];

  for (const tag of tags) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik.padded}/us-gaap/${tag}.json`;
    try {
      const { data } = await cachedJson(url, XBRL_TTL, EDGAR_UA);
      const usd = data?.units?.USD;
      if (usd && usd.length) return usd;
    } catch { /* try next tag */ }
  }
  return [];
}

// Fetch revenue and net income trends via individual companyconcept calls.
// Only 2-3 calls instead of companyfacts (which can be 4MB+).
export async function getXbrlTrend(symbol) {
  const cik = await getCik(symbol);
  if (!cik) return null;

  // Fetch only revenue and net income (skip FCF/CapEx/EPS to save time)
  const [revenueRaw, netIncomeRaw] = await Promise.all([
    fetchConcept(cik, 'revenue'),
    fetchConcept(cik, 'netIncome'),
  ]);

  if (!revenueRaw.length && !netIncomeRaw.length) return null;

  const revenue = annualFacts(revenueRaw);
  const netIncome = annualFacts(netIncomeRaw);
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
