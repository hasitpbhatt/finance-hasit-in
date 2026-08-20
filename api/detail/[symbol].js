import { getQuotes, getFundamentalsBatch, getChart, getNews } from '../../lib/yahoo.js';
import { getNasdaqQuote, getNasdaqChart } from '../../lib/nasdaq.js';
import { computeIndicators, lastNonNull } from '../../lib/indicators.js';
import { json, corsPreflight } from '../../lib/http.js';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || url.pathname.split('/').pop() || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const result = { symbol, degraded: false, errors: [] };

  const [quoteR, chartDailyR, chartHistoryR, newsR] = await Promise.allSettled([
    (async () => {
      try {
        const quotes = await getQuotes(symbol);
        return quotes[0] || null;
      } catch {
        const q2 = await getQuotes(symbol);
        return q2[0] || null;
      }
    })(),
    getChart(symbol, '2y'),
    getChart(symbol, 'max'),
    getNews(symbol),
  ]);

  if (quoteR.status === 'fulfilled' && quoteR.value) {
    Object.assign(result, quoteR.value);
  } else {
    // Nasdaq fallback: if Yahoo quotes failed entirely, still surface a live
    // price so the page never shows a blank quote strip.
    const nasdaq = await getNasdaqQuote(symbol).catch(() => null);
    if (nasdaq?.price != null) {
      Object.assign(result, nasdaq);
      result.errors.push('quote: degraded (Nasdaq fallback)');
    } else {
      result.symbol = symbol;
      result.degraded = true;
      result.errors.push('quote: ' + (quoteR.reason?.message || 'unavailable'));
    }
  }

  let daily = chartDailyR.status === 'fulfilled' && chartDailyR.value?.series?.length
    ? chartDailyR.value
    : { series: [] };
  let history = chartHistoryR.status === 'fulfilled' && chartHistoryR.value?.series?.length
    ? chartHistoryR.value.series
    : [];

  // Chart fallback chain: Yahoo → Nasdaq historical (no key, free).
  if (!daily.series.length) {
    const n = await getNasdaqChart(symbol, '2y').catch(() => null);
    if (n?.series?.length) {
      daily = n;
      result.errors.push('chart: degraded (Nasdaq fallback)');
    }
  }
  if (!history.length) {
    const n = await getNasdaqChart(symbol, 'max').catch(() => null);
    if (n?.series?.length) {
      history = n.series;
      result.errors.push('chart history: degraded (Nasdaq fallback)');
    }
  }
  if (!history.length) history = daily.series;

  result.chart = { series: daily.series, history };
  if (!daily.series.length && !history.length) {
    result.degraded = true;
    result.errors.push('chart: ' + (chartDailyR.reason?.message || chartHistoryR.reason?.message || 'error'));
  }

  // Technical indicators computed from the dense daily series (null-safe).
  const closes = daily.series.map(p => p.c).filter(v => v != null);
  const ind = computeIndicators(closes);
  if (ind) {
    result.indicators = {
      sma20: ind.sma20,
      sma50: ind.sma50,
      sma200: ind.sma200,
      rsi14: ind.rsi14,
      macd: ind.macd,
      latest: {
        sma50: lastNonNull(ind.sma20, ind.sma50),
        sma200: lastNonNull(ind.sma200),
        rsi14: lastNonNull(ind.rsi14),
        macdHist: ind.macdHist?.[ind.macdHist.length - 1],
      },
    };
  }

  if (newsR.status === 'fulfilled') {
    result.news = newsR.value;
  } else {
    result.news = [];
    result.degraded = true;
    result.errors.push('news: ' + (newsR.reason?.message || 'error'));
  }

  return json(result, { headers: { 'Cache-Control': 's-maxage=300' } });
}