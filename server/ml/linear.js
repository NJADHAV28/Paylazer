// Sparse linear models (multinomial + binary logistic regression) trained with
// SGD, plus the evaluation metrics the pipeline reports. Pure JS, no deps.
// A sample is { idx: number[], val: number[] }.

// Small deterministic PRNG (mulberry32) so training is reproducible.
function makeRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const dot = (w, off, x) => {
  let s = 0;
  for (let i = 0; i < x.idx.length; i++) s += w[off + x.idx[i]] * x.val[i];
  return s;
};

export function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

function shuffled(n, rng) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Multinomial logistic regression. Returns weights as a flat array [K * D].
export function trainSoftmax(X, y, K, D, { epochs = 30, lr = 0.25, l2 = 1e-4, seed = 7, classWeight = null } = {}) {
  const W = new Float64Array(K * D);
  const rng = makeRng(seed);
  for (let ep = 0; ep < epochs; ep++) {
    const rate = lr / (1 + ep * 0.25);
    for (const n of shuffled(X.length, rng)) {
      const x = X[n];
      const p = softmax(Array.from({ length: K }, (_, k) => dot(W, k * D, x)));
      const cw = classWeight ? classWeight[y[n]] : 1;
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (y[n] === k ? 1 : 0)) * cw;
        const off = k * D;
        for (let i = 0; i < x.idx.length; i++) {
          const j = off + x.idx[i];
          W[j] -= rate * (g * x.val[i] + l2 * W[j]);
        }
      }
    }
  }
  return Array.from(W, (v) => Math.round(v * 1e5) / 1e5);
}

export const predictSoftmax = (W, K, D, x) => softmax(Array.from({ length: K }, (_, k) => dot(W, k * D, x)));

// Binary logistic regression.
export function trainLogistic(X, y, D, { epochs = 12, lr = 0.08, l2 = 1e-5, seed = 7 } = {}) {
  const W = new Float64Array(D);
  const rng = makeRng(seed);
  for (let ep = 0; ep < epochs; ep++) {
    const rate = lr / (1 + ep * 0.3);
    for (const n of shuffled(X.length, rng)) {
      const x = X[n];
      const g = sigmoid(dot(W, 0, x)) - y[n];
      for (let i = 0; i < x.idx.length; i++) {
        const j = x.idx[i];
        W[j] -= rate * (g * x.val[i] + l2 * W[j]);
      }
    }
  }
  return Array.from(W, (v) => Math.round(v * 1e5) / 1e5);
}

export const predictLogistic = (W, x) => sigmoid(dot(W, 0, x));

// ---------- metrics ----------
export function classification(probs, y, K) {
  const confusion = Array.from({ length: K }, () => new Array(K).fill(0));
  let correct = 0;
  let logloss = 0;
  const conf = [];
  probs.forEach((p, n) => {
    const pred = p.indexOf(Math.max(...p));
    confusion[y[n]][pred]++;
    if (pred === y[n]) correct++;
    logloss -= Math.log(Math.max(1e-12, p[y[n]]));
    conf.push({ p: p[pred], ok: pred === y[n] });
  });
  const f1s = [];
  for (let k = 0; k < K; k++) {
    const tp = confusion[k][k];
    const fp = confusion.reduce((s, row, i) => s + (i === k ? 0 : row[k]), 0);
    const fn = confusion[k].reduce((s, v, i) => s + (i === k ? 0 : v), 0);
    if (tp + fp + fn > 0) f1s.push((2 * tp) / (2 * tp + fp + fn));
  }
  return {
    n: y.length,
    accuracy: correct / Math.max(1, y.length),
    macroF1: f1s.reduce((a, b) => a + b, 0) / Math.max(1, f1s.length),
    logloss: logloss / Math.max(1, y.length),
    ece: ece(conf.map((c) => c.p), conf.map((c) => (c.ok ? 1 : 0))),
    confusion,
  };
}

// Expected calibration error over equal-width bins.
export function ece(p, y, bins = 10) {
  let err = 0;
  for (const b of calibration(p, y, bins)) err += (b.n / p.length) * Math.abs(b.predicted - b.observed);
  return err;
}

export function calibration(p, y, bins = 10) {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let n = 0, sp = 0, sy = 0;
    p.forEach((v, i) => {
      if (v >= lo && (v < hi || (b === bins - 1 && v <= hi))) { n++; sp += v; sy += y[i]; }
    });
    if (n) out.push({ bin: b, lo, hi, n, predicted: sp / n, observed: sy / n });
  }
  return out;
}

// Rank-based ROC AUC.
export function auc(p, y) {
  const order = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  let posRanks = 0, pos = 0;
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (order[k][1]) { posRanks += avg; pos++; }
    i = j;
  }
  const neg = order.length - pos;
  return pos && neg ? (posRanks - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

export function binaryLogloss(p, y) {
  return -p.reduce((s, v, i) => s + (y[i] ? Math.log(Math.max(1e-12, v)) : Math.log(Math.max(1e-12, 1 - v))), 0) / Math.max(1, p.length);
}
