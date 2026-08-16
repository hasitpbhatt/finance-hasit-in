// Platform-aware TTL cache.
// Cloudflare: backed by the Cache API (caches.default).
// Vercel / other: falls back to an in-memory Map (per-instance, TTL-based).

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// --- Platform detection ---
const HAS_EDGE_CACHE = typeof caches !== 'undefined' && caches.default;

// --- In-memory fallback (Vercel) ---
const memCache = new Map();
const MEM_MAX_ENTRIES = 1000;
const MEM_MAX_AGE_MS = 3600_000;

function memEvict() {
  if (memCache.size <= MEM_MAX_ENTRIES) return;
  const cutoff = Date.now() - MEM_MAX_AGE_MS;
  for (const [k, v] of memCache) {
    if (v.cachedAt < cutoff) memCache.delete(k);
  }
}

// --- Unified cache read/write ---

export async function fromCache(key) {
  if (HAS_EDGE_CACHE) {
    const cached = await caches.default.match(new Request(key));
    if (!cached) return null;
    const cachedAt = Number(cached.headers.get('X-Cached-At') || '0');
    const text = await cached.text();
    const contentType = cached.headers.get('Content-Type') || 'application/json';
    return { text, contentType, cachedAt };
  }
  const entry = memCache.get(key);
  if (!entry) return null;
  return { text: entry.text, contentType: entry.contentType, cachedAt: entry.cachedAt };
}

export async function store(key, text, contentType) {
  if (HAS_EDGE_CACHE) {
    const response = new Response(text, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Cached-At': String(Date.now()),
      },
    });
    await caches.default.put(new Request(key), response);
    return;
  }
  memCache.set(key, { text, contentType, cachedAt: Date.now() });
  memEvict();
}

// Fetch with retry on 429/503. Max 2 retries. Honors the upstream Retry-After
// header when present, otherwise exponential backoff (capped so we never sit on
// a function worker for too long). Accepts opts.signal (AbortSignal) so callers
// can cancel the whole retry loop when their deadline expires.
export async function retryFetch(url, opts = {}, retries = 2) {
  const { signal, cf, ...fetchOpts } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const res = await fetch(url, { ...fetchOpts, signal });
    if ((res.status === 429 || res.status === 503) && !signal?.aborted) {
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
  return fetch(url, opts);
}

// Fetch JSON with caching. Returns { data, cached, stale }.
// Falls back to a stale cached copy if the upstream errors (graceful degradation).
export async function cachedJson(url, ttlSeconds, extraHeaders = {}, cacheKey = null, signal = null) {
  const key = cacheKey || url;
  const hit = await fromCache(key);
  if (hit && hit.cachedAt && Date.now() - hit.cachedAt < ttlSeconds * 1000) {
    return { data: JSON.parse(hit.text), cached: true, fresh: true };
  }
  try {
    const upstream = await retryFetch(url, {
      headers: { ...UA, ...extraHeaders },
      signal,
    });
    if (!upstream.ok) throw new Error(`status ${upstream.status}`);
    const text = await upstream.text();
    const data = JSON.parse(text);
    await store(key, text, 'application/json');
    return { data, cached: false };
  } catch (err) {
    if (hit) {
      return { data: JSON.parse(hit.text), cached: true, stale: true };
    }
    throw err;
  }
}

// Same as cachedJson but for non-JSON (e.g. RSS XML).
export async function cachedText(url, ttlSeconds, extraHeaders = {}, cacheKey = null, signal = null) {
  const key = cacheKey || url;
  const hit = await fromCache(key);
  if (hit && hit.cachedAt && Date.now() - hit.cachedAt < ttlSeconds * 1000) {
    return { data: hit.text, cached: true, fresh: true };
  }
  try {
    const upstream = await retryFetch(url, {
      headers: { ...UA, ...extraHeaders },
      signal,
    });
    if (!upstream.ok) throw new Error(`status ${upstream.status}`);
    const text = await upstream.text();
    await store(key, text, 'text/xml');
    return { data: text, cached: false };
  } catch (err) {
    if (hit) {
      return { data: hit.text, cached: true, stale: true };
    }
    throw err;
  }
}

export { UA };
