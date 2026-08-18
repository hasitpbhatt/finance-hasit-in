// Optional, best-effort TradingView scraper
// Returns {available:false} on any failure to keep core safe
export async function getTvScreener(symbol) {
  try {
    // Unofficial endpoint example – placeholder. Real implementation would
    // target public TradingView screener pages. We keep it minimal and fail-safe.
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 2000);
    // Example public page – not guaranteed to contain data
    const url = `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeout);
    if (!res.ok) return { available:false, reason:'http_'+res.status };
    const text = await res.text();
    // Very naive check for symbol presence
    const found = text.toUpperCase().includes(symbol.toUpperCase());
    return { available:true, found, source:'tradingview' };
  } catch {
    return { available:false, reason:'error' };
  }
}
