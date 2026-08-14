// GET /api/signals/AAPL — heavy signals: insider, newsIntel, leadership, hiring.
// All sources run concurrently via Promise.allSettled so the slowest one
// determines total latency, not the sum of all.

import { getInsiderTrades, getLeadershipChanges } from '../../_lib/edgar.js';
import { getNewsIntel } from '../../_lib/newsintel.js';
import { getHiring } from '../../_lib/hiring.js';
import { getOptionChain, computeOptionSignals, getQuotes } from '../../_lib/yahoo.js';
import { getCboeOptionChain } from '../../_lib/cboe.js';
import { json, corsPreflight } from '../../_lib/http.js';

// Race a promise against a timeout. Resolves with null on timeout.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const symbol = (context.params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const result = { symbol, degraded: false, errors: [] };

  // We need the company name for newsIntel; fetch a lightweight quote for it.
  let companyName = '';
  let quote = null;
  try {
    const quotes = await getQuotes([symbol]);
    quote = quotes[0] || null;
    companyName = quote?.name || '';
  } catch { /* not critical */ }

  // Run all signal sources concurrently with per-source timeouts.
  // The slowest source determines total latency — timeouts prevent one
  // slow source (e.g. Mistral) from blocking the entire response.
  const TIMEOUTS = {
    insider: 8000,
    newsIntel: 6000,
    leadership: 10000,
    hiring: 5000,
    options: 8000,
  };

  const [insiderR, newsIntelR, leadershipR, hiringR, optionsR] = await Promise.allSettled([
    withTimeout(getInsiderTrades(symbol, 8), TIMEOUTS.insider),
    withTimeout(getNewsIntel(symbol, companyName), TIMEOUTS.newsIntel),
    withTimeout(getLeadershipChanges(symbol, 12, context.env), TIMEOUTS.leadership),
    withTimeout(getHiring(symbol), TIMEOUTS.hiring),
    withTimeout((async () => {
      try {
        const chain = await getOptionChain(symbol);
        return computeOptionSignals(chain, quote?.price);
      } catch {
        try {
          const cboe = await getCboeOptionChain(symbol);
          if (cboe) {
            const chain = { expirations: cboe.expirations, chain: cboe.chain };
            return computeOptionSignals(chain, cboe.currentPrice || quote?.price);
          }
        } catch { /* both failed */ }
        return null;
      }
    })(), TIMEOUTS.options),
  ]);

  // Insider
  if (insiderR.status === 'fulfilled' && insiderR.value) {
    result.insiderAvailable = insiderR.value.available;
    result.insiderTrades = insiderR.value.trades;
  } else {
    result.insiderAvailable = false;
    result.insiderTrades = [];
    result.insiderDegraded = true;
    result.degraded = true;
    result.errors.push('insider: ' + (insiderR.reason?.message || 'timeout'));
  }

  // News intelligence
  if (newsIntelR.status === 'fulfilled' && newsIntelR.value) {
    result.newsIntel = newsIntelR.value;
  } else {
    result.newsIntel = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('newsIntel: ' + (newsIntelR.reason?.message || 'timeout'));
  }

  // Leadership
  if (leadershipR.status === 'fulfilled' && leadershipR.value) {
    result.leadership = leadershipR.value;
  } else {
    result.leadership = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('leadership: ' + (leadershipR.reason?.message || 'timeout'));
  }

  // Hiring
  if (hiringR.status === 'fulfilled' && hiringR.value) {
    result.hiring = hiringR.value;
  } else {
    result.hiring = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('hiring: ' + (hiringR.reason?.message || 'timeout'));
  }

  // Options
  if (optionsR.status === 'fulfilled' && optionsR.value) {
    result.options = {
      available: true,
      currentPrice: quote?.price || null,
      nearestExpiry: optionsR.value.expiryDate || null,
      signals: optionsR.value,
    };
  } else {
    result.options = { available: false, reason: 'unavailable' };
    result.errors.push('options: ' + (optionsR.reason?.message || 'timeout'));
  }

  // Compute signal flags (needs insider + leadership + newsIntel)
  const signalFlags = { redFlag: false, bullishNews: false, bearishNews: false, attentionSpike: false };
  if (result.newsIntel?.available) {
    signalFlags.bullishNews = result.newsIntel.avgSentiment > 0.35;
    signalFlags.bearishNews = result.newsIntel.avgSentiment < -0.35;
    signalFlags.attentionSpike = result.newsIntel.spike === true;
  }
  if (result.leadership?.available && result.insiderAvailable === true) {
    const recentChanges = (result.leadership.changes || []).filter(c => {
      const d = new Date(c.date).getTime();
      return d >= Date.now() - 90 * 24 * 3600 * 1000;
    });
    const keyRoles = recentChanges.filter(c => ['ceo', 'cfo', 'cto', 'coo', 'president', 'chairman'].some(r => c.snippet.toLowerCase().includes(r)));
    const anyDepartures = recentChanges.some(c => c.kind === 'departure' || c.kind === 'both');
    const netInsiderSelling = (result.insiderTrades || []).some(t => t.code === 'S' && t.total != null && t.total > 0);
    signalFlags.redFlag = (keyRoles.length >= 1 || (anyDepartures && recentChanges.length >= 2)) && netInsiderSelling;
  }
  result.signalFlags = signalFlags;

  return json(result, { headers: { 'Cache-Control': 's-maxage=300' } });
}
