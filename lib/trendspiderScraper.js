// Optional, best-effort TrendSpider free scanner hint
export async function getTrendSpiderHint(symbol) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 3000);
    // Public free scanner landing page – no guarantee of content
    const url = 'https://trendspider.com/free-scanners-daily/';
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeout);
    if (!res.ok) return { available:false, reason:'http_'+res.status };
    const text = await res.text();
    const mention = text.toUpperCase().includes(symbol.toUpperCase());
    return { available:true, mention, source:'trendspider' };
  } catch {
    return { available:false, reason:'error' };
  }
}
