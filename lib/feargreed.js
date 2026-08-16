// Fear & Greed / market sentiment data. Free, no key.
// Primary: FearGreedChart.com US stock market index (5 components).
// Fallback: alternative.me crypto Fear & Greed Index.
// Plus VIX-based fear gauge via Yahoo.

import { cachedJson, UA } from './cache.js';

// --- US Stock Market Fear & Greed Index (FearGreedChart.com, no key) ---
// 5-component index: Volatility (25%), Momentum (25%), Put/Call (20%),
// Safe Haven (15%), Junk Bond Appetite (15%).
export async function getUsFearGreed() {
  const url = 'https://api.feargreedchart.com/?action=all';
  try {
    const { data } = await cachedJson(url, 900, {
      'User-Agent': UA,
      Accept: 'application/json',
    });
    if (!data?.score) return null;
    const score = data.score;
    const classification = score.score <= 25 ? 'Extreme Fear'
      : score.score <= 45 ? 'Fear'
      : score.score <= 55 ? 'Neutral'
      : score.score <= 75 ? 'Greed'
      : 'Extreme Greed';
    return {
      score: score.score,
      classification,
      components: score.components || [],
      timestamp: data.score.timestamp || null,
    };
  } catch {
    return null;
  }
}

// --- Crypto Fear & Greed (alternative.me, fallback) ---
export async function getFearGreed() {
  const url = 'https://api.alternative.me/fng/?limit=1';
  try {
    const { data } = await cachedJson(url, 900);
    const entry = data?.data?.[0];
    if (!entry) return null;
    return {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: Number(entry.timestamp) * 1000,
    };
  } catch {
    return null;
  }
}

// --- VIX fear gauge via Yahoo ---
export async function getVixFear() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d';
  try {
    const { data } = await cachedJson(url, 600);
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const latest = closes.filter(v => v != null).pop();
    if (latest == null) return null;
    let score;
    if (latest <= 12) score = 10;
    else if (latest <= 15) score = 25;
    else if (latest <= 18) score = 40;
    else if (latest <= 22) score = 55;
    else if (latest <= 28) score = 70;
    else if (latest <= 35) score = 85;
    else score = 95;
    let classification;
    if (score <= 20) classification = 'Extreme Greed';
    else if (score <= 40) classification = 'Greed';
    else if (score <= 60) classification = 'Neutral';
    else if (score <= 80) classification = 'Fear';
    else classification = 'Extreme Fear';
    return { vix: latest, score, classification };
  } catch {
    return null;
  }
}

// --- Combined market sentiment ---
export async function getMarketSentiment() {
  const [usFg, fg, vix] = await Promise.allSettled([getUsFearGreed(), getFearGreed(), getVixFear()]);
  return {
    available: true,
    usFearGreed: usFg.status === 'fulfilled' ? usFg.value : null,
    fearGreed: fg.status === 'fulfilled' ? fg.value : null,
    vix: vix.status === 'fulfilled' ? vix.value : null,
    degraded: usFg.status !== 'fulfilled' && fg.status !== 'fulfilled' && vix.status !== 'fulfilled',
  };
}
