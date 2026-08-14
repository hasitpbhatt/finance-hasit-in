// SEC EDGAR XBRL companyfacts helpers (free, no key). Fetches all financial
// data in a SINGLE call via companyfacts, then extracts the specific concepts
// we need. Computes a layman "trend verdict" from 4-5 fiscal years.
// Tag fallback handles the fact that different companies use different XBRL
// tags for the same economic concept.

import { cachedJson } from './cache.js';
import { getCik } from './edgar.js';

const EDGAR_UA = {
  'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  Accept: 'application/json',
};

const XBRL_TTL = 24 * 3600; // 24 hours (filing data changes quarterly)

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
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
  ],
  eps: [
    'EarningsPerShareDiluted',
    'EarningsPerShareBasicAndDiluted',
    'EarningsPerShareBasic',
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

// Fetch all XBRL facts for a ticker in ONE call, then extract what we need.
export async function getXbrlTrend(symbol) {
  const cik = await getCik(symbol);
  if (!cik) return null;

  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padded}.json`;
  let data;
  try {
    ({ data } = await cachedJson(url, XBRL_TTL, EDGAR_UA));
  } catch {
    return null;
  }

  const usGaap = data?.facts?.['us-gaap'];
  if (!usGaap) return null;

  const revenueRaw = annualFacts(findConcept(usGaap, TAG_CANDIDATES.revenue));
  const netIncomeRaw = annualFacts(findConcept(usGaap, TAG_CANDIDATES.netIncome));
  const ocfRaw = annualFacts(findConcept(usGaap, TAG_CANDIDATES.operatingCashFlow));
  const capexRaw = annualFacts(findConcept(usGaap, TAG_CANDIDATES.capex));
  const epsRaw = annualFacts(findConcept(usGaap, TAG_CANDIDATES.eps));

  if (!revenueRaw.length && !netIncomeRaw.length && !ocfRaw.length) return null;

  // Compute FCF from OCF - CapEx
  const capexByYear = {};
  for (const c of capexRaw) capexByYear[c.fy] = c.value;
  const fcf = ocfRaw.map(o => ({
    fy: o.fy,
    value: o.value - (capexByYear[o.fy] || 0),
  }));

  const revenueGrowth = yoyGrowth(revenueRaw);
  const netIncomeGrowth = yoyGrowth(netIncomeRaw);
  const fcfGrowth = yoyGrowth(fcf);
  const epsGrowth = yoyGrowth(epsRaw);

  return {
    available: true,
    symbol,
    latestFY: revenueRaw[0]?.fy || netIncomeRaw[0]?.fy || null,
    revenue: {
      latest: revenueRaw[0]?.value ?? null,
      years: revenueRaw.map(r => ({ fy: r.fy, value: r.value })),
      growth: revenueGrowth,
      trend: verdict(revenueGrowth),
      trendLabel: verdictLabel(verdict(revenueGrowth)),
    },
    netIncome: {
      latest: netIncomeRaw[0]?.value ?? null,
      years: netIncomeRaw.map(r => ({ fy: r.fy, value: r.value })),
      growth: netIncomeGrowth,
      trend: verdict(netIncomeGrowth),
      trendLabel: verdictLabel(verdict(netIncomeGrowth)),
    },
    freeCashFlow: {
      latest: fcf[0]?.value ?? null,
      years: fcf,
      growth: fcfGrowth,
      trend: verdict(fcfGrowth),
      trendLabel: verdictLabel(verdict(fcfGrowth)),
    },
    eps: {
      latest: epsRaw[0]?.value ?? null,
      years: epsRaw.map(r => ({ fy: r.fy, value: r.value })),
      growth: epsGrowth,
      trend: verdict(epsGrowth),
      trendLabel: verdictLabel(verdict(epsGrowth)),
    },
  };
}
