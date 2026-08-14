// Pages Function: /s/AAPL — serves the SPA shell with the symbol pre-set so
// the client can render the detail view on first paint (no extra round-trip).

const SYMBOL_RE = /^[A-Z]{1,6}$/;

export async function onRequest(context) {
  const raw = (context.params.symbol || '').toUpperCase();
  if (!SYMBOL_RE.test(raw)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${raw} — Investment Finder</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <div class="brand">
        <a href="/" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:8px">
          <span class="logo">📈</span>
          <div>
            <h1>Investment Finder</h1>
            <p class="tagline">Free US stocks &amp; ETFs — no account, no API keys.</p>
          </div>
        </a>
      </div>
      <div class="search-wrap">
        <input id="global-search" type="text" placeholder="Search any company (Apple, NVDA)…" autocomplete="off" />
        <div id="global-search-results" class="search-results hidden"></div>
      </div>
      <nav class="tabs">
        <button class="tab" data-tab="overview">Overview</button>
        <button class="tab" data-tab="screener">Screener</button>
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
      <p>Data: Yahoo Finance &amp; CoinGecko (free, no key). For educational use only — not investment advice.</p>
    </footer>

    <script>window.__INITIAL_SYMBOL__ = "${raw}";</script>
    <script src="/app.js"></script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
