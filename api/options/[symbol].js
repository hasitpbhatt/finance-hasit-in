import { getOptionChainLimited, getOptionChainForExpiry, computeOptionSignals, getQuotes } from '../../lib/yahoo.js';
import { getCboeOptionChain } from '../../lib/cboe.js';
import { json, corsPreflight } from '../../lib/http.js';
import { summarizeGex } from '../../lib/gex.js';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request) {
  const url = new URL(request.url);
  const symbol = (url.pathname.split('/').pop() || '').toUpperCase();
if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const requestedDate = (url.searchParams.get('expiry') || '').trim();

  let currentPrice = null;
  try {
    const quotes = await getQuotes([symbol]);
    currentPrice = quotes[0]?.price || null;
  } catch { /* not critical */ }

  let chain = null;
  let source = 'yahoo';
  try {
    chain = requestedDate
      ? await getOptionChainForExpiry(symbol, requestedDate)
      : await getOptionChainLimited(symbol);
  } catch { /* fall through to CBOE */ }

  if (!chain) {
    source = 'cboe';
    try {
      const cboe = await getCboeOptionChain(symbol);
      if (cboe) {
        chain = { expirations: cboe.expirations, chain: cboe.chain };
        if (!currentPrice) currentPrice = cboe.currentPrice;
      }
    } catch { /* both failed */ }
  }

  if (!chain) {
    return json({
      symbol,
      available: false,
      reason: 'no_options_data',
      currentPrice,
    }, { headers: { 'Cache-Control': 's-maxage=600' } });
  }

  const dateToEpoch = (d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000)
    : null;
  let requestedEpoch = dateToEpoch(requestedDate);
  if (requestedEpoch != null) {
    const exact = chain.chain.find(e => e.expiry === requestedEpoch);
    if (!exact) {
      const closest = chain.chain.reduce((best, e) => (!best || Math.abs(e.expiry - requestedEpoch) < Math.abs(best.expiry - requestedEpoch) ? e : best), null);
      requestedEpoch = closest?.expiry ?? null;
    }
  }

  const signals = computeOptionSignals(chain, currentPrice, { expiryEpoch: requestedEpoch });

  // GEX heuristic
  let gex = null;
  try {
    gex = summarizeGex(chain, currentPrice);
  } catch {
    gex = { available:false };
  }

  const expirations = (chain.expirations || []).map(epoch => ({
    date: new Date(epoch * 1000).toISOString().split('T')[0],
    epoch,
  }));
  const nearestExpiry = expirations.length
    ? expirations.reduce((a, b) => (b.epoch < a.epoch ? b : a)).date
    : null;

  // Build OI distribution for selected expiry
  let distribution = null;
  if (chain?.chain?.length) {
    // Use the same expiry that signals uses
    const sigExpiry = signals?.expiryDate;
    let activeEntry = null;
    if (sigExpiry) {
      const epoch = Math.floor(new Date(sigExpiry + 'T00:00:00Z').getTime() / 1000);
      activeEntry = chain.chain.find(e => e.expiry === epoch);
    }
    if (!activeEntry) {
      const activeEpoch = requestedEpoch != null ? requestedEpoch : chain.chain[0]?.expiry;
      activeEntry = chain.chain.find(e => e.expiry === activeEpoch) || chain.chain[0];
    }
    if (activeEntry) {
      const strikes = new Map();
      (activeEntry.calls || []).forEach(c => {
        if (c.strike == null) return;
        const s = Number(c.strike);
        if (!strikes.has(s)) strikes.set(s, { strike: s, callOI: 0, putOI: 0 });
        const rec = strikes.get(s);
        const oi = c.oi ?? c.vol ?? 0;
        rec.callOI += oi;
      });
      (activeEntry.puts || []).forEach(p => {
        if (p.strike == null) return;
        const s = Number(p.strike);
        if (!strikes.has(s)) strikes.set(s, { strike: s, callOI: 0, putOI: 0 });
        const rec = strikes.get(s);
        const oi = p.oi ?? p.vol ?? 0;
        rec.putOI += oi;
      });
      distribution = Array.from(strikes.values()).sort((a, b) => a.strike - b.strike);
    }
  }

  return json({
    symbol,
    available: true,
    source,
    currentPrice,
    expirations,
    selectedExpiry: signals?.expiryDate || nearestExpiry,
    nearestExpiry,
    signals,
    distribution,
    gex,
  }, { headers: { 'Cache-Control': 's-maxage=600' } });
}
