// News intelligence helpers (free, no key). Combines Google News RSS + Yahoo RSS.
// Lightweight deterministic sentiment and topic tagging; no ML/API keys.

import { cachedText } from './cache.js';
import { getNews } from './yahoo.js';

// ---------- Configuration ----------
const GOOGLE_NEWS_URL = (symbol, companyName) => {
  const q = encodeURIComponent(`${symbol} "${companyName}"`);
  return `https://news.google.com/rss/search?q=${q}+when:30d&hl=en-US&gl=US&ceid=US:en`;
};

// Finance sentiment lexicon (lowercase tokens)
const POS_WORDS = [
  'beat', 'beats', 'surpass', 'exceed', 'record', 'growth', 'strong', 'profit', 'profits', 'revenue', 'sales', 'beat', 'beat', 'beat', 'beat', 'beat', 'beat',
  'record', 'growth', 'strong', 'beat', 'beat', 'beat', 'beat', 'beat', 'beat', 'beat',
  'win', 'wins', 'best', 'top', 'up', 'rise', 'rising', 'gain', 'gains', 'positive', 'upbeat',
  'upgrade', 'upgraded', 'outlook', 'improve', 'improved', 'increase', 'increased', 'ahead',
  'acquire', 'acquired', 'acquires', 'merger', 'buy', 'buys', 'purchase', 'purchases',
  'launch', 'launched', 'unveil', 'unveiled', 'release', 'releases', 'announce', 'announced',
  'dividend', 'dividends', 'buyback', 'buybacks', 'repurchase', 'bonus', 'raises', 'raised',
  'guidance', 'raise', 'raised', 'beat', 'beats', 'beat', 'beat',
];

const NEG_WORDS = [
  'miss', 'misses', 'missed', 'misses', 'misses', 'misses', 'miss', 'misses', 'missed',
  'loss', 'losses', 'losses', 'loss', 'losses', 'losses', 'loss', 'losses',
  'cut', 'cuts', 'cutting', 'cuts', 'cuts', 'cuts', 'cut', 'cuts',
  'lawsuit', 'lawsuit', 'lawsuit', 'lawsuit', 'lawsuit', 'lawsuit',
  'probe', 'probes', 'probed', 'probe', 'probes', 'probed',
  'fine', 'fines', 'fined', 'fine', 'fines', 'fined',
  'layoff', 'layoffs', 'lay off', 'layoffs', 'layoff', 'layoffs',
  'down', 'downs', 'downside', 'downside', 'down', 'downs',
  'losses', 'loss', 'losses', 'loss',
  'downgrade', 'downgraded', 'downgrades', 'downgrade', 'downgraded',
  'settlement', 'settle', 'settled', 'settlement', 'settle', 'settled',
  'penalty', 'penalties', 'penalty', 'penalties',
];

const NEGATORS = ['no', 'not', 'never', 'without', 'despite', 'rejects', 'reject', 'rejecting'];

// Topic keyword maps (regex)
const TOPIC_MAPS = {
  m_and_a: { label: 'M&A', re: /acqui|merger|to buy|take over|take private|acquires|acquisition/i },
  legal: { label: 'Legal', re: /lawsuit|sued|lawsuit|sec probe|doj|fines|settlement|antitrust|regulatory/i },
  earnings: { label: 'Earnings', re: /earnings|q[1-4]|revenue|profit|beat|miss|guidance/i },
  product: { label: 'Product', re: /launch|unveil|release|announce/i },
  layoffs: { label: 'Layoffs', re: /layoff|lay off|job cuts|reduce workforce|severance|restructuring/i },
  capital_returns: { label: 'Buybacks/Dividends', re: /buyback|buy back|dividend|share repurchase/i },
  insider: { label: 'Insider', re: /insider|form 4|shares (sold|bought) by/i },
  analyst: { label: 'Analyst', re: /upgraded|downgraded|price target|analyst/i },
  executive: { label: 'Executive', re: /ceo|cto|cfo|coo|president|chairman|board|executive/i },
};

// Source domain weights (higher = more reputable)
const SOURCE_WEIGHTS = {
  'reuters.com': 1.0,
  'bloomberg.com': 1.0,
  'wsj.com': 1.0,
  'cnbc.com': 1.0,
  'barrons.com': 1.0,
  'nytimes.com': 1.0,
  'ft.com': 1.0,
  'marketwatch.com': 0.9,
  'seekingalpha.com': 0.6,
  'yahoo.com': 0.8,
  'google.com': 0.8,
};

// ---------- Helpers ----------
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreHeadline(title) {
  const tokens = title.toLowerCase().split(/\s+/);
  let score = 0;
  let negate = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (NEGATORS.includes(t)) negate = true;
    if (POS_WORDS.includes(t)) score += negate ? -1 : 1;
    if (NEG_WORDS.includes(t)) score += negate ? 1 : -1;
    if (i > 0 && tokens[i - 1] === 'not') negate = true; // simple back-look
    if (i >= 3) negate = false; // reset after window
  }

  const sentiment = Math.max(-1, Math.min(1, score / Math.max(1, tokens.length / 8)));

  const topics = [];
  for (const [key, { label, re }] of Object.entries(TOPIC_MAPS)) {
    if (re.test(title)) topics.push(key);
  }

  return { sentiment, topics };
}

function sourceWeight(domain) {
  return SOURCE_WEIGHTS[domain] || 0.7;
}

// ---------- Main export ----------
// Returns { available: true, count, avgSentiment, trend, spike, topics, articles } or { available: false, reason }
export async function getNewsIntel(symbol, companyName) {
  // 1) Google News RSS (30d)
  let googleXml = '';
  try {
    const { data } = await cachedText(GOOGLE_NEWS_URL(symbol, companyName), 10800);
    googleXml = data || '';
  } catch {
    // continue with Yahoo only
  }

  // 2) Yahoo RSS (freshness) — use existing getNews helper
  let yahooNews = [];
  try {
    yahooNews = await getNews(symbol, 30);
  } catch {
    // ignore
  }

  // 3) Parse Google items
  const googleItems = [];
  const googleBlocks = googleXml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of googleBlocks) {
    const title = pick(block, 'title');
    const link = pick(block, 'link');
    const pubDate = pick(block, 'pubDate');
    // Extract source name and domain from <source url="...">Name</source>
    const sourceMatch = block.match(/<source[^>]*url="([^"]*)"[^>]*>([^<]*)<\/source>/i);
    const source = sourceMatch ? sourceMatch[2].trim() : '';
    const domain = sourceMatch ? new URL(sourceMatch[1]).hostname.replace('www.', '') : '';
    if (title && link) {
      googleItems.push({ title, link, pubDate, source, domain });
    }
  }

  // 4) Dedupe by normalized title
  const seen = new Set();
  const articles = [...googleItems, ...yahooNews].filter((a) => {
    const key = normalizeTitle(a.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (articles.length === 0) {
    return { available: false, reason: 'no_articles' };
  }

  // 5) Score articles
  const scored = articles.map((a) => {
    const { sentiment, topics } = scoreHeadline(a.title);
    const weight = sourceWeight(a.domain);
    return { ...a, sentiment, topics, weight };
  });

  // 6) Aggregate
  const now = Date.now();
  const msPerDay = 86400000;
  const recent7 = scored.filter((a) => {
    if (!a.pubDate) return false;
    const d = new Date(a.pubDate).getTime();
    return d >= now - 7 * msPerDay;
  });

  const older7to30 = scored.filter((a) => {
    if (!a.pubDate) return false;
    const d = new Date(a.pubDate).getTime();
    return d < now - 7 * msPerDay && d >= now - 30 * msPerDay;
  });

  const avgSentiment = scored.reduce((s, a) => s + a.sentiment * a.weight, 0) / scored.reduce((s, a) => s + a.weight, 1);

  const trend = recent7.length && older7to30.length
    ? recent7.reduce((s, a) => s + a.sentiment * a.weight, 0) / recent7.reduce((s, a) => s + a.weight, 1) -
      older7to30.reduce((s, a) => s + a.sentiment * a.weight, 0) / older7to30.reduce((s, a) => s + a.weight, 1)
    : 0;

  const count = scored.length;
  const recent7Count = recent7.length;
  const olderPerDay = older7to30.length / 23;
  const spike = recent7Count >= 8 || (olderPerDay > 0 && recent7Count >= olderPerDay * 3);

  // Topic counts
  const topicCounts = {};
  for (const a of scored) {
    for (const t of a.topics) {
      topicCounts[t] = (topicCounts[t] || 0) + 1;
    }
  }
  const topics = Object.entries(topicCounts)
    .map(([k, c]) => ({ key: k, label: TOPIC_MAPS[k]?.label || k, count: c }))
    .sort((a, b) => b.count - a.count);

  // Top articles by |sentiment|
  const topArticles = [...scored]
    .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
    .slice(0, 6);

  return {
    available: true,
    count,
    avgSentiment: Math.round(avgSentiment * 100) / 100,
    trend: Math.round(trend * 100) / 100,
    spike,
    topics,
    articles: topArticles,
  };
}