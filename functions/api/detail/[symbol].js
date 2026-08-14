// GET /api/detail/AAPL — fast path: quote + chart + news only.
// Signals (insider, newsIntel, leadership, hiring) are in /api/signals/AAPL.
// All three sources run concurrently.

import { getQuotes, getFundamentalsBatch, getChart, getNews } from '../../_lib/yahoo.js';
import { json, corsPreflight } from '../../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const symbol = (context.params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const result = { symbol, degraded: false, errors: [] };

  // Run all 3 fast sources concurrently.
  const [quoteR, chartR, newsR] = await Promise.allSettled([
    (async () => {
      try {
        const quotes = await getFundamentalsBatch([symbol]);
        return quotes[0] || null;
      } catch {
        const q2 = await getQuotes([symbol]);
        return q2[0] || null;
      }
    })(),
    getChart(symbol),
    getNews(symbol),
  ]);

  // Quote
  if (quoteR.status === 'fulfilled' && quoteR.value) {
    Object.assign(result, quoteR.value);
  } else {
    result.symbol = symbol;
    result.degraded = true;
    result.errors.push('quote: ' + (quoteR.reason?.message || 'unavailable'));
  }

  // Chart
  if (chartR.status === 'fulfilled') {
    result.chart = chartR.value;
  } else {
    result.chart = { series: [] };
    result.degraded = true;
    result.errors.push('chart: ' + (chartR.reason?.message || 'error'));
  }

  // News
  if (newsR.status === 'fulfilled') {
    result.news = newsR.value;
  } else {
    result.news = [];
    result.degraded = true;
    result.errors.push('news: ' + (newsR.reason?.message || 'error'));
  }

  return json(result, { headers: { 'Cache-Control': 's-maxage=300' } });
}
