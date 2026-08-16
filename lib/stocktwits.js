// StockTwits retail sentiment (free, no key). Fetches recent messages for a
// symbol and computes bullish/bearish/neutral percentages from user-labeled
// sentiment tags. Rate limit: 200 req/hr — edge-cached aggressively.

import { cachedJson } from './cache.js';

const BASE = 'https://api.stocktwits.com/api/2/streams/symbol';
const UA = 'InvestmentFinder/1.0 (contact@example.com)';
const TTL = 600; // 10 minutes

// Fetch retail sentiment for a symbol.
// Returns { available, total, bullish, bearish, neutral, bullPct, bearPct, sentimentLabel }.
export async function getRetailSentiment(symbol, signal = null) {
  const url = `${BASE}/${encodeURIComponent(symbol)}.json`;
  try {
    const { data } = await cachedJson(url, TTL, {
      'User-Agent': UA,
      Accept: 'application/json',
    }, null, signal);
    const messages = data?.messages || [];
    if (!messages.length) return { available: false, reason: 'no_messages' };

    let bullish = 0, bearish = 0, neutral = 0;
    for (const m of messages) {
      const tag = m?.entities?.sentiment?.basic;
      if (tag === 'Bullish') bullish++;
      else if (tag === 'Bearish') bearish++;
      else neutral++;
    }
    const total = bullish + bearish + neutral;
    const bullPct = total > 0 ? Math.round(bullish / total * 100) : 0;
    const bearPct = total > 0 ? Math.round(bearish / total * 100) : 0;

    let sentimentLabel = 'Neutral';
    if (bullPct >= 60) sentimentLabel = 'Bullish';
    else if (bearPct >= 60) sentimentLabel = 'Bearish';
    else if (bullPct > bearPct + 10) sentimentLabel = 'Slightly Bullish';
    else if (bearPct > bullPct + 10) sentimentLabel = 'Slightly Bearish';

    return {
      available: true,
      total,
      bullish,
      bearish,
      neutral,
      bullPct,
      bearPct,
      sentimentLabel,
    };
  } catch {
    return { available: false, reason: 'error' };
  }
}
