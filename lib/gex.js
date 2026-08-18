// Heuristic Gamma Exposure from Yahoo options chain
// Uses OI, IV, moneyness as proxy for gamma. No external data.

function normCdf(x) {
  return 0.5 * (1 + Math.erf(x / Math.SQRT2));
}

function approxDelta(strike, price, iv, dte) {
  if (!iv || iv <= 0 || dte <= 0) return 0;
  const sigmaSqrtT = iv * Math.sqrt(dte / 365);
  const d1 = (Math.log(price / strike) + 0.5 * sigmaSqrtT * sigmaSqrtT) / sigmaSqrtT;
  return normCdf(d1); // call delta
}

function approxGamma(price, strike, iv, dte) {
  if (!iv || iv <= 0 || dte <= 0) return 0;
  const sigmaSqrtT = iv * Math.sqrt(dte / 365);
  const d1 = (Math.log(price / strike) + 0.5 * sigmaSqrtT * sigmaSqrtT) / sigmaSqrtT;
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return pdf / (price * sigmaSqrtT);
}

export function computeGexForEntry(entry, price, dte) {
  if (!entry || !price || !dte) return { netGex: 0, gexByStrike: [] };
  const calls = entry.calls || [];
  const puts = entry.puts || [];
  const gexByStrike = new Map();
  
  for (const c of calls) {
    if (!c.strike || !c.oi) continue;
    const iv = c.iv || 0;
    const gamma = approxGamma(price, c.strike, iv, dte);
    const gex = c.oi * gamma * 100 * price; // rough dollar gamma
    const key = c.strike;
    gexByStrike.set(key, (gexByStrike.get(key)||0) + gex);
  }
  for (const p of puts) {
    if (!p.strike || !p.oi) continue;
    const iv = p.iv || 0;
    const gamma = approxGamma(price, p.strike, iv, dte);
    const gex = -p.oi * gamma * 100 * price; // puts negative gamma exposure
    const key = p.strike;
    gexByStrike.set(key, (gexByStrike.get(key)||0) + gex);
  }
  let netGex = 0;
  const byStrike = [];
  for (const [strike, gex] of gexByStrike) {
    netGex += gex;
    byStrike.push({ strike, gex });
  }
  byStrike.sort((a,b)=>a.strike-b.strike);
  return { netGex, gexByStrike: byStrike };
}

export function summarizeGex(chain, price) {
  if (!chain?.chain?.length || !price) return { available:false };
  const results = [];
  for (const e of chain.chain) {
    const dte = Math.max(1, Math.round((e.expiry*1000 - Date.now())/86400000));
    const g = computeGexForEntry(e, price, dte);
    results.push({
      expiry: e.expiry,
      dte,
      netGex: g.netGex,
      gexByStrike: g.gexByStrike
    });
  }
  // find gamma flip: sign change around price
  const active = results[0];
  const flip = active?.gexByStrike?.length ? (() => {
    const below = active.gexByStrike.filter(s=>s.strike < price).reduce((s,x)=>s+x.gex,0);
    const above = active.gexByStrike.filter(s=>s.strike > price).reduce((s,x)=>s+x.gex,0);
    return { below, above, flip: Math.sign(below) !== Math.sign(above) };
  })() : null;
  return {
    available:true,
    expiries: results,
    gammaFlip: flip
  };
}
