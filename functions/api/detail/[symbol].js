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

  // Run all 4 fast sources concurrently.
  // Chart: 2y daily (serves the 1M/3M/6M/1Y range buttons) + max (serves ALL).
  // Yahoo coalesces range=max down to ~quarterly points, so short ranges must
  // be sliced from the denser 2y series instead.
  const [quoteR, chartDailyR, chartHistoryR, newsR] = await Promise.allSettled([
    (async () => {
      try {
        const quotes = await getFundamentalsBatch([symbol]);
        return quotes[0] || null;
      } catch {
        const q2 = await getQuotes([symbol]);
        return q2[0] || null;
      }
    })(),
    getChart(symbol, '2y'),
    getChart(symbol, 'max'),
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
  const daily = chartDailyR.status === 'fulfilled' && chartDailyR.value?.series?.length
    ? chartDailyR.value
    : { series: [] };
  const history = chartHistoryR.status === 'fulfilled' && chartHistoryR.value?.series?.length
    ? chartHistoryR.value.series
    : daily.series;
  result.chart = { series: daily.series, history };
  if (!daily.series.length && !history.length) {
    result.degraded = true;
    result.errors.push('chart: ' + (chartDailyR.reason?.message || chartHistoryR.reason?.message || 'error'));
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
