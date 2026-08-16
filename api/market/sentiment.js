import { getMarketSentiment } from '../../lib/feargreed.js';
import { json, corsPreflight } from '../../lib/http.js';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET() {
  const sentiment = await getMarketSentiment();
  return json(sentiment, { headers: { 'Cache-Control': 's-maxage=300' } });
}
