import { getCrypto } from '../_lib/crypto.js';
import { json, corsPreflight } from '../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(context.request.url);
  const perPage = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 100);

  try {
    const results = await getCrypto(perPage);
    return json(
      { count: results.length, results, degraded: false, clientFallback: true },
      { headers: { 'Cache-Control': 's-maxage=300' } },
    );
  } catch (e) {
    return json(
      { count: 0, results: [], degraded: true, clientFallback: true, error: e.message },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
