# Investable — Architecture Overview

This document maps the codebase structure, data flow, and key gotchas so future sessions don't need to scan every file.

## Directory Layout

| Directory | Purpose |
|---|---|
| `api/` | Serverless API routes (Vercel). Each file exports `OPTIONS` (CORS) and `GET`. Heavy routes (signals) have `maxDuration 30s` in `vercel.json`. |
| `lib/` | Shared modules — cache, data providers (Yahoo, CBOE, CoinGecko, EDGAR, Finnhub, Stocktwits, Mistral), retry logic, indicators, utilities. No build step; pure ESM. |
| `public/` | Static frontend — `index.html`, `styles.css`, `app.js`. No build step, no framework. All UI logic in `app.js`. |
| `AGENTS.md` | Agent guardrails (protected; never delete/weaken). |
| `opencode.json` | Opencode configuration (protected). |

## Design & Decision Principles

These principles govern architectural choices and are derived from the committee.

| Principle | Source | Architectural Impact |
|---|---|---|
| **Say no by default** | Jobs | No feature creep; every API must earn its place |
| **Inversion checkpoint** | Munger | Every route documents top 3 failure modes and mitigations |
| **Data integrity > completeness** | Buffett | All endpoints return `source`, `staleness`, `confidenceScore`; `null` beats fabricated data |
| **Margin of safety** | Buffett/Marks | Cache TTLs, retry budgets, and graceful degradation are mandatory for all external calls |
| **Leverage via composability** | Naval | New data providers must be added to `lib/` as primitives, not one-offs in `api/` |
| **End-to-end ownership** | Jobs | API author must own the UI surface consuming it |
| **Explainability** | Lynch/Norman | Every metric exposed in UI has a one-sentence plain-English definition in code comments |
| **Cycle awareness** | Marks | Time-series endpoints expose regime metadata; UI labels metrics accordingly |
| **Decision log** | Dalio | High-impact architectural changes require a one-line log entry in `ARCHITECTURE.md` or `DECISIONS.md` |
| **Free-only boundary** | Buffett | No paid APIs; all providers must be free-tier or CORS-open |

## Data Flow — Signal Pipeline

### 1. `/api/signals/[symbol]` (heavy, aggregated)

- **Purpose**: Full verdict + market pulse + options + fundamentals + Mistral narrative.
- **Flow** (via `handleSignals`, `api/signals/[symbol].js`):
  1. Parallel fetch of all sources under per-source AbortController + timeout budgets (total ~6s).
  2. **Options path** (light): `getOptionChainLimited(symbol)` → returns full expiration list but only 2 chains (nearest + ~30 DTE). `computeOptionSignals` uses those 2 to compute expected move, probability bands, max pain, support/resistance, sentiment, and IV-derived metrics.
  3. Other sources: insider (Edgar), newsIntel, leadership, hiring, analyst/earnings/dividends (Finnhub), retail sentiment (Stocktwits), XBRL trends, short-interest.
  4. `computeMarketPulse` weighs options (0.30), retail (0.35), news (0.35) → composite score / grade.
  5. Mistral `mistral-medium-latest` call → 7- investor persona takes (summary, buffett, munger, graham, lynch, fisher, templeton).
  6. Verdict scoring (two lenses): Quality (analyst, fundamentals, insider, growth) vs Market pulse.
  7. Returns full `result` JSON: price, name, value metrics, score, marketPulse, buffettMetrics, narrative, options, etc.

- **Key routes inside**: `getOptionChain`, `getOptionChainLimited`, `getOptionChainForExpiry` (all in `lib/yahoo.js`); `computeOptionSignals` (the core options math); `computeValueMetrics`, `computeMarginOfSafety`, `computeBuffettMetrics`.

### 2. `/api/options/[symbol]?expiry=YYYY-MM-DD` (per-expiry)

- **Purpose**: Fetch options chain for a **single** expiration, compute signals for that expiry only.
- **Flow** (via `api/options/[symbol].js`):
  1. Resolve requested date → epoch via `dateToEpoch`.
  2. Fetch chain for that epoch via `getOptionChainForExpiry` (two Yahoo calls: expiration list + `?date=`).
  3. `computeOptionSignals(chain, currentPrice, { expiryEpoch: requestedEpoch })` → sigma (expected move) uses the **requested** expiry's DTE and ATM IV.
  4. Returns `{ symbol, available, source, currentPrice, expirations (full list), selectedExpiry, signals, distribution (OI concentration) }`.
  5. If the specific expiry fetch fails, falls back to CBOE delayed data; if both fail → `available: false`.

- **Critical fix**: `computeOptionSignals` ATM IV filter (see "Known Gotchas") — Yahoo sometimes returns `0.00001` as a sentinel for stale/illiquid contracts. The filter excludes `iv < 0.01` (1%), preventing a near-zero expected move that made the bell curve an invisible spike regardless of expiry.

### 3. Frontend rendering (`public/app.js`)

- **`renderSignals(c, d, s)`** (line 1150): builds the detail page — chart zone first, then verdict strip, then story sections (business, quality, value, growth, price, ownership, watchouts, news, noise/market pulse). Bell curve overlay removed from primary chart zone.
- **`probabilityBlockHtml(o, symbol)`** (line 818): retained for code reuse but no longer rendered in primary detail page. Bell curve canvas is demoted; probability visualisation removed from chart area per Jobs minimalism.
- **Delegated change handler** (line 2340): listens for `.options-expiry` change, fetches `/api/options/[symbol]?expiry=VALUE`, rebuilds `#options-details` via `optionsDetailsHtml`. Overlay update removed.
- **`optionsDetailsHtml(o, symbol)`** (line 857): renders the options grid (expected move, max pain, support/resistance, PC ratio, IV, unusual volume) and the "In plain English" synthesis. Rendered inside Market pulse section with expiry selector.
- **`marketNoiseContent(s, symbol)`** (line 759): now includes an expiry `<select class="options-expiry">` with date · ~Nd labels, caption explaining change effect, and `optionsDetailsHtml`. Visible Trader lens only.
- **`applyLens(c, d, s)`** (line 1426): swaps Investor ⇄ Trader lens. Trader lens shows Market pulse with options expiry control; Investor lens hides Market pulse. `#trader-overlay` removed from DOM.
- **`currentLens()`** (line 246): reads `localStorage.getItem('if_lens') === 'trader' ? 'trader' : 'investor'`.

### 3. Key Constants

- `QUALITY_WEIGHTS` (signals route): analyst 0.20, fundamentals 0.35, insider 0.25, growth 0.20.
- `MARKET_WEIGHTS` (signals route): options 0.30, retail 0.35, news 0.35.
- Trader lens is the default lens that shows options/beta metrics; Investor lens shows long-term business quality.

## Known Gotchas

| Gotcha | Location | Description |
|---|---|---|
| **Yahoo `0.00001` IV sentinel** | `lib/yahoo.js:computeOptionSignals` | Yahoo options data returns `0.00001` as a placeholder for illiquid/stale contracts. The old code `filter(c => c.iv > 0)` included these, dragging the average ATM IV to ~1% instead of the real ~25–35%. This caused: (a) expected-move numbers like `±$0.66 (0.2%)` (meaningless), (b) bell curve always a narrow spike that doesn't perceptibly change across expiries, (c) sigma=0.12 on a $80 stock (Uber) — impossible IV. The fix: exclude `iv < 0.01` and widen band gracefully; fallback to closest strike with `iv > 0` when all data is corrupted. |
| **`getOptionChainLimited` returns full expirations but only 2 chains** | `lib/yahoo.js:getOptionChainLimited` | The expiration list (all dates) is returned, but only the nearest and ~30-DTE contracts are fetched. This means the dropdown always has all dates, but the initial signals only use 2 expiries for computing metrics. |
| **Bell curve is a symmetric normal approximation centered on today's price** | `public/app.js:drawProbabilityDistribution` | The "most likely price" is always today's price (no-move outcome is the market's best guess). The curve width scales with `σ = expectedMoveDollar = atmIV × price × sqrt(DTE/365)`. Changing the option date changes DTE and thereby σ — but only if ATM IV is computed correctly (see above). |
| **Mistral model usage** | `lib/mistral.js` (new) / `api/signals/[symbol].js` | The main narrative uses `mistral-medium-latest` (7-investor takes). A new `mistral-small-latest` helper provides a brief trader-focused read (expected move, max pain, support/resistance, sentiment) for the per-expiry options block, with a hardcoded fallback when no API key or on timeout. |
| **CBOE fallback for options** | `api/options/[symbol].js` / `lib/cboe.js` | If Yahoo options fetch fails entirely, a delayed CBOE chain is used as fallback. CBOE data is stale (end-of-day) and has fewer expiries. |
| **`getJSON` is a bare fetch, no retry/timeout** | `public/app.js:31` | The delegated date-change handler uses `getJSON` (plain fetch) for the `/api/options` call. No built-in timeout — relies on the 30s Vercel maxDuration on the server side. |

## Component Metadata

| Component | Responsibility | Key Inputs | Key Outputs | Cache TTL | Dependencies |
|---|---|---|---|---|---|
| `api/signals/[symbol]` | Aggregate verdict, market pulse, options, fundamentals, narrative | symbol | full signal JSON with score, marketPulse, buffettMetrics, narrative | 300s s-maxage | Yahoo, EDGAR, Finnhub, Stocktwits, Mistral, CBOE |
| `api/options/[symbol]` | Per-expiry options chain + derived signals | symbol, expiry | options signals, distribution, OI walls, narrative | 600s s-maxage | Yahoo, CBOE, Mistral |
| `api/detail/[symbol]` | Price, chart, indicators, news | symbol | quote, 2y/max chart, SMA/RSI/MACD, news | 300s s-maxage | Yahoo, Nasdaq |
| `lib/yahoo.js` | Yahoo Finance free endpoints wrapper | symbol | quotes, fundamentals, chart, options | 1800-21600s | Cookie+crumb session |
| `lib/cache.js` | Edge / in-memory caching, retry, coalescing | url | cached JSON/text | varies | Cache API / Map |
| `lib/indicators.js` | SMA, RSI, MACD computation | closes[] | indicator arrays | N/A | CPU only |
| `lib/mistral.js` | LLM narrative generation | symbol, signals | plain-English summary | none | Mistral API |
| `public/app.js` | SPA UI, verdict strip, chart, lens switch | DOM | rendered detail page | N/A | Browser |

## Quick-Start Verification

```bash
# Smoke-test
node --check public/app.js

# Dev server (no build step)
vercel dev        # → http://localhost:3000

# Test the fix
# 1. Open a symbol in the Trader lens.
# 2. Change the "Look at" date selector.
# 3. The bell-curve width and the "In plain English" text should change visibly.
# 4. Expected move should show a sensible % (e.g., ±8–12% for a typical stock),
#    not a sub-1% artifact.
```