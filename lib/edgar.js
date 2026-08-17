// SEC EDGAR helpers (free, no key). Per SEC fair-access policy we send a
// compliant User-Agent with contact info. Parsed data is edge-cached
// aggressively: the ticker map for 7 days, Form 4 summaries/XML for 12 hours.
// On upstream failure we degrade gracefully (empty arrays) so the rest of the
// app keeps working.

import { cachedJson, cachedText, retryFetch, runSec } from './cache.js';

// SEC requires a User-Agent that identifies the app and a contact address.
const EDGAR_UA = {
  'User-Agent': 'InvestmentFinder/1.0 (contact@example.com)',
  Accept: 'application/json',
};

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_TTL = 7 * 24 * 3600; // 7 days
const FORM4_TTL = 12 * 3600; // 12 hours

const CODE_LABEL = {
  P: 'Purchase',
  S: 'Sale',
  M: 'Exercise/Related',
  A: 'Grant/Award',
  D: 'Disposition',
  F: 'Tax/Withhold',
  G: 'Gift',
};

// Cap raw SEC documents before regex passes. Form 4 / 8-K documents can run
// hundreds of KB; the regex parsing is the single biggest CPU consumer in this
// library, so bound the work to the first N chars where all the signal lives.
const DOC_CAP = 512 * 1024;

// In-memory ticker map (refreshed at most once per worker instance lifetime).
let tickerMap = null;

async function getTickerMap(signal = null) {
  if (tickerMap) return tickerMap;
  const { data } = await runSec(() => cachedJson(TICKERS_URL, TICKERS_TTL, EDGAR_UA, null, signal));
  const map = new Map();
  for (const key of Object.keys(data || {})) {
    const entry = data[key];
    if (!entry || !entry.ticker) continue;
    map.set(entry.ticker.toUpperCase(), {
      cik: String(entry.cik_str),
      padded: String(entry.cik_str).padStart(10, '0'),
      name: entry.title || null,
    });
  }
  tickerMap = map;
  return map;
}

// Resolve a ticker symbol to its CIK (and 10-digit padded form).
export async function getCik(symbol, signal = null) {
  try {
    const map = await getTickerMap(signal);
    return map.get(String(symbol).toUpperCase()) || null;
  } catch {
    return null;
  }
}

// Fetch a CIK's recent-filings array once and share it between the Form 4 and
// 8-K paths. Both getInsiderTrades and getLeadershipChanges need this same
// document; deduping here (on top of the cache coalescing) guarantees a single
// upstream call per invocation instead of two racing fetches.
async function getSubmissionsData(cikInfo, signal = null) {
  if (!cikInfo) return null;
  const url = `https://data.sec.gov/submissions/CIK${cikInfo.padded}.json`;
  try {
    const { data } = await runSec(() => cachedJson(url, FORM4_TTL, EDGAR_UA, null, signal));
    return data?.filings?.recent || null;
  } catch {
    return null;
  }
}

// Recent Form 4 filings for a CIK (most recent first), capped at `max`.
export async function getForm4Summaries(cikInfo, max = 8, signal = null) {
  if (!cikInfo) return [];
  try {
    const recent = await getSubmissionsData(cikInfo, signal);
    if (!recent || !Array.isArray(recent.form)) return [];
    const out = [];
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === '4') {
        out.push({
          filingDate: recent.filingDate[i] || null,
          reportDate: recent.reportDate ? recent.reportDate[i] || null : null,
          accessionNumber: recent.accessionNumber[i] || null,
        });
        if (out.length >= max) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Parse non-derivative transactions from a Form 4 XML document. We use regex
// extraction rather than DOMParser because the SEC document uses a default XML
// namespace, which makes element-name matching unreliable in the Workers DOM
// implementation. The Form 4 structure is regular enough for this approach.
function parseForm4(xml) {
  if (!xml) return [];
  const insiderMatch = xml.match(
    /<reportingOwner>[\s\S]*?<rptOwnerName>\s*([\s\S]*?)\s*<\/rptOwnerName>/,
  );
  const insider = insiderMatch ? insiderMatch[1].trim() : null;

  const txns = [];
  const blockRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const code = pick(block, 'transactionCoding', 'transactionCode');
    const date = pick(block, 'transactionDate', 'value');
    const shares = toNum(pick(block, 'transactionShares', 'value'));
    const price = toNum(pick(block, 'transactionPricePerShare', 'value'));
    if (date == null && shares == null) continue;
    const total = shares != null && price != null ? shares * price : null;
    txns.push({
      date,
      insider,
      code: code || null,
      codeLabel: code ? CODE_LABEL[code] || code : null,
      shares,
      price,
      total,
    });
  }
  return txns;
}

// Pull a nested <value> out of a named parent within a Form 4 block.
function pick(block, parent, child) {
  const re = new RegExp(`<${parent}>[\\s\\S]*?<${child}>\\s*([\\s\\S]*?)\\s*<\\/${child}>`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// Fetch and parse a single Form 4 XML filing.
export async function getForm4Transactions(cikInfo, accessionNumber, signal = null) {
  if (!cikInfo || !accessionNumber) return [];
  const acc = accessionNumber.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInfo.cik}/${acc}/form4.xml`;
  try {
    const { data: xml } = await runSec(() => cachedText(url, FORM4_TTL, {
      ...EDGAR_UA,
      Accept: '*/*',
    }, null, signal));
    return parseForm4((xml || '').slice(0, DOC_CAP));
  } catch {
    return [];
  }
}

// Generic: fetch recent filings for a CIK filtered by form type.
export async function getRecentFilings(cikInfo, form, max = 40, signal = null) {
  if (!cikInfo) return [];
  try {
    const recent = await getSubmissionsData(cikInfo, signal);
    if (!recent || !Array.isArray(recent.form)) return [];
    const out = [];
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === form) {
        out.push({
          filingDate: recent.filingDate[i] || null,
          accessionNumber: recent.accessionNumber[i] || null,
          primaryDocument: recent.primaryDocument?.[i] || null,
          formType: recent.form[i],
        });
        if (out.length >= max) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Aggregate Form 4 insider trades for a symbol: returns the flat list of
// transactions plus a small net summary. Fetches Form 4 XMLs concurrently.
export async function getInsiderTrades(symbol, max = 8, signal = null) {
  const cikInfo = await getCik(symbol, signal);
  if (!cikInfo) return { available: false, trades: [] };
  const summaries = await getForm4Summaries(cikInfo, max, signal);
  // Fetch all Form 4 XMLs concurrently (cap at 8).
  const results = await Promise.allSettled(
    summaries.map(s => getForm4Transactions(cikInfo, s.accessionNumber, signal))
  );
  const trades = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const txns = results[i].value;
    for (const t of txns) {
      trades.push({ ...t, filingDate: summaries[i].filingDate });
    }
  }
  return { available: true, trades };
}

// Role keywords for proximity-based name detection (global for matchAll)
const ROLE_RE = /\b(?:chief|president|director|officer|chairman|vice\s+president|ceo|cfo|coo|cto|secretary|treasurer|resigned|departed|retired|terminated|appointed|elected|nominated|stepped\s+down|leave\s+the\s+company|senior\s+vice|executive\s+vice|board\s+member)\b/ig;
// Non-global copy for .test() calls (avoids lastIndex advancement issues)
const ROLE_TEST_RE = /\b(?:chief|president|director|officer|chairman|vice\s+president|ceo|cfo|coo|cto|secretary|treasurer|resigned|departed|retired|terminated|appointed|elected|nominated|stepped\s+down|leave\s+the\s+company|senior\s+vice|executive\s+vice|board\s+member)\b/i;

// Month names used to filter date-prefixed false positives
const MONTH_RE = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

// Boilerplate phrases that match the capitalized-words regex
const BOILERPLATE_RE = /\b(?:times\s+new\s+roman|securities\s+exchange\s+act|commission\s+file\s+number|employer\s+identification\s+no|third\s+street|securities\s+act|exchange\s+act|trading\s+symbol|common\s+stock|new\s+york\s+stock\s+exchange|certain\s+officers|compensatory\s+arrangements|document\s+created|workiva\s+platform|not\s+applicable|arial\s+unicode|security\s+holders|named\s+executive|executive\s+compensation|independent\s+registered|public\s+accounting|advisory\s+vote|safety\s+operations|public\s+policy|chief\s+corporate|press\s+secretary|new\s+york\s+city|executive\s+severance|severance\s+plan|employment\s+agreement|executive\s+bonus|financial\s+condition|financial\s+statements|exhibit\s+number|investor\s+relations|company\s+name|ticker\s+symbol|form\s+type|filing\s+date|broker\s+non|on\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|from\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))\b/i;

// Decode common HTML entities and strip tags for clean snippet text
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the Item 5.02 section text (between its heading and the next Item / signature / end)
function extractItem502Section(xml) {
  const start = xml.search(/ITEM\s+5\.02/i);
  if (start < 0) return null;
  const rest = xml.substring(start);
  const endRe = /ITEM\s+\d+\.\d+|SIGNATURE|<\/body>|<\/html>/i;
  const endMatch = rest.substring(30).match(endRe);
  const end = endMatch ? 30 + endMatch.index : Math.min(rest.length, 8000);
  return rest.substring(0, end);
}

// Call Mistral to extract officer names from the Item 5.02 section text.
// Falls back to an empty array on any error. Honors `signal` so a deadline
// abort actually stops the fetch (and its retries) instead of churning.
async function mistralExtractNames(section, apiKey, signal = null) {
  if (!apiKey) return [];
  const plain = stripHtml(section).substring(0, 3000);
  try {
    const res = await retryFetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: 'Extract only the full names of real people (officers, directors, executives) who are departing, appointed, or elected in this SEC 8-K Item 5.02 filing section. Return a JSON array of strings, e.g. ["Jane Doe", "John Smith"]. Return [] if no person names found. No explanations.' },
          { role: 'user', content: plain },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
      signal,
    });
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return parsed.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()).slice(0, 5);
  } catch {
    return [];
  }
}

// Fallback regex-based name extraction (used when Mistral is unavailable)
function extractNamesRegex(section) {
  const nameRe = /([A-Z][a-z]+(?: [A-Z][a-z]+){1,3})/g;
  const matches = [...section.matchAll(nameRe)];
  const rolePositions = [...section.matchAll(ROLE_RE)].map(m => m.index);
  const candidates = [];
  for (const m of matches) {
    const name = m[1];
    const pos = m.index;
    if (MONTH_RE.test(name)) continue;
    if (BOILERPLATE_RE.test(name)) continue;
    if (ROLE_TEST_RE.test(name)) continue;
    const nearRole = rolePositions.some(rp => Math.abs(pos - rp) <= 60);
    if (!nearRole) continue;
    candidates.push({ name, pos });
  }
  if (rolePositions.length > 0) {
    const first = rolePositions[0];
    candidates.sort((a, b) => Math.abs(a.pos - first) - Math.abs(b.pos - first));
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c.name);
    if (out.length >= 5) break;
  }
  return out;
}

// Create a short plain-text snippet centered on the first detected name, or a
// fallback window from the start of the section.
function createSnippet(section, firstNamePos) {
  const plain = stripHtml(section);
  if (firstNamePos != null) {
    const start = Math.max(0, firstNamePos - 40);
    return plain.substring(start, start + 160);
  }
  return plain.substring(0, 160);
}

// Resolve a filing's primary document URL (handles the index.json fallback)
function resolveDocUrl(cikInfo, f) {
  if (f.primaryDocument) {
    return `https://www.sec.gov/Archives/edgar/data/${cikInfo.cik}/${f.accessionNumber.replace(/-/g, '')}/${f.primaryDocument}`;
  }
  return null; // caller will try index.json fallback
}

// Leadership changes from 8-K Item 5.02 (officer departures/appointments)
export async function getLeadershipChanges(symbol, months = 12, env = {}, signal = null) {
  const cikInfo = await getCik(symbol, signal);
  if (!cikInfo) return { available: false };

  const cutoffMs = months * 30 * 24 * 3600 * 1000;
  const now = Date.now();

  // 1) Fetch recent 8-Ks (limit to 5 to stay within Cloudflare's 30s budget)
  const filings = await getRecentFilings(cikInfo, '8-K', 5, signal);

  // 2) Filter by cutoff and resolve doc URLs (skip fallback to save time)
  const toFetch = [];
  for (const f of filings) {
    if (!f.filingDate) continue;
    if (new Date(f.filingDate).getTime() < now - cutoffMs) continue;
    const docUrl = resolveDocUrl(cikInfo, f);
    if (docUrl) toFetch.push({ filing: f, docUrl });
  }

  // 3) Fetch primary documents concurrently (batches of 5)
  const BATCH = 5;
  const docs = [];
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ filing, docUrl }) => {
      try {
        const { data } = await runSec(() => cachedText(docUrl, FORM4_TTL, { ...EDGAR_UA, Accept: '*/*' }, null, signal));
        return { filing, xml: (data || '').slice(0, DOC_CAP) };
      } catch {
        return { filing, xml: '' };
      }
    }));
    docs.push(...results);
  }

  // 4) Process each document — extract sections, then run Mistral concurrently
  const apiKey = env.MISTRAL_API_KEY || '';
  const toProcess = [];
  for (const { filing, xml } of docs) {
    if (!xml || !/ITEM\s+5\.02/i.test(xml)) continue;
    const section = extractItem502Section(xml);
    if (!section) continue;
    toProcess.push({ filing, section });
  }

  // Run all Mistral calls concurrently (cap at 6 parallel)
  const MISTRAL_BATCH = 6;
  const mistralResults = [];
  for (let i = 0; i < toProcess.length; i += MISTRAL_BATCH) {
    const batch = toProcess.slice(i, i + MISTRAL_BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ filing, section }) => {
        const secLower = section.toLowerCase();
        const hasDeparture = /resign|depart|retire|terminat|leave the company|steps down/i.test(secLower);
        const hasAppointment = /appoint|elect|promote|welcome|board member/i.test(secLower);
        let names = await mistralExtractNames(section, apiKey, signal);
        if (!names.length) names = extractNamesRegex(section);
        const plainSection = stripHtml(section);
        const firstNameIdx = names.length > 0 ? plainSection.indexOf(names[0]) : null;
        return {
          date: filing.filingDate,
          kind: hasDeparture && hasAppointment ? 'both' : hasDeparture ? 'departure' : hasAppointment ? 'appointment' : 'unknown',
          names,
          snippet: createSnippet(section, firstNameIdx),
          filingUrl: `https://www.sec.gov/Archives/edgar/data/${cikInfo.cik}/${filing.accessionNumber.replace(/-/g, '')}/${filing.primaryDocument || ''}`,
        };
      })
    );
    for (const r of batchResults) mistralResults.push(r);
  }

  const changes = mistralResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  return { available: true, changes };
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
