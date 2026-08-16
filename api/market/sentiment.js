import { getMarketSentiment } from '../lib/feargreed.js';
import { json, corsPreflight } from '../lib/http.js';

export default async function handler(request) {
  if (request.method === 'OPTIONS') return corsPreflight();
  const sentiment = await getMarketSentiment();
  return json(sentiment, { headers: { 'Cache-Control': 's-maxage=300' } });
}
