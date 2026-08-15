// GET /api/signals/AAPL — heavy signals: insider, newsIntel, leadership,
// hiring, options, analyst/earnings/dividends, retail sentiment, XBRL trends,
// and a Mistral plain-English narrative. All sources run concurrently via
// Promise.allSettled so the slowest one determines total latency.

import { getInsiderTrades, getLeadershipChanges } from '../../_lib/edgar.js';
import { getNewsIntel } from '../../_lib/newsintel.js';
import { getHiring } from '../../_lib/hiring.js';
import { getOptionChain, computeOptionSignals, getQuotes, getFundamentals } from '../../_lib/yahoo.js';
import { getCboeOptionChain } from '../../_lib/cboe.js';
import { getXbrlTrend } from '../../_lib/xbrl.js';
import { getRetailSentiment } from '../../_lib/stocktwits.js';
import { json, corsPreflight } from '../../_lib/http.js';
import { retryFetch } from '../../_lib/cache.js';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

// Call Mistral to write a plain-English summary from the collected signals.
async function mistralNarrative(symbol, companyName, signals, env) {
  const apiKey = env?.MISTRAL_API_KEY || env?.mistralApiKey;
  if (!apiKey) return null;

  const parts = [];
  if (signals.analyst?.available) {
    const a = signals.analyst;
    parts.push(`Analyst consensus: ${a.analystConsensus || 'N/A'}, target mean $${a.targetMean ?? 'N/A'}, ${a.numAnalysts ?? 0} analysts`);
  }
  if (signals.earnings?.available) {
    const e = signals.earnings;
    parts.push(`Next earnings: ${e.nextEarningsDate || 'N/A'}, beat streak ${e.beatStreak ?? 0} quarters`);
  }
  if (signals.shortInterest?.available) {
    const s = signals.shortInterest;
    parts.push(`Short interest: ${s.shortPercentOfFloat != null ? (s.shortPercentOfFloat * 100).toFixed(1) : 'N/A'}% of float, days to cover ${s.shortRatio ?? 'N/A'}`);
  }
  if (signals.retail?.available) {
    parts.push(`Retail sentiment: ${signals.retail.bullPct ?? 0}% bullish / ${signals.retail.bearPct ?? 0}% bearish`);
  }
  if (signals.newsIntel?.available) {
    parts.push(`News sentiment: ${signals.newsIntel.avgSentiment > 0.2 ? 'positive' : signals.newsIntel.avgSentiment < -0.2 ? 'negative' : 'neutral'} (${signals.newsIntel.count} articles)`);
  }
  if (signals.insiderAvailable) {
    const buys = (signals.insiderTrades || []).filter(t => t.code === 'P').length;
    const sells = (signals.insiderTrades || []).filter(t => t.code === 'S').length;
    parts.push(`Insider trades: ${buys} buys, ${sells} sells`);
  }
  if (signals.options?.available) {
    parts.push(`Options sentiment: ${signals.options.signals?.sentiment || 'N/A'}`);
  }
  if (signals.xbrl?.available) {
    parts.push(`Fundamentals trend: Revenue ${signals.xbrl.revenue?.trendLabel || 'N/A'}, Net income ${signals.xbrl.netIncome?.trendLabel || 'N/A'}`);
  }

  if (parts.length === 0) return null;

  const prompt = `You are a financial analyst writing for a non-expert investor. Based on the following data points for ${symbol} (${companyName || symbol}), write a 3-5 sentence plain-English summary of what's going on with this stock right now. Highlight the most important positives and negatives. End with a one-sentence overall take. Be factual, not speculative. No investment advice disclaimers needed.

Data:
${parts.join('\n')}`;

  try {
    const res = await retryFetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'mistral-medium-latest',
        messages: [
          { role: 'system', content: 'You write concise, factual, layman-friendly stock summaries. 3-5 sentences max.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || null;
    if (!text) return null;
    return { available: true, text: text.trim() };
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const symbol = (context.params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const result = { symbol, degraded: false, errors: [] };

  // Lightweight quote for company name and price.
  let companyName = '';
  let quote = null;
  try {
    const quotes = await getQuotes([symbol]);
    quote = quotes[0] || null;
    companyName = quote?.name || '';
  } catch { /* not critical */ }

  // All signal sources run concurrently with per-source timeouts.
  // Total budget: ~25s (leaves 5s headroom for Cloudflare's 30s limit).
  const TIMEOUTS = {
    insider: 6000,
    newsIntel: 5000,
    leadership: 8000,
    hiring: 4000,
    options: 6000,
    analyst: 8000,
    retail: 4000,
    xbrl: 10000,
  };

  const [insiderR, newsIntelR, leadershipR, hiringR, optionsR, analystR, retailR, xbrlR] = await Promise.allSettled([
    withTimeout(getInsiderTrades(symbol, 5), TIMEOUTS.insider),
    withTimeout(getNewsIntel(symbol, companyName), TIMEOUTS.newsIntel),
    withTimeout(getLeadershipChanges(symbol, 12, context.env), TIMEOUTS.leadership),
    withTimeout(getHiring(symbol), TIMEOUTS.hiring),
    withTimeout((async () => {
      try {
        const cboe = await getCboeOptionChain(symbol);
        if (cboe) {
          const chain = { expirations: cboe.expirations, chain: cboe.chain };
          return computeOptionSignals(chain, cboe.currentPrice || quote?.price);
        }
      } catch { /* CBOE failed */ }
      try {
        const chain = await getOptionChain(symbol);
        return computeOptionSignals(chain, quote?.price);
      } catch { /* Yahoo also failed */ }
      return null;
    })(), TIMEOUTS.options),
    // Analyst/earnings/dividends/short-interest via getFundamentals (single quoteSummary call)
    withTimeout(getFundamentals(symbol).catch(() => null), TIMEOUTS.analyst),
    // Retail sentiment
    withTimeout(getRetailSentiment(symbol), TIMEOUTS.retail),
    // XBRL fundamentals trend
    withTimeout(getXbrlTrend(symbol), TIMEOUTS.xbrl),
  ]);

  // --- Insider ---
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

  // --- News intelligence ---
  if (newsIntelR.status === 'fulfilled' && newsIntelR.value) {
    result.newsIntel = newsIntelR.value;
  } else {
    result.newsIntel = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('newsIntel: ' + (newsIntelR.reason?.message || 'timeout'));
  }

  // --- Leadership ---
  if (leadershipR.status === 'fulfilled' && leadershipR.value) {
    result.leadership = leadershipR.value;
  } else {
    result.leadership = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('leadership: ' + (leadershipR.reason?.message || 'timeout'));
  }

  // --- Hiring ---
  if (hiringR.status === 'fulfilled' && hiringR.value) {
    result.hiring = hiringR.value;
  } else {
    result.hiring = { available: false, reason: 'error' };
    result.degraded = true;
    result.errors.push('hiring: ' + (hiringR.reason?.message || 'timeout'));
  }

  // --- Options ---
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

  // --- Analyst / earnings / dividends / short-interest ---
  if (analystR.status === 'fulfilled' && analystR.value) {
    const f = analystR.value;
    result.analyst = {
      available: true,
      consensus: f.analystConsensus || null,
      mean: f.analystMean ?? null,
      targetMean: f.targetMean ?? null,
      targetHigh: f.targetHigh ?? null,
      targetLow: f.targetLow ?? null,
      targetMedian: f.targetMedian ?? null,
      numAnalysts: f.numAnalysts ?? null,
      breakdown: f.analystBreakdown || null,
      upsidePct: (f.targetMean != null && f.price != null && f.price > 0)
        ? +((f.targetMean - f.price) / f.price * 100).toFixed(1)
        : null,
    };
    result.earnings = {
      available: true,
      nextDate: f.nextEarningsDate || null,
      epsEstimate: f.epsEstimate ?? null,
      beatStreak: f.beatStreak ?? 0,
      surpriseHistory: f.surpriseHistory || [],
    };
    result.dividends = {
      available: f.dividendRate != null || f.dividendYield != null,
      rate: f.dividendRate ?? null,
      yield: f.dividendYield ?? null,
      exDividendDate: f.exDividendDate || null,
      payoutRatio: f.payoutRatio ?? null,
    };
    result.shortInterest = {
      available: f.sharesShort != null || f.shortPercentOfFloat != null,
      sharesShort: f.sharesShort ?? null,
      shortRatio: f.shortRatio ?? null,
      shortPercentOfFloat: f.shortPercentOfFloat ?? null,
      dateShortInterest: f.dateShortInterest || null,
      sharesShortPriorMonth: f.sharesShortPriorMonth ?? null,
    };
  } else {
    result.analyst = { available: false };
    result.earnings = { available: false };
    result.dividends = { available: false };
    result.shortInterest = { available: false };
    result.errors.push('analyst: ' + (analystR.reason?.message || 'timeout'));
  }

  // --- Retail sentiment ---
  if (retailR.status === 'fulfilled' && retailR.value) {
    result.retail = retailR.value;
  } else {
    result.retail = { available: false, reason: 'error' };
    result.errors.push('retail: ' + (retailR.reason?.message || 'timeout'));
  }

  // --- XBRL fundamentals trend ---
  if (xbrlR.status === 'fulfilled' && xbrlR.value) {
    result.xbrl = xbrlR.value;
  } else {
    result.xbrl = { available: false, reason: 'error' };
    result.errors.push('xbrl: ' + (xbrlR.reason?.message || 'timeout'));
  }

  // --- Signal flags ---
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

  // --- Mistral narrative (runs after all signals, uses aggregated data) ---
  try {
    const narrative = await withTimeout(mistralNarrative(symbol, companyName, result, context.env), 8000);
    result.narrative = narrative || { available: false, reason: 'unavailable' };
  } catch {
    result.narrative = { available: false, reason: 'error' };
  }

  return json(result, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, max-age=60',
      'CDN-Cache-Control': 'public, s-maxage=300',
    },
  });
}
