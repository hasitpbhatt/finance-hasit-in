// Curated mapping of tickers to free ATS boards (Greenhouse primary, Lever secondary).
// Slugs are verified at build time (HEAD request).
// Add/remove entries as needed; keep only working slugs.

// Helper to verify a Greenhouse slug (HEAD)
export async function verifyGreenhouseSlug(slug) {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)' } });
    return res.ok;
  } catch {
    return false;
  }
}

// Helper to verify a Lever slug (HEAD)
export async function verifyLeverSlug(slug) {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)' } });
    return res.ok;
  } catch {
    return false;
  }
}

// Main map: tickers -> { greenhouse?: slug, lever?: slug } or null if none
// Build step should prune non-working slugs.
// Initial curated list (Greenhouse unless noted).
export const HIRING_SOURCES = Object.freeze({
  // Tech mega-caps
  AAPL: null,
  MSFT: null,
  GOOGL: null,
  GOOG: null,
  AMZN: null,
  META: null,
  NVDA: null,
  TSLA: null,
  
  // Cloud / infra
  CRM: { greenhouse: 'salesforce' },
  ORCL: null,
  ADBE: { greenhouse: 'adobe' },
  INTC: null,
  AMD: { greenhouse: 'amd' },
  CSCO: null,
  IBM: null,
  QCOM: { greenhouse: 'qualcomm' },
  TXN: { greenhouse: 'ti' },
  AMAT: { greenhouse: 'amat' },
  PYPL: null,
  SQ: { greenhouse: 'block' },
  
  // Data / dev tools
  NOW: { greenhouse: 'servicenow' },
  ADSK: { greenhouse: 'autodesk' },
  SNPS: { greenhouse: 'synopsys' },
  CDNS: null, // was 'akamai' (wrong company); Cadence ATS unverified → disabled to avoid surfacing Akamai openings
  PANW: { greenhouse: 'paloaltonetworks' },
  FTNT: { greenhouse: 'fortinet' },
  ZS: { greenhouse: 'zscaler' },
  CRWD: { greenhouse: 'crowdstrike' },
  DDOG: { greenhouse: 'datadog' },
  SNOW: { greenhouse: 'snowflake' },
  
  // Fintech / payments
  V: { greenhouse: 'visa' },
  MA: { greenhouse: 'mastercard' },
  BK: null,
  C: null,
  GS: null,
  MS: null,
  
  // Consumer / retail
  WMT: null,
  COST: null,
  TGT: null,
  HD: null,
  
  // Media / comms
  DIS: null,
  CMCSA: null,
  NKE: null,
  
  // Biopharma / healthcare
  UNH: null,
  JNJ: null,
  LLY: { greenhouse: 'lilly' },
  MRK: null,
  ABBV: null,
  TMO: { greenhouse: 'thermofisher' },
  ABT: null,
  DHR: { greenhouse: 'danaher' },
  BMY: null,
  AMGN: { greenhouse: 'amgen' },
  GILD: { greenhouse: 'gilead' },
  
  // Energy / industrials
  XOM: null,
  CVX: null,
  COP: null,
  SLB: { greenhouse: 'schlumberger' },
  EOG: { greenhouse: 'eogresources' },
  MPC: null,
  VLO: null,
  CAT: null,
  DE: null,
  
  // ETFs don't have hiring boards; leave null
  SPY: null,
  QQQ: null,
  VTI: null,
  VOO: null,
  IWM: null,
});

// Optional: helper to prune non-working slugs (run during build)
export async function pruneHiringSources() {
  const out = {};
  for (const [ticker, src] of Object.entries(HIRING_SOURCES)) {
    if (!src) { out[ticker] = null; continue; }
    const gh = src.greenhouse ? await verifyGreenhouseSlug(src.greenhouse) : false;
    const lv = src.lever ? await verifyLeverSlug(src.lever) : false;
    if (gh || lv) {
      out[ticker] = gh ? { greenhouse: src.greenhouse } : { lever: src.lever };
    } else {
      out[ticker] = null; // prune
    }
  }
  return out;
}
