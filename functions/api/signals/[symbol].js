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

// --- Verdict scoring (two lenses) ---
// Quality = long-term business lens (analyst, fundamentals, insider, growth).
// Market pulse = short-term noise lens (options, retail, news) — surfaced only
// as context inside the "Market noise" section, never in the verdict.
const QUALITY_WEIGHTS = {
  analyst: 0.30,
  fundamentals: 0.25,
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
  if (c.includes('strong_buy') || c === 'buy') s += 40;
  else if (c === 'hold') s += 0;
  else if (c.includes('sell')) s -= 30;
  if (a.upsidePct != null) s += clamp(a.upsidePct * 2, -30, 50);
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
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const raw = factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight;
  return Math.round(raw);
}

function gradeFor(value) {
  if (value >= 30) return 'bullish';
  if (value >= 10) return 'leaning_bullish';
  if (value > -10) return 'neutral';
  if (value > -30) return 'leaning_bearish';
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
    return { value: 0, label: 'No data', grade: 'neutral', factors: [], weights };
  }

  const valueScore = computeComposite(factors, weights);
  const grade = gradeFor(valueScore);
  return { value: valueScore, label: grade, grade, factors, weights };
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
        max_tokens: 1100,
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
    if (quote?.price != null) result.price = quote.price;
  } catch { /* not critical */ }

  // All signal sources run concurrently with per-source timeouts.
  // Total budget: ~18s (leaves 12s headroom for Cloudflare's 30s limit + cold starts).
  const TIMEOUTS = {
    insider: 5000,
    newsIntel: 4000,
    leadership: 6000,
    hiring: 3000,
    options: 5000,
    analyst: 6000,
    retail: 3000,
    xbrl: 6000,
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
          return { signals: computeOptionSignals(chain, cboe.currentPrice || quote?.price), expirations: cboe.expirations };
        }
      } catch { /* CBOE failed */ }
      try {
        const chain = await getOptionChain(symbol);
        return { signals: computeOptionSignals(chain, quote?.price), expirations: chain?.expirations || [] };
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

  // --- Mistral narrative (runs after all signals, uses aggregated data) ---
  try {
    const narrative = await withTimeout(mistralNarrative(symbol, companyName, result, context.env), 6000);
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
