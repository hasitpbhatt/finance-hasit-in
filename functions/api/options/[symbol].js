// GET /api/options/AAPL — options chain + derived signals.
// Tries Yahoo first, falls back to CBOE. Returns option signals
// (put/call ratios, unusual activity, max pain, IV).

import { getOptionChain, computeOptionSignals, getQuotes } from '../../_lib/yahoo.js';
import { getCboeOptionChain } from '../../_lib/cboe.js';
import { json, corsPreflight } from '../../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const symbol = (context.params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  // Optional expiry selection: ?expiry=YYYY-MM-DD
  const url = new URL(context.request.url);
  const requestedDate = (url.searchParams.get('expiry') || '').trim();

  // Get current price for the underlying
  let currentPrice = null;
  try {
    const quotes = await getQuotes([symbol]);
    currentPrice = quotes[0]?.price || null;
  } catch { /* not critical */ }

  // Try Yahoo first
  let chain = null;
  let source = 'yahoo';
  try {
    chain = await getOptionChain(symbol);
  } catch { /* fall through to CBOE */ }

  // Fall back to CBOE
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

  // Resolve requested expiry to a chain epoch (closest match if not exact)
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
  const nearestExpiryEpoch = chain.chain?.[0]?.expiry;
  const nearestExpiry = nearestExpiryEpoch ? new Date(nearestExpiryEpoch * 1000).toISOString().split('T')[0] : null;

  const expirations = (chain.expirations || []).map(epoch => ({
    date: new Date(epoch * 1000).toISOString().split('T')[0],
    epoch,
  }));

  return json({
    symbol,
    available: true,
    source,
    currentPrice,
    expirations,
    selectedExpiry: signals?.expiryDate || nearestExpiry,
    nearestExpiry,
    signals,
  }, { headers: { 'Cache-Control': 's-maxage=600' } });
}
