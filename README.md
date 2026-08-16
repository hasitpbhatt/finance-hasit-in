# Investment Finder

A free, no-account, no-API-key web tool that surfaces investable US **stocks and ETFs**
plus crypto market data. Built for **Cloudflare Pages** and **Vercel**: a plain static frontend
(`./public`) backed by **Cloudflare Pages Functions** (`./functions`) that proxy and
edge-cache free public data sources.

## Data sources (all free, no key)
- **Yahoo Finance** — quotes, fundamentals, historical prices, headlines (via public `query1.finance.yahoo.com` endpoints).
- **SEC EDGAR** — insider Form 4 filings, mapped from ticker → CIK via `company_tickers.json` (public, no key).
- **CoinGecko** — crypto prices and market cap (public API, no key for low volume).

No database, no accounts, no secrets. Results are cached at the Cloudflare edge
(stocks/ETFs ~1h, crypto ~5min) to avoid hammering the free upstreams.

## Features
- **Overview** — top gainers / losers for US stocks and ETFs, plus top crypto movers (24h).
- **Screener** — filter the curated universe by type (stock/ETF), min market cap, sector, max P/E, min dividend yield, and value-investor fundamentals: max P/B, min ROE, max D/E, min current ratio, max beta, and min earnings growth. The deep-fundamental filters use Yahoo `quoteSummary` and are only fetched when requested (cheap v7 quotes otherwise).
- **Detail view** — price chart (canvas), expanded value-investor metrics (P/B, ROE, margins, debt/equity, current ratio, beta, EV multiples, ownership %), latest news, and an **Insider Trades** panel with recent SEC Form 4 transactions (purchases green, sales red, net summary). Opened by clicking any symbol.
- **Crypto** — top coins by market cap with 24h change.

## Local development
Requires [Node.js](https://nodejs.org) and the Cloudflare `wrangler` CLI.

```bash
npm install -g wrangler      # or: npx wrangler ...
wrangler pages dev public    # serves ./public + ./functions on http://localhost:8788
```

Then open http://localhost:8788.

## Deploy to Cloudflare Pages
1. Push this repo to GitHub/GitLab.
2. In Cloudflare Pages, create a project and set:
   - **Framework preset:** None
   - **Build command:** (leave empty)
   - **Build output directory:** `public`
3. Deploy. Pages auto-detects `./functions` and serves the API at `/api/*`.

Or via CLI:
```bash
wrangler pages deploy public
```

## Project layout
```
public/            # static frontend (index.html, styles.css, app.js)
functions/
  _lib/            # shared helpers (edge cache, Yahoo, SEC EDGAR, CoinGecko, HTTP)
  api/
    overview.js
    screener.js
    crypto.js
    detail/[symbol].js
wrangler.toml
```

## Notes & limitations
- Free upstreams can be rate-limited or change without notice. The app degrades
  gracefully: a failed source returns `degraded: true` with a message instead of an error page.
- The screener universe is a curated list in `lib/universe.js` — edit it to
  change coverage. There are no API keys involved, so you can add/remove tickers freely.
- Data is for educational/informational use only — **not investment advice**.

## Known data quirks
- Yahoo's quote endpoint does not return `marketCap` for ETFs, so the screener's
  "Min Market Cap" filter effectively only applies to stocks. ETFs still appear in
  the overview and detail views.
- Yahoo requires a cookie + crumb for quotes; this is handled automatically and
  cached at the edge, with a one-time retry on expiry.
- The deeper value-investor fundamentals (ROE, margins, debt/equity, etc.) come from
  Yahoo `quoteSummary` and are displayed in the detail view and applied by the
  screener only when a corresponding filter is requested.
- Insider trades are sourced from SEC EDGAR Form 4 filings. The ticker→CIK map is
  cached for 7 days; Form 4 summaries and XML are cached for 12 hours. If EDGAR is
  unreachable, the insider panel shows "unavailable" rather than breaking the page.
