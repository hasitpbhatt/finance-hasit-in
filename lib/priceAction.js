// Price action breakout / retest detection from daily closes
// Input: closes = [{t, c, v}] sorted ascending
export function detectSwingLevels(closes, lookback = 50) {
  if (!closes || closes.length < lookback) return null;
  const slice = closes.slice(-lookback);
  let highs = [];
  let lows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const prev = slice.slice(i-2, i+1);
    const next = slice.slice(i, i+3);
    const isHigh = prev.every(p => p.c <= slice[i].c) && next.every(p => p.c <= slice[i].c);
    const isLow = prev.every(p => p.c >= slice[i].c) && next.every(p => p.c >= slice[i].c);
    if (isHigh) highs.push({price:slice[i].c, t:slice[i].t});
    if (isLow) lows.push({price:slice[i].c, t:slice[i].t});
  }
  if (!highs.length || !lows.length) return null;
  const resistance = Math.max(...highs.map(h=>h.price));
  const support = Math.min(...lows.map(l=>l.price));
  return { resistance, support, highs, lows };
}

export function checkBreakout(closes, levels, volumeThreshold = 1.5) {
  if (!closes?.length || !levels) return null;
  const last = closes[closes.length-1];
  const prev = closes[closes.length-2];
  if (!last || !prev) return null;
  const avgVol = closes.slice(-20).reduce((s,c)=>s+(c.v||0),0)/20;
  const volOk = (last.v||0) > avgVol * volumeThreshold;
  const priceAboveRes = last.c > levels.resistance;
  const priceAboveResPrev = prev.c <= levels.resistance;
  const breakout = priceAboveRes && priceAboveResPrev && volOk;
  return {
    breakout,
    resistance: levels.resistance,
    price: last.c,
    volumeOk: volOk,
    // retest check: price came back to within 1% of resistance
    retest: breakout ? null : checkRetest(closes, levels)
  };
}

export function checkRetest(closes, levels, tolerance = 0.01) {
  if (!closes?.length || !levels) return null;
  const last = closes[closes.length-1];
  const recent = closes.slice(-10);
  const hit = recent.find(c => Math.abs(c.c - levels.resistance)/levels.resistance <= tolerance);
  if (!hit) return null;
  // retest holds if after hit price stays above level
  const afterHit = closes.slice(closes.indexOf(hit)+1);
  const holds = afterHit.length && afterHit.every(c => c.c >= levels.resistance * (1 - tolerance));
  return {
    retest: true,
    level: levels.resistance,
    price: last.c,
    holds
  };
}

export function summarizePriceAction(closes) {
  const levels = detectSwingLevels(closes);
  if (!levels) return { available:false };
  const breakout = checkBreakout(closes, levels);
  return {
    available:true,
    support: levels.support,
    resistance: levels.resistance,
    breakout: breakout?.breakout || false,
    retest: breakout?.retest || null,
    volumeOk: breakout?.volumeOk || false
  };
}
