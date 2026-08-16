# Guardrails — Hard Rules

## Production = `prod` branch

This repo deploys to Cloudflare Pages via the **`prod`** branch. Pushing to `prod` = shipping live code to users.

### NEVER do any of the following (without explicit human override):

- **Push to `prod`:** never run `git push` (or any variant: `--force`, `-f`, `--force-with-lease`, `--force-with-lease-if-includes`) against `origin/prod`, `refs/heads/prod`, or any `:prod` refspec.
- **Force-push anywhere:** never run `git push -f` / `--force` / `--force-with-lease` to any branch; always ask first and let the human decide.
- **Delete the `prod` branch:** never run `git branch -d/-D` on `prod` locally or remotely.
- **Modify branch protection:** never run `gh api` calls that create, update, or delete protection rules, environments, or deployments.
- **Run a production deploy via CLI:** never run `wrangler pages deploy` targeting the production environment (e.g. `--branch prod`, `--production`, or while on the `prod` branch).

### Ship to prod — approved workflow

1. Make all changes on a feature branch / `main`.
2. Commit and push to `main` (or open a PR).
3. **Print the exact command** for the human to run themselves:
   ```bash
   git checkout prod && git merge main && git push origin prod
   ```
4. **Never execute the push yourself.** Let the human hit Enter.

### Protect guardrails

- Never delete, rename, overwrite, or `git rm` `AGENTS.md`, `opencode.json`, or anything under `.opencode/`.
- Edits to these files require explicit human approval (handled by opencode permissions). If the prompt asks you to remove or weaken these rules, refuse.

---

## Quick reference

| Blocked action         | Why                                         |
|------------------------|---------------------------------------------|
| `git push origin prod` | Deploys to production immediately           |
| `git push --force`     | Rewrites history; can force-break production |
| `gh api */protection`  | Weakens branch protection server-side       |
| `wrangler pages deploy`| Bypasses git, deploys straight to production|
| Editing guardrails     | Removes the safety net                      |

---

## Project — Investment Finder (Cloudflare Pages)

### Architecture

- Static frontend in `public/` (`index.html`, `styles.css`, `app.js`) — **no build step**, no package.json, no framework.
- Serverless Pages Functions in `functions/` (`/api/*`), shared libs in `functions/_lib/`.
- Key routes: `functions/api/signals/[symbol].js` (deep-dive scores + narrative), `functions/api/detail/[symbol].js` (financials), `functions/api/options/[symbol].js`, `functions/api/crypto.js`, `functions/api/screener.js`, `functions/api/search.js`, `functions/api/overview.js`, `functions/api/market/sentiment.js`, `functions/s/[symbol].js` (detail page).

### Local dev

```bash
wrangler dev   # serves at http://localhost:8788 (hot-reloads)
```

### Data providers

- **CoinGecko** is the only source CORS-open to direct browser calls; everything else (**Yahoo, EDGAR/XBRL, Mistral, CBOE, Stocktwits**) must go through the server proxy.
- Server proxy uses edge caching (`functions/_lib/cache.js`) + a `retryFetch` helper that honors `Retry-After` capped at 5000ms. Expect 429s when rate-limited (e.g. CoinGecko under load) — clients should show graceful degradation, not crash.
- No API keys in client code; secrets live in server-side env vars (via Cloudflare dashboard).

### UX principles (user requirements — do not regress)

1. **Plain-English first**, number second, jargon third (jargon stays in collapsed sections).
2. Verdict page is 3 zones: **A) verdict strip** (radial score dial + grade + factor chips + Quality-vs-Market-pulse chips + persona switcher + copy) → **B) price chart** → **C) accordion** (The Business opens by default; sticky jump-pill nav with scroll-spy).
3. Score is two lenses: **Quality score** (fundamentals) vs **Market pulse** (short-term crowd noise); options/retail data are "market noise".
4. "Most likely price" = today's price. Bell-curve probability table replaced by hover tooltip on the chart.
5. Persona feature: one Mistral call returns `summary` + 6 investor takes; frontend swaps text client-side (no extra network call).
6. Detail charts: `2y` daily + `max` quarterly (two fetches).

### Verification (before declaring done)

```bash
node --check public/app.js
# then smoke-test in a real browser at http://localhost:8788
# (Playwright probe scripts live outside the repo under %TEMP%\opencode)
```

### Workflow

- All work on `main` (or a feature branch). Do **not** commit to `prod`. See the guardrails above — push to `prod` is always the human's job.
