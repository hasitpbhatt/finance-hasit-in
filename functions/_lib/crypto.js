// CoinGecko public API (free, no key for low volume). Cached at the edge.

import { cachedJson } from './cache.js';

export async function getCrypto(perPage = 50) {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd` +
    `&order=market_cap_desc&per_page=${perPage}&page=1` +
    `&price_change_percentage=24h`;
  const { data } = await cachedJson(url, 300);
  return (data || []).map((c) => ({
    id: c.id,
    symbol: (c.symbol || '').toUpperCase(),
    name: c.name,
    image: c.image,
    price: c.current_price,
    marketCap: c.market_cap,
    volume: c.total_volume,
    change24h: c.price_change_percentage_24h,
  }));
}
