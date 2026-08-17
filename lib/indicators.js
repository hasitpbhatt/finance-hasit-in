// Server-side technical indicators computed from a price series (no network).
// Series is [{ t, c }]; indicators return arrays aligned to the same indexes,
// with null where not enough history exists.

// Simple moving average over the last n closes. Returns an array same length as
// closes, null until the window is full.
export function sma(closes, n) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Relative Strength Index (Wilder smoothing), period n (default 14).
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= n;
  avgLoss /= n;
  out[n] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = n + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

// EMA helper used by MACD.
function ema(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (!closes.length) return out;
  const k = 2 / (n + 1);
  let prev = closes[0];
  out[0] = prev;
  for (let i = 1; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// MACD (12/26/9). Returns { macd, signal, hist } arrays aligned to closes.
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const eFast = ema(closes, fast);
  const eSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (eFast[i] != null && eSlow[i] != null ? eFast[i] - eSlow[i] : null));

  // Compute signal EMA aligned to macdLine, skipping nulls but preserving index alignment.
  const signal = new Array(macdLine.length).fill(null);
  const k = 2 / (signalPeriod + 1);
  let prev = null;
  let started = false;
  for (let i = 0; i < macdLine.length; i++) {
    const v = macdLine[i];
    if (v == null) continue;
    if (!started) {
      prev = v;
      signal[i] = prev;
      started = true;
    } else {
      prev = v * k + prev * (1 - k);
      signal[i] = prev;
    }
  }

  const hist = macdLine.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { macd: macdLine, signal, hist };
}

// One-shot: compute the full indicator set over a series of closes.
// Returns { sma20, sma50, sma200, rsi14, macd: {...} }.
export function computeIndicators(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdLine = macd(closes);
  return {
    sma20,
    sma50,
    sma200,
    rsi14,
    macd: macdLine,
  };
}

// Latest non-null value from a series array.
export function lastNonNull(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}