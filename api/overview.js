import { getQuotes } from '../lib/yahoo.js';
import { getCrypto } from '../lib/crypto.js';
import { UNIVERSE } from '../lib/universe.js';
import { json, corsPreflight } from '../lib/http.js';

function topMovers(list, dir, n = 5) {
  const withChange = list.filter((x) => x.changePercent != null);
  withChange.sort((a, b) =>
    dir === 'gainers' ? b.changePercent - a.changePercent : a.changePercent - b.changePercent,
  );
  return withChange.slice(0, n);
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return corsPreflight();

  const result = {
    updatedAt: Date.now(),
    stocks: { gainers: [], losers: [] },
    etfs: { gainers: [], losers: [] },
    crypto: [],
    degraded: false,
    errors: [],
  };

  try {
    const quotes = await getQuotes(UNIVERSE);
    const stocks = quotes.filter((q) => q.type === 'STOCK');
    const etfs = quotes.filter((q) => q.type === 'ETF');
    result.stocks.gainers = topMovers(stocks, 'gainers');
    result.stocks.losers = topMovers(stocks, 'losers');
    result.etfs.gainers = topMovers(etfs, 'gainers');
    result.etfs.losers = topMovers(etfs, 'losers');
  } catch (e) {
    result.degraded = true;
    result.errors.push('stocks/etfs: ' + e.message);
  }

  try {
    const crypto = await getCrypto(10);
    result.crypto = crypto
      .sort((a, b) => (b.change24h ?? -1e9) - (a.change24h ?? -1e9))
      .slice(0, 5);
  } catch (e) {
    result.degraded = true;
    result.errors.push('crypto: ' + e.message);
  }

  return json(result, { headers: { 'Cache-Control': 's-maxage=300' } });
}
