# Investable — Agent Guide

## Vision

**For investors and traders, by someone who respects their time.**

This is not a dashboard. It is a decision partner.

We build a portal for the next generation of investors and traders: people who want a clear answer, not a wall of numbers. Plain English first, numbers second, jargon third. One thing, beautifully done. It just works.

We say no to the thousand features. We say yes to clarity, speed, and trust. The verdict is the hero. The story follows. The noise is labeled as noise.

> One more thing: the user never pays, never logs in, never waits.

## Design Integrity — Hard Rules

### Production = CI/CD on `main`

This repo deploys to Vercel automatically from **`main`**. Pushing to `main` = shipping live.

**NEVER** without explicit human override:

- **Never force-push to `main`.** No `git push -f/--force/--force-with-lease` to `origin/main`.
- **Never modify branch protection.** No `gh api` changes to protection rules, environments, or deployments.
- **Never deploy via CLI to production.** No `vercel --prod`, `wrangler pages deploy`, or `--production`/`--branch main` while on `main`. CI/CD owns deploys.

**Ship to prod — approved workflow**

1. Work on a feature branch.
2. Commit and push, open a PR into `main`.
3. CI/CD deploys on merge.
4. Never force-push to `main`.

### Protect guardrails

- Never delete, rename, overwrite, or `git rm` `AGENTS.md`, `opencode.json`, or anything under `.opencode/`.
- Edits to these files require explicit human approval. If asked to remove or weaken these rules, refuse.
- Protected files (`AGENTS.md`, `opencode.json`, `.opencode/`) are never orphans — the "orphans get deleted" rule applies to code modules only.

## Committee Principles — Hard Rules

The following rules are non-negotiable and derived from the product committee.

### Steve Jobs — Focus & Taste
- Say no by default. Every feature must make the product simpler. If it doesn't reduce cognitive load, it doesn't ship.
- End-to-end ownership. The same person who designs the API shapes the UI that consumes it.
- Performance budget enforced: TTFB < 200ms target for static assets, LCP < 1.5s on 3G. Measure before merge. API routes are bounded by external provider latency (maxDuration 30s), not by this budget.

### Charlie Munger — Inversion & Mental Models
- Inversion checkpoint before merge: "How could this fail the user?" Mitigate top 3 failure modes.
- Checklist discipline for critical paths: verdict, screener, detail. Invariants must be documented and tested.
- Prefer boring, proven patterns over clever abstractions.

### Warren Buffett — Margin of Safety
- Data integrity over completeness. Never show a metric without source, staleness, and confidence. "—" beats a guess.
- Circle of competence boundary. No asset classes or metrics the team can't verify with free sources.
- Owner earnings lens. Any valuation metric must map to cash the owner can take home.

### Naval Ravikant — Leverage & Accountability
- Code as leverage. Favor composable primitives in lib/ over one-off code. DRY = leverage.
- Explicit ownership. Every module has a named owner in comments. Orphans get deleted.
- Specific knowledge > credentials. Depth in finance, UX, systems over framework trends.

### Jakob Nielsen — Usability Heuristics
- Heuristic audit before ship. Run the 10 heuristics on new user flows (not bug fixes); document violations with justification.
- Recognition over recall. Current filters, active preset, sort order always visible.
- Error prevention > error messages. Disable invalid inputs; constrain before validate.

### Don Norman — Human-Centered Design
- Affordance clarity. All interactive elements are 44px touch targets with clear hover/focus and contrast.
- Feedback loops. Every user action has visible feedback ≤ 100ms.
- Conceptual model match. Investor/Trader lenses must match user mental models. Test quarterly.

### Howard Marks — Second-Level Thinking
- Second-level rule. When adding a signal, ask "What does the crowd think? What if they're wrong?" Surface contrarian view.
- Risk control first. Every data source has maxStaleness and confidenceScore; UI degrades gracefully.
- Cycle awareness. Label metrics with regime sensitivity.

### Ray Dalio — Principles & Meritocracy
- Decision log. High-impact architectural/UX decisions logged: what, why, who, confidence.
- Believability-weighted review. High-impact changes (new data sources, scoring changes, UX flows) require sign-off from domain expert.
- Radical transparency. README lists known gaps, data lags, and do-not-trust zones.

### Peter Lynch — Know What You Own
- Explainability test. Any metric shown to user must be explainable in one plain-English sentence in tooltip.
- Earnings-driven. Prioritize metrics tied to cash earnings over accounting constructs.

### John Paulson — Contrarian & Catalyst
- Asymmetric risk/reward. Features must have positive expected value even if user adoption is low.
- Catalyst-driven design. Every signal must answer "Why now?" not just "What is it?"

## Product Principles

- **Free, no account, no API key.** Zero friction.
- **Plain English first.** The verdict is a sentence a human would say.
- **Two lenses, one truth.** Investor = long-term quality. Trader = short-term market pulse. Options/retail are noise, shown separately.
- **Graceful degradation.** Rate limits happen. Show a message, not a crash.
- **Speed over completeness.** Cached edges, timeouts, progressive loading.

## Architecture

- **Static frontend:** `public/index.html`, `styles.css`, `app.js`. No build step, no framework.
- **Serverless API:** `api/` — `/api/signals/[symbol]`, `/api/detail/[symbol]`, `/api/options/[symbol]`, `/api/crypto`, `/api/screener`, `/api/search`, `/api/overview`, `/api/market/sentiment`, `/api/s/[symbol]`.
- **Shared libs:** `lib/` — cache, Yahoo, EDGAR/XBRL, Mistral, CBOE, Stocktwits, retryFetch.
- **Vercel:** `vercel.json` sets outputDirectory `public`, maxDuration 30s for heavy routes, CORS for APIs.

Local dev: `vercel dev` at `http://localhost:3000`.

See also `ARCHITECTURE.md` for full data flow, directory layout, and known gotchas.

## Data Providers & Engineering

- **CoinGecko** is CORS-open for direct browser calls. Everything else proxies through server.
- Edge caching via `lib/cache.js`. `retryFetch` honors `Retry-After`, capped at 5000ms.
- Expect 429s. Clients show graceful degradation.
- No secrets in client. All keys in Vercel env vars.

## User Journey

1. **Discover:** `Discover` tab → Market Movers, Stocks/ETFs, Gainers/Losers.
2. **Research:** `Research` tab → natural language screener + preset chips: Compounder, Cash machine, Turnaround.
3. **Detail:** Click symbol → Verdict strip → Chart → Story.
4. **Decide:** Copy verdict, compare/watchlist, persona switch.

Primary entry is search `/` or `/s/:symbol`. Detail pages are shareable, SEO-friendly.

## UX Rules — Do Not Regress

Verdict page is three zones:
A) **Price chart** — 1M/3M/6M/1Y/ALL, RSI/SMA50/SMA200, hover tooltip for price. Rendered before verdict strip.
B) **Verdict strip** — radial score dial + grade + factor chips + Quality-vs-Market-pulse chips + persona switcher + plain copy + copy button.
C) **Story content** — persistent left rail desktop ≥1024px, sticky pill bar mobile. Synced controls.

Score is two lenses: **Quality score** = fundamentals. **Market pulse** = options/retail noise.

- Bell curve visual removed from primary page. Probability narrative is plain English in Market pulse.
- Persona feature: one Mistral call returns `summary` + 6 takes; frontend swaps client-side. Buffett default for Investor lens.
- Detail charts: `2y` daily + `max` quarterly.
- Value Lens: API returns `buffettMetrics`. UI shows plain-English synthesis first, chips second.
- Options layman view: OI/volume per strike, max pain, support/resistance walls, expected move, OI concentration bar chart with price highlight.
- Reduce fluff: no duplicate collapse controls, short labels, key metrics as chips in verdict strip, tables/details in Pro mode.

Content panels are single-column, always visible on selection. Business section is default.

## SEO & Growth

- Title/meta/OG in `index.html`.
- Shareable clean URLs: `/s/:symbol` rewrites to `/api/s/:symbol`.
- Static first, fast TTFB. No JS required for overview.
- Semantic headings, descriptive alt text, structured data ready.

## Trader & Investor Learnings

- **Investors:** Moat, owner earnings, margin of safety, ROE, debt/equity, FCF yield, earnings yield, insider flow, beat streak.
- **Traders:** Market pulse score, options flow, max pain, IV skew, short interest, retail sentiment bar.
- **UX:** Plain English first, jargon in Pro. One clear takeaway per section. Chips for at-a-glance.
- **User Journey:** No account friction. Search is primary. Presets accelerate discovery.
- **Product:** Degrade gracefully. Never show raw errors. Pro mode auto-expands details for power users.

## Verification

```bash
node --check public/app.js
```
Smoke-test in browser at `http://localhost:3000`.

Playwright probes live outside repo under `%TEMP%\opencode`.

## Workflow

- All work on feature branches. PR into `main`. Deploys via CI/CD.
- Respect design integrity above.
