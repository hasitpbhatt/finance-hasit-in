// CBOE delayed options chain fallback. No API key needed.
// Data is 15-minute delayed. Used when Yahoo throttles.

import { cachedJson } from './cache.js';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

// Fetch options chain from CBOE. Returns the same shape as Yahoo's getOptionChain
// or null on failure. Falls back gracefully.
export async function getCboeOptionChain(symbol, signal = null) {
  const url = `${BASE}/${encodeURIComponent(symbol.toUpperCase())}.json`;
  try {
    const { data } = await cachedJson(url, 1800, {}, null, signal);
    // CBOE returns the payload under a flat `data` object:
    // { data: { options: [...], symbol, current_price, ... } } — no per-symbol key.
    const optionsData = data?.data;
    if (!optionsData?.options) return null;
    const currentPrice = optionsData.current_price || null;
    // CBOE returns a flat array of option contracts
    const expMap = {};
    for (const opt of optionsData.options) {
      const occ = opt.option || '';
      // Parse OCC symbol: ROOT + YYMMDD + C/P + STRIKE (8 digits)
      const m = occ.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
      if (!m) continue;
      const [, , dateStr, cp, strikeStr] = m;
      const yy = parseInt(dateStr.slice(0, 2), 10) + 2000;
      const mm = dateStr.slice(2, 4);
      const dd = dateStr.slice(4, 6);
      const expiry = `${yy}-${mm}-${dd}`;
      const strike = parseInt(strikeStr, 10) / 1000;
      const contract = {
        symbol: occ,
        strike,
        bid: opt.bid,
        ask: opt.ask,
        last: opt.last_trade_price,
        vol: opt.volume,
        oi: opt.open_interest,
        iv: opt.iv,
        itm: null,
      };
      if (!expMap[expiry]) expMap[expiry] = { expiry: Math.floor(new Date(expiry + 'T00:00:00Z').getTime() / 1000), calls: [], puts: [] };
      if (cp === 'C') expMap[expiry].calls.push(contract);
      else expMap[expiry].puts.push(contract);
    }
    const expirations = Object.keys(expMap).sort().map(e => ({
      date: e,
      epoch: Math.floor(new Date(e + 'T00:00:00Z').getTime() / 1000),
    }));
    const chain = expirations.map(e => expMap[e.date]);
    return { expirations: expirations.map(e => e.epoch), chain, currentPrice };
  } catch {
    return null;
  }
}
