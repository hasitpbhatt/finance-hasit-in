// Dynamic sitemap for the curated universe. Each symbol = a shareable,
// crawlable verdict page at /s/SYMBOL. Crawlers discover the long tail here.
import { UNIVERSE } from '../../lib/universe.js';

const BASE = 'https://finance.hasit.in/s';

export async function GET() {
  const urls = UNIVERSE
    .map(s => `  <url><loc>${BASE}/${encodeURIComponent(s)}</loc><changefreq>daily</changefreq><priority>0.6</priority></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, max-age=600',
    },
  });
}
