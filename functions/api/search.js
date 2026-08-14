import { searchSymbols } from '../_lib/yahoo.js';
import { UNIVERSE } from '../_lib/universe.js';
import { json, corsPreflight } from '../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ count: 0, results: [], degraded: false }, {
      headers: { 'Cache-Control': 's-maxage=60' },
    });
  }

  try {
    const hits = await searchSymbols(q, 10);
    const results = hits.map((h) => ({
      ...h,
      inUniverse: UNIVERSE.includes(h.symbol),
    }));
    return json({ count: results.length, results, degraded: false }, {
      headers: { 'Cache-Control': 's-maxage=900' },
    });
  } catch (e) {
    return json({ count: 0, results: [], degraded: true, error: e.message }, {
      status: 200,
      headers: { 'Cache-Control': 's-maxage=60' },
    });
  }
}
