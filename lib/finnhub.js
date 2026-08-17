// Finnhub data providers (requires FINNHUB_API_KEY env var).
// Endpoints: earnings surprises, analyst recommendations, company news.
// Free tier: 60 calls/min — we cache aggressively (1h for fundamentals, 30m for news).

import { cachedJson } from './cache.js';

const BASE = 'https://finnhub.io/api/v1';

function getKey(env) {
  return env?.FINNHUB_API_KEY || env?.finnhubApiKey || '';
}

// --- Earnings surprises (actual vs estimate per quarter) ---
// Returns the most recent N quarters of earnings data.
export async function getEarnings(symbol, env, signal) {
  const key = getKey(env);
  if (!key) return null;
  const url = `${BASE}/stock/earnings?symbol=${encodeURIComponent(symbol)}&limit=8`;
  try {
    const { data } = await cachedJson(url, 3600, { token: key }, null, signal);
    if (!Array.isArray(data) || !data.length) return null;
    return {
      available: true,
      quarters: data.map(q => ({
        period: q.period || null,         // e.g. "2024-01-01"
        quarter: q.quarter || null,       // e.g. "Q1 2024"
        year: q.year || null,
        epsActual: q.epsActual ?? null,
        epsEstimate: q.epsEstimate ?? null,
        surprisePercent: q.surprisePercent ?? null,
        revenue: q.revenue ?? null,
        revenueEstimate: q.revenueEstimate ?? null,
      })),
    };
  } catch {
    return null;
  }
}

// --- Analyst recommendations (buy/hold/sell counts + price targets) ---
export async function getRecommendations(symbol, env, signal) {
  const key = getKey(env);
  if (!key) return null;
  const url = `${BASE}/stock/recommendation?symbol=${encodeURIComponent(symbol)}`;
  try {
    const { data } = await cachedJson(url, 3600, { token: key }, null, signal);
    if (!Array.isArray(data) || !data.length) return null;
    // Take the most recent period
    const latest = data[0];
    return {
      available: true,
      period: latest.period || null,
      strongBuy: latest.strongBuy ?? 0,
      buy: latest.buy ?? 0,
      hold: latest.hold ?? 0,
      sell: latest.sell ?? 0,
      strongSell: latest.strongSell ?? 0,
    };
  } catch {
    return null;
  }
}

// --- Company news (recent articles with timestamps) ---
export async function getCompanyNews(symbol, env, signal) {
  const key = getKey(env);
  if (!key) return null;
  // Last 30 days
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 3600_000);
  const fmt = d => d.toISOString().split('T')[0];
  const url = `${BASE}/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(now)}`;
  try {
    const { data } = await cachedJson(url, 1800, { token: key }, null, signal);
    if (!Array.isArray(data) || !data.length) return null;
    return {
      available: true,
      count: data.length,
      articles: data.slice(0, 20).map(a => ({
        headline: a.headline || '',
        summary: a.summary || '',
        source: a.source || '',
        url: a.url || '',
        published: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
        category: a.category || '',
      })),
    };
  } catch {
    return null;
  }
}
