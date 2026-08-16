// Edge TTL cache backed by the Cloudflare Cache API (caches.default).
// Used by Pages Functions to avoid hammering free upstreams.

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

async function fromCache(url) {
  if (typeof caches === 'undefined') return null;
  const cached = await caches.default.match(new Request(url));
  if (!cached) return null;
  const cachedAt = Number(cached.headers.get('X-Cached-At') || '0');
  return { response: cached, cachedAt };
}

async function store(url, text, contentType) {
  if (typeof caches === 'undefined') return;
  const response = new Response(text, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-Cached-At': String(Date.now()),
    },
  });
  await caches.default.put(new Request(url), response);
}

// Fetch with retry on 429/503. Max 2 retries. Honors the upstream Retry-After
// header when present, otherwise exponential backoff (capped so we never sit on
// a function worker for too long).
async function retryFetch(url, opts = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429 || res.status === 503) {
      if (attempt < retries) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : Math.min(1000 * 2 ** attempt, 4000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
    return res;
  }
  // Unreachable but TypeScript-safe
  return fetch(url, opts);
}

// Fetch JSON with edge caching. Returns { data, cached, stale }.
// Falls back to a stale cached copy if the upstream errors (graceful degradation).
// `cacheKey` lets callers cache under a stable URL (e.g. with a rotating crumb
// stripped) so the edge cache isn't busted every session refresh.
export async function cachedJson(url, ttlSeconds, extraHeaders = {}, cacheKey = null) {
  const key = cacheKey || url;
  const hit = await fromCache(key);
  if (hit && hit.cachedAt && Date.now() - hit.cachedAt < ttlSeconds * 1000) {
    return { data: await hit.response.json(), cached: true, fresh: true };
  }
  try {
    const upstream = await retryFetch(url, {
      headers: { ...UA, ...extraHeaders },
      cf: { cacheTtl: ttlSeconds, cacheEverything: true },
    });
    if (!upstream.ok) throw new Error(`status ${upstream.status}`);
    const text = await upstream.text();
    const data = JSON.parse(text);
    await store(key, text, 'application/json');
    return { data, cached: false };
  } catch (err) {
    if (hit) {
      return { data: await hit.response.json(), cached: true, stale: true };
    }
    throw err;
  }
}

// Same as cachedJson but for non-JSON (e.g. RSS XML).
export async function cachedText(url, ttlSeconds, extraHeaders = {}, cacheKey = null) {
  const key = cacheKey || url;
  const hit = await fromCache(key);
  if (hit && hit.cachedAt && Date.now() - hit.cachedAt < ttlSeconds * 1000) {
    return { data: await hit.response.text(), cached: true, fresh: true };
  }
  try {
    const upstream = await retryFetch(url, {
      headers: { ...UA, ...extraHeaders },
      cf: { cacheTtl: ttlSeconds, cacheEverything: true },
    });
    if (!upstream.ok) throw new Error(`status ${upstream.status}`);
    const text = await upstream.text();
    await store(key, text, 'text/xml');
    return { data: text, cached: false };
  } catch (err) {
    if (hit) {
      return { data: await hit.response.text(), cached: true, stale: true };
    }
    throw err;
  }
}

export { UA, retryFetch };
