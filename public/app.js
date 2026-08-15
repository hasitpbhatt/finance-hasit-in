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

// ---------- score rendering ----------
function scoreGaugeHtml(score) {
  if (!score) return '';
  const v = score.value;
  const pct = Math.round(((v + 100) / 200) * 100);
  const fillClass = v >= 30 ? 'hi' : v >= -30 ? 'mid' : '';
  const gradeClass = v >= 10 ? 'up' : v > -10 ? 'mid' : 'down';
  const gradeLabel = (score.label || 'neutral').replace(/_/g, ' ');

  return `
    <div class="score-hero">
      <div class="score-gauge">
        <div class="score-gauge-fill ${fillClass}" style="width:${pct}%"></div>
      </div>
      <div class="score-gauge-label ${gradeClass}">${v > 0 ? '+' : ''}${v}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <span class="score-grade ${gradeClass}">${gradeLabel}</span>
      <span class="muted" style="font-size:12px;">${score.factors.length} signal${score.factors.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="score-factors">
      ${score.factors.map(f => {
        const cls = f.score > 0 ? 'up' : f.score < 0 ? 'down' : 'mid';
        const label = f.score > 0 ? '+' + f.score : f.score;
        return `<span class="score-factor"><span class="dot ${cls}"></span>${f.label} ${label}</span>`;
      }).join('')}
    </div>`;
}

// ---------- narrative ----------
function narrativeBreathHtml(s) {
  if (!s.narrative?.available || !s.narrative.text) return '';
  const text = s.narrative.text;
  const cutAt = text.lastIndexOf('. ', 180);
  const breath = cutAt > 50 ? text.substring(0, cutAt + 1) : text.substring(0, 180) + '…';
  const full = text;
  return `
    <div class="narrative-breath">
      <span class="breath-text">${breath}</span>
      ${breath !== full ? `<span class="more" data-full="${encodeURIComponent(full)}">read more</span>` : ''}
      <div class="meta" style="margin-top:4px;font-size:11px;">AI-generated · not investment advice</div>
    </div>`;
}

// ---------- copy verdict ----------
function copyVerdictHtml(d, s) {
  const price = d.price != null ? fmtMoney(d.price) : '';
  const chg = d.changePercent != null ? fmtPct(d.changePercent) : '';
  const grade = s.score?.label?.replace(/_/g, ' ') || 'unknown';
  const scoreVal = s.score?.value ?? 0;
  const text = `${d.symbol} ${price} (${chg}) · Verdict: ${grade} (${scoreVal > 0 ? '+' : ''}${scoreVal})`;
  return `<button class="copy-btn" data-copy="${encodeURIComponent(text)}" title="Copy verdict">⧉ Copy verdict</button>`;
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
let currentChart = null;

function drawChart(chart, range) {
  const canvas = $('#detail-canvas');
  if (!canvas) return;
  const series = (chart && chart.series) || [];
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

  const prices = series.map(s => s.c);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
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

  // animate: draw progressively
  const totalPts = series.length;
  let drawn = 0;

  function frame() {
    drawn += Math.max(1, Math.floor(totalPts / 20));
    if (drawn > totalPts) drawn = totalPts;
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
    ctx.stroke();

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
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
    }

    if (drawn < totalPts) requestAnimationFrame(frame);
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
      tooltip.innerHTML = `<div class="num" style="font-weight:600;">${fmtMoney(pt.c)}</div><div class="muted" style="font-size:11px;">${pt.d || ''}</div>`;
      tooltip.classList.add('show');
      tooltip.style.left = Math.min(mx + 12, w - 120) + 'px';
      tooltip.style.top = '8px';
    }
  };
  canvas.onmouseleave = () => { if (tooltip) tooltip.classList.remove('show'); };

  currentChart = { chart, range };
}

function chartHtml(d) {
  const ranges = ['1M', '3M', '6M', '1Y', 'ALL'];
  return `
    <div class="chart-wrap">
      <canvas id="detail-canvas"></canvas>
      <div class="chart-tooltip"></div>
      <div class="chart-range">
        ${ranges.map(r => `<button class="chart-range-btn${r === '1Y' ? ' active' : ''}" data-range="${r}">${r}</button>`).join('')}
      </div>
    </div>`;
}

// ---------- section accordion ----------
function sectionHtml(id, title, content, open) {
  return `
    <div class="story-section${open ? ' open' : ''}" data-section="${id}">
      <button class="story-toggle" aria-expanded="${open}">
        <span>${title}</span>
        <span class="chevron">▸</span>
      </button>
      <div class="story-body">${content}</div>
    </div>`;
}

// ---------- signal section content ----------
function verdictContent(s) {
  let html = '';
  if (s.signalFlags?.redFlag) html += '<div class="flag-banner">⚠ Red flag: officer departures + insider selling</div>';
  html += scoreGaugeHtml(s.score);
  return html;
}

function whyContent(s) {
  let html = '';
  const breath = narrativeBreathHtml(s);
  if (breath) html += breath;
  // top reasons from score factors
  if (s.score?.factors?.length) {
    const sorted = [...s.score.factors].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const top = sorted.slice(0, 3);
    html += '<div style="margin-top:12px;">';
    html += top.map(f => {
      const cls = f.score > 0 ? 'up' : f.score < 0 ? 'down' : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;"><span class="dot ${cls}" style="width:6px;height:6px;border-radius:50%;flex-shrink:0;"></span>${f.label}: <strong class="${cls}">${f.score > 0 ? '+' : ''}${f.score}</strong></div>`;
    }).join('');
    html += '</div>';
  }
  return html || '<p class="muted" style="font-size:13px;">No data available for a verdict.</p>';
}

function fundamentalsContent(s) {
  if (!s.xbrl?.available) return '<p class="muted" style="font-size:13px;">SEC XBRL data unavailable.</p>';
  const x = s.xbrl;
  const rows = [];
  const trendIcon = (t) => {
    if (t === 'strong_growth' || t === 'growing') return '<span class="up">↑</span>';
    if (t === 'declining' || t === 'sharply_declining') return '<span class="down">↓</span>';
    return '<span class="muted">→</span>';
  };
  const trendCls = (t) => {
    if (t === 'strong_growth' || t === 'growing') return 'up';
    if (t === 'declining' || t === 'sharply_declining') return 'down';
    return 'muted';
  };

  if (x.revenue?.latest != null) {
    rows.push(`<div><span>Revenue (${x.latestFY || ''})</span><span>${fmtMoney(x.revenue.latest)}</span></div>`);
    rows.push(`<div><span>Revenue trend</span><span>${trendIcon(x.revenue.trend)} <span class="${trendCls(x.revenue.trend)}">${x.revenue.trendLabel}</span></span></div>`);
  }
  if (x.netIncome?.latest != null) {
    rows.push(`<div><span>Net Income (${x.latestFY || ''})</span><span>${fmtMoney(x.netIncome.latest)}</span></div>`);
    rows.push(`<div><span>Net Income trend</span><span>${trendIcon(x.netIncome.trend)} <span class="${trendCls(x.netIncome.trend)}">${x.netIncome.trendLabel}</span></span></div>`);
  }
  if (x.revenue?.growth?.length) {
    rows.push(`<div><span>Avg Revenue Growth</span><span class="${x.revenue.growth[0]?.growth >= 0 ? 'up' : 'down'}">${(x.revenue.growth.reduce((s, g) => s + g.growth, 0) / x.revenue.growth.length).toFixed(1)}%</span></div>`);
  }
  return rows.length ? `<div class="signal-grid">${rows.join('')}</div>` : '<p class="muted" style="font-size:13px;">Insufficient data.</p>';
}

function analystsContent(s) {
  if (!s.analyst?.available) return '<p class="muted" style="font-size:13px;">Analyst data unavailable.</p>';
  const a = s.analyst;
  const rows = [];
  rows.push(`<div><span>Consensus</span><span>${a.consensus ? a.consensus.charAt(0).toUpperCase() + a.consensus.slice(1) : '—'}</span></div>`);
  rows.push(`<div><span>Analysts</span><span>${a.numAnalysts ?? '—'}</span></div>`);
  rows.push(`<div><span>Target (mean)</span><span>${a.targetMean != null ? fmtMoney(a.targetMean) : '—'}</span></div>`);
  rows.push(`<div><span>Upside</span><span class="${a.upsidePct >= 0 ? 'up' : 'down'}">${a.upsidePct != null ? fmtPct(a.upsidePct) : '—'}</span></div>`);
  if (a.breakdown) {
    const b = a.breakdown;
    const chips = [];
    if (b.strongBuy > 0) chips.push(`<span class="chip up">Strong Buy ${b.strongBuy}</span>`);
    if (b.buy > 0) chips.push(`<span class="chip up">Buy ${b.buy}</span>`);
    if (b.hold > 0) chips.push(`<span class="chip">Hold ${b.hold}</span>`);
    if (b.sell > 0) chips.push(`<span class="chip down">Sell ${b.sell}</span>`);
    if (b.strongSell > 0) chips.push(`<span class="chip down">Strong Sell ${b.strongSell}</span>`);
    if (chips.length) rows.push(`<div><span>Breakdown</span><span>${chips.join(' ')}</span></div>`);
  }
  // earnings
  if (s.earnings?.available) {
    const e = s.earnings;
    if (e.beatStreak > 0) rows.push(`<div><span>Beat streak</span><span class="up">${e.beatStreak} quarters</span></div>`);
  }
  return `<div class="signal-grid">${rows.join('')}</div>`;
}

function tradingContent(s) {
  let html = '';

  // options layman
  if (s.options?.available && s.options.signals?.available) {
    const sig = s.options.signals;
    const exp = sig.expectedMove;
    const dte = sig.dte;
    const parts = [];
    if (exp) {
      const lo = (s.options.currentPrice - exp.dollar).toFixed(2);
      const hi = (s.options.currentPrice + exp.dollar).toFixed(2);
      parts.push(`<div class="layman-row"><div class="layman-label">Expected move (${dte != null ? dte + 'd' : ''})</div><div class="layman-range"><span class="down">${fmtMoney(lo)}</span> — <span class="up">${fmtMoney(hi)}</span></div><div class="layman-sub">±${fmtMoney(exp.dollar)} (${exp.percent}%)</div></div>`);
    }
    if (sig.support) parts.push(`<div class="layman-row"><div class="layman-label">Support</div><span class="up">${fmtMoney(sig.support.strike)}</span></div>`);
    if (sig.resistance) parts.push(`<div class="layman-row"><div class="layman-label">Resistance</div><span class="down">${fmtMoney(sig.resistance.strike)}</span></div>`);
    if (sig.maxPain) parts.push(`<div class="layman-row"><div class="layman-label">Max pain</div><span>${fmtMoney(sig.maxPain)}</span></div>`);
    if (parts.length) {
      const sentCls = sig.sentiment === 'Bullish' ? 'up' : sig.sentiment === 'Bearish' ? 'down' : '';
      html += `<div style="margin-bottom:12px;"><span class="chip ${sentCls}">${sig.sentiment}</span> <span class="muted" style="font-size:11px;">${dte != null ? dte + 'd to expiry' : ''}</span></div>`;
      html += parts.join('');
    }

    // raw numbers
    const rawRows = [];
    rawRows.push(`<div><span>Calls / Puts</span><span>${sig.callsCount} / ${sig.putsCount}</span></div>`);
    rawRows.push(`<div><span>Put/Call ratio</span><span>${sig.pcRatioVol?.toFixed(3) ?? '—'}</span></div>`);
    if (sig.avgIV != null) rawRows.push(`<div><span>Avg IV</span><span>${(sig.avgIV * 100).toFixed(1)}%</span></div>`);
    if (rawRows.length) {
      html += `<details class="raw-details"><summary>Raw numbers</summary><div class="signal-grid" style="margin-top:8px;">${rawRows.join('')}</div></details>`;
    }
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
    if (rows.length) {
      if (html) html += '<div style="margin-top:12px;">';
      html += `<h4 style="margin-bottom:4px;">Short Interest</h4><div class="signal-grid">${rows.join('')}</div>`;
      if (html) html += '</div>';
    }
  }

  // retail sentiment
  if (s.retail?.available) {
    const r = s.retail;
    html += '<div style="margin-top:12px;">';
    html += `<h4 style="margin-bottom:4px;">Retail Sentiment</h4>`;
    html += `<div class="sentiment-bar"><div class="sentiment-bar-fill up" style="width:${r.bullPct}%"></div><div class="sentiment-bar-fill down" style="width:${r.bearPct}%"></div></div>`;
    html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px;"><span class="up">Bull ${r.bullPct}%</span><span class="muted">${r.total} msgs</span><span class="down">Bear ${r.bearPct}%</span></div>`;
    html += '</div>';
  }

  return html || '<p class="muted" style="font-size:13px;">Options data unavailable.</p>';
}

function ownershipContent(s) {
  let html = '';

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
    html += `<div class="muted" style="font-size:12px;margin-bottom:8px;"><span class="${netCls}">${netLabel}</span> · ${trades.length} transaction(s)</div>`;
    html += `<div class="table-wrap"><table class="insider-table"><thead><tr><th>Date</th><th>Insider</th><th>Code</th><th>Shares</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // leadership
  if (s.leadership?.available && s.leadership.changes?.length) {
    html += html ? '<div style="margin-top:16px;">' : '';
    html += `<h4 style="margin-bottom:4px;">Leadership Changes</h4>`;
    const changes = s.leadership.changes.map(c => {
      const names = (c.names || []).join(', ') || '—';
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span class="muted">${c.date || ''}</span> ${c.kind || ''} · ${names}</div>`;
    }).join('');
    html += changes;
    if (html.endsWith('<div style="margin-top:16px;">')) html += '</div>';
  }

  // hiring
  if (s.hiring?.available) {
    const h = s.hiring;
    html += html ? '<div style="margin-top:16px;">' : '';
    html += `<h4 style="margin-bottom:4px;">Hiring</h4>`;
    html += `<div class="signal-grid"><div><span>Open jobs</span><span>${h.openJobs}</span></div>`;
    if (h.earliestOpening) html += `<div><span>Earliest</span><span>${h.earliestOpening}</span></div>`;
    html += '</div>';
    if (html.endsWith('<div style="margin-top:16px;">')) html += '</div>';
  }

  return html || '<p class="muted" style="font-size:13px;">No ownership or leadership data available.</p>';
}

function newsContent(d) {
  if (!d.news?.length) return '<p class="muted" style="font-size:13px;">No headlines available.</p>';
  const items = d.news.slice(0, 6).map(n =>
    `<li><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>${n.pubDate ? ` <span class="date">${new Date(n.pubDate).toLocaleDateString()}</span>` : ''}</li>`
  ).join('');
  return `<ul class="news-list">${items}</ul>`;
}

// ---------- main renderers ----------
function renderDetailFast(c, d, symbol) {
  c.innerHTML = heroHtml(d, '') + chartHtml(d) + newsHtml(d);
  drawChart(d.chart, '1Y');

  // init section accordion (story)
  const story = document.createElement('div');
  story.className = 'story-sections';
  story.id = 'story-sections';
  story.innerHTML = '<div class="story-section open" data-section="verdict"><button class="story-toggle" aria-expanded="true"><span>Verdict</span><span class="chevron">▸</span></button><div class="story-body"><p class="muted" style="font-size:13px;">Loading signals…</p></div></div>';
  c.appendChild(story);

  // attach chart range handlers
  c.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      c.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawChart(d.chart, btn.dataset.range);
    });
  });
}

function renderSignals(c, d, s) {
  const story = $('#story-sections') || c;

  // build all section content
  const sections = [
    { id: 'verdict', title: 'Verdict', content: verdictContent(s), open: true },
    { id: 'why', title: 'Why', content: whyContent(s), open: false },
    { id: 'fundamentals', title: 'Fundamentals', content: fundamentalsContent(s), open: false },
    { id: 'analysts', title: 'Analysts', content: analystsContent(s), open: false },
    { id: 'trading', title: 'Trading', content: tradingContent(s), open: false },
    { id: 'ownership', title: 'Ownership', content: ownershipContent(s), open: false },
    { id: 'news', title: 'News', content: newsHtml(d), open: false },
  ].filter(sec => sec.content.trim() !== '');

  // update hero with score
  const heroEl = c.querySelector('.detail-hero');
  if (heroEl && s.score) {
    const heroRight = heroEl.querySelector('.detail-hero-right');
    if (heroRight) {
      const copyBtn = copyVerdictHtml(d, s);
      const narrativeHtml = narrativeBreathHtml(s);
      heroRight.insertAdjacentHTML('afterend',
        `<div style="margin-top:12px;">${copyBtn}</div><div style="margin-top:8px;">${narrativeHtml}</div>`
      );
    }
  }

  // render sections
  story.innerHTML = sections.map(sec => sectionHtml(sec.id, sec.title, sec.content, sec.open)).join('');

  // accordion behavior: one open at a time
  story.querySelectorAll('.story-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.story-section');
      const isOpen = section.classList.contains('open');
      if (!isOpen) story.querySelectorAll('.story-section').forEach(s => s.classList.remove('open'));
      section.classList.toggle('open', !isOpen);
      btn.setAttribute('aria-expanded', !isOpen);
    });
  });

  // copy verdict
  story.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = decodeURIComponent(btn.dataset.copy);
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉ Copy verdict'; }, 2000);
      });
    });
  });

  // read more
  story.querySelectorAll('.more').forEach(btn => {
    btn.addEventListener('click', () => {
      const full = decodeURIComponent(btn.dataset.full);
      const breathEl = btn.closest('.narrative-breath');
      if (breathEl) {
        breathEl.querySelector('.breath-text').textContent = full;
        btn.remove();
      }
    });
  });
}

// ---------- overview ----------
function miniRow(q) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${q.symbol}</div><div class="meta">${q.name || ''}</div></div>` +
    `<div style="text-align:right"><div class="chg ${chgClass(q.changePercent)}">${fmtPct(q.changePercent)}</div>` +
    `<div class="meta num">${fmtMoney(q.price)}</div></div>`;
  el.addEventListener('click', () => openDetail(q.symbol));
  return el;
}

function cryptoRow(c) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${c.symbol}</div><div class="meta">${c.name || ''}</div></div>` +
    `<div style="text-align:right"><div class="chg ${chgClass(c.change24h)}">${fmtPct(c.change24h)}</div>` +
    `<div class="meta num">${fmtMoney(c.price)}</div></div>`;
  return el;
}

async function loadOverview() {
  const status = $('#overview-status');
  if (!status) return;
  status.textContent = 'Loading market overview…';
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
  } catch (e) {
    status.className = 'status warn';
    status.textContent = 'Failed to load overview: ' + e.message;
  }
}

function fill(id, list) {
  const root = $('#' + id);
  if (!root) return;
  root.innerHTML = '';
  if (!list || !list.length) {
    root.innerHTML = '<div class="muted" style="font-size:13px;padding:8px;">No data.</div>';
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
  }
}

// ---------- crypto ----------
async function loadCrypto() {
  const status = $('#crypto-status');
  if (!status) return;
  status.textContent = 'Loading crypto…';
  try {
    const d = await getJSON('/api/crypto?limit=50');
    if (d.degraded) status.className = 'status warn';
    status.textContent = d.degraded ? 'CoinGecko unavailable: ' + (d.error || '') : `${d.count} coins.`;
    const tbody = $('#crypto-table tbody');
    tbody.innerHTML = '';
    (d.results || []).forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${i + 1}</td><td>${c.name}</td><td>${c.symbol}</td><td class="num">${fmtMoney(c.price)}</td>` +
        `<td class="${chgClass(c.change24h)} num">${fmtPct(c.change24h)}</td><td class="num">${fmtCap(c.marketCap)}</td><td class="num">${fmtCap(c.volume)}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    status.className = 'status warn';
    status.textContent = 'Crypto error: ' + e.message;
  }
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
        if (d.degraded || !d.results.length) { hideResults(); return; }
        const curated = d.results.filter((r) => r.inUniverse);
        const wider = d.results.filter((r) => !r.inUniverse);
        if (curated.length) {
          const hdr = document.createElement('div');
          hdr.className = 'search-section-header';
          hdr.textContent = 'Curated';
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
  const c = $('#detail-content');
  c.innerHTML = '<div style="padding:48px 0;"><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-block"></div></div>';

  let detailData = null;
  let signalsData = null;
  try {
    detailData = await getJSON('/api/detail/' + encodeURIComponent(symbol));
    renderDetailFast(c, detailData, symbol);
  } catch (e) {
    c.innerHTML = `<div style="padding:48px 0;"><p class="muted">Failed to load ${symbol}: ${e.message}</p></div>`;
    return;
  }

  try {
    signalsData = await getJSON('/api/signals/' + encodeURIComponent(symbol));
    renderSignals(c, detailData, signalsData);
  } catch (e) {
    const story = $('#story-sections');
    if (story) story.innerHTML = '<p class="muted" style="padding:16px;font-size:13px;">Signals unavailable.</p>';
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
(function boot() {
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
