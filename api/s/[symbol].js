// Vercel API route: /s/AAPL — serves the SPA shell with the symbol pre-set so
// the client can render the detail view on first paint (no extra round-trip).
// Includes dynamic og:title / og:description for share cards.

const SYMBOL_RE = /^[A-Z]{1,6}$/;

export async function GET(request) {
  const url = new URL(request.url);
  const raw = (url.pathname.split('/').pop() || '').toUpperCase();
  if (!SYMBOL_RE.test(raw)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${raw} — Investment Finder</title>
    <meta name="description" content="Free investment research for ${raw}. Analyst ratings, insider trades, options, fundamentals, and AI summary." />
    <meta property="og:title" content="${raw} — Investment Finder" />
    <meta property="og:description" content="Free investment research for ${raw}. Analyst ratings, insider trades, options, fundamentals, and AI summary." />
    <meta property="og:type" content="website" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a href="/" class="brand">
        <span class="brand-glyph">IF</span>
        Investment Finder
      </a>

      <div class="search-wrap">
        <input id="global-search" type="text" placeholder="Search any company…" autocomplete="off" />
        <kbd>/</kbd>
        <div id="global-search-results" class="search-results hidden"></div>
      </div>

      <nav class="tabs">
        <button class="tab" data-tab="overview">Discover</button>
        <button class="tab" data-tab="screener">Research</button>
        <button class="tab" data-tab="crypto">Crypto</button>
      </nav>
    </header>

    <main>
      <section id="overview" class="panel"></section>
      <section id="screener" class="panel"></section>
      <section id="crypto" class="panel"></section>
      <section id="detail" class="panel active">
        <div id="detail-content"></div>
      </section>
    </main>

    <footer class="site-footer">
      <p>Data: Yahoo Finance, SEC EDGAR, CoinGecko, StockTwits (free, no key). For educational use only — not investment advice.</p>
    </footer>

    <script src="/app.js"></script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}