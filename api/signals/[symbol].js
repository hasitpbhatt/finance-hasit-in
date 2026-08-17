// GET /api/signals/AAPL — heavy signals: insider, newsIntel, leadership,
// hiring, options, analyst/earnings/dividends, retail sentiment, XBRL trends,
// and a Mistral plain-English narrative. All sources run concurrently via
// Promise.allSettled so the slowest one determines total latency.

import { getInsiderTrades, getLeadershipChanges } from '../../lib/edgar.js';
import { getNewsIntel } from '../../lib/newsintel.js';
import { getHiring } from '../../lib/hiring.js';
import { getOptionChain, getOptionChainLimited, computeOptionSignals, getQuotes, getFundamentals } from '../../lib/yahoo.js';
import { getCboeOptionChain } from '../../lib/cboe.js';
import { getXbrlTrend } from '../../lib/xbrl.js';
import { getRetailSentiment } from '../../lib/stocktwits.js';
import { getEarnings, getRecommendations, getCompanyNews } from '../../lib/finnhub.js';
import { json, corsPreflight } from '../../lib/http.js';
import { retryFetch } from '../../lib/cache.js';

// Run a promise under a wall-clock cap AND abort it when the cap hits so the
// underlying fetch/parse stops consuming CPU (the Worker Free plan budgets only
// ~10ms of CPU per invocation, so a timed-out source must not keep churning).
function withTimeout(promise, ms, signal) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      setTimeout(() => {
        signal?.abort();
        resolve(null);
      }, ms);
    }),
  ]);
}

// --- Verdict scoring (two lenses) ---
// Quality = long-term business lens (analyst, fundamentals, insider, growth).
// Market pulse = short-term noise lens (options, retail, news) — surfaced only
// as context inside the "Market noise" section, never in the verdict.
const QUALITY_WEIGHTS = {
  analyst: 0.20,
  fundamentals: 0.35,
  insider: 0.25,
  growth: 0.20,
};

const MARKET_WEIGHTS = {
  options: 0.30,
  retail: 0.35,
  news: 0.35,
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function scoreAnalyst(a) {
  if (!a?.available) return null;
  let s = 0;
  const c = (a.consensus || '').toLowerCase();
  if (c.includes('strong_buy') || c === 'buy') s += 25;
  else if (c === 'hold') s += 0;
  else if (c.includes('sell')) s -= 30;
  // Symmetric upside clamp: sell-side targets can be wrong in either direction.
  if (a.upsidePct != null) s += clamp(a.upsidePct * 2, -50, 50);
  if (a.numAnalysts != null) s += Math.min(a.numAnalysts / 10, 10);
  return clamp(Math.round(s), -100, 100);
}

function scoreFundamentals(x) {
  if (!x?.available) return null;
  let s = 0;
  const rev = x.revenue?.trend;
  const ni = x.netIncome?.trend;
  if (rev === 'strong_growth') s += 40;
  else if (rev === 'growing') s += 20;
  else if (rev === 'declining') s -= 20;
  else if (rev === 'sharply_declining') s -= 40;
  if (ni === 'strong_growth') s += 40;
  else if (ni === 'growing') s += 20;
  else if (ni === 'declining') s -= 20;
  else if (ni === 'sharply_declining') s -= 40;
  return clamp(Math.round(s), -100, 100);
}

function scoreInsider(s) {
  if (!s.insiderAvailable || !s.insiderTrades?.length) return null;
  const buys = s.insiderTrades.filter(t => t.code === 'P').length;
  const sells = s.insiderTrades.filter(t => t.code === 'S').length;
  const total = buys + sells;
  if (total === 0) return null;
  const ratio = (buys - sells) / total;
  return clamp(Math.round(ratio * 80), -100, 100);
}

function scoreGrowth(v) {
  // Earnings estimate growth is the single best forward-looking growth proxy.
  let s = 0;
  if (v?.epsGrowthPct != null) s += clamp(v.epsGrowthPct * 3, -60, 60);
  if (v?.beatStreak != null && v.beatStreak > 0) s += Math.min(v.beatStreak * 8, 30);
  if (s === 0) return null;
  return clamp(Math.round(s), -100, 100);
}

function scoreOptions(o) {
  if (!o?.available || !o.signals?.sentiment) return null;
  const sent = o.signals.sentiment;
  if (sent === 'Bullish') return 40;
  if (sent === 'Bearish') return -40;
  return 0;
}

function scoreRetail(r) {
  if (!r?.available) return null;
  return clamp(Math.round((r.bullPct - r.bearPct) * 1.5), -100, 100);
}

function scoreNews(n) {
  if (!n?.available) return null;
  const sent = n.avgSentiment || 0;
  return clamp(Math.round(sent * 100), -100, 100);
}

function computeComposite(factors, weights) {
  if (!factors.length) return null;
  // Denominator is the FIXED total weight of every lens component, not just the
  // factors present. Missing (null) bearish-capable signals are treated as 0,
  // so they dilute the composite instead of vanishing from the denominator and
  // letting a single bullish factor dominate.
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  const earned = factors.reduce((s, f) => s + f.score * f.weight, 0);
  return Math.round(earned / totalWeight);
}

function gradeFor(value) {
  if (value >= 45) return 'bullish';
  if (value >= 20) return 'leaning_bullish';
  if (value > -20) return 'neutral';
  if (value > -45) return 'leaning_bearish';
  return 'bearish';
}

// Value-investor metrics from the fundamentals quoteSummary payload.
function computeValueMetrics(f) {
  if (!f) return null;
  const price = f.price;
  const mcap = f.marketCap;
  const out = {};

  // Owner earnings (Buffett): FCF yield + cash conversion.
  if (f.freeCashflow != null && mcap > 0) out.fcfYield = +((f.freeCashflow / mcap) * 100).toFixed(2);
  if (f.freeCashflow != null && f.netIncome != null) {
    out.fcfConversion = f.freeCashflow / f.netIncome;
  }

  // PEG (Lynch): forward P/E ÷ forward EPS growth.
  if (f.forwardPe != null && f.epsGrowthPct != null && f.epsGrowthPct > 0) {
    out.peg = +(f.forwardPe / f.epsGrowthPct).toFixed(2);
  }

  // Earnings yield (Graham): 1 ÷ trailing P/E.
  if (f.pe != null && f.pe > 0) out.earningsYield = +((1 / f.pe) * 100).toFixed(2);

  // Graham fair value: EPS × (8.5 + 2g), where g = expected growth %.
  if (f.price != null && f.pe != null && f.pe > 0 && f.epsGrowthPct != null) {
    const eps = f.price / f.pe;
    const g = clamp(f.epsGrowthPct, 0, 35);
    out.grahamFairValue = +(eps * (8.5 + 2 * g)).toFixed(2);
  }

  // Leverage & balance-sheet sanity (Graham/Buffett).
  if (f.debtToEquity != null) out.debtToEquity = f.debtToEquity;
  if (f.currentRatio != null) out.currentRatio = f.currentRatio;
  if (f.returnOnEquity != null) out.roe = f.returnOnEquity;
  if (f.returnOnAssets != null) out.roa = f.returnOnAssets;
  if (f.grossMargins != null) out.grossMargin = f.grossMargins;
  if (f.profitMargins != null) out.profitMargin = f.profitMargins;

  return Object.keys(out).length ? out : null;
}

// Margin of safety (Graham): how far today's price sits below an intrinsic-value
// estimate. Returns null when there's no estimate to compare against.
function computeMarginOfSafety(value, price) {
  if (!value || price == null || price <= 0) return null;
  if (value.grahamFairValue == null) return null;
  const mosPct = +(((value.grahamFairValue - price) / price) * 100).toFixed(1);
  const state = mosPct >= 20 ? 'cheap' : mosPct <= -20 ? 'expensive' : 'fair';
  return {
    fairValue: value.grahamFairValue,
    mosPct,
    state,
    fcfYield: value.fcfYield != null ? value.fcfYield : null,
    earningsYield: value.earningsYield != null ? value.earningsYield : null,
  };
}

function computeScore(result, value) {
  const factors = [];
  const weights = QUALITY_WEIGHTS;

  const a = scoreAnalyst(result.analyst);
  if (a != null) factors.push({ key: 'analyst', label: 'Analyst', score: a, weight: weights.analyst });

  const f = scoreFundamentals(result.xbrl);
  if (f != null) factors.push({ key: 'fundamentals', label: 'Fundamentals', score: f, weight: weights.fundamentals });

  const i = scoreInsider(result);
  if (i != null) factors.push({ key: 'insider', label: 'Insider', score: i, weight: weights.insider });

  const g = scoreGrowth(value);
  if (g != null) factors.push({ key: 'growth', label: 'Growth', score: g, weight: weights.growth });

  if (factors.length === 0) {
    return { value: 0, label: 'No data', grade: 'neutral', factors: [], weights, coverage: 0 };
  }

  const valueScore = computeComposite(factors, weights);
  const grade = gradeFor(valueScore);
  // coverage = share of the fixed total weight that actually had data, so users
  // can see thin-data vs strong-data verdicts (missing signals now dilute, not vanish).
  const coverage = +factors.reduce((s, f) => s + f.weight, 0).toFixed(2);
  return { value: valueScore, label: grade, grade, factors, weights, coverage };
}

// Market pulse lens: short-term noise shown as context only.
function computeMarketPulse(result) {
  const factors = [];
  const weights = MARKET_WEIGHTS;

  const o = scoreOptions(result.options);
  if (o != null) factors.push({ key: 'options', label: 'Options', score: o, weight: weights.options });

  const r = scoreRetail(result.retail);
  if (r != null) factors.push({ key: 'retail', label: 'Retail', score: r, weight: weights.retail });

  const n = scoreNews(result.newsIntel);
  if (n != null) factors.push({ key: 'news', label: 'News', score: n, weight: weights.news });

  if (!factors.length) return null;
  return {
    value: computeComposite(factors, weights),
    grade: gradeFor(computeComposite(factors, weights)),
    factors,
    weights,
  };
}

// Call Mistral to write a plain-English summary in a value-investor frame
// (Buffett/Lynch): what the business is, quality, growth, price, owners, risks.
async function mistralNarrative(symbol, companyName, signals, env) {
  const apiKey = env?.MISTRAL_API_KEY || env?.mistralApiKey;
  if (!apiKey) return null;

  const parts = [];
  const v = signals.value;
  const s = signals.score;
  if (s?.grade) parts.push(`Composite quality score: ${s.value} (${s.grade.replace(/_/g, ' ')})`);
  if (signals.analyst?.available) {
    const a = signals.analyst;
    parts.push(`Analyst consensus: ${a.consensus || 'N/A'}, target mean $${a.targetMean ?? 'N/A'}, upside ${a.upsidePct ?? 'N/A'}% (${a.numAnalysts ?? 0} analysts)`);
  }
  if (v) {
    const bits = [];
    if (v.roe != null) bits.push(`ROE ${(v.roe * 100).toFixed(1)}%`);
    if (v.fcfYield != null) bits.push(`free-cash-flow yield ${v.fcfYield}%`);
    if (v.peg != null) bits.push(`PEG ${v.peg}`);
    if (v.debtToEquity != null) bits.push(`debt/equity ${(v.debtToEquity).toFixed(2)}`);
    if (v.grahamFairValue != null && signals.price) bits.push(`Graham fair value $${v.grahamFairValue} vs price $${signals.price}`);
    if (bits.length) parts.push(`Quality/valuation metrics: ${bits.join(', ')}`);
  }
  if (signals.xbrl?.available) {
    parts.push(`Fundamentals trend: Revenue ${signals.xbrl.revenue?.trendLabel || 'N/A'}, Net income ${signals.xbrl.netIncome?.trendLabel || 'N/A'}`);
  }
  if (signals.earnings?.available) {
    const e = signals.earnings;
    parts.push(`Next earnings: ${e.nextDate || 'N/A'}, beat streak ${e.beatStreak ?? 0} quarters`);
  }
  if (signals.dividends?.available) {
    parts.push(`Dividend yield ${signals.dividends.yield != null ? (signals.dividends.yield * 100).toFixed(2) + '%' : 'N/A'}`);
  }
  if (signals.shortInterest?.available) {
    const si = signals.shortInterest;
    parts.push(`Short interest: ${si.shortPercentOfFloat != null ? (si.shortPercentOfFloat * 100).toFixed(1) : 'N/A'}% of float`);
  }
  if (signals.insiderAvailable) {
    const buys = (signals.insiderTrades || []).filter(t => t.code === 'P').length;
    const sells = (signals.insiderTrades || []).filter(t => t.code === 'S').length;
    parts.push(`Insider trades: ${buys} buys, ${sells} sells`);
  }
  if (signals.marketPulse) {
    parts.push(`Short-term market pulse (noise, not a value signal): score ${signals.marketPulse.value} (${(signals.marketPulse.grade || '').replace(/_/g, ' ')})`);
  }
  if (signals.signalFlags?.redFlag) parts.push(`Red flag: recent officer departures alongside insider selling`);

  if (parts.length === 0) return null;

  // One call returns a neutral overview + takes from 6 legendary investors.
  const prompt = `You are a panel of legendary investors reviewing ${symbol} (${companyName || symbol}) for a non-expert. Based on the data below, write a short take for each investor in their own voice and mindset. Each take must be 2-4 sentences, plain-English, factual, and must reflect that investor's actual philosophy (not generic advice). End each take with a one-sentence verdict.

Investors and their lenses:
- summary: a neutral, balanced plain-English overview answering: what the business is, quality, growth, whether the price is fair, and risks.
- buffett (Warren Buffett): moat, owner earnings / free cash flow, management quality, would he own it for 10 years, margin of safety.
- munger (Charlie Munger): inversion ("what could kill this?"), incentives, psychology, mispricing, avoiding stupidity.
- graham (Benjamin Graham): margin of safety, cheap on earnings/assets, balance-sheet strength, defensive vs enterprising.
- lynch (Peter Lynch): can you explain the story to your grandmother, PEG / growth at a reasonable price, what could make it a 10-bagger.
- fisher (Philip Fisher): quality of the business and its management, R&D and long-term growth, scuttlebutt, patience.
- templeton (John Templeton): contrarian value, bargains where others won't look, point of maximum pessimism, long-term global view.

Return ONLY a JSON object with exactly these keys, each value a string: summary, buffett, munger, graham, lynch, fisher, templeton. No markdown, no commentary.

Data:
${parts.join('\n')}`;

  try {
    const res = await retryFetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'mistral-medium-latest',
        messages: [
          { role: 'system', content: 'You are a panel of the greatest investors in history. You reply in strict JSON only, with short plain-English takes for a non-expert. No markdown.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 900,
        response_format: { type: 'json_object' },
      }),
    });
    const body = await res.json();
    const raw = body?.choices?.[0]?.message?.content || null;
    if (!raw) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const keys = ['summary', 'buffett', 'munger', 'graham', 'lynch', 'fisher', 'templeton'];
    const personas = {};
    let summary = null;
    for (const k of keys) {
      const txt = typeof parsed[k] === 'string' ? parsed[k].trim() : '';
      if (txt) {
        if (k === 'summary') summary = txt;
        else personas[k] = txt;
      }
    }
    if (!summary && Object.keys(personas).length) {
      summary = personas.buffett || personas.munger || Object.values(personas)[0];
    }
    if (!summary) return null;
    return { available: true, text: summary, personas };
  } catch {
    return null;
  }
}

async function handleSignals(request, params) {
  if (request.method === 'OPTIONS') return corsPreflight();
  const symbol = (params.symbol || '').toUpperCase();
  if (!symbol) return json({ error: 'symbol required' }, { status: 400 });

  const result = { symbol, degraded: false, errors: [] };
  const controllers = [];

  // Lightweight quote for company name and price.
  let companyName = '';
  let quote = null;
  try {
    const quotes = await getQuotes([symbol]);
    quote = quotes[0] || null;
    companyName = quote?.name || '';
    if (quote?.price != null) result.price = quote.price;
    result.name = companyName || symbol;
  } catch { /* not critical */ }

  // Each source gets its own AbortController so a deadline miss actually stops
  // the upstream fetch + parse instead of burning CPU in the background.
  const src = () => {
    const ac = new AbortController();
    controllers.push(ac);
    return ac.signal;
  };

  // All signal sources run concurrently with per-source timeouts.
  // Total budget: ~6s (well under Cloudflare's CPU/duration limits; each source
  // aborts on timeout so nothing keeps running past its cap).
  const TIMEOUTS = {
    insider: 4000,
    newsIntel: 3000,
    leadership: 4000,
    hiring: 2000,
    options: 4000,
    analyst: 4500,
    retail: 2000,
    xbrl: 4500,
  };

  const [insiderR, newsIntelR, leadershipR, hiringR, optionsR, analystR, retailR, xbrlR, fhEarningsR, fhRecsR, fhNewsR] = await Promise.allSettled([
    withTimeout(getInsiderTrades(symbol, 5, src()), TIMEOUTS.insider, controllers[controllers.length - 1]),
    withTimeout(getNewsIntel(symbol, companyName, src()), TIMEOUTS.newsIntel, controllers[controllers.length - 1]),
    withTimeout(getLeadershipChanges(symbol, 12, process.env, src()), TIMEOUTS.leadership, controllers[controllers.length - 1]),
    withTimeout(getHiring(symbol, src()), TIMEOUTS.hiring, controllers[controllers.length - 1]),
    withTimeout((async () => {
      // Light path: only the expiries the signals consume (nearest + ~30 DTE)
      // — avoids Yahoo getAllData's 1-3MB parse, a top CPU-time risk.
      try {
        const chain = await getOptionChainLimited(symbol, src());
        if (chain?.chain?.length) {
          return { signals: computeOptionSignals(chain, quote?.price), expirations: chain.expirations };
        }
      } catch { /* limited path failed */ }
      try {
        const cboe = await getCboeOptionChain(symbol, src());
        if (cboe) {
          const chain = { expirations: cboe.expirations, chain: cboe.chain };
          return { signals: computeOptionSignals(chain, cboe.currentPrice || quote?.price), expirations: cboe.expirations };
        }
      } catch { /* CBOE failed */ }
      try {
        const chain = await getOptionChain(symbol, src());
        return { signals: computeOptionSignals(chain, quote?.price), expirations: chain?.expirations || [] };
      } catch { /* Yahoo also failed */ }
      return null;
    })(), TIMEOUTS.options, controllers[controllers.length - 1]),
    // Analyst/earnings/dividends/short-interest via getFundamentals (single quoteSummary call)
    withTimeout(getFundamentals(symbol, src()).catch(() => null), TIMEOUTS.analyst, controllers[controllers.length - 1]),
    // Retail sentiment
    withTimeout(getRetailSentiment(symbol, src()), TIMEOUTS.retail, controllers[controllers.length - 1]),
    // XBRL fundamentals trend
    withTimeout(getXbrlTrend(symbol, src()), TIMEOUTS.xbrl, controllers[controllers.length - 1]),
    // Finnhub: earnings surprises
    withTimeout(getEarnings(symbol, process.env, src()), 3000, controllers[controllers.length - 1]),
    // Finnhub: analyst recommendations
    withTimeout(getRecommendations(symbol, process.env, src()), 3000, controllers[controllers.length - 1]),
    // Finnhub: company news
    withTimeout(getCompanyNews(symbol, process.env, src()), 4000, controllers[controllers.length - 1]),
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
  if (optionsR.status === 'fulfilled' && optionsR.value && optionsR.value.signals) {
    const expirations = (optionsR.value.expirations || []).map(epoch => ({
      date: new Date(epoch * 1000).toISOString().split('T')[0],
      epoch,
    }));
    const nearestEpoch = expirations.length ? Math.min(...expirations.map(e => e.epoch)) : null;
    result.options = {
      available: true,
      currentPrice: quote?.price || null,
      nearestExpiry: nearestEpoch ? new Date(nearestEpoch * 1000).toISOString().split('T')[0] : null,
      moveExpiry: optionsR.value.signals.expiryDate || null,
      expirations,
      signals: optionsR.value.signals,
    };
  } else {
    result.options = { available: false, reason: 'unavailable' };
    result.errors.push('options: ' + (optionsR.reason?.message || 'timeout'));
  }

  // --- Analyst / earnings / dividends / short-interest ---
  let fundamentalsRaw = null;
  if (analystR.status === 'fulfilled' && analystR.value) {
    const f = analystR.value;
    fundamentalsRaw = f;
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

  // --- Finnhub: earnings surprises (enhance Yahoo earnings data) ---
  if (fhEarningsR.status === 'fulfilled' && fhEarningsR.value?.available) {
    const fh = fhEarningsR.value;
    // Merge Finnhub surprise history into result.earnings if Yahoo didn't provide it
    if (!result.earnings?.available || !result.earnings.surpriseHistory?.length) {
      result.earnings = {
        available: true,
        nextDate: result.earnings?.nextDate || null,
        epsEstimate: result.earnings?.epsEstimate ?? null,
        beatStreak: result.earnings?.beatStreak ?? 0,
        surpriseHistory: fh.quarters.map(q => ({
          quarter: q.quarter, year: q.year,
          epsActual: q.epsActual, epsEstimate: q.epsEstimate,
          surprisePercent: q.surprisePercent,
        })),
      };
    }
    // Recompute beat streak from Finnhub data if it's richer
    if (fh.quarters.length > 0) {
      let streak = 0;
      for (const q of fh.quarters) {
        if (q.epsActual != null && q.epsEstimate != null && q.epsActual >= q.epsEstimate) streak++;
        else break;
      }
      if (streak > (result.earnings?.beatStreak || 0)) {
        result.earnings.beatStreak = streak;
      }
    }
  }

  // --- Finnhub: analyst recommendations (cross-validate Yahoo) ---
  if (fhRecsR.status === 'fulfilled' && fhRecsR.value?.available) {
    result.finnhubRecommendations = fhRecsR.value;
  }

  // --- Finnhub: company news (merge into newsIntel) ---
  if (fhNewsR.status === 'fulfilled' && fhNewsR.value?.available) {
    const fhArticles = fhNewsR.value.articles || [];
    if (result.newsIntel?.available && result.newsIntel.articles?.length) {
      // Merge: dedupe by title similarity, keep existing sentiment scores
      const existing = new Set(result.newsIntel.articles.map(a => a.title?.toLowerCase().slice(0, 40)));
      for (const a of fhArticles) {
        const key = a.headline?.toLowerCase().slice(0, 40);
        if (key && !existing.has(key)) {
          result.newsIntel.articles.push({
            title: a.headline, link: a.url, pubDate: a.published,
            source: a.source, domain: '', sentiment: 0, topics: [], weight: 0.7,
          });
          existing.add(key);
        }
      }
      result.newsIntel.count = result.newsIntel.articles.length;
    } else {
      // No existing news — use Finnhub as the source
      result.newsIntel = {
        available: true,
        count: fhArticles.length,
        avgSentiment: 0,
        trend: 0,
        spike: fhArticles.length >= 8,
        topics: [],
        articles: fhArticles.map(a => ({
          title: a.headline, link: a.url, pubDate: a.published,
          source: a.source, domain: '', sentiment: 0, topics: [], weight: 0.7,
        })),
      };
    }
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

  // --- Verdict score (two lenses, server-side) ---
  const value = computeValueMetrics(fundamentalsRaw);
  result.value = value;
  result.score = computeScore(result, value);
  result.marketPulse = computeMarketPulse(result);
  result.marginOfSafety = computeMarginOfSafety(value, result.price);

  // --- Mistral narrative (runs after all signals, uses aggregated data) ---
  try {
    const narrative = await withTimeout(mistralNarrative(symbol, companyName, result, process.env), 5000);
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

export async function OPTIONS() {
  return corsPreflight();
}

// Top-level guard: never let an unhandled throw surface as a 500. If anything
// unexpectedly blows up we still return 200 with a degraded partial payload so
// the client never shows a blank "no signals" state.
export async function GET(request) {
  const url = new URL(request.url);
  const params = { symbol: url.pathname.split('/').pop() || '' };
  try {
    return await handleSignals(request, params);
  } catch (err) {
    return json({
      symbol: (params.symbol || '').toUpperCase(),
      degraded: true,
      error: 'signals: ' + (err?.message || 'internal error'),
      score: null,
      marketPulse: null,
      narrative: { available: false, reason: 'error' },
    }, {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=60, max-age=30' },
    });
  }
}

