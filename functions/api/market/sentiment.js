// GET /api/market/sentiment — Fear & Greed index + VIX fear gauge.
// Free, no key. Aggregates multiple sentiment signals.

import { getMarketSentiment } from '../../_lib/feargreed.js';
import { json, corsPreflight } from '../../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const sentiment = await getMarketSentiment();
  return json(sentiment, { headers: { 'Cache-Control': 's-maxage=300' } });
}
