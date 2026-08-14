// Fear & Greed / market sentiment data. Free, no key.
// Primary: alternative.me crypto Fear & Greed Index.
// We also compute a simple VIX-based market fear gauge via Yahoo.

import { cachedJson, UA } from './cache.js';

// Fetch the Fear & Greed Index from alternative.me (crypto-based, but widely used).
// Returns { value, classification, timestamp } or null on failure.
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

// Fetch VIX from Yahoo and compute a simple fear score (0-100).
// VIX < 15 = extreme greed, 15-20 = greed/neutral, 20-30 = fear, >30 = extreme fear.
export async function getVixFear() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d';
  try {
    const { data } = await cachedJson(url, 600);
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const latest = closes.filter(v => v != null).pop();
    if (latest == null) return null;
    // Map VIX to 0-100 fear score (inverted: high VIX = high fear)
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

// Combined market sentiment. Aggregates fear/greed + VIX.
export async function getMarketSentiment() {
  const [fg, vix] = await Promise.allSettled([getFearGreed(), getVixFear()]);
  return {
    available: true,
    fearGreed: fg.status === 'fulfilled' ? fg.value : null,
    vix: vix.status === 'fulfilled' ? vix.value : null,
    degraded: fg.status !== 'fulfilled' && vix.status !== 'fulfilled',
  };
}
