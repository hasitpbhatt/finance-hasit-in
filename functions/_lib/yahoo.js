// Yahoo Finance helpers (free, no key). Uses the public query1 endpoints.
// Yahoo's quote endpoint now requires a cookie + crumb; we obtain a short-lived
// session and cache it at the edge. All calls go through the edge TTL cache with
// graceful degradation.

import { cachedJson, cachedText, UA } from './cache.js';

const YH = 'https://query1.finance.yahoo.com';

// Fields we request from v7/quote. The deeper fundamentals (ROE, margins,
// debt/equity, growth, EV multiples) are NOT exposed by v7, so we fetch those
// separately from v10/quoteSummary (see getFundamentals below).
const QUOTE_FIELDS = [
  'symbol', 'shortName', 'longName', 'quoteType',
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketDayHigh', 'regularMarketDayLow', 'regularMarketVolume',
  'marketCap', 'trailingPE', 'forwardPE', 'dividendYield',
  'sector', 'industry', 'regularMarketTime', 'currency', 'exchangeName',
  'priceToBook', 'beta', 'fiftyDayAverage', 'twoHundredDayAverage',
  'bookValue', 'sharesOutstanding', 'heldPercentInsiders',
  'heldPercentInstitutions', 'floatShares',
  'sharesShort', 'sharesShortPriorMonth', 'shortRatio',
  'shortPercentOfFloat', 'dateShortInterest',
].join(',');

// Modules requested from v10/quoteSummary for the value-investor fundamentals.
// + recommendationTrend, calendarEvents, earningsHistory, earningsTrend for
// analyst ratings, earnings surprises, dividends.
const FUND_MODULES = 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,recommendationTrend,calendarEvents,earningsHistory,earningsTrend';

const CRUMB_KEY = new Request('https://internal/yahoo-session');
const CRUMB_TTL = 10 * 60 * 1000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Obtain a Yahoo cookie + crumb. Cached at the edge for CRUMB_TTL.
async function getSession(force = false) {
  if (!force && typeof caches !== 'undefined') {
    const hit = await caches.default.match(CRUMB_KEY);
    if (hit) {
      const at = Number(hit.headers.get('X-Cached-At') || '0');
      if (Date.now() - at < CRUMB_TTL) return hit.json();
    }
  }
  const fc = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'follow' });
  const rawCookie = fc.headers.get('set-cookie') || '';
  const cookie = rawCookie
    .split(/,\s*(?=[^;]+=)/)
    .map((c) => c.split(';')[0])
    .join('; ');
  const crumbRes = await fetch(`${YH}/v1/test/getcrumb`, {
    headers: { 'User-Agent': UA['User-Agent'], Accept: '*/*', Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  const session = { cookie, crumb };
  if (typeof caches !== 'undefined') {
    await caches.default.put(
      CRUMB_KEY,
      new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'X-Cached-At': String(Date.now()) },
      }),
    );
  }
  return session;
}

// Returns a flat array of normalized quote objects. Missing fields -> null.
export async function getQuotes(symbols, signal = null) {
  const results = [];
  for (const group of chunk(symbols, 50)) {
    const built = (session) =>
      `${YH}/v7/finance/quote?symbols=${encodeURIComponent(group.join(','))}` +
      `&fields=${QUOTE_FIELDS}&crumb=${encodeURIComponent(session.crumb)}`;
    // Cache under a crumb-independent key so the rotating crumb doesn't bust it.
    const cacheKey = (session) =>
      `${YH}/v7/finance/quote?symbols=${encodeURIComponent(group.join(','))}` +
      `&fields=${QUOTE_FIELDS}`;
    const headersFor = (session) => ({
      'User-Agent': UA['User-Agent'],
      Accept: '*/*',
      Cookie: session.cookie,
    });

    let session = await getSession();
    let data;
    try {
      ({ data } = await cachedJson(built(session), 3600, headersFor(session), cacheKey(session), signal));
    } catch (e) {
      // Session likely expired -> refresh once and retry.
      session = await getSession(true);
      ({ data } = await cachedJson(built(session), 3600, headersFor(session), cacheKey(session), signal));
    }

    const list = data?.quoteResponse?.result || [];
    for (const q of list) {
      results.push({
        symbol: q.symbol,
        name: q.shortName || q.longName || q.symbol,
        type: (q.quoteType || 'EQUITY').toUpperCase() === 'ETF' ? 'ETF' : 'STOCK',
        price: q.regularMarketPrice ?? null,
        change: q.regularMarketChange ?? null,
        changePercent: q.regularMarketChangePercent ?? null,
        dayHigh: q.regularMarketDayHigh ?? null,
        dayLow: q.regularMarketDayLow ?? null,
        volume: q.regularMarketVolume ?? null,
        marketCap: q.marketCap ?? null,
        pe: q.trailingPE ?? null,
        forwardPe: q.forwardPE ?? null,
        dividendYield: q.dividendYield ?? null,
        sector: q.sector || 'Unknown',
        industry: q.industry || null,
        currency: q.currency || 'USD',
        exchange: q.exchangeName || null,
        asOf: q.regularMarketTime || null,
        priceToBook: q.priceToBook ?? null,
        returnOnEquity: q.returnOnEquity ?? null,
        debtToEquity: q.debtToEquity ?? null,
        currentRatio: q.currentRatio ?? null,
        quickRatio: q.quickRatio ?? null,
        grossMargins: q.grossMargins ?? null,
        profitMargins: q.profitMargins ?? null,
        earningsQuarterlyGrowth: q.earningsQuarterlyGrowth ?? null,
        revenueQuarterlyGrowth: q.revenueQuarterlyGrowth ?? null,
        beta: q.beta ?? null,
        fiftyDayAverage: q.fiftyDayAverage ?? null,
        twoHundredDayAverage: q.twoHundredDayAverage ?? null,
        fiftyTwoWeekChange: q.fiftyTwoWeekChange ?? null,
        enterpriseValue: q.enterpriseValue ?? null,
        enterpriseToRevenue: q.enterpriseToRevenue ?? null,
        enterpriseToEbitda: q.enterpriseToEbitda ?? null,
        totalCashPerShare: q.totalCashPerShare ?? null,
        totalDebt: q.totalDebt ?? null,
        sharesOutstanding: q.sharesOutstanding ?? null,
        heldPercentInsiders: q.heldPercentInsiders ?? null,
        heldPercentInstitutions: q.heldPercentInstitutions ?? null,
        floatShares: q.floatShares ?? null,
        bookValue: q.bookValue ?? null,
        sharesShort: q.sharesShort ?? null,
        shortRatio: q.shortRatio ?? null,
        shortPercentOfFloat: q.shortPercentOfFloat ?? null,
        dateShortInterest: q.dateShortInterest ?? null,
        sharesShortPriorMonth: q.sharesShortPriorMonth ?? null,
      });
    }
  }
  return results;
}

// Pull the numeric `raw` value out of a Yahoo quoteSummary field node.
// Yahoo wraps most fields as { raw, fmt }; some may be a bare number or absent.
function qRaw(node, key) {
  const v = node ? node[key] : undefined;
  if (v == null) return null;
  if (typeof v === 'object' && 'raw' in v) return v.raw ?? null;
  if (typeof v === 'number') return v;
  return null;
}

// Normalize a v10/quoteSummary result into the same shape as getQuotes, but
// with the deeper value-investor fundamentals populated.
function normalizeFundamental(result) {
  const price = result?.price || {};
  const sd = result?.summaryDetail || {};
  const dks = result?.defaultKeyStatistics || {};
  const fd = result?.financialData || {};
  const ap = result?.assetProfile || {};
  const rt = result?.recommendationTrend?.trend || [];
  const cal = result?.calendarEvents?.earnings || {};
  const eHist = result?.earningsHistory?.history || [];
  const eTrend = result?.earningsTrend?.trend || [];

  // Analyst: latest period (0m) from recommendationTrend
  const latestRT = rt.find(t => t.period === '0m') || rt[0] || null;
  const analystConsensus = fd?.recommendationKey || null;
  const analystMean = qRaw(fd, 'recommendationMean');
  const targetMean = qRaw(fd, 'targetMeanPrice');
  const targetHigh = qRaw(fd, 'targetHighPrice');
  const targetLow = qRaw(fd, 'targetLowPrice');
  const targetMedian = qRaw(fd, 'targetMedianPrice');
  const numAnalysts = qRaw(fd, 'numberOfAnalystOpinions');
  const analystBreakdown = latestRT ? {
    strongBuy: latestRT.strongBuy ?? null,
    buy: latestRT.buy ?? null,
    hold: latestRT.hold ?? null,
    sell: latestRT.sell ?? null,
    strongSell: latestRT.strongSell ?? null,
  } : null;

  // Earnings: next date, historical surprises
  const nextEarningsDate = cal?.formattedDate || cal?.date || null;
  const earningsEstimate = eTrend.find(t => t.period === '0q' || t.period === '0cq') || eTrend[0] || null;
  const epsEstimate = earningsEstimate?.earningsEstimate?.avg?.raw ?? null;
  const epsEstimateHigh = earningsEstimate?.earningsEstimate?.high?.raw ?? null;
  const epsEstimateLow = earningsEstimate?.earningsEstimate?.low?.raw ?? null;
  const epsGrowthPct = earningsEstimate?.earningsEstimate?.growth?.raw ?? null;

  // Cash flow (owner earnings) — Buffett's lens
  const freeCashflow = qRaw(fd, 'freeCashflow');
  const operatingCashflow = qRaw(fd, 'operatingCashflow');
  const ebitda = qRaw(fd, 'ebitda');
  const totalRevenue = qRaw(fd, 'totalRevenue');
  const returnOnAssets = qRaw(fd, 'returnOnAssets');
  const netIncome = qRaw(fd, 'netIncome') ?? qRaw(dks, 'netIncomeToCommon');

  // Earnings surprise history (most recent 8 quarters)
  const surpriseHistory = eHist.slice(0, 8).map(h => ({
    quarter: h.quarter || null,
    year: h.year ?? null,
    epsActual: h.epsActual?.raw ?? null,
    epsEstimate: h.epsEstimate?.raw ?? null,
    surprisePercent: h.surprisePercent?.raw ?? null,
  }));

  // Beat streak: consecutive quarters where actual > estimate
  let beatStreak = 0;
  for (const h of eHist) {
    if (h.epsActual?.raw != null && h.epsEstimate?.raw != null) {
      if (h.epsActual.raw >= h.epsEstimate.raw) beatStreak++;
      else break;
    } else break;
  }

  // Dividends
  const dividendRate = qRaw(sd, 'dividendRate');
  const dividendYieldQ = qRaw(sd, 'dividendYield');
  const exDividendDate = qRaw(sd, 'exDividendDate');
  const payoutRatio = qRaw(sd, 'payoutRatio');

  // Short interest (from v7 quote fields — these live in summaryDetail/defaultKeyStatistics)
  const sharesShortVal = qRaw(dks, 'sharesShort');
  const shortRatioVal = qRaw(dks, 'shortRatio');
  const shortPctFloat = qRaw(dks, 'shortPercentOfFloat');
  const dateShortInterestVal = qRaw(dks, 'dateShortInterest');
  const sharesShortPriorVal = qRaw(dks, 'sharesShortPriorMonth');

  return {
    symbol: price.symbol || (result?.symbol) || null,
    name: price.shortName || price.longName || price.symbol || null,
    type: (price.quoteType || 'EQUITY').toUpperCase() === 'ETF' ? 'ETF' : 'STOCK',
    price: qRaw(price, 'regularMarketPrice'),
    change: qRaw(price, 'regularMarketChange'),
    changePercent: qRaw(price, 'regularMarketChangePercent'),
    dayHigh: qRaw(price, 'regularMarketDayHigh'),
    dayLow: qRaw(price, 'regularMarketDayLow'),
    volume: qRaw(price, 'regularMarketVolume'),
    marketCap: qRaw(price, 'marketCap'),
    pe: qRaw(sd, 'trailingPE'),
    forwardPe: qRaw(sd, 'forwardPE'),
    dividendYield: dividendYieldQ,
    sector: ap.sector || 'Unknown',
    industry: ap.industry || null,
    currency: price.currency || 'USD',
    exchange: price.exchangeName || null,
    asOf: qRaw(price, 'regularMarketTime'),
    priceToBook: qRaw(dks, 'priceToBook'),
    returnOnEquity: qRaw(fd, 'returnOnEquity'),
    debtToEquity: qRaw(fd, 'debtToEquity'),
    currentRatio: qRaw(fd, 'currentRatio'),
    quickRatio: qRaw(fd, 'quickRatio'),
    grossMargins: qRaw(fd, 'grossMargins'),
    profitMargins: qRaw(dks, 'profitMargins'),
    earningsQuarterlyGrowth: qRaw(dks, 'earningsQuarterlyGrowth'),
    revenueQuarterlyGrowth: qRaw(fd, 'revenueGrowth'),
    beta: qRaw(sd, 'beta'),
    fiftyDayAverage: qRaw(sd, 'fiftyDayAverage'),
    twoHundredDayAverage: qRaw(sd, 'twoHundredDayAverage'),
    fiftyTwoWeekChange: qRaw(price, 'fiftyTwoWeekChange'),
    enterpriseValue: qRaw(dks, 'enterpriseValue'),
    enterpriseToRevenue: qRaw(dks, 'enterpriseToRevenue'),
    enterpriseToEbitda: qRaw(dks, 'enterpriseToEbitda'),
    totalCashPerShare: qRaw(fd, 'totalCashPerShare'),
    totalDebt: qRaw(fd, 'totalDebt'),
    sharesOutstanding: qRaw(dks, 'sharesOutstanding'),
    heldPercentInsiders: qRaw(dks, 'heldPercentInsiders'),
    heldPercentInstitutions: qRaw(dks, 'heldPercentInstitutions'),
    floatShares: qRaw(dks, 'floatShares'),
    bookValue: qRaw(dks, 'bookValue'),
    fullTimeEmployees: qRaw(ap, 'fullTimeEmployees'),
    // Analyst
    analystConsensus, analystMean, targetMean, targetHigh, targetLow, targetMedian,
    numAnalysts, analystBreakdown,
    // Earnings
    nextEarningsDate, epsEstimate, epsEstimateHigh, epsEstimateLow, epsGrowthPct,
    surpriseHistory, beatStreak,
    // Cash flow
    freeCashflow, operatingCashflow, ebitda, totalRevenue, returnOnAssets, netIncome,
    // Dividends
    dividendRate, exDividendDate, payoutRatio,
    // Short interest
    sharesShort: sharesShortVal, shortRatio: shortRatioVal,
    shortPercentOfFloat: shortPctFloat, dateShortInterest: dateShortInterestVal,
    sharesShortPriorMonth: sharesShortPriorVal,
  };
}

// Fetch the full value-investor fundamentals for a single symbol via
// v10/quoteSummary. Returns null on failure. Cached at the edge for 1h under a
// crumb-independent key.
export async function getFundamentals(symbol, signal = null) {
  const session = await getSession();
  const built =
    `${YH}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=${FUND_MODULES}&crumb=${encodeURIComponent(session.crumb)}`;
  const cacheKey =
    `${YH}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${FUND_MODULES}`;
  const headers = {
    'User-Agent': UA['User-Agent'],
    Accept: '*/*',
    Cookie: session.cookie,
  };
  const { data } = await cachedJson(built, 3600, headers, cacheKey, signal);
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return null;
  return normalizeFundamental(result);
}

// Fetch fundamentals for many symbols with bounded concurrency (used by the
// screener). Yahoo rate-limits aggressively, so we cap parallel requests and
// rely on the 1h edge cache to keep repeat runs cheap. Failures are skipped.
export async function getFundamentalsBatch(symbols, concurrency = 20) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const s = symbols[i++];
      try {
        const f = await getFundamentals(s);
        if (f) out.push(f);
      } catch {
        /* skip unavailable symbol */
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, symbols.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// Historical close series for a symbol. Returns { series: [{t, c}] }.
export async function getChart(symbol, range = '6mo', interval = '1d', signal = null) {
  const url =
    `${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  // Daily close series changes at most a few times per session; 6h TTL keeps
  // the chart fresh without hammering Yahoo (the heaviest endpoint by payload).
  const { data } = await cachedJson(url, 21600, {}, null, signal);
  const result = data?.chart?.result?.[0];
  if (!result) return { series: [] };
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) series.push({ t: timestamps[i], c: closes[i], d: new Date(timestamps[i] * 1000).toISOString().slice(0, 10) });
  }
  return { series };
}

// Latest headlines for a symbol via Yahoo's RSS headline feed (free, no key).
export async function getNews(symbol, limit = 8, signal = null) {
  const url =
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}` +
    `&region=US&lang=en-US`;
  try {
    const { data: xml } = await cachedText(url, 900, {}, null, signal);
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const news = [];
    for (const block of items) {
      const pick = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (!m) return null;
        return m[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
      };
      const title = pick('title');
      const link = pick('link');
      const pubDate = pick('pubDate');
      if (title && link) news.push({ title, link, pubDate });
      if (news.length >= limit) break;
    }
    return news;
  } catch {
    return [];
  }
}

// --- Options chain + derived signals ---

// Fetch the full options chain for a symbol via Yahoo's v7/options endpoint.
// Returns { expirations, chain: [{ expiry, calls, puts }] } or null on failure.
export async function getOptionChain(symbol, signal = null) {
  const session = await getSession();
  const built =
    `${YH}/v7/finance/options/${encodeURIComponent(symbol)}` +
    `?getAllData=true&crumb=${encodeURIComponent(session.crumb)}`;
  const cacheKey =
    `${YH}/v7/finance/options/${encodeURIComponent(symbol)}?getAllData=true`;
  const headers = { 'User-Agent': UA['User-Agent'], Accept: '*/*', Cookie: session.cookie };
  try {
    const { data } = await cachedJson(built, 1800, headers, cacheKey, signal);
    const result = data?.optionChain?.result?.[0];
    if (!result) return null;
    const expirations = result.expirationDates || [];
    const options = result.options || [];
    const chain = options.map(o => ({
      expiry: o.expirationDate,
      calls: (o.calls || []).map(c => ({
        symbol: c.contractSymbol,
        strike: c.strike,
        bid: c.bid,
        ask: c.ask,
        last: c.lastPrice,
        vol: c.volume,
        oi: c.openInterest,
        iv: c.impliedVolatility,
        itm: c.inTheMoney,
        _type: 'call',
      })),
      puts: (o.puts || []).map(p => ({
        symbol: p.contractSymbol,
        strike: p.strike,
        bid: p.bid,
        ask: p.ask,
        last: p.lastPrice,
        vol: p.volume,
        oi: p.openInterest,
        iv: p.impliedVolatility,
        itm: p.inTheMoney,
        _type: 'put',
      })),
    }));
    return { expirations, chain };
  } catch {
    return null;
  }
}

// Lighter options fetch for the signals path: only the two expiries that the
// signals actually consume (nearest, and the one closest to ~30 DTE). Avoids
// getAllData's 1-3MB payload, which is the heaviest JSON.parse in the app and
// a major CPU-time risk on the Workers Free plan's 10ms budget.
// Returns the same { expirations, chain } shape as getOptionChain.
export async function getOptionChainLimited(symbol, signal = null) {
  const session = await getSession();
  const headers = { 'User-Agent': UA['User-Agent'], Accept: '*/*', Cookie: session.cookie };
  const baseCacheKey =
    `${YH}/v7/finance/options/${encodeURIComponent(symbol)}`;
  try {
    // 1) Get expiration list (tiny response).
    const built1 = `${baseCacheKey}?crumb=${encodeURIComponent(session.crumb)}`;
    const { data } = await cachedJson(built1, 1800, headers, baseCacheKey, signal);
    const result = data?.optionChain?.result?.[0];
    if (!result) return null;
    const expirations = result.expirationDates || [];
    if (!expirations.length) return null;

    // 2) Pick nearest + closest-to-30-DTE.
    const now = Date.now();
    const dteOf = e => Math.max(1, Math.round((e * 1000 - now) / 86400000));
    const nearest = expirations.reduce((a, b) => (dteOf(b) < dteOf(a) ? b : a));
    const move = expirations.reduce((a, b) =>
      (Math.abs(dteOf(b) - 30) < Math.abs(dteOf(a) - 30) ? b : a));

    // 3) Fetch just those two (two small calls instead of one giant one).
    const want = new Set([nearest, move]);
    const chain = [];
    for (const expiry of expirations) {
      if (!want.has(expiry)) continue;
      const built = `${baseCacheKey}?expiration=${expiry}&crumb=${encodeURIComponent(session.crumb)}`;
      const key = `${baseCacheKey}?expiration=${expiry}`;
      const { data: d2 } = await cachedJson(built, 1800, headers, key, signal);
      const res = d2?.optionChain?.result?.[0];
      if (!res) continue;
      const o = (res.options || [])[0];
      chain.push({
        expiry: o?.expirationDate ?? expiry,
        calls: (o?.calls || []).map(c => ({
          symbol: c.contractSymbol, strike: c.strike, bid: c.bid, ask: c.ask,
          last: c.lastPrice, vol: c.volume, oi: c.openInterest,
          iv: c.impliedVolatility, itm: c.inTheMoney, _type: 'call',
        })),
        puts: (o?.puts || []).map(p => ({
          symbol: p.contractSymbol, strike: p.strike, bid: p.bid, ask: p.ask,
          last: p.lastPrice, vol: p.volume, oi: p.openInterest,
          iv: p.impliedVolatility, itm: p.inTheMoney, _type: 'put',
        })),
      });
      if (chain.length === want.size) break;
    }
    if (!chain.length) return null;
    return { expirations, chain };
  } catch {
    return null;
  }
}

// Compute option-derived signals from a chain. Returns a summary object.
export function computeOptionSignals(chain, currentPrice, opts = {}) {
  if (!chain?.chain?.length || !currentPrice) return null;
  const now = Date.now();
  const dteFor = (epoch) => (epoch ? Math.max(1, Math.round((epoch * 1000 - now) / 86400000)) : null);
  const dteOf = (e) => dteFor(e.expiry) ?? 99999;

  // Expiry driving the expected move / probability bands.
  // Default: expiration closest to 30 days. Explicit: the requested epoch.
  let moveEntry;
  if (opts.expiryEpoch != null) {
    moveEntry = chain.chain.find(e => e.expiry === opts.expiryEpoch)
      || chain.chain.reduce((best, e) => (!best || Math.abs(e.expiry - opts.expiryEpoch) < Math.abs(best.expiry - opts.expiryEpoch) ? e : best), null);
  } else {
    moveEntry = chain.chain.reduce((best, e) => {
      if (!best) return e;
      return (Math.abs(dteOf(e) - 30) < Math.abs(dteOf(best) - 30)) ? e : best;
    }, null);
  }
  if (!moveEntry) return null;

  // Expiry for positioning signals (put/call, max pain, support/resistance,
  // unusual activity, IV). Default: nearest; explicit: same as the move expiry.
  const activeEntry = opts.expiryEpoch != null ? moveEntry : chain.chain[0];
  const { calls, puts } = activeEntry;
  const moveCalls = moveEntry.calls || [];
  const movePuts = moveEntry.puts || [];
  const dte = dteFor(moveEntry.expiry) ?? 1;
  const moveDate = moveEntry.expiry ? new Date(moveEntry.expiry * 1000).toISOString().split('T')[0] : null;

  // Aggregate volume and OI
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const c of calls) { callVol += c.vol || 0; callOI += c.oi || 0; }
  for (const p of puts) { putVol += p.vol || 0; putOI += p.oi || 0; }

  const totalVol = callVol + putVol;
  const totalOI = callOI + putOI;

  // Put/call ratios
  const pcRatioVol = callVol > 0 ? putVol / callVol : null;
  const pcRatioOI = callOI > 0 ? putOI / callOI : null;

  // --- Implied move (1 standard deviation) from the MOVE expiry ---
  // ATM IV × price × sqrt(DTE/365) = expected dollar move
  const atmCalls = moveCalls.filter(c => c.iv > 0 && Math.abs(c.strike - currentPrice) / currentPrice < 0.03);
  const atmPuts = movePuts.filter(p => p.iv > 0 && Math.abs(p.strike - currentPrice) / currentPrice < 0.03);
  const atmIVs = [...atmCalls, ...atmPuts].map(c => c.iv);
  const atmIV = atmIVs.length ? atmIVs.reduce((a, b) => a + b, 0) / atmIVs.length : null;
  const expectedMoveDollar = (atmIV != null && dte != null) ? +(currentPrice * atmIV * Math.sqrt(dte / 365)).toFixed(2) : null;
  const expectedMovePct = expectedMoveDollar != null ? +(expectedMoveDollar / currentPrice * 100).toFixed(1) : null;

  // --- Probability bands (normal-distribution approx centered on current price) ---
  const sigma = expectedMoveDollar;
  const probabilityBands = sigma != null ? {
    p50: { lo: +(currentPrice - 0.674 * sigma).toFixed(2), hi: +(currentPrice + 0.674 * sigma).toFixed(2) },
    p60: { lo: +(currentPrice - 0.842 * sigma).toFixed(2), hi: +(currentPrice + 0.842 * sigma).toFixed(2) },
    p68: { lo: +(currentPrice - sigma).toFixed(2), hi: +(currentPrice + sigma).toFixed(2) },
    p70: { lo: +(currentPrice - 1.036 * sigma).toFixed(2), hi: +(currentPrice + 1.036 * sigma).toFixed(2) },
    p80: { lo: +(currentPrice - 1.282 * sigma).toFixed(2), hi: +(currentPrice + 1.282 * sigma).toFixed(2) },
    p90: { lo: +(currentPrice - 1.645 * sigma).toFixed(2), hi: +(currentPrice + 1.645 * sigma).toFixed(2) },
  } : null;

  // --- Probability of being above/below key prices (delta ≈ prob ITM) ---
  // Find the strikes closest to key levels: current price, ±expected move
  function findStrikeNear(strikeList, target) {
    let best = null, bestDist = Infinity;
    for (const c of strikeList) {
      const d = Math.abs(c.strike - target);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  // Probability of staying above support (highest put OI strike below price)
  const putsBelow = puts.filter(p => p.strike < currentPrice && p.oi > 0).sort((a, b) => b.strike - a.strike);
  const support = putsBelow[0] || null;
  // Probability of staying below resistance (highest call OI strike above price)
  const callsAbove = calls.filter(c => c.strike > currentPrice && c.oi > 0).sort((a, b) => a.strike - b.strike);
  const resistance = callsAbove[0] || null;

  // Delta-based probabilities for key strikes
  const atmStrike = findStrikeNear(calls, currentPrice);
  const probAboveATM = atmStrike?.itm ? 50 + Math.round((atmStrike.iv || 0) * 20) : null; // rough heuristic

  // --- Support / Resistance from OI concentration ---
  // Put wall = strike with most put OI below current price (support)
  // Call wall = strike with most call OI above current price (resistance)
  const putOIByStrike = {};
  for (const p of puts) { if (p.strike < currentPrice && p.oi > 0) putOIByStrike[p.strike] = (putOIByStrike[p.strike] || 0) + p.oi; }
  const callOIByStrike = {};
  for (const c of calls) { if (c.strike > currentPrice && c.oi > 0) callOIByStrike[c.strike] = (callOIByStrike[c.strike] || 0) + c.oi; }

  let supportStrike = null, supportOI = 0;
  for (const [s, oi] of Object.entries(putOIByStrike)) { if (oi > supportOI) { supportStrike = Number(s); supportOI = oi; } }
  let resistanceStrike = null, resistanceOI = 0;
  for (const [s, oi] of Object.entries(callOIByStrike)) { if (oi > resistanceOI) { resistanceStrike = Number(s); resistanceOI = oi; } }

  // --- Max pain ---
  const strikeMap = {};
  for (const c of calls) { if (c.strike) strikeMap[c.strike] = (strikeMap[c.strike] || 0) + c.oi; }
  for (const p of puts) { if (p.strike) strikeMap[p.strike] = (strikeMap[p.strike] || 0) + p.oi; }
  let maxPain = null, maxPainOI = 0;
  for (const [strike, oi] of Object.entries(strikeMap)) {
    if (oi > maxPainOI) { maxPain = Number(strike); maxPainOI = oi; }
  }

  // --- Layman summary ---
  const bullish = (pcRatioVol != null && pcRatioVol < 0.7) || (expectedMovePct != null && expectedMovePct < 3 * Math.sqrt(dte));
  const bearish = (pcRatioVol != null && pcRatioVol > 1.3) || (expectedMoveDollar != null && resistanceStrike != null && resistanceStrike < currentPrice + expectedMoveDollar);
  const sentiment = bullish ? 'Bullish' : bearish ? 'Bearish' : 'Neutral';

  // Unusual activity
  const unusual = [];
  for (const c of [...calls, ...puts]) {
    if (c.oi > 0 && c.vol > c.oi * 3 && c.vol > 100) {
      unusual.push({
        symbol: c.symbol,
        strike: c.strike,
        type: c._type || 'unknown',
        vol: c.vol,
        oi: c.oi,
        ratio: +(c.vol / c.oi).toFixed(1),
        iv: c.iv,
      });
    }
  }
  unusual.sort((a, b) => b.ratio - a.ratio);

  // Average IV across chain
  const allIV = [...calls, ...puts].map(c => c.iv).filter(v => v > 0);
  const avgIV = allIV.length ? allIV.reduce((a, b) => a + b, 0) / allIV.length : null;

  // Near-the-money IV
  const ntmc = [...calls, ...puts].filter(c => c.iv > 0 && Math.abs(c.strike - currentPrice) / currentPrice < 0.05);
  const nearMoneyIV = ntmc.length ? ntmc.reduce((a, b) => a + b.iv, 0) / ntmc.length : null;

  return {
    available: true,
    expiryDate: moveDate,
    dte,
    callsCount: calls.length,
    putsCount: puts.length,
    callVol,
    putVol,
    callOI,
    putOI,
    pcRatioVol: pcRatioVol != null ? +pcRatioVol.toFixed(3) : null,
    pcRatioOI: pcRatioOI != null ? +pcRatioOI.toFixed(3) : null,
    unusual: unusual.slice(0, 5),
    maxPain,
    avgIV: avgIV != null ? +avgIV.toFixed(4) : null,
    nearMoneyIV: nearMoneyIV != null ? +nearMoneyIV.toFixed(4) : null,
    // --- Easy-to-read insights ---
    expectedMove: expectedMoveDollar != null ? { dollar: expectedMoveDollar, percent: expectedMovePct } : null,
    probabilityBands,
    support: supportStrike != null ? { strike: supportStrike, oi: supportOI } : null,
    resistance: resistanceStrike != null ? { strike: resistanceStrike, oi: resistanceOI } : null,
    sentiment,
  };
}

// Full-market symbol search via Yahoo search API (free, cookie+crumb required).
// Returns US-listed equities and ETFs in Yahoo relevance order.
export async function searchSymbols(query, max = 10) {
  const q = String(query || '').trim();
  if (!q) return [];
  const session = await getSession();
  const built =
    `${YH}/v1/finance/search?q=${encodeURIComponent(q)}` +
    `&quotesCount=${max}&newsCount=0&listsCount=0` +
    `&crumb=${encodeURIComponent(session.crumb)}`;
  // Cache under a crumb-independent key (same trick as getQuotes).
  const cacheKey =
    `${YH}/v1/finance/search?q=${encodeURIComponent(q)}` +
    `&quotesCount=${max}&newsCount=0&listsCount=0`;
  const headers = { 'User-Agent': UA['User-Agent'], Accept: '*/*', Cookie: session.cookie };
  const { data } = await cachedJson(built, 900, headers, cacheKey, signal);
  const US = new Set(['NMS', 'NYQ', 'NAS', 'NGM', 'NCM', 'ASE', 'PCX', 'PNK', 'BTS']);
  const out = [];
  for (const r of data?.quotes || []) {
    if (!r.symbol) continue;
    const t = (r.quoteType || '').toUpperCase();
    if (t !== 'EQUITY' && t !== 'ETF') continue;
    if (!US.has(r.exchange)) continue;
    out.push({
      symbol: r.symbol,
      name: r.shortname || r.longname || r.symbol,
      type: t === 'ETF' ? 'ETF' : 'STOCK',
      exchange: r.exchange,
    });
  }
  return out;
}
