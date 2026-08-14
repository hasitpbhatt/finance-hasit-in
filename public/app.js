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
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
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

// ---------- router ----------
function isDetailView() {
  return $('#detail').classList.contains('active');
}

function showDetail() {
  $$('.panel').forEach(p => p.classList.remove('active'));
  $('#detail').classList.add('active');
  $$('.tab').forEach(b => b.classList.remove('active'));
  document.title = $('#detail-content').textContent.trim().split('\n')[0] || 'Investment Finder';
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

function parseSymbolFromPath() {
  const m = window.location.pathname.match(/^\/s\/([A-Za-z]{1,6})$/);
  return m ? m[1].toUpperCase() : null;
}

async function openDetail(symbol, pushState) {
  if (pushState !== false) {
    history.pushState({ symbol }, '', '/s/' + symbol);
  }
  showDetail();
  const c = $('#detail-content');
  c.innerHTML = '<p class="status">Loading ' + symbol + '…</p>';

  // --- Fast path: quote + chart + news (runs in parallel) ---
  let detailData = null;
  let signalsData = null;
  try {
    detailData = await getJSON('/api/detail/' + encodeURIComponent(symbol));
    renderDetailFast(c, detailData, symbol);
  } catch (e) {
    c.innerHTML = '<p class="status warn">Failed to load ' + symbol + ': ' + e.message + '</p>';
    return;
  }

  // --- Slow path: signals (runs after fast path renders) ---
  const signalsSlot = document.createElement('div');
  signalsSlot.id = 'signals-slot';
  signalsSlot.innerHTML = '<div class="card" style="margin-top:16px"><p class="status">Loading signals…</p></div>';
  c.appendChild(signalsSlot);

  try {
    signalsData = await getJSON('/api/signals/' + encodeURIComponent(symbol));
    renderSignals(c, detailData, signalsData);
  } catch (e) {
    signalsSlot.innerHTML = '<div class="card" style="margin-top:16px"><p class="meta">Signals unavailable.</p></div>';
  }
}

function renderDetailFast(c, d, symbol) {
  const head =
    `<div class="detail-head"><div><h2 style="margin:0">${d.symbol}</h2>` +
    `<div class="meta">${d.name || ''} · ${d.exchange || ''}</div></div>` +
    `<div style="text-align:right"><div class="detail-price">${fmtMoney(d.price)}</div>` +
    `<div class="${chgClass(d.changePercent)}">${fmtPct(d.changePercent)}</div></div></div>`;
  const grid =
    `<div class="detail-grid">` +
    pair('Market Cap', fmtCap(d.marketCap)) +
    pair('P/E (TTM)', d.pe != null ? d.pe.toFixed(2) : '—') +
    pair('P/B', d.priceToBook != null ? d.priceToBook.toFixed(2) : '—') +
    pair('Forward P/E', d.forwardPe != null ? d.forwardPe.toFixed(2) : '—') +
    pair('ROE', d.returnOnEquity != null ? (d.returnOnEquity * 100).toFixed(1) + '%' : '—') +
    pair('Profit Margin', d.profitMargins != null ? (d.profitMargins * 100).toFixed(1) + '%' : '—') +
    pair('Debt/Equity', d.debtToEquity != null ? d.debtToEquity.toFixed(2) : '—') +
    pair('Current Ratio', d.currentRatio != null ? d.currentRatio.toFixed(2) : '—') +
    pair('Beta', d.beta != null ? d.beta.toFixed(2) : '—') +
    pair('EV/EBITDA', d.enterpriseToEbitda != null ? d.enterpriseToEbitda.toFixed(2) : '—') +
    pair('52wk Change', d.fiftyTwoWeekChange != null ? fmtPct(d.fiftyTwoWeekChange * 100) : '—') +
    pair('Insider Own', d.heldPercentInsiders != null ? (d.heldPercentInsiders * 100).toFixed(1) + '%' : '—') +
    pair('Institutional Own', d.heldPercentInstitutions != null ? (d.heldPercentInstitutions * 100).toFixed(1) + '%' : '—') +
    pair('Div Yield', d.dividendYield != null ? d.dividendYield.toFixed(2) + '%' : '—') +
    pair('Sector', d.sector || '—') +
    pair('Industry', d.industry || '—') +
    pair('Day High', fmtMoney(d.dayHigh)) +
    pair('Day Low', fmtMoney(d.dayLow)) +
    `</div>`;
  const chart = '<canvas id="detail-canvas"></canvas>';
  const news = newsHtml(d.news);
  c.innerHTML = head + grid + chart + news + '<div id="signals-slot"></div>';
  drawChart(d.chart);
}

function renderSignals(c, d, s) {
  const slot = $('#signals-slot') || c;
  const insider = insiderHtml(s);
  const signals = signalsHtml(s);
  const leadership = leadershipHtml(s);
  const hiring = hiringHtml(s);
  const options = optionsHtml(s);
  const flagBanner = s.signalFlags?.redFlag
    ? '<div class="flag-banner">⚠️ Red flag: officer departures + insider selling</div>'
    : '';
  slot.innerHTML = flagBanner + signals + options + leadership + hiring + insider;
}

function pair(k, v) {
  return `<div><span>${k}</span><span>${v}</span></div>`;
}
function newsHtml(news) {
  if (!news || !news.length) return '<h3 style="margin-top:16px">News</h3><p class="meta">No headlines available.</p>';
  const items = news
    .map(
      (n) =>
        `<li><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a>` +
        (n.pubDate ? ` <span class="meta">· ${new Date(n.pubDate).toLocaleDateString()}</span>` : '') +
        `</li>`,
    )
    .join('');
  return '<h3 style="margin-top:16px">Latest News</h3><ul class="news-list">' + items + '</ul>';
}

function insiderHtml(s) {
  if (s.insiderAvailable === false) {
    if (s.insiderDegraded) {
      return '<h3 style="margin-top:16px">Insider Trades</h3><p class="meta">SEC EDGAR data unavailable right now.</p>';
    }
    return '<h3 style="margin-top:16px">Insider Trades</h3><p class="meta">No insider filing data available for this symbol.</p>';
  }
  const trades = s.insiderTrades || [];
  if (!trades.length) {
    return '<h3 style="margin-top:16px">Insider Trades</h3><p class="meta">No recent Form 4 transactions found.</p>';
  }
  let netShares = 0;
  for (const t of trades) {
    if (t.code === 'P') netShares += t.shares || 0;
    else if (t.code === 'S') netShares -= t.shares || 0;
  }
  const netLabel =
    netShares >= 0
      ? `<span class="up">net bought ${fmtNum(netShares)} shares</span>`
      : `<span class="down">net sold ${fmtNum(-netShares)} shares</span>`;
  const rows = trades
    .map((t) => {
      const cls = t.code === 'P' ? 'up' : t.code === 'S' ? 'down' : '';
      const code = t.code ? `${t.code}${t.codeLabel ? ' · ' + t.codeLabel : ''}` : '—';
      return (
        `<tr>` +
        `<td>${t.date || '—'}</td>` +
        `<td>${t.insider || '—'}</td>` +
        `<td class="${cls}">${code}</td>` +
        `<td>${t.shares != null ? fmtNum(t.shares) : '—'}</td>` +
        `<td>${t.price != null ? fmtMoney(t.price) : '—'}</td>` +
        `<td>${t.total != null ? fmtMoney(t.total) : '—'}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    '<h3 style="margin-top:16px">Insider Trades (Form 4)</h3>' +
    `<p class="meta">${netLabel} across ${trades.length} transaction(s) from recent filings.</p>` +
    '<div class="table-wrap"><table class="insider-table"><thead><tr>' +
    '<th>Date</th><th>Insider</th><th>Code</th><th>Shares</th><th>Price</th><th>Total Value</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>'
  );
}

function drawChart(chart) {
  const canvas = $('#detail-canvas');
  if (!canvas) return;
  const series = (chart && chart.series) || [];
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth);
  const h = (canvas.height = 240);
  ctx.clearRect(0, 0, w, h);
  if (!series.length) {
    ctx.fillStyle = '#93a0bd';
    ctx.font = '14px sans-serif';
    ctx.fillText('No chart data', 16, h / 2);
    return;
  }
  const prices = series.map((s) => s.c);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pad = 24;
  const x = (i) => pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / range) * (h - pad * 2);
  const up = prices[prices.length - 1] >= prices[0];
  ctx.strokeStyle = up ? '#2ecc71' : '#ff5c5c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((s, i) => (i === 0 ? ctx.moveTo(x(i), y(s.c)) : ctx.lineTo(x(i), y(s.c))));
  ctx.stroke();
}

// ---------- signal renderers ----------
function chip(label, cls = '') {
  return `<span class="chip ${cls}">${label}</span>`;
}

function signalsHtml(s) {
  if (!s.newsIntel || !s.newsIntel.available) {
    return '<div class="card"><h3>Signals</h3><p class="meta">News intelligence unavailable.</p></div>';
  }
  const ni = s.newsIntel;
  const sentimentBar = () => {
    const w = ((ni.avgSentiment + 1) / 2) * 100;
    const cls = ni.avgSentiment >= 0 ? 'up' : ni.avgSentiment <= 0 ? 'down' : '';
    return `<div class="sentiment-bar"><div class="sentiment-bar-fill" style="width:${w}%"></div></div>`;
  };
  const trendArrow = ni.trend >= 0 ? '↗' : '↘';
  const topics = (ni.topics || []).slice(0, 4).map(t => chip(t.label, 'warn')).join(' ');
  const spikeChip = ni.spike ? chip('Attention spike', 'down') : '';
  const articles = (ni.articles || []).slice(0, 3).map(a => {
    return `<li><a href="${a.link}" target="_blank" rel="noopener">${a.title}</a></li>`;
  }).join('');

  return (
    '<div class="card">' +
    '<h3>Signals</h3>' +
    '<div class="signal-grid">' +
    `<div><span>Sentiment</span><span>${ni.avgSentiment.toFixed(2)}</span></div>` +
    `<div><span>Trend</span><span>${trendArrow} ${ni.trend.toFixed(2)}</span></div>` +
    `<div><span>Articles (30d)</span><span>${ni.count}</span></div>` +
    '</div>' +
    sentimentBar() +
    (topics ? '<div class="signal-chips" style="margin-top:8px;">' + topics + '</div>' : '') +
    (spikeChip ? '<div style="margin-top:8px;">' + spikeChip + '</div>' : '') +
    (articles ? '<h4 style="margin-top:12px;">Top Headlines</h4><ul class="small-list">' + articles + '</ul>' : '') +
    '</div>'
  );
}

function leadershipHtml(s) {
  if (!s.leadership || !s.leadership.available) {
    return '<div class="card"><h3>Leadership Changes</h3><p class="meta">No 8-K officer changes detected.</p></div>';
  }
  const changes = s.leadership.changes || [];
  if (!changes.length) {
    return '<div class="card"><h3>Leadership Changes</h3><p class="meta">No 8-K officer changes in the last 12 months.</p></div>';
  }
  const rows = changes.map(c => {
    const names = (c.names || []).join(', ') || '—';
    const dateCell = c.filingUrl
      ? `<a href="${c.filingUrl}" target="_blank" rel="noopener">${c.date || '—'}</a>`
      : (c.date || '—');
    return (
      `<tr><td>${dateCell}</td><td>${c.kind || '—'}</td><td>${names}</td><td>${c.snippet || '—'}</td></tr>`
    );
  }).join('');
  const flagBanner = s.signalFlags?.redFlag ? '<div class="flag-banner">⚠️ Red flag: officer departures + insider selling</div>' : '';

  return (
    '<div class="card">' +
    '<h3>Leadership Changes (8-K Item 5.02)</h3>' +
    flagBanner +
    '<div class="table-wrap"><table class="small-table"><thead><tr><th>Date</th><th>Type</th><th>Names</th><th>Snippet</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></div>' +
    '</div>'
  );
}

function hiringHtml(s) {
  if (!s.hiring || !s.hiring.available) {
    const reason = s.hiring?.reason === 'no_ats' ? 'No ATS board mapped for this ticker.' : 'Hiring data unavailable.';
    return '<div class="card"><h3>Hiring</h3><p class="meta">' + reason + '</p></div>';
  }
  const h = s.hiring;
  const ratio = s.fullTimeEmployees ? (h.openJobs / s.fullTimeEmployees).toFixed(3) : '—';
  const depts = (h.topDepartments || []).map(d => chip(d, 'warn')).join(' ');
  const remote = h.remoteShare ? chip(`${h.remoteShare}% remote`, h.remoteShare >= 30 ? 'up' : '') : '';
  const posted = (h.posted || []).map(p => `<li>${p.title} <span class="meta">${p.department || p.location}</span></li>`).join('');

  return (
    '<div class="card">' +
    '<h3>Hiring</h3>' +
    '<div class="signal-grid">' +
    `<div><span>Open Jobs</span><span>${h.openJobs}</span></div>` +
    `<div><span>Ratio (open / employees)</span><span>${ratio}</span></div>` +
    `<div><span>Earliest Opening</span><span>${h.earliestOpening || '—'}</span></div>` +
    '</div>' +
    (depts ? '<div style="margin-top:8px;">' + depts + '</div>' : '') +
    (remote ? '<div style="margin-top:6px;">' + remote + '</div>' : '') +
    (posted ? '<h4 style="margin-top:12px;">Recent Postings</h4><ul class="small-list">' + posted + '</ul>' : '') +
    '</div>'
  );
}

function optionsHtml(s) {
  const o = s.options;
  if (!o || !o.available) {
    return '<div class="card"><h3>Options</h3><p class="meta">No options data available.</p></div>';
  }
  const sig = o.signals;
  if (!sig || !sig.available) {
    return '<div class="card"><h3>Options</h3><p class="meta">Options chain empty.</p></div>';
  }

  // --- Layman probability card ---
  const exp = sig.expectedMove;
  const dte = sig.dte;
  const rangeLow = exp ? (o.currentPrice - exp.dollar).toFixed(2) : '—';
  const rangeHigh = exp ? (o.currentPrice + exp.dollar).toFixed(2) : '—';
  const sentCls = sig.sentiment === 'Bullish' ? 'up' : sig.sentiment === 'Bearish' ? 'down' : '';
  const sentChip = `<span class="chip ${sentCls}">${sig.sentiment}</span>`;

  const laymanParts = [];
  if (exp) {
    laymanParts.push(
      `<div class="layman-row">` +
      `<div class="layman-label">Expected Move (${dte != null ? dte + ' days' : ''})</div>` +
      `<div class="layman-range">` +
      `<span class="down">${fmtMoney(rangeLow)}</span>` +
      `<span class="meta"> — </span>` +
      `<span class="up">${fmtMoney(rangeHigh)}</span>` +
      `</div>` +
      `<div class="layman-sub">±${fmtMoney(exp.dollar)} (±${exp.percent}%)</div>` +
      `</div>`
    );
  }
  if (sig.support) {
    const distPct = ((o.currentPrice - sig.support.strike) / o.currentPrice * 100).toFixed(1);
    laymanParts.push(
      `<div class="layman-row">` +
      `<div class="layman-label">Support (put wall)</div>` +
      `<div><span class="up">${fmtMoney(sig.support.strike)}</span> <span class="meta">${distPct}% below</span></div>` +
      `</div>`
    );
  }
  if (sig.resistance) {
    const distPct = ((sig.resistance.strike - o.currentPrice) / o.currentPrice * 100).toFixed(1);
    laymanParts.push(
      `<div class="layman-row">` +
      `<div class="layman-label">Resistance (call wall)</div>` +
      `<div><span class="down">${fmtMoney(sig.resistance.strike)}</span> <span class="meta">${distPct}% above</span></div>` +
      `</div>`
    );
  }
  if (sig.maxPain) {
    laymanParts.push(
      `<div class="layman-row">` +
      `<div class="layman-label">Max Pain (options magnets to)</div>` +
      `<div>${fmtMoney(sig.maxPain)}</div>` +
      `</div>`
    );
  }

  const laymanCard =
    '<div class="card">' +
    '<h3>What Options Market Is Pricing In</h3>' +
    '<div style="margin-bottom:10px;">' + sentChip +
    (dte != null ? ` <span class="meta">· ${dte} days to expiry · ${o.nearestExpiry}</span>` : '') +
    '</div>' +
    (laymanParts.length
      ? laymanParts.join('')
      : '<p class="meta">Not enough data to compute probabilities.</p>') +
    '</div>';

  // --- Raw numbers (collapsible) ---
  const pcBar = (ratio) => {
    if (ratio == null) return '';
    const w = Math.min(ratio / 2, 1) * 100;
    const cls = ratio > 1.2 ? 'down' : ratio < 0.8 ? 'up' : '';
    return `<div class="sentiment-bar"><div class="sentiment-bar-fill ${cls}" style="width:${w}%"></div></div>`;
  };

  const unusualRows = (sig.unusual || []).map(u => {
    const cls = u.type === 'call' ? 'up' : 'down';
    return `<tr><td>${u.symbol}</td><td class="${cls}">${u.type}</td><td>${fmtMoney(u.strike)}</td><td>${fmtNum(u.vol)}</td><td>${fmtNum(u.oi)}</td><td>${u.ratio}×</td><td>${u.iv != null ? (u.iv * 100).toFixed(1) + '%' : '—'}</td></tr>`;
  }).join('');

  const rawCard =
    '<details class="card options-details">' +
    '<summary style="cursor:pointer;color:var(--muted);font-size:13px;">Show raw numbers</summary>' +
    '<div class="signal-grid" style="margin-top:12px;">' +
    `<div><span>Calls / Puts</span><span>${sig.callsCount} / ${sig.putsCount}</span></div>` +
    `<div><span>Call Vol</span><span>${fmtNum(sig.callVol)}</span></div>` +
    `<div><span>Put Vol</span><span>${fmtNum(sig.putVol)}</span></div>` +
    `<div><span>Put/Call Vol</span><span>${sig.pcRatioVol != null ? sig.pcRatioVol.toFixed(3) : '—'}</span></div>` +
    `<div><span>Put/Call OI</span><span>${sig.pcRatioOI != null ? sig.pcRatioOI.toFixed(3) : '—'}</span></div>` +
    `<div><span>Avg IV</span><span>${sig.avgIV != null ? (sig.avgIV * 100).toFixed(1) + '%' : '—'}</span></div>` +
    `<div><span>Near-Money IV</span><span>${sig.nearMoneyIV != null ? (sig.nearMoneyIV * 100).toFixed(1) + '%' : '—'}</span></div>` +
    '</div>' +
    pcBar(sig.pcRatioVol) +
    (unusualRows
      ? '<h4 style="margin-top:12px;">Unusual Activity</h4>' +
        '<div class="table-wrap"><table class="small-table"><thead><tr><th>Contract</th><th>Type</th><th>Strike</th><th>Volume</th><th>OI</th><th>Vol/OI</th><th>IV</th></tr></thead><tbody>' +
        unusualRows + '</tbody></table></div>'
      : '') +
    '</details>';

  return laymanCard + rawCard;
}

// ---------- tabs ----------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    if (isDetailView()) {
      history.pushState(null, '', '/');
    }
    showTab(tabId);
  });
});

// ---------- overview ----------
function miniRow(q) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${q.symbol}</div><div class="meta">${q.name || ''}</div></div>` +
    `<div style="text-align:right"><div class="chg ${chgClass(q.changePercent)}">${fmtPct(q.changePercent)}</div>` +
    `<div class="meta">${fmtMoney(q.price)}</div></div>`;
  el.addEventListener('click', () => openDetail(q.symbol));
  return el;
}
function cryptoRow(c) {
  const el = document.createElement('div');
  el.className = 'mini-row';
  el.innerHTML =
    `<div><div class="sym">${c.symbol}</div><div class="meta">${c.name || ''}</div></div>` +
    `<div style="text-align:right"><div class="chg ${chgClass(c.change24h)}">${fmtPct(c.change24h)}</div>` +
    `<div class="meta">${fmtMoney(c.price)}</div></div>`;
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
    root.innerHTML = '<div class="meta">No data.</div>';
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
async function runScreener() {
  const status = $('#screener-status');
  status.textContent = 'Searching…';
  const params = new URLSearchParams();
  const type = $('#f-type').value;
  const mcap = $('#f-mcap').value;
  const sector = $('#f-sector').value.trim();
  const pe = $('#f-pe').value;
  const dy = $('#f-dy').value;
  const pb = $('#f-pb').value;
  const roe = $('#f-roe').value;
  const de = $('#f-de').value;
  const cr = $('#f-cr').value;
  const beta = $('#f-beta').value;
  const eg = $('#f-eg').value;
  const limit = $('#f-limit').value;
  if (type && type !== 'all') params.set('type', type);
  if (mcap) params.set('marketCapMin', mcap);
  if (sector) params.set('sector', sector);
  if (pe) params.set('peMax', pe);
  if (dy) params.set('dividendYieldMin', dy);
  if (pb) params.set('pbMax', pb);
  if (roe) params.set('roeMin', roe);
  if (de) params.set('deMax', de);
  if (cr) params.set('currentRatioMin', cr);
  if (beta) params.set('betaMax', beta);
  if (eg) params.set('earningsGrowthMin', eg);
  if (limit) params.set('limit', limit);
  const q = $('#f-q').value.trim();
  if (q) params.set('q', q);
  try {
    const d = await getJSON('/api/screener?' + params.toString());
    const tbody = $('#screener-table tbody');
    tbody.innerHTML = '';
    if (d.degraded) status.className = 'status warn';
    if (d.degraded) {
      status.textContent = 'Source unavailable: ' + (d.error || 'unknown error');
    } else if (d.outsideUniverse) {
      status.textContent = `Found ${d.count} result(s) (matched outside curated universe).`;
    } else {
      status.textContent = `Found ${d.count} result(s).`;
    }
    (d.results || []).forEach((q) => {
      const tr = document.createElement('tr');
       tr.innerHTML =
        `<td class="sym-link">${q.symbol}</td><td>${q.name || ''}</td><td>${q.type}</td>` +
        `<td>${fmtMoney(q.price)}</td><td class="${chgClass(q.changePercent)}">${fmtPct(q.changePercent)}</td>` +
        `<td>${fmtCap(q.marketCap)}</td>` +
        `<td>${q.pe != null ? q.pe.toFixed(2) : '—'}</td>` +
        `<td>${q.priceToBook != null ? q.priceToBook.toFixed(2) : '—'}</td>` +
        `<td>${q.returnOnEquity != null ? (q.returnOnEquity * 100).toFixed(1) + '%' : '—'}</td>` +
        `<td>${q.debtToEquity != null ? q.debtToEquity.toFixed(2) : '—'}</td>` +
        `<td>${q.currentRatio != null ? q.currentRatio.toFixed(2) : '—'}</td>` +
        `<td>${q.beta != null ? q.beta.toFixed(2) : '—'}</td>` +
        `<td>${q.dividendYield != null ? q.dividendYield.toFixed(2) : '—'}</td><td>${q.sector || '—'}</td>`;
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
        `<td>${i + 1}</td><td>${c.name}</td><td>${c.symbol}</td><td>${fmtMoney(c.price)}</td>` +
        `<td class="${chgClass(c.change24h)}">${fmtPct(c.change24h)}</td><td>${fmtCap(c.marketCap)}</td><td>${fmtCap(c.volume)}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    status.className = 'status warn';
    status.textContent = 'Crypto error: ' + e.message;
  }
}

// ---------- header search typeahead ----------
(function initGlobalSearch() {
  const gs = $('#global-search');
  const gsr = $('#global-search-results');
  if (!gs || !gsr) return;
  let debounceTimer = null;

  function hideResults() { gsr.classList.add('hidden'); }
  gsr.addEventListener('mousedown', (e) => e.preventDefault());

  function addItem(r) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML =
      `<span class="sym">${r.symbol}</span>` +
      `<span class="meta">${r.name}${r.type === 'ETF' ? ' · ETF' : ''}</span>`;
    item.addEventListener('click', () => { gs.value = ''; hideResults(); openDetail(r.symbol); });
    return item;
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
          hdr.textContent = 'Curated universe';
          gsr.appendChild(hdr);
          curated.slice(0, 5).forEach((r) => gsr.appendChild(addItem(r)));
        }
        if (wider.length) {
          const hdr = document.createElement('div');
          hdr.className = 'search-section-header';
          hdr.textContent = 'Wider market';
          gsr.appendChild(hdr);
          wider.slice(0, 5).forEach((r) => gsr.appendChild(addItem(r)));
        }

        gsr.classList.remove('hidden');
      } catch { hideResults(); }
    }, 250);
  });

  gs.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = gsr.querySelector('.search-result-item');
      if (first) first.click();
    } else if (e.key === 'Escape') { hideResults(); }
  });

  gs.addEventListener('blur', () => setTimeout(hideResults, 150));
})();

// ---------- popstate (back/forward) ----------
window.addEventListener('popstate', () => {
  const sym = parseSymbolFromPath();
  if (sym) {
    openDetail(sym, false);
  } else {
    showTab('overview');
  }
});

// ---------- fear & greed widget ----------
async function loadFearGreed() {
  const el = $('#fear-greed-widget');
  if (!el) return;
  try {
    const d = await getJSON('/api/market/sentiment');
    if (d.degraded) { el.classList.add('hidden'); return; }
    const parts = [];
    if (d.vix) {
      parts.push(`<span class="meta">VIX</span> <span class="${d.vix.score > 60 ? 'down' : d.vix.score < 40 ? 'up' : ''}">${d.vix.vix?.toFixed(1) || '—'}</span>`);
    }
    if (d.fearGreed) {
      const fg = d.fearGreed;
      const cls = fg.value <= 25 ? 'up' : fg.value >= 75 ? 'down' : '';
      parts.push(`<span class="meta">F&G</span> <span class="${cls}">${fg.value} <span class="meta">${fg.classification}</span></span>`);
    }
    if (parts.length) {
      el.innerHTML = parts.join('<span style="margin:0 6px;color:var(--border)">·</span>');
      el.classList.remove('hidden');
    }
  } catch { el.classList.add('hidden'); }
}

// ---------- boot ----------
(function boot() {
  const sym = parseSymbolFromPath();
  if (sym) {
    openDetail(sym, false);
  } else {
    showTab('overview');
    loadOverview();
    loadCrypto();
    loadFearGreed();
  }
})();
