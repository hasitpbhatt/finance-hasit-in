'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- formatting ----------
function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtCap(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + fmtNum(n);
}
function chgClass(v) {
  if (v == null || isNaN(v)) return '';
  return v >= 0 ? 'up' : 'down';
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Same as getJSON but with a wall-clock abort so a dead/slow upstream doesn't
// hang the page indefinitely. Resolves undefined on timeout so callers can show
// a graceful "sources are slow" state instead of an error.
async function getJSONWithTimeout(url, ms = 18000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') return undefined;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- icons ----------
const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5v-1a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1" stroke="currentColor" stroke-width="1.4"/></svg>',
};

// ---------- score dial (radial 0–100 arc) ----------
function scoreDialHtml(score) {
  if (!score) return '';
  const factors = score.factors || [];
  if (!factors.length) {
    // No data — never paint a +0 as though it were a real verdict.
    return `
      <div class="score-dial score-dial-none">
        <div class="score-dial-grade">Not enough data</div>
        <div class="score-dial-meta">Fewer signals than we'd like to judge.</div>
      </div>`;
  }
  const v = score.value;
  const thin = factors.length < 2; // low confidence → de-emphasize the dial
  const pct = Math.round(((v + 100) / 200) * 100);
  const dialCls = v >= 30 ? 'up' : v >= -30 ? 'mid' : 'down';
  const gradeCls = v >= 10 ? 'up' : v > -10 ? 'mid' : 'down';
  const gradeLabel = (score.label || score.grade || 'neutral').replace(/_/g, ' ');
  const ARC = Math.PI * 46;
  const dash = (ARC * pct) / 100;
  return `
    <div class="score-dial">
      <svg class="score-dial-svg" viewBox="0 0 120 74" role="img" aria-label="Quality score ${v}">
        <path class="score-dial-track" d="M 14 62 A 46 46 0 0 1 106 62" fill="none"/>
        <path class="score-dial-fill ${dialCls}${thin ? ' thin' : ''}" d="M 14 62 A 46 46 0 0 1 106 62" fill="none" stroke-dasharray="${dash.toFixed(2)} ${ARC.toFixed(2)}"/>
      </svg>
      <div class="score-dial-value ${gradeCls}${thin ? ' thin' : ''}">${v > 0 ? '+' : ''}${v}</div>
      <div class="score-dial-grade">${gradeLabel}</div>
    </div>
    <div class="score-dial-meta">${factors.length} of 4 signal${factors.length !== 1 ? 's' : ''}</div>`;
}

// Quality-vs-Noise framing: long-term score vs short-term market pulse.
function qualityVsNoiseHtml(s) {
  const lens = currentLens();
  const chips = [];
  if (s.score) {
    const sv = s.score.value;
    const cls = sv >= 10 ? 'up' : sv > -10 ? 'mid' : 'down';
    const active = lens === 'investor' ? ' lens-active' : '';
    chips.push(`<span class="qn-chip${active}" title="Quality = long-term business health"><span class="qn-dot ${cls}"></span>Quality <strong>${sv > 0 ? '+' : ''}${sv}</strong></span>`);
  }
  if (s.marketPulse) {
    const mv = s.marketPulse.value;
    const cls = mv > 10 ? 'up' : mv < -10 ? 'down' : 'neutral';
    const active = lens === 'trader' ? ' lens-active' : '';
    chips.push(`<span class="qn-chip qn-muted${active}" title="Market pulse = short-term crowd &amp; options noise — not part of the long-term verdict"><span class="qn-dot ${cls}"></span>Market pulse <strong>${mv > 0 ? '+' : ''}${mv}</strong></span>`);
  }
  if (!chips.length) return '';
  return `<div class="quality-vs-noise">${chips.join('')}</div>`;
}

// One plain-English sentence that interprets the dial for a non-expert, plus a
// valuation note when we have the data. Traders still get the raw numbers in
// the sections; this is the "what does it mean" layer.
function plainVerdictSentence(d, s) {
  const sc = s.score;
  if (!sc || !sc.factors?.length) return '';
  const v = sc.value;
  let take = '';
  if (v >= 30) take = 'A solid long-term business based on the signals we have.';
  else if (v >= 10) take = 'A decent long-term business, with a few caveats.';
  else if (v > -10) take = 'The long-term signals are mixed — no clear call either way.';
  else if (v > -30) take = 'Long-term signals look soft. Be careful.';
  else take = 'Long-term signals look weak. We would be wary here.';
  const vv = s.value;
  if (vv?.grahamFairValue != null && d.price != null) {
    const gap = ((d.price - vv.grahamFairValue) / vv.grahamFairValue) * 100;
    if (gap <= -15) take += ' It trades below a rough fair value — a margin of safety.';
    else if (gap <= 15) take += ' The price looks roughly fair.';
    else take += ' It trades above a rough fair value — little margin of safety.';
  } else if (!(s.analyst?.targetMean != null && d.price != null)) {
    take += " We couldn't judge whether the price is fair from the data.";
  }
  return take;
}

// Factor chip tooltips — plain-English gloss for jargon labels (UX: layman
// understands the factor; traders still get the number).
const FACTOR_TITLES = {
  analyst: 'What professional analysts expect — ratings and price targets',
  fundamentals: 'Revenue and earnings trend from SEC filings',
  insider: 'What company insiders are doing with their own shares',
  growth: 'How fast earnings are expected to grow',
};

// Verdict strip — always-visible summary above the chart.
// Margin-of-safety band (Graham): where price sits vs an intrinsic-value estimate.
function marginOfSafetyHtml(s) {
  const m = s.marginOfSafety;
  if (!m) return '';
  const cls = m.state === 'cheap' ? 'up' : m.state === 'expensive' ? 'down' : '';
  const label = m.state === 'cheap' ? 'Cheap vs fair value' : m.state === 'expensive' ? 'Expensive vs fair value' : 'Around fair value';
  const pct = Math.max(-50, Math.min(50, m.mosPct));
  const left = ((pct + 50) / 100) * 100;
  const price = s.price != null ? fmtMoney(s.price) : '—';
  return `
    <div class="mos-band ${cls}">
      <div class="mos-head"><span>${label}</span><span class="mos-pct">${m.mosPct > 0 ? '+' : ''}${m.mosPct}% vs Graham estimate</span></div>
      <div class="mos-track"><div class="mos-marker" style="left:${left.toFixed(1)}%"></div></div>
      <div class="mos-foot caption">Est. fair value ${fmtMoney(m.fairValue)} · price ${price}</div>
    </div>`;
}

function verdictStripHtml(d, s) {
  const flag = s.signalFlags?.redFlag
    ? '<div class="flag-banner">⚠ Red flag: officer departures + insider selling</div>'
    : '';
  const factors = s.score?.factors?.length
    ? `<div class="score-factors">${s.score.factors.map(f => {
        const cls = f.score > 0 ? 'up' : f.score < 0 ? 'down' : 'mid';
        const label = f.score > 0 ? '+' + f.score : f.score;
        const tip = FACTOR_TITLES[f.key] || '';
        return `<span class="score-factor"${tip ? ` title="${tip}"` : ''}><span class="dot ${cls}"></span>${f.label} ${label}</span>`;
      }).join('')}</div>`
    : '';
  const cov = s.score?.coverage;
  const conf = cov != null && cov < 1
    ? `<div class="caption confidence-note">Based on ${s.score.factors?.length || 0} of 4 data sources (${Math.round(cov * 100)}% coverage) — treat the score as provisional when coverage is low.</div>`
    : '';
  return `
    <div class="verdict-strip" data-lens="${currentLens()}">
      ${flag}
      <div class="verdict-top">
        <div id="verdict-dial">${scoreDialHtml(primaryScore(s))}</div>
        <div class="verdict-narrative">
          ${plainForLens(d, s) ? `<p class="verdict-plain" id="verdict-plain">${plainForLens(d, s)}</p>` : ''}
          <div id="quality-vs-noise">${qualityVsNoiseHtml(s)}</div>
          ${narrativeBreathHtml(s)}
        </div>
      </div>
      ${factors}
      ${marginOfSafetyHtml(s)}
      ${conf}
      <div class="caption disclaimer">Research context, not a trade trigger. The verdict blends fundamentals only; options &amp; retail flow are shown separately as risk.</div>
    </div>`;
}

// ---------- narrative ----------
const NARRATIVE_PERSONAS = {
  summary: { label: 'Overview', blurb: 'Balanced overview' },
  buffett: { label: 'Buffett', blurb: 'Moat · owner earnings · 10-year view' },
  munger: { label: 'Munger', blurb: 'Invert · incentives · psychology' },
  graham: { label: 'Graham', blurb: 'Margin of safety · balance sheet' },
  lynch: { label: 'Lynch', blurb: 'The story · PEG · growth at a fair price' },
  fisher: { label: 'Fisher', blurb: 'Business & management quality · patience' },
  templeton: { label: 'Templeton', blurb: 'Contrarian bargains · maximum pessimism' },
};

function narrativeBreathHtml(s) {
  if (!s.narrative?.available || !s.narrative.text) return '';
  const personas = s.narrative.personas || {};
  const text = s.narrative.text;
  const cutAt = text.lastIndexOf('. ', 180);
  const breath = cutAt > 50 ? text.substring(0, cutAt + 1) : text.substring(0, 180) + '…';
  const full = text;

  const pills = Object.keys(NARRATIVE_PERSONAS).map(k => {
    const has = k === 'summary' ? true : !!personas[k];
    if (!has) return '';
    const p = NARRATIVE_PERSONAS[k];
    return `<button class="persona-pill${k === 'summary' ? ' active' : ''}" data-persona="${k}" data-full="${encodeURIComponent(k === 'summary' ? full : personas[k])}" title="${p.blurb}">${p.label}</button>`;
  }).join('');

  return `
    <div class="narrative-breath">
      ${pills ? `<div class="persona-row">${pills}</div>` : ''}
      <span class="breath-text">${breath}</span>
      ${breath !== full ? `<span class="more" data-full="${encodeURIComponent(full)}">read more</span>` : ''}
      <div class="caption mt-1">AI-generated · not investment advice</div>
    </div>`;
}

// ---------- copy verdict ----------
function copyVerdictHtml(d, s) {
  const price = d.price != null ? fmtMoney(d.price) : '';
  const chg = d.changePercent != null ? fmtPct(d.changePercent) : '';
  const grade = s.score?.label?.replace(/_/g, ' ') || 'unknown';
  const scoreVal = s.score?.value ?? 0;
  const text = `${d.symbol} ${price} (${chg}) · Verdict: ${grade} (${scoreVal > 0 ? '+' : ''}${scoreVal})`;
  return `<button class="copy-btn" data-copy="${encodeURIComponent(text)}" title="Copy verdict">${ICONS.copy} Copy verdict</button>`;
}

// ---------- lens switch (single Investor/Trader control) ----------
function currentLens() {
  try { return localStorage.getItem('if_lens') === 'trader' ? 'trader' : 'investor'; } catch { return 'investor'; }
}
function lensSwitchHtml() {
  const lens = currentLens();
  const inv = lens === 'investor' ? 'active' : '';
  const tr = lens === 'trader' ? 'active' : '';
  return `
    <div class="lens-switch" role="tablist" aria-label="View lens">
      <button class="lens-pill ${inv}" data-lens="investor" role="tab" aria-selected="${lens === 'investor'}">Investor</button>
      <button class="lens-pill ${tr}" data-lens="trader" role="tab" aria-selected="${lens === 'trader'}">Trader</button>
      <span class="lens-hint caption">${lens === 'trader' ? 'Short-term market bets &amp; options' : 'Long-term business quality'}</span>
    </div>`;
}

// Truncate a narrative to a plain-English preview with a consistent "read more".
function truncate180(t) {
  if (!t) return '';
  const cutAt = t.lastIndexOf('. ', 180);
  return cutAt > 50 ? t.substring(0, cutAt + 1) : t.substring(0, 180) + '…';
}

// The lens swaps which "primary" score drives the verdict strip.
function primaryScore(s) {
  return (currentLens() === 'trader' && s.marketPulse) ? s.marketPulse : s.score;
}
function traderPlainSentence(s) {
  const m = s.marketPulse;
  if (!m) return '';
  const v = m.value;
  if (v >= 10) return 'Short-term crowd is leaning bullish — options flow and momentum favor buyers right now.';
  if (v <= -10) return 'Short-term crowd is leaning bearish — options flow and momentum favor sellers right now.';
  return 'Short-term signals are balanced — no clear crowd bias either way.';
}
function plainForLens(d, s) {
  return currentLens() === 'trader' ? traderPlainSentence(s) : plainVerdictSentence(d, s);
}

// Pro mode — a persisted preference that auto-expands every "Why / the numbers"
// block so experienced users don't click each one open.
function proMode() {
  try { return localStorage.getItem('if_pro') === '1'; } catch { return false; }
}
function applyProMode(c) {
  const on = proMode();
  c.querySelectorAll('.raw-details').forEach(el => { el.open = on; });
}

// ---------- persistent side rail (sticky on desktop) ----------
function railGradeHtml(s) {
  const sc = primaryScore(s);
  if (!sc || !sc.factors?.length) return '<span class="muted">Not enough data</span>';
  const v = sc.value;
  const cls = v >= 10 ? 'up' : v > -10 ? 'mid' : 'down';
  const label = (sc.label || sc.grade || 'neutral').replace(/_/g, ' ');
  return `<div class="rail-grade-val ${cls}">${v > 0 ? '+' : ''}${v}</div><div class="rail-grade-label">${label}</div>`;
}
function railHtml(d, s) {
  return `
    <div class="rail-card">
      <div class="rail-price">${fmtMoney(d.price)} <span class="change ${chgClass(d.changePercent)}">${fmtPct(d.changePercent)}</span></div>
      <div class="rail-grade" id="rail-grade">${railGradeHtml(s)}</div>
      ${lensSwitchHtml()}
      <button class="pro-toggle${proMode() ? ' active' : ''}" id="pro-toggle" type="button" aria-pressed="${proMode()}">Pro · show numbers</button>
      <div class="rail-copy">${copyVerdictHtml(d, s)}</div>
      <div class="caption rail-note">Verdict stays in view as you scroll.</div>
    </div>`;
}

// ---------- hero ----------
function heroHtml(d, s) {
  return `
    <div class="detail-hero">
      <div class="detail-hero-left">
        <div class="ticker">${d.symbol}</div>
        <div class="name">${d.name || ''} · ${d.exchange || ''}</div>
      </div>
      <div class="detail-hero-right">
        <div class="price">${fmtMoney(d.price)}</div>
        <div class="change ${chgClass(d.changePercent)}">${fmtPct(d.changePercent)}</div>
      </div>
    </div>`;
}

// ---------- chart ----------
const RANGE_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1Y': 365, 'ALL': Infinity };
function sliceSeriesByRange(chart, range) {
  // ALL uses the full-history series (range=max, quarterly-sampled by Yahoo).
  // Short ranges are sliced from the dense 2y daily series so they don't end up
  // with just 1-4 points.
  if (range === 'ALL') return (chart && chart.history && chart.history.length) ? chart.history : (chart?.series || []);
  const full = (chart && chart.series) || [];
  const days = RANGE_DAYS[range];
  if (days === undefined || days === Infinity) return full;
  const cutoff = Date.now() - days * 86400000;
  const sliced = full.filter(p => p.t * 1000 >= cutoff);
  return sliced.length ? sliced : full;
}

function drawChart(chart, range, indicators) {
  const canvas = $('#detail-canvas');
  if (!canvas) return;
  const series = sliceSeriesByRange(chart, range);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!series.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillText('No chart data', 16, h / 2);
    return;
  }

  // Align SMA overlay arrays to the sliced series by timestamp.
  // The SMA arrays are computed from the dense 2y daily series. On the ALL
  // range we draw the quarterly max-history series whose timestamps don't match
  // the daily array — overlays would render misaligned, so skip them there
  // (unless max-history fell back to the daily series, in which case they align).
  const overlaysOn = range !== 'ALL' || !chart?.history || chart.history === chart.series;
  function alignByTime(full, indArray) {
    const byT = new Map();
    for (let i = 0; i < full.length; i++) byT.set(full[i].t, indArray[i]);
    return series.map(p => byT.get(p.t) ?? null);
  }
  const sma50Full = overlaysOn ? indicators?.sma50 || null : null;
  const sma200Full = overlaysOn ? indicators?.sma200 || null : null;
  const sma50 = sma50Full ? alignByTime(chart.series || [], sma50Full) : null;
  const sma200 = sma200Full ? alignByTime(chart.series || [], sma200Full) : null;

  const prices = series.map(s => s.c);
  const indVals = [sma50, sma200].flat().filter(v => v != null);
  const min = Math.min(...prices, ...(indVals.length ? indVals : [Infinity]));
  const max = Math.max(...prices, ...(indVals.length ? indVals : [-Infinity]));
  const range2 = max - min || 1;
  const pad = { top: 12, right: 16, bottom: 24, left: 16 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const x = (i) => pad.left + (i / (series.length - 1)) * plotW;
  const y = (v) => pad.top + plotH - ((v - min) / range2) * plotH;

  const up = prices[prices.length - 1] >= prices[0];
  const strokeColor = up ? getComputedStyle(document.documentElement).getPropertyValue('--up').trim() : getComputedStyle(document.documentElement).getPropertyValue('--down').trim();
  const fillColor = up ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)';

  // gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, 'transparent');

  // animate: draw progressively (skip for large series to avoid stutter)
  const totalPts = series.length;
  const animate = totalPts <= 1500;
  let drawn = animate ? 0 : totalPts;

  function frame() {
    if (animate) {
      drawn += Math.max(1, Math.floor(totalPts / 20));
      if (drawn > totalPts) drawn = totalPts;
    }
    ctx.clearRect(0, 0, w, h);

    // fill area
    ctx.beginPath();
    ctx.moveTo(x(0), y(prices[0]));
    for (let i = 1; i < drawn; i++) ctx.lineTo(x(i), y(prices[i]));
    ctx.lineTo(x(drawn - 1), h - pad.bottom);
    ctx.lineTo(x(0), h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // stroke line
    ctx.beginPath();
    ctx.moveTo(x(0), y(prices[0]));
    for (let i = 1; i < drawn; i++) ctx.lineTo(x(i), y(prices[i]));
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = strokeColor;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // SMA overlays (SMA50 = amber, SMA200 = violet), drawn over the same X axis.
    function overlay(arr, color) {
      if (!arr) return;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < drawn; i++) {
        const v = arr[i];
        if (v == null) { started = false; continue; }
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
        else ctx.lineTo(x(i), y(v));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    overlay(sma50, 'rgba(250,204,21,0.85)');
    overlay(sma200, 'rgba(167,139,250,0.85)');

    // price labels
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtMoney(max), w - 4, pad.top + 10);
    ctx.fillText(fmtMoney(min), w - 4, h - pad.bottom - 4);

    // hover dot (at end if no hover)
    if (drawn === totalPts) {
      const lastX = x(totalPts - 1);
      const lastY = y(prices[totalPts - 1]);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (animate && drawn < totalPts) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // hover tooltip
  const tooltip = canvas.parentElement?.querySelector('.chart-tooltip');
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const idx = Math.round(((mx - pad.left) / plotW) * (totalPts - 1));
    if (idx < 0 || idx >= totalPts) { if (tooltip) tooltip.classList.remove('show'); return; }
    const pt = series[idx];
    if (tooltip) {
      tooltip.innerHTML = `<div class="chart-tip-price">${fmtMoney(pt.c)}</div><div class="caption">${pt.d || ''}</div>`;
      tooltip.classList.add('show');
      tooltip.style.left = Math.min(mx + 12, w - 120) + 'px';
      tooltip.style.top = '8px';
    }
  };
  canvas.onmouseleave = () => { if (tooltip) tooltip.classList.remove('show'); };
}

function chartHtml(d) {
  const ranges = ['1M', '3M', '6M', '1Y', 'ALL'];
  const lat = d?.indicators?.latest || {};
  let indHtml = '';
  if (lat.rsi14 != null || lat.sma50 != null || lat.sma200 != null) {
    const rsiCls = lat.rsi14 != null ? (lat.rsi14 >= 70 ? 'warn' : lat.rsi14 <= 30 ? 'up' : '') : '';
    const rsiLabel = lat.rsi14 != null
      ? (lat.rsi14 >= 70 ? 'overbought' : lat.rsi14 <= 30 ? 'oversold' : 'neutral')
      : '';
    const rsiTip = lat.rsi14 != null
      ? (lat.rsi14 >= 70 ? 'RSI 70+ suggests buyers may be exhausted' : lat.rsi14 <= 30 ? 'RSI 30− suggests sellers may be exhausted' : 'RSI near 50 means balanced momentum')
      : '';
    indHtml = `<div class="chart-indicators">` +
      (lat.rsi14 != null ? `<span class="chip ${rsiCls}" title="${rsiTip}">RSI ${Math.round(lat.rsi14)} ${rsiLabel}</span>` : '') +
      (lat.sma50 != null ? `<span class="chip" title="50-day average — the recent trend">SMA50 ${fmtMoney(lat.sma50)}</span>` : '') +
      (lat.sma200 != null ? `<span class="chip" title="200-day average — the long-term trend">SMA200 ${fmtMoney(lat.sma200)}</span>` : '') +
      `</div>`;
  }
  return `
    <div class="chart-wrap">
      <canvas id="detail-canvas" role="img" aria-label="Price history chart for ${d.symbol || ''}"></canvas>
      <div class="chart-tooltip"></div>
      ${indHtml}
      <div class="chart-range">
        ${ranges.map(r => `<button class="chart-range-btn${r === '1Y' ? ' active' : ''}" data-range="${r}">${r}</button>`).join('')}
      </div>
      <div class="trader-overlay" id="trader-overlay" hidden></div>
    </div>`;
}

// ---------- section accordion ----------
function sectionHtml(id, title, content, open) {
  return `
    <div class="story-section${open ? ' open' : ''}" data-section="${id}">
      <button class="story-toggle" aria-expanded="${open}">
        <span>${title}</span>
        <span class="chevron">${ICONS.chevron}</span>
      </button>
      <div class="story-body">${content}</div>
    </div>`;
}

// ---------- signal section content ----------
// Plain-English-first pattern: one takeaway sentence + colored chips, with raw
// numbers tucked behind a "Why / the numbers" expander so novices aren't buried
// in jargon.
function insightHtml({ sentence, chips, details }) {
  const chipHtml = chips?.length
    ? `<div class="insight-chips">${chips.map(c => `<span class="chip ${c.cls || ''}">${c.text}</span>`).join('')}</div>`
    : '';
  const detailsHtml = details
    ? `<details class="raw-details"${proMode() ? ' open' : ''}><summary>Why / the numbers</summary><div class="signal-grid mt-2">${details}</div></details>`
    : '';
  return `<div class="insight">${sentence ? `<p class="insight-text">${sentence}</p>` : ''}${chipHtml}${detailsHtml}</div>`;
}

// The Business — "what do they do?" (Lynch: explain it to your grandmother)
function businessContent(d, s) {
  const parts = [];
  const name = d.name || s.name || '';
  if (name) parts.push(name);
  const sector = d.sector || s.sector || null;
  const industry = d.industry || s.industry || null;
  if (sector && industry && sector.toLowerCase() !== industry.toLowerCase()) parts.push(`${sector} — ${industry}`);
  else if (sector) parts.push(sector);
  const cap = d.marketCap ?? null;
  if (cap != null) parts.push(`worth ${fmtCap(cap)}`);

  let sentence = 'No company profile available.';
  if (parts.length) sentence = `${parts.join(' · ')}.`;
  const chips = [];
  if (cap != null) chips.push({ text: fmtCap(cap) });
  const details = [];
  if (d.exchange) details.push(`<div><span>Exchange</span><span>${d.exchange}</span></div>`);
  if (d.type) details.push(`<div><span>Type</span><span>${d.type}</span></div>`);
  return insightHtml({ sentence, chips, details: details.length ? details.join('') : null });
}

// Quality — "is it a good business?" (Buffett: moat, returns, debt)
function qualityContent(s) {
  const v = s.value;
  if (!v) return '<p class="muted">Fundamentals unavailable.</p>';
  const roe = v.roe;
  const debtEq = v.debtToEquity;
  const curRatio = v.currentRatio;
  const gross = v.grossMargin;
  const profit = v.profitMargin;

  let take = '';
  const chips = [];
  if (roe != null) {
    const r = roe * 100;
    if (r >= 15) { take += 'A strong business — earns well on shareholder money.'; chips.push({ text: `ROE ${r.toFixed(1)}%`, cls: 'up' }); }
    else if (r >= 10) { take += 'A solid business — decent returns on shareholder money.'; chips.push({ text: `ROE ${r.toFixed(1)}%`, cls: 'up' }); }
    else { take += 'A weak business — returns on shareholder money are thin.'; chips.push({ text: `ROE ${r.toFixed(1)}%`, cls: 'down' }); }
  }
  if (debtEq != null) {
    if (debtEq < 1) take += ' It keeps debt low.'; else if (debtEq < 2) take += ' Debt is moderate.'; else take += ' Debt is high — watch it.';
    chips.push({ text: `Debt/equity ${debtEq.toFixed(2)}`, cls: debtEq < 1 ? 'up' : debtEq < 2 ? '' : 'down' });
  }
  if (take === '') take = 'Business quality data is thin.';

  const details = [];
  if (gross != null) details.push(`<div><span>Gross margin</span><span>${(gross * 100).toFixed(1)}%</span></div>`);
  if (profit != null) details.push(`<div><span>Net margin</span><span>${(profit * 100).toFixed(1)}%</span></div>`);
  if (roe != null) details.push(`<div><span>Return on equity</span><span>${(roe * 100).toFixed(1)}%</span></div>`);
  if (v.roa != null) details.push(`<div><span>Return on assets</span><span>${(v.roa * 100).toFixed(1)}%</span></div>`);
  if (debtEq != null) details.push(`<div><span>Debt / equity</span><span>${debtEq.toFixed(2)}</span></div>`);
  if (curRatio != null) details.push(`<div><span>Current ratio</span><span>${curRatio.toFixed(2)}</span></div>`);
  if (v.fcfYield != null) details.push(`<div><span>Free cash-flow yield</span><span>${v.fcfYield}%</span></div>`);

  return insightHtml({ sentence: take, chips, details: details.length ? details.join('') : null });
}

// Growth — "is it growing, and is the price fair for that growth?" (Lynch)
function growthContent(s) {
  const x = s.xbrl;
  const v = s.value;
  const chips = [];
  const details = [];
  let take = 'Growth data is thin.';

  if (x?.available && x.revenue?.latest != null) {
    details.push(`<div><span>Revenue (${x.latestFY || ''})</span><span>${fmtMoney(x.revenue.latest)}</span></div>`);
    const avgG = x.revenue.growth?.length
      ? (x.revenue.growth.reduce((a, g) => a + g.growth, 0) / x.revenue.growth.length).toFixed(1)
      : null;
    if (avgG != null) details.push(`<div><span>Avg revenue growth</span><span class="${avgG >= 0 ? 'up' : 'down'}">${avgG}%</span></div>`);
    if (x.netIncome?.latest != null) details.push(`<div><span>Net income (${x.latestFY || ''})</span><span>${fmtMoney(x.netIncome.latest)}</span></div>`);
  }

  const beatStreak = s.earnings?.available ? s.earnings.beatStreak ?? 0 : 0;
  if (beatStreak > 0) { take = `Earnings have beaten estimates ${beatStreak} quarters in a row.`; chips.push({ text: `${beatStreak}-qtr beat streak`, cls: 'up' }); }

  if (v?.peg != null) {
    if (v.peg < 1) { take += ' Growth is cheap relative to the price you pay.'; chips.push({ text: `PEG ${v.peg}`, cls: 'up' }); }
    else if (v.peg < 1.5) { take += ' Growth looks reasonably priced.'; chips.push({ text: `PEG ${v.peg}` }); }
    else if (v.peg < 2) { take += ' Growth is getting pricey.'; chips.push({ text: `PEG ${v.peg}`, cls: 'warn' }); }
    else { take += ' Growth is expensive relative to the price.'; chips.push({ text: `PEG ${v.peg}`, cls: 'down' }); }
    details.push(`<div><span>PEG (price/growth)</span><span>${v.peg}</span></div>`);
  }

  if (x?.available) {
    const revT = x.revenue?.trend;
    const niT = x.netIncome?.trend;
    const revGrowing = revT === 'strong_growth' || revT === 'growing';
    const revShrinking = revT === 'declining' || revT === 'sharply_declining';
    const niGrowing = niT === 'strong_growth' || niT === 'growing';
    const niShrinking = niT === 'declining' || niT === 'sharply_declining';
    if (revGrowing) chips.push({ text: 'Revenue growing', cls: 'up' });
    else if (revShrinking) chips.push({ text: 'Revenue shrinking', cls: 'down' });
    if (niGrowing) chips.push({ text: 'Earnings growing', cls: 'up' });
    else if (niShrinking) chips.push({ text: 'Earnings shrinking', cls: 'down' });
    if (take === 'Growth data is thin.' && (revGrowing || revShrinking || niGrowing || niShrinking)) {
      take = (revGrowing || niGrowing)
        ? 'The business is growing.'
        : 'The business has been shrinking.';
    }
    if (details.length) details.push(`<div><span>Revenue trend</span><span>${x.revenue?.trendLabel || '—'}</span></div>`);
    if (x.netIncome?.latest != null) details.push(`<div><span>Net income trend</span><span>${x.netIncome.trendLabel || '—'}</span></div>`);
  }

  if (!chips.length) take = 'Growth data is thin.';
  return insightHtml({ sentence: take, chips, details: details.length ? details.join('') : null });
}

// Price vs Value — "am I paying a fair price?" (Graham/Buffett: margin of safety)
function priceContent(d, s) {
  const v = s.value;
  const a = s.analyst;
  const price = d.price ?? s.price ?? null;
  const chips = [];
  const details = [];
  let take = '';

  if (price != null) {
    const fair = v?.grahamFairValue;
    if (fair != null) {
      const gap = ((price - fair) / fair) * 100;
      if (gap <= -15) { take = `Trading about ${Math.abs(gap).toFixed(0)}% below a rough fair value of ${fmtMoney(fair)} — a margin of safety.`; chips.push({ text: `Fair value ${fmtMoney(fair)}`, cls: 'up' }); }
      else if (gap <= 15) { take = `Trading roughly at a fair value of about ${fmtMoney(fair)}.`; chips.push({ text: `Fair value ${fmtMoney(fair)}` }); }
      else { take = `Trading about ${gap.toFixed(0)}% above a rough fair value of ${fmtMoney(fair)} — little margin of safety.`; chips.push({ text: `Fair value ${fmtMoney(fair)}`, cls: 'down' }); }
      details.push(`<div><span>Graham fair value</span><span>${fmtMoney(fair)}</span></div>`);
    } else {
      take = 'A reasonable price is hard to pin down from the available data.';
    }
  }

  if (a?.available && a.targetMean != null && price != null) {
    const upside = ((a.targetMean - price) / price) * 100;
    if (upside > 10) take += ` Analysts see ${fmtMoney(a.targetMean)} (${upside >= 0 ? '+' : ''}${upside.toFixed(0)}%).`;
    chips.push({ text: `Analyst target ${fmtMoney(a.targetMean)}`, cls: upside > 5 ? 'up' : upside < -5 ? 'down' : '' });
    details.push(`<div><span>Analyst target (mean)</span><span>${fmtMoney(a.targetMean)}</span></div>`);
    if (a.numAnalysts != null) details.push(`<div><span>Coverage</span><span>${a.numAnalysts} analysts</span></div>`);
  }

  if (d.pe != null) { details.push(`<div><span>P/E (trailing)</span><span>${d.pe.toFixed(1)}</span></div>`); chips.push({ text: `P/E ${d.pe.toFixed(1)}`, cls: d.pe > 0 && d.pe < 20 ? 'up' : d.pe > 35 ? 'down' : '' }); }
  if (d.forwardPe != null) details.push(`<div><span>P/E (forward)</span><span>${d.forwardPe.toFixed(1)}</span></div>`);
  if (d.priceToBook != null) details.push(`<div><span>Price/book</span><span>${d.priceToBook.toFixed(1)}</span></div>`);
  if (v?.earningsYield != null) details.push(`<div><span>Earnings yield</span><span>${v.earningsYield}%</span></div>`);
  if (v?.fcfYield != null) { details.push(`<div><span>Free cash-flow yield</span><span>${v.fcfYield}%</span></div>`); if (v.fcfYield >= 4) chips.push({ text: `FCF yield ${v.fcfYield}%`, cls: 'up' }); }
  if (d.dividendYield != null) details.push(`<div><span>Dividend yield</span><span>${(d.dividendYield * 100).toFixed(2)}%</span></div>`);

  if (take === '') take = 'Price data is thin.';
  return insightHtml({ sentence: take, chips, details: details.length ? details.join('') : null });
}

// Watch-outs — risks, red flags, concerning trends (Munger: invert)
function watchoutsContent(d, s) {
  const items = [];
  const chips = [];
  if (s.signalFlags?.redFlag) items.push('⚠ Officer departures alongside insider selling — treat with caution.');
  const v = s.value;
  if (v?.debtToEquity != null && v.debtToEquity >= 2) { chips.push({ text: `High debt ${v.debtToEquity.toFixed(1)}x`, cls: 'down' }); items.push('Debt is high relative to equity.'); }
  const x = s.xbrl;
  if (x?.available) {
    if (x.revenue?.trend === 'declining' || x.revenue?.trend === 'sharply_declining') items.push('Revenue has been declining.');
    if (x.netIncome?.trend === 'declining' || x.netIncome?.trend === 'sharply_declining') items.push('Net income has been declining.');
  }
  if (s.shortInterest?.available && s.shortInterest.shortPercentOfFloat != null && s.shortInterest.shortPercentOfFloat > 0.15) {
    chips.push({ text: `${(s.shortInterest.shortPercentOfFloat * 100).toFixed(1)}% shorted`, cls: 'warn' });
    items.push('A lot of the float is sold short — heavy bearish positioning.');
  }

  if (!items.length && !chips.length) return '<p class="muted">No obvious red flags from the data we can see.</p>';
  const html = items.length ? `<ul class="watch-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>` : '';
  return insightHtml({ sentence: html, chips, details: null });
}

// Market noise — short-term trading signals, demoted and labeled as noise.
function marketNoiseContent(s, symbol) {
  let html = '<div class="noise-note">Trader lens — short-term market bets and crowd sentiment. Not part of the long-term verdict.</div>';

  // market pulse score (context only)
  if (s.marketPulse) {
    const m = s.marketPulse;
    const cls = m.value > 10 ? 'up' : m.value < -10 ? 'down' : '';
    html += `<div class="mt-2 mb-2"><span class="caption">Market pulse:</span> <span class="chip ${cls}">${m.value > 0 ? '+' : ''}${m.value}</span> <span class="caption">options + crowd + news, short-term</span></div>`;
  }

  // contrarian flag — extreme crowd positioning has historically been a fade
  const r = s.retail;
  const crowdBullish = r?.available && r.bullPct >= 75;
  const oSig = s.options?.signals;
  const crowdBearish = r?.available && r.bearPct >= 75;
  if (crowdBullish || crowdBearish || oSig?.sentiment === 'Bullish' || oSig?.sentiment === 'Bearish') {
    const lean = crowdBullish || oSig?.sentiment === 'Bullish' ? 'bullish' : 'bearish';
    html += `<div class="contrarian-note">The crowd is leaning hard <strong>${lean}</strong>. Crowds this one-sided have historically been a <em>fade</em> — treat as risk, not confirmation.</div>`;
  }

  // options — details only (the bell-curve overlay lives on the chart in the Trader lens)
  if (s.options?.available && s.options.signals?.available) {
    const oSig = s.options.signals;
    if (oSig.expiryDate) {
      html += `<div class="options-expiry-line caption">Options expiring <strong>${oSig.expiryDate}</strong>${oSig.dte != null ? ` · ${oSig.dte} days to expiry` : ''}</div>`;
    }
    html += optionsDetailsHtml(s.options, symbol);
  }

  // short interest
  if (s.shortInterest?.available) {
    const si = s.shortInterest;
    const rows = [];
    if (si.shortPercentOfFloat != null) {
      const pct = (si.shortPercentOfFloat * 100).toFixed(2);
      const cls = si.shortPercentOfFloat > 0.15 ? 'down' : si.shortPercentOfFloat > 0.05 ? 'warn' : 'up';
      rows.push(`<div><span>% Float Short</span><span class="${cls}">${pct}%</span></div>`);
    }
    if (si.shortRatio != null) rows.push(`<div><span>Days to cover</span><span>${si.shortRatio}</span></div>`);
    if (rows.length) html += `<h4 class="sub-tight">Short Interest</h4><div class="signal-grid">${rows.join('')}</div>`;
  }

  // retail sentiment
  if (s.retail?.available) {
    const r = s.retail;
    html += '<div class="mt-3">';
    html += `<h4 class="sub-tight">Retail Sentiment</h4>`;
    html += `<div class="sentiment-bar"><div class="sentiment-bar-fill up" style="width:${r.bullPct}%"></div><div class="sentiment-bar-fill down" style="width:${r.bearPct}%"></div></div>`;
    html += `<div class="flex-between mt-1 caption"><span class="up">Bull ${r.bullPct}%</span><span class="muted">${r.total} msgs</span><span class="down">Bear ${r.bearPct}%</span></div>`;
    html += '</div>';
  }

  return html;
}

// Probability panel — shown OPEN and FIRST (after verdict strip, before chart).
// Trader lens: bell curve + honest caption + static legend + expiry selector.
// Never feeds the long-term verdict.
function probabilityBlockHtml(o, symbol) {
  const sig = o.signals;
  if (!sig?.available) return '';
  const price = o.currentPrice;
  const bands = sig.probabilityBands;
  const dte = sig.dte;
  const moveDate = sig.expiryDate;
  const expirations = o.expirations || [];
  if (!(bands && price != null)) return '';

  const sigma = +(bands.p68.hi - price).toFixed(2);
  let html = '<div class="options-block trader-overlay-inner">';
  html += `<div class="lens-tag trader">Trader lens · probability</div>`;
  html += `<div class="options-expiry-line caption">Options expiring <strong>${moveDate || '—'}</strong>${dte != null ? ` · ${dte} days to expiry` : ''}</div>`;
  html += `<div class="prob-graph"><canvas class="prob-dist-canvas" data-price="${price}" data-sigma="${sigma}" role="img" aria-label="Probability of price at ${moveDate || 'expiry'}"></canvas></div>`;
  html += `<div class="prob-caption">The single most likely price at ${moveDate || 'expiry'} is <strong>${fmtMoney(price)}</strong> — the same as today, because a no-move outcome is the market's best guess. The curve shows the market's expected range: <strong>50%</strong> chance it lands between ${fmtMoney(bands.p50.lo)} and ${fmtMoney(bands.p50.hi)}, <strong>90%</strong> chance between ${fmtMoney(bands.p90.lo)} and ${fmtMoney(bands.p90.hi)}. This is a <em>symmetric</em> guess — real prices have fatter tails (bigger surprises than the curve implies).</div>`;

  // static legend — visible without hovering
  html += `<div class="prob-legend">`;
  html += `<span><b>50%</b> ${fmtMoney(bands.p50.lo)}–${fmtMoney(bands.p50.hi)}</span>`;
  html += `<span><b>68%</b> ${fmtMoney(bands.p68.lo)}–${fmtMoney(bands.p68.hi)}</span>`;
  html += `<span><b>90%</b> ${fmtMoney(bands.p90.lo)}–${fmtMoney(bands.p90.hi)}</span>`;
  html += `</div>`;

  // date selector — default date (30-DTE) labelled as "Monthly"
  if (expirations.length) {
    const opts = expirations.map(e => {
      const isMove = e.date === moveDate;
      const label = isMove ? `Monthly (~${dte != null ? dte + 'd' : '30d'}) — ${e.date}` : e.date;
      return `<option value="${e.date}"${isMove ? ' selected' : ''}>${label}</option>`;
    }).join('');
    html += `<div class="options-date-row"><label>Look at</label><select class="options-expiry" data-symbol="${encodeURIComponent(symbol)}">${opts}</select></div>`;
  }

  html += '</div>';
  return html;
}

// Options details (sentiment + raw jargon) — Trader lens, inside Market pulse.
function optionsDetailsHtml(o, symbol) {
  const sig = o.signals;
  if (!sig?.available) return '';
  const dte = sig.dte;
  const sentCls = sig.sentiment === 'Bullish' ? 'up' : sig.sentiment === 'Bearish' ? 'down' : '';
  const moveDate = sig.expiryDate;

  let html = '<div class="options-block" id="options-details">';
  if (sig.sentiment) {
    html += `<div class="mb-2"><span class="chip ${sentCls}">${sig.sentiment}</span> <span class="caption">as of ${moveDate || ''}${dte != null ? ' · ' + dte + 'd to expiry' : ''}</span></div>`;
  }

  // raw jargon — behind a collapsed toggle
  const rawRows = [];
  if (sig.expectedMove) rawRows.push(`<div><span>Expected move (1σ)</span><span>±${fmtMoney(sig.expectedMove.dollar)} (${sig.expectedMove.percent}%)</span></div>`);
  rawRows.push(`<div><span>Calls / Puts</span><span>${sig.callsCount} / ${sig.putsCount}</span></div>`);
  rawRows.push(`<div><span>Put/Call ratio</span><span>${sig.pcRatioVol?.toFixed(3) ?? '—'}</span></div>`);
  if (sig.maxPain != null) {
    const mpNote = dte != null ? ` · ${dte}d to expiry` : '';
    rawRows.push(`<div><span>Max pain (expiry magnet)</span><span>${fmtMoney(sig.maxPain)}<span class="caption"> ${mpNote}</span></span></div>`);
  }
  if (sig.support) rawRows.push(`<div><span>Support wall (OI)</span><span>${fmtMoney(sig.support.strike)}</span></div>`);
  if (sig.resistance) rawRows.push(`<div><span>Resistance wall (OI)</span><span>${fmtMoney(sig.resistance.strike)}</span></div>`);
  if (sig.avgIV != null) rawRows.push(`<div><span>Avg IV</span><span>${(sig.avgIV * 100).toFixed(1)}%</span></div>`);
  if (sig.nearMoneyIV != null) rawRows.push(`<div><span>ATM IV</span><span>${(sig.nearMoneyIV * 100).toFixed(1)}%</span></div>`);
  if (sig.unusual?.length) {
    rawRows.push(`<div class="grid-full">Unusual volume</div>`);
    sig.unusual.slice(0, 3).forEach(u => rawRows.push(`<div><span>${u.type} @ ${fmtMoney(u.strike)}</span><span>vol ${fmtNum(u.vol)} · OI ${fmtNum(u.oi)}</span></div>`));
  }
  if (rawRows.length) {
    html += `<details class="raw-details"${proMode() ? ' open' : ''}><summary>Details for the curious</summary><div class="signal-grid mt-2">${rawRows.join('')}</div></details>`;
  }

  html += '</div>';
  return html;
}

// Bell-curve probability distribution centered on today's price.
function drawProbabilityDistribution(canvas) {
  if (!canvas) return;
  const price = parseFloat(canvas.dataset.price);
  const sigma = parseFloat(canvas.dataset.sigma);
  if (!(price > 0) || !(sigma > 0)) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320;
  const h = 150;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = { top: 30, right: 12, bottom: 30, left: 12 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const lo = price - 4 * sigma;
  const hi = price + 4 * sigma;
  const xOf = (v) => pad.left + ((v - lo) / (hi - lo)) * plotW;
  const norm = (v) => (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-((v - price) ** 2) / (2 * sigma * sigma));
  const maxY = norm(price);
  const yOf = (v) => pad.top + plotH - (norm(v) / maxY) * plotH;
  const baseY = pad.top + plotH;

  function shade(a, b, color) {
    ctx.beginPath();
    ctx.moveTo(xOf(a), baseY);
    for (let v = a; v <= b; v += (b - a) / 40) ctx.lineTo(xOf(v), yOf(v));
    ctx.lineTo(xOf(b), baseY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // shaded bands
  shade(price - 1.645 * sigma, price + 1.645 * sigma, 'rgba(96,165,250,0.18)');
  shade(price - 0.674 * sigma, price + 0.674 * sigma, 'rgba(96,165,250,0.34)');

  // full curve fill + stroke
  ctx.beginPath();
  ctx.moveTo(xOf(lo), baseY);
  for (let v = lo; v <= hi; v += (hi - lo) / 120) ctx.lineTo(xOf(v), yOf(v));
  ctx.lineTo(xOf(hi), baseY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(96,165,250,0.08)';
  ctx.fill();
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#60a5fa';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // center line
  ctx.strokeStyle = 'rgba(148,163,184,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(xOf(price), pad.top);
  ctx.lineTo(xOf(price), baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // labels
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  ctx.textAlign = 'center';

  // peak marker — most likely price (= today's price; single best guess = no move)
  const peakX = xOf(price);
  const peakY = yOf(price);
  ctx.fillStyle = muted;
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.fillText('Most likely', peakX, pad.top - 2);
  ctx.fillText(fmtMoney(price), peakX, pad.top + 10);
  ctx.beginPath();
  ctx.arc(peakX, peakY, 3, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#60a5fa';
  ctx.fill();

  // band edge labels along the baseline
  ctx.fillStyle = muted;
  ctx.font = '10px -apple-system, sans-serif';
  const edgeLabels = [
    { z: 0.674, label: '50%' },
    { z: 0.842, label: '60%' },
    { z: 1.036, label: '70%' },
    { z: 1.282, label: '80%' },
    { z: 1.645, label: '90%' },
  ];
  edgeLabels.forEach(({ z, label }) => {
    ctx.fillText(label, xOf(price - z * sigma), baseY + 14);
    ctx.fillText(label, xOf(price + z * sigma), baseY + 14);
  });

  // hover: show price at cursor + chance of landing inside ±|that z| band
  if (!canvas.dataset.hoverBound) {
    canvas.dataset.hoverBound = '1';
    const tip = document.createElement('div');
    tip.className = 'prob-tooltip';
    const graph = canvas.closest('.prob-graph');
    graph.appendChild(tip);

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const v = lo + ((e.clientX - rect.left - pad.left) / plotW) * (hi - lo);
      const z = Math.abs(v - price) / sigma;
      const pct = Math.min(99, Math.round(erf(z / Math.SQRT2) * 100));
      tip.textContent = `${fmtMoney(v)} · ±${pct}% chance`;
      const x = Math.min(Math.max(e.clientX - rect.left - tip.offsetWidth / 2, 2), rect.width - tip.offsetWidth - 2);
      tip.style.left = x + 'px';
      tip.style.top = Math.max(e.clientY - rect.top - tip.offsetHeight - 8, 2) + 'px';
      tip.classList.add('show');
      canvas.style.cursor = 'crosshair';
    });
    canvas.addEventListener('mouseleave', () => {
      tip.classList.remove('show');
      canvas.style.cursor = '';
    });
  }
}

// Standard normal CDF via erf (Abramowitz-Stegun 7.1.26 approximation).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

function ownershipContent(s) {
  const blocks = [];

  // insider trades
  if (s.insiderAvailable && s.insiderTrades?.length) {
    const trades = s.insiderTrades;
    let netShares = 0;
    for (const t of trades) {
      if (t.code === 'P') netShares += t.shares || 0;
      else if (t.code === 'S') netShares -= t.shares || 0;
    }
    const netLabel = netShares >= 0 ? `net bought ${fmtNum(netShares)}` : `net sold ${fmtNum(-netShares)}`;
    const netCls = netShares >= 0 ? 'up' : 'down';
    const rows = trades.slice(0, 5).map(t => {
      const cls = t.code === 'P' ? 'up' : t.code === 'S' ? 'down' : '';
      return `<tr><td>${t.date || '—'}</td><td>${t.insider || '—'}</td><td class="${cls}">${t.code || '—'}</td><td>${t.shares != null ? fmtNum(t.shares) : '—'}</td><td>${t.total != null ? fmtMoney(t.total) : '—'}</td></tr>`;
    }).join('');
    blocks.push(`
      <div class="caption mb-2"><span class="${netCls}">${netLabel}</span> · ${trades.length} transaction(s)</div>
      <div class="table-wrap"><table class="insider-table"><thead><tr><th>Date</th><th>Insider</th><th>Code</th><th>Shares</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }

  // leadership
  if (s.leadership?.available && s.leadership.changes?.length) {
    const changes = s.leadership.changes.map(c => {
      const names = (c.names || []).join(', ') || '—';
      return `<div class="lead-row"><span class="muted">${c.date || ''}</span> ${c.kind || ''} · ${names}</div>`;
    }).join('');
    blocks.push(`<h4 class="sub-tight">Leadership Changes</h4>${changes}`);
  }

  // hiring
  if (s.hiring?.available) {
    const h = s.hiring;
    let grid = `<div class="signal-grid"><div><span>Open jobs</span><span>${h.openJobs}</span></div>`;
    if (h.earliestOpening) grid += `<div><span>Earliest</span><span>${h.earliestOpening}</span></div>`;
    grid += '</div>';
    blocks.push(`<h4 class="sub-tight">Hiring</h4>${grid}`);
  }

  if (!blocks.length) return '<p class="muted">No ownership or leadership data available.</p>';
  return blocks.map((b, i) => i ? `<div class="mt-4">${b}</div>` : b).join('');
}

function newsContent(d) {
  if (!d.news?.length) return '<p class="muted">No headlines available.</p>';
  const items = d.news.slice(0, 6).map(n =>
    `<li><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>${n.pubDate ? ` <span class="date">${new Date(n.pubDate).toLocaleDateString()}</span>` : ''}</li>`
  ).join('');
  return `<ul class="news-list">${items}</ul>`;
}

// ---------- main renderers ----------
function renderDetailFast(c, d, symbol) {
  c.innerHTML = `<div class="detail-layout"><div class="detail-main">${heroHtml(d, '')}${chartHtml(d)}</div><aside class="detail-rail" id="detail-rail"></aside></div>`;
  drawChart(d.chart, '1Y', d.indicators);

  // init section accordion (story)
  const main = c.querySelector('.detail-main');
  const story = document.createElement('div');
  story.className = 'story-sections';
  story.id = 'story-sections';
  story.innerHTML = '<div class="loading-skeleton muted" style="padding:16px 0;font-size:13px;">Loading analysis…</div>';
  main.appendChild(story);

  // attach chart range handlers
  c.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      c.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawChart(d.chart, btn.dataset.range, d.indicators);
    });
  });
}

function renderSignals(c, d, s) {
  const story = $('#story-sections') || c;

  // build all section content
  const sections = [
    { id: 'business', title: 'The Business', content: businessContent(d, s), open: true },
    { id: 'quality', title: 'Quality', content: qualityContent(s), open: false },
    { id: 'growth', title: 'Growth', content: growthContent(s), open: false },
    { id: 'price', title: 'Price vs Value', content: priceContent(d, s), open: false },
    { id: 'ownership', title: 'Ownership', content: ownershipContent(s), open: false },
    { id: 'watchouts', title: 'Watch-outs', content: watchoutsContent(d, s), open: false },
    { id: 'news', title: 'News', content: newsContent(d), open: false },
    { id: 'noise', title: 'Market pulse (short-term) · Trader lens', content: marketNoiseContent(s, d.symbol), open: false },
  ].filter(sec => sec.content.trim() !== '');

  // always-visible verdict strip (dial + factors + Quality-vs-Noise + narrative)
  const heroEl = c.querySelector('.detail-hero');
  if (heroEl && !c.querySelector('.verdict-strip')) {
    heroEl.insertAdjacentHTML('afterend', verdictStripHtml(d, s));
  }

  // persistent side rail (sticky on desktop): glance summary + controls
  const rail = c.querySelector('#detail-rail');
  if (rail) rail.innerHTML = railHtml(d, s);

  // Trader overlay — lives in the chart zone (Zone B), hidden in Investor lens.
  const overlay = c.querySelector('#trader-overlay');
  if (overlay) {
    const probHtml = probabilityBlockHtml(s.options, d.symbol, d);
    overlay.innerHTML = probHtml;
    const hasProb = !!overlay.querySelector('.prob-dist-canvas');
    if (currentLens() === 'trader' && hasProb) {
      overlay.hidden = false;
      const pc = overlay.querySelector('.prob-dist-canvas');
      if (pc) requestAnimationFrame(() => drawProbabilityDistribution(pc));
    } else {
      overlay.hidden = true;
    }
  }

  // render sections
  story.innerHTML = sections.map(sec => sectionHtml(sec.id, sec.title, sec.content, sec.open)).join('');

  // accordion behavior: one open at a time
  story.querySelectorAll('.story-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.story-section');
      const isOpen = section.classList.contains('open');
      if (!isOpen) story.querySelectorAll('.story-section').forEach(x => x.classList.remove('open'));
      section.classList.toggle('open', !isOpen);
      btn.setAttribute('aria-expanded', !isOpen);
      if (!isOpen) {
        const cv = section.querySelector('.prob-dist-canvas');
        if (cv) requestAnimationFrame(() => drawProbabilityDistribution(cv));
      }
    });
  });

  // copy verdict
  c.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = decodeURIComponent(btn.dataset.copy);
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '✓ Copied';
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = ICONS.copy + ' Copy verdict'; }, 2000);
      }).catch(() => { /* clipboard unavailable (e.g. non-secure context) — ignore */ });
    });
  });

  // persona switcher — swap narrative text without a network call; keep a
  // consistent "read more" affordance on every persona (plain-English-first).
  c.querySelectorAll('.persona-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const row = pill.closest('.persona-row');
      const breathEl = pill.closest('.narrative-breath');
      if (row) row.querySelectorAll('.persona-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      if (breathEl) {
        const full = decodeURIComponent(pill.dataset.full);
        const textEl = breathEl.querySelector('.breath-text');
        if (textEl) textEl.textContent = truncate180(full);
        let more = breathEl.querySelector('.more');
        if (!more) {
          more = document.createElement('span');
          more.className = 'more';
          breathEl.appendChild(more);
        }
        more.dataset.full = pill.dataset.full;
        more.textContent = 'read more';
      }
    });
  });

  // delegated "read more" — survives persona switches (re-added spans)
  c.querySelectorAll('.narrative-breath').forEach(breath => {
    breath.addEventListener('click', (e) => {
      const more = e.target.closest('.more');
      if (!more) return;
      const textEl = breath.querySelector('.breath-text');
      if (textEl) textEl.textContent = decodeURIComponent(more.dataset.full);
      more.remove();
    });
  });

  // sticky section nav (covers Verdict · Chart · all accordion sections)
  initDetailNav(c);

  // single lens switcher — Investor (default) vs Trader reshapes the whole view
  c.querySelectorAll('.lens-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      c.querySelectorAll('.lens-pill').forEach(p => { p.classList.remove('active'); p.setAttribute('aria-selected', 'false'); });
      pill.classList.add('active');
      pill.setAttribute('aria-selected', 'true');
      const lens = pill.dataset.lens;
      try { localStorage.setItem('if_lens', lens); } catch { /* ignore */ }
      const hint = c.querySelector('.lens-hint');
      if (hint) hint.innerHTML = lens === 'trader' ? 'Short-term market bets &amp; options' : 'Long-term business quality';
      applyLens(c, d, s);
    });
  });

  // Pro toggle — persist and live-apply to all "Why / the numbers" blocks
  const proBtn = c.querySelector('#pro-toggle');
  if (proBtn) {
    proBtn.addEventListener('click', () => {
      const on = !proMode();
      try { localStorage.setItem('if_pro', on ? '1' : '0'); } catch { /* ignore */ }
      proBtn.classList.toggle('active', on);
      proBtn.setAttribute('aria-pressed', String(on));
      applyProMode(c);
    });
  }

  // sync the page to the persisted lens on first paint
  applyLens(c, d, s);
  applyProMode(c);
}

// Sticky jump-pill nav for the whole detail page; scroll-spies via IntersectionObserver.
function initDetailNav(c) {
  const story = c.querySelector('#story-sections');
  if (!story) return;
  const sections = [...story.querySelectorAll('.story-section')];
  if (!sections.length) return;
  if (c.querySelector('.detail-nav')) return;

  const nav = document.createElement('div');
  nav.className = 'detail-nav';

  const items = [];
  const spyTargets = [];

  function addTop(cls, label) {
    const target = c.querySelector(cls);
    if (!target) return;
    const pill = document.createElement('button');
    pill.className = 'detail-nav-pill';
    pill.dataset.target = cls;
    pill.textContent = label;
    pill.addEventListener('click', () => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    nav.appendChild(pill);
    items.push({ pill, sec: target });
    spyTargets.push(target);
  }
  addTop('.verdict-strip', 'Verdict');
  addTop('.chart-wrap', 'Chart');

  sections.forEach(sec => {
    const titleEl = sec.querySelector('.story-toggle span');
    const title = titleEl ? titleEl.textContent.trim() : (sec.dataset.section || '');
    const pill = document.createElement('button');
    pill.className = 'detail-nav-pill';
    pill.dataset.target = sec.dataset.section;
    pill.textContent = title;
    pill.addEventListener('click', () => {
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!sec.classList.contains('open')) {
        story.querySelectorAll('.story-section').forEach(x => x.classList.remove('open'));
        sec.classList.add('open');
        const btn = sec.querySelector('.story-toggle');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        const cv = sec.querySelector('.prob-dist-canvas');
        if (cv) requestAnimationFrame(() => drawProbabilityDistribution(cv));
      }
    });
    nav.appendChild(pill);
    items.push({ pill, sec });
    spyTargets.push(sec);
  });

  const heroEl = c.querySelector('.detail-hero');
  if (heroEl) heroEl.after(nav);
  else c.prepend(nav);

  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) items.forEach(({ pill, sec }) => pill.classList.toggle('active', sec === en.target));
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    spyTargets.forEach(t => spy.observe(t));
  }
}

// Apply the active lens to the visible page: swap the primary dial + headline,
// highlight the matching Quality/Market-pulse chip, surface the chart overlay,
// and open the lens-appropriate accordion section. Makes the toggle unmistakable.
function applyLens(c, d, s) {
  const lens = currentLens();
  const strip = c.querySelector('.verdict-strip');
  if (strip) strip.dataset.lens = lens;

  const dial = c.querySelector('#verdict-dial');
  if (dial) dial.innerHTML = scoreDialHtml(primaryScore(s));

  const plainEl = c.querySelector('#verdict-plain');
  if (plainEl) plainEl.textContent = plainForLens(d, s) || '';

  const qvn = c.querySelector('#quality-vs-noise');
  if (qvn) qvn.innerHTML = qualityVsNoiseHtml(s);

  const rg = c.querySelector('#rail-grade');
  if (rg) rg.innerHTML = railGradeHtml(s);

  const overlay = c.querySelector('#trader-overlay');
  if (overlay) {
    if (lens === 'trader' && overlay.querySelector('.prob-dist-canvas')) {
      overlay.hidden = false;
      const pc = overlay.querySelector('.prob-dist-canvas');
      if (pc) requestAnimationFrame(() => drawProbabilityDistribution(pc));
    } else {
      overlay.hidden = true;
    }
  }

  const story = c.querySelector('#story-sections');
  if (story) {
    const targetId = lens === 'trader' ? 'noise' : 'business';
    story.querySelectorAll('.story-section').forEach(sec => {
      const open = sec.dataset.section === targetId;
      sec.classList.toggle('open', open);
      const btn = sec.querySelector('.story-toggle');
      if (btn) btn.setAttribute('aria-expanded', String(open));
    });
  }
}

// ---------- recently viewed (localStorage) ----------
function recordRecent(symbol) {
  try {
    const rec = JSON.parse(localStorage.getItem('if_recent') || '[]');
    const next = [symbol, ...rec.filter(s => s !== symbol)].slice(0, 6);
    localStorage.setItem('if_recent', JSON.stringify(next));
  } catch { /* ignore quota/security errors */ }
  renderRecent();
}

function renderRecent() {
  const wrap = $('#recent-wrap');
  const list = $('#recent-list');
  if (!wrap || !list) return;
  let rec = [];
  try { rec = JSON.parse(localStorage.getItem('if_recent') || '[]'); } catch { rec = []; }
  if (!rec.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  rec.forEach(sym => {
    const el = document.createElement('div');
    el.className = 'mini-row';
    el.innerHTML =
      `<div><div class="sym">${sym}</div></div>` +
      `<div class="meta num text-right">view report</div>`;
    el.addEventListener('click', () => openDetail(sym));
    list.appendChild(el);
  });
}

// ---------- overview ----------
function miniRow(q) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${q.symbol}</div><div class="meta">${q.name || ''}</div></div>` +
    `<div class="text-right"><div class="chg ${chgClass(q.changePercent)}">${fmtPct(q.changePercent)}</div>` +
    `<div class="meta num">${fmtMoney(q.price)}</div></div>`;
  el.addEventListener('click', () => openDetail(q.symbol));
  return el;
}

function cryptoRow(c) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${c.symbol}</div><div class="meta">${c.name || ''}</div></div>` +
    `<div class="text-right"><div class="chg ${chgClass(c.change24h)}">${fmtPct(c.change24h)}</div>` +
    `<div class="meta num">${fmtMoney(c.price)}</div></div>`;
  return el;
}

function skelMiniRows(n) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += '<div class="mini-row"><div class="skeleton skeleton-line" style="width:52px;height:12px;"></div><div class="skeleton skeleton-line" style="width:74px;height:12px;"></div></div>';
  }
  return h;
}
function skelTable(n, cols) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += '<tr>' + Array.from({ length: cols }).map(() => '<td><span class="skeleton skeleton-line" style="display:inline-block;width:62%;height:12px;"></span></td>').join('') + '</tr>';
  }
  return h;
}

async function loadOverview() {
  const status = $('#overview-status');
  if (!status) return;
  status.textContent = 'Loading market overview…';
  status.classList.add('loading');
  ['ov-stock-gainers', 'ov-stock-losers', 'ov-etf-gainers', 'ov-etf-losers', 'ov-crypto'].forEach(id => {
    const r = document.getElementById(id);
    if (r) r.innerHTML = skelMiniRows(5);
  });
  try {
    const d = await getJSON('/api/overview');
    if (d.degraded) status.className = 'status warn';
    status.textContent = d.degraded
      ? 'Partial data (some sources unavailable). Showing what we have.'
      : 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
    fill('ov-stock-gainers', d.stocks.gainers);
    fill('ov-stock-losers', d.stocks.losers);
    fill('ov-etf-gainers', d.etfs.gainers);
    fill('ov-etf-losers', d.etfs.losers);
    const cr = $('#ov-crypto');
    if (cr) {
      cr.innerHTML = '';
      (d.crypto || []).forEach((c) => cr.appendChild(cryptoRow(c)));
    }
    status.classList.remove('loading');
  } catch (e) {
    status.className = 'status warn';
    status.textContent = 'Failed to load overview: ' + e.message;
    status.classList.remove('loading');
  }
}

function fill(id, list) {
  const root = $('#' + id);
  if (!root) return;
  root.innerHTML = '';
  if (!list || !list.length) {
    root.innerHTML = '<p class="muted caption" style="padding:var(--space-2);">No data.</p>';
    return;
  }
  list.forEach((q) => root.appendChild(miniRow(q)));
}

// ---------- screener ----------
const screenerForm = $('#screener-form');
if (screenerForm) {
  screenerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runScreener();
  });
}

// filters toggle
const filtersToggle = $('#filters-toggle');
if (filtersToggle) {
  filtersToggle.addEventListener('click', () => {
    const form = $('#screener-form');
    const visible = form.style.display !== 'none';
    form.style.display = visible ? 'none' : 'flex';
    filtersToggle.textContent = visible ? 'Show all filters' : 'Hide filters';
  });
}

// preset chips
$$('.preset-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $$('.preset-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const nlInput = $('#f-nl');
    if (nlInput) nlInput.value = '';
    runScreener(chip.dataset.preset);
  });
});

// NL search on enter
const nlInput = $('#f-nl');
if (nlInput) {
  nlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $$('.preset-chip').forEach(c => c.classList.remove('active'));
      runScreener();
    }
  });
}

// NL presets
const PRESETS = {
  compounder: { peMax: 25, roeMin: 0.15, earningsGrowthMin: 0.1, limit: 20, label: 'Compounder' },
  cash: { dividendYieldMin: 2, deMax: 1, peMax: 20, limit: 20, label: 'Cash machine' },
  turnaround: { peMax: 15, earningsGrowthMin: 0.05, limit: 20, label: 'Turnaround' },
};

function parseNaturalLanguage(q) {
  const params = new URLSearchParams();
  const lower = q.toLowerCase();
  if (lower.includes('big cap') || lower.includes('large cap') || lower.includes('mega')) {
    params.set('marketCapMin', '200000000000');
  } else if (lower.includes('mid cap') || lower.includes('medium')) {
    params.set('marketCapMin', '10000000000');
    params.set('marketCapMax', '200000000000');
  } else if (lower.includes('small cap')) {
    params.set('marketCapMax', '10000000000');
  }
  if (lower.includes('etf')) params.set('type', 'ETF');
  if (lower.includes('stock')) params.set('type', 'STOCK');
  const debtMatch = lower.match(/debt\s*(?:under|below|less than|<)\s*([\d.]+)/);
  if (debtMatch) params.set('deMax', debtMatch[1]);
  const yieldMatch = lower.match(/yield\s*(?:above|over|more than|>)\s*([\d.]+)/);
  if (yieldMatch) params.set('dividendYieldMin', yieldMatch[1]);
  const roeMatch = lower.match(/roe\s*(?:above|over|more than|>)\s*([\d.]+)/);
  if (roeMatch) params.set('roeMin', roeMatch[1]);
  const peMatch = lower.match(/pe\s*(?:under|below|less than|<)\s*([\d.]+)/);
  if (peMatch) params.set('peMax', peMatch[1]);
  if (lower.includes('tech') || lower.includes('technology')) params.set('sector', 'technology');
  if (lower.includes('health')) params.set('sector', 'healthcare');
  if (lower.includes('profitable') || lower.includes('profit')) params.set('roeMin', '0.05');
  if (lower.includes('no debt') || lower.includes('debt free')) params.set('deMax', '0.1');
  if (lower.includes('growing') || lower.includes('growth')) params.set('earningsGrowthMin', '0.05');
  return params;
}

async function runScreener(preset) {
  const status = $('#screener-status');
  status.textContent = 'Searching…';
  status.classList.add('loading');
  const stb = document.querySelector('#screener-table tbody');
  if (stb) stb.innerHTML = skelTable(10, 8);
  const params = new URLSearchParams();

  if (preset && PRESETS[preset]) {
    Object.entries(PRESETS[preset]).forEach(([k, v]) => {
      if (k !== 'label') params.set(k, v);
    });
  } else {
    const nlQuery = $('#f-nl')?.value?.trim();
    if (nlQuery) {
      const nlParams = parseNaturalLanguage(nlQuery);
      nlParams.forEach((v, k) => params.set(k, v));
    } else {
      // traditional filters
      const type = $('#f-type').value;
      const mcap = $('#f-mcap').value;
      const sector = $('#f-sector').value.trim();
      const pe = $('#f-pe').value;
      const dy = $('#f-dy').value;
      const limit = $('#f-limit').value;
      if (type && type !== 'all') params.set('type', type);
      if (mcap) params.set('marketCapMin', mcap);
      if (sector) params.set('sector', sector);
      if (pe) params.set('peMax', pe);
      if (dy) params.set('dividendYieldMin', dy);
      if (limit) params.set('limit', limit);
    }
  }

  try {
    const d = await getJSON('/api/screener?' + params.toString());
    const tbody = $('#screener-table tbody');
    tbody.innerHTML = '';
    status.classList.remove('loading');
    if (d.degraded) status.className = 'status warn';
    status.textContent = d.degraded
      ? 'Source unavailable: ' + (d.error || 'unknown error')
      : `Found ${d.count} result(s).`;
    (d.results || []).forEach((q) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="sym-link">${q.symbol}</td><td>${q.name || ''}</td><td>${q.type}</td>` +
        `<td class="num">${fmtMoney(q.price)}</td><td class="${chgClass(q.changePercent)} num">${fmtPct(q.changePercent)}</td>` +
        `<td class="num">${fmtCap(q.marketCap)}</td>` +
        `<td class="num">${q.pe != null ? q.pe.toFixed(1) : '—'}</td>` +
        `<td class="num">${q.dividendYield != null ? q.dividendYield.toFixed(2) + '%' : '—'}</td>`;
      tr.addEventListener('click', () => openDetail(q.symbol));
      tbody.appendChild(tr);
    });
  } catch (e) {
    status.className = 'status warn';
    status.textContent = 'Screener error: ' + e.message;
    status.classList.remove('loading');
  }
}

// ---------- crypto ----------
// CoinGecko is CORS-open (Access-Control-Allow-Origin: *), so when the server
// proxy is degraded/rate-limited the browser can fetch it directly as a fallback.
async function fetchCryptoDirect() {
  const url =
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd' +
    '&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h';
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return data.map((c) => ({
    id: c.id,
    symbol: (c.symbol || '').toUpperCase(),
    name: c.name,
    image: c.image,
    price: c.current_price,
    marketCap: c.market_cap,
    volume: c.total_volume,
    change24h: c.price_change_percentage_24h,
  }));
}

async function loadCrypto() {
  const status = $('#crypto-status');
  if (!status) return;
  status.textContent = 'Loading crypto…';
  status.classList.add('loading');
  const ctb = document.querySelector('#crypto-table tbody');
  if (ctb) ctb.innerHTML = skelTable(8, 7);
  let d;
  try {
    d = await getJSON('/api/crypto?limit=50');
  } catch (e) {
    d = { count: 0, results: [], degraded: true, error: e.message };
  }
  let direct = false;
  if (d.degraded && d.clientFallback) {
    try {
      const results = await fetchCryptoDirect();
      if (results.length) { d = { count: results.length, results, degraded: false }; direct = true; }
    } catch { /* both paths failed */ }
  }
  if (d.degraded) status.className = 'status warn';
  status.textContent = d.degraded
    ? 'CoinGecko unavailable: ' + (d.error || 'unknown error')
    : `${d.count} coins.` + (direct ? ' (direct)' : '');
  status.classList.remove('loading');
  const tbody = $('#crypto-table tbody');
  tbody.innerHTML = '';
  (d.results || []).forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${i + 1}</td><td>${c.name}</td><td>${c.symbol}</td><td class="num">${fmtMoney(c.price)}</td>` +
      `<td class="${chgClass(c.change24h)} num">${fmtPct(c.change24h)}</td><td class="num">${fmtCap(c.marketCap)}</td><td class="num">${fmtCap(c.volume)}</td>`;
    tbody.appendChild(tr);
  });
}

// ---------- F&G strip ----------
async function loadFgStrip() {
  const el = $('#fg-strip');
  if (!el) return;
  try {
    const d = await getJSON('/api/market/sentiment');
    if (d.degraded) { el.style.display = 'none'; return; }
    let html = '';
    if (d.usFearGreed) {
      const ug = d.usFearGreed;
      const cls = ug.score <= 25 ? 'up' : ug.score >= 75 ? 'down' : '';
      html += `<span class="fg-item"><span class="fg-label">Market F&G</span><span class="${cls}">${ug.score}</span></span>`;
    }
    if (d.vix) {
      const cls = d.vix.score > 60 ? 'down' : d.vix.score < 40 ? 'up' : '';
      html += `<span class="fg-item"><span class="fg-label">VIX</span><span class="${cls}">${d.vix.vix?.toFixed(1) || '—'}</span></span>`;
    }
    const macro = d.macro || {};
    if (macro.tenYear != null) {
      html += `<span class="fg-item"><span class="fg-label">10Y</span><span>${macro.tenYear.value?.toFixed(2) || '—'}%</span></span>`;
    }
    if (macro.sp500?.changePct != null) {
      const cls = chgClass(macro.sp500.changePct);
      html += `<span class="fg-item"><span class="fg-label">S&P</span><span class="${cls}">${fmtPct(macro.sp500.changePct)}</span></span>`;
    }
    if (macro.dollar?.changePct != null) {
      const cls = chgClass(macro.dollar.changePct);
      html += `<span class="fg-item"><span class="fg-label">DXY</span><span class="${cls}">${fmtPct(macro.dollar.changePct)}</span></span>`;
    }
    if (html) {
      el.innerHTML = html;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  } catch { el.style.display = 'none'; }
}

// ---------- search ----------
(function initGlobalSearch() {
  const gs = $('#global-search');
  const gsr = $('#global-search-results');
  if (!gs || !gsr) return;
  let debounceTimer = null;
  let focusIdx = -1;

  function hideResults() { gsr.classList.add('hidden'); focusIdx = -1; }
  function clearFocus() { gsr.querySelectorAll('.search-result-item').forEach(i => i.classList.remove('focused')); }
  function setFocus(idx) {
    clearFocus();
    const items = gsr.querySelectorAll('.search-result-item');
    if (idx >= 0 && idx < items.length) { items[idx].classList.add('focused'); focusIdx = idx; }
  }

  gs.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = gs.value.trim();
    if (!q) { hideResults(); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const d = await getJSON('/api/search?q=' + encodeURIComponent(q));
        gsr.innerHTML = '';
        if (d.degraded) { hideResults(); return; }
        if (!d.results.length) {
          const empty = document.createElement('div');
          empty.className = 'search-empty';
          empty.textContent = `No matches for “${q}”.`;
          gsr.appendChild(empty);
          gsr.classList.remove('hidden');
          return;
        }
        const curated = d.results.filter((r) => r.inUniverse);
        const wider = d.results.filter((r) => !r.inUniverse);
        if (curated.length) {
          const hdr = document.createElement('div');
          hdr.className = 'search-section-header';
          hdr.textContent = 'In our list';
          gsr.appendChild(hdr);
          curated.slice(0, 5).forEach((r) => gsr.appendChild(addItem(r, q)));
        }
        if (wider.length) {
          const hdr = document.createElement('div');
          hdr.className = 'search-section-header';
          hdr.textContent = 'Wider market';
          gsr.appendChild(hdr);
          wider.slice(0, 5).forEach((r) => gsr.appendChild(addItem(r, q)));
        }
        gsr.classList.remove('hidden');
      } catch { hideResults(); }
    }, 200);
  });

  function addItem(r, query) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    const sym = r.symbol;
    const name = r.name || '';
    // highlight query in name
    let nameHtml = name;
    if (query) {
      const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      nameHtml = name.replace(re, '<span class="search-highlight">$1</span>');
    }
    item.innerHTML =
      `<span class="sym">${sym}</span>` +
      `<span class="meta">${nameHtml}${r.type === 'ETF' ? ' · ETF' : ''}</span>`;
    item.addEventListener('click', () => { gs.value = ''; hideResults(); openDetail(sym); });
    return item;
  }

  gs.addEventListener('keydown', (e) => {
    const items = gsr.querySelectorAll('.search-result-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(Math.min(focusIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(Math.max(focusIdx - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (focusIdx >= 0 && focusIdx < items.length) items[focusIdx].click();
      else if (items.length) items[0].click();
    } else if (e.key === 'Escape') { hideResults(); }
  });

  gs.addEventListener('blur', () => setTimeout(hideResults, 150));
})();

// ⌘K / "/" shortcut
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('#global-search')?.focus();
  }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#global-search')?.focus();
  }
});

// ---------- router ----------
function parseSymbolFromPath() {
  const m = window.location.pathname.match(/^\/s\/([A-Za-z]{1,6})$/);
  return m ? m[1].toUpperCase() : null;
}

function showTab(tabId) {
  $$('.panel').forEach(p => p.classList.remove('active'));
  $$('.tab').forEach(b => b.classList.remove('active'));
  const panel = $('#' + tabId);
  if (panel) panel.classList.add('active');
  const btn = $(`.tab[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');
  document.title = 'Investment Finder — free US stocks & ETFs';
}

function showDetail() {
  $$('.panel').forEach(p => p.classList.remove('active'));
  $('#detail').classList.add('active');
  $$('.tab').forEach(b => b.classList.remove('active'));
}

async function openDetail(symbol, pushState) {
  if (pushState !== false) history.pushState({ symbol }, '', '/s/' + symbol);
  showDetail();
  recordRecent(symbol);
  const c = $('#detail-content');
  c.innerHTML = '<div style="padding:48px 0;"><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-block"></div></div>';

  let detailData = null;
  let signalsData = null;

  // Fire detail + signals concurrently: chart paints as soon as detail lands,
  // signals fill the accordion when ready. Saves the serial detail wait.
  const detailP = getJSONWithTimeout('/api/detail/' + encodeURIComponent(symbol), 15000);
  const signalsP = getJSONWithTimeout('/api/signals/' + encodeURIComponent(symbol), 20000);

  try {
    detailData = await detailP;
    if (!detailData) throw new Error('timeout');
    renderDetailFast(c, detailData, symbol);
  } catch (e) {
    c.innerHTML = `<div style="padding:48px 0;"><p class="muted">Failed to load ${symbol}: ${e.message}</p></div>`;
    return;
  }

  try {
    signalsData = await signalsP;
    if (!signalsData) throw new Error('sources slow');
    renderSignals(c, detailData, signalsData);
  } catch (e) {
    const story = $('#story-sections');
    if (story) story.innerHTML = '<p class="muted" style="padding:16px;font-size:13px;">Signals are taking longer than usual — try again in a minute.</p>';
  }

  document.title = `${symbol} — Investment Finder`;
}

// ---------- popstate ----------
window.addEventListener('popstate', () => {
  const sym = parseSymbolFromPath();
  if (sym) openDetail(sym, false);
  else showTab('overview');
});

// ---------- tabs ----------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if ($('#detail').classList.contains('active')) history.pushState(null, '', '/');
    showTab(btn.dataset.tab);
  });
});

// ---------- boot ----------
// Delegated handler: options expiry date selector (one-time, survives re-renders)
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('.options-expiry');
  if (!sel) return;
  const symbol = decodeURIComponent(sel.dataset.symbol);
  const value = sel.value;
  const overlay = document.getElementById('trader-overlay');
  const details = document.getElementById('options-details');
  sel.disabled = true;
  if (overlay) overlay.style.opacity = '0.4';
  if (details) details.style.opacity = '0.4';
  try {
    const q = value ? '?expiry=' + encodeURIComponent(value) : '';
    const data = await getJSON('/api/options/' + encodeURIComponent(symbol) + q);
    if (!data.available || !data.signals) throw new Error('no options data');
    const optsObj = { currentPrice: data.currentPrice, expirations: data.expirations, signals: data.signals, available: true };
    if (overlay) {
      overlay.innerHTML = probabilityBlockHtml(optsObj, symbol);
      overlay.style.opacity = '1';
      if (!overlay.hidden) requestAnimationFrame(() => drawProbabilityDistribution(overlay.querySelector('.prob-dist-canvas')));
    }
    if (details) { details.innerHTML = optionsDetailsHtml(optsObj, symbol); details.style.opacity = '1'; }
  } catch (err) {
    if (overlay) { overlay.style.opacity = '1'; overlay.innerHTML = '<p class="muted caption" style="padding:var(--space-2) 0;">Could not load options for this date.</p>'; }
    if (details) details.style.opacity = '1';
  }
});

// recently-viewed clear
const recentClearBtn = $('#recent-clear');
if (recentClearBtn) {
  recentClearBtn.addEventListener('click', () => {
    try { localStorage.removeItem('if_recent'); } catch { /* ignore */ }
    renderRecent();
  });
}

(function boot() {
  renderRecent();
  const sym = parseSymbolFromPath();
  if (sym) {
    openDetail(sym, false);
  } else {
    showTab('overview');
    loadOverview();
    loadCrypto();
    loadFgStrip();
  }
})();
