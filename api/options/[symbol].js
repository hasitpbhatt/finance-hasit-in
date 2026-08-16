import { getOptionChainLimited, getOptionChainForExpiry, computeOptionSignals, getQuotes } from '../../lib/yahoo.js';
import { getCboeOptionChain } from '../../lib/cboe.js';
import { json, corsPreflight } from '../../lib/http.js';

export default async function handler(request, { params }) {
  if (request.method === 'OPTIONS') return corsPreflight();
  const symbol = (params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const url = new URL(request.url);
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

  const expirations = (chain.expirations || []).map(epoch => ({
    date: new Date(epoch * 1000).toISOString().split('T')[0],
    epoch,
  }));
  const nearestExpiry = expirations.length
    ? expirations.reduce((a, b) => (b.epoch < a.epoch ? b : a)).date
    : null;

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
