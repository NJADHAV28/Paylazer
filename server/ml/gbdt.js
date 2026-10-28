// Gradient-boosted decision trees for binary classification (log loss), with
// histogram binning and early stopping on a validation set. Pure JS.
// X: array of Float64Array rows (dense), y: 0/1 labels.

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

// Quantile bin edges per feature (at most maxBins distinct thresholds).
function binEdges(X, maxBins) {
  const F = X[0].length;
  const edges = [];
  for (let f = 0; f < F; f++) {
    const vals = Float64Array.from(X, (r) => r[f]).sort();
    const uniq = [];
    for (let i = 0; i < vals.length; i++) if (i === 0 || vals[i] !== vals[i - 1]) uniq.push(vals[i]);
    let cuts;
    if (uniq.length <= maxBins) cuts = uniq.slice(0, -1).map((v, i) => (v + uniq[i + 1]) / 2);
    else {
      cuts = [];
      for (let b = 1; b < maxBins; b++) {
        const v = vals[Math.floor((b / maxBins) * vals.length)];
        if (!cuts.length || v > cuts.at(-1)) cuts.push(v);
      }
    }
    edges.push(cuts);
  }
  return edges;
}

const binOf = (cuts, v) => {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v > cuts[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo; // 0..cuts.length
};

function buildTree(B, idx, g, h, edges, { maxDepth, minHess, lambda, minGain }) {
  const F = edges.length;
  const nodes = [];
  const grow = (rows, depth) => {
    let G = 0;
    let H = 0;
    for (const i of rows) { G += g[i]; H += h[i]; }
    const node = { leaf: -G / (H + lambda) };
    nodes.push(node);
    if (depth >= maxDepth || rows.length < 2) return node;
    let best = null;
    for (let f = 0; f < F; f++) {
      const nb = edges[f].length + 1;
      if (nb < 2) continue;
      const hg = new Float64Array(nb);
      const hh = new Float64Array(nb);
      for (const i of rows) { const b = B[i][f]; hg[b] += g[i]; hh[b] += h[i]; }
      let gl = 0;
      let hl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += hg[b];
        hl += hh[b];
        const gr = G - gl;
        const hr = H - hl;
        if (hl < minHess || hr < minHess) continue;
        const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - (G * G) / (H + lambda);
        if (gain > minGain && (!best || gain > best.gain)) best = { gain, f, b };
      }
    }
    if (!best) return node;
    const left = [];
    const right = [];
    for (const i of rows) (B[i][best.f] <= best.b ? left : right).push(i);
    node.f = best.f;
    node.t = edges[best.f][best.b]; // go left when value <= t
    node.gain = best.gain;
    delete node.leaf;
    node.l = grow(left, depth + 1);
    node.r = grow(right, depth + 1);
    return node;
  };
  return grow(idx, 0);
}

const predictTree = (node, x) => {
  let n = node;
  while (n.leaf === undefined) n = x[n.f] <= n.t ? n.l : n.r;
  return n.leaf;
};

function logloss(p, y) {
  let s = 0;
  for (let i = 0; i < y.length; i++) s -= y[i] ? Math.log(Math.max(1e-12, p[i])) : Math.log(Math.max(1e-12, 1 - p[i]));
  return s / y.length;
}

export function trainGbdt(X, y, Xv, yv, opts = {}) {
  const o = { trees: 400, lr: 0.05, maxDepth: 3, maxBins: 32, lambda: 1, minHess: 5, minGain: 1e-6, patience: 40, subsample: 0.8, seed: 7, ...opts };
  const edges = binEdges(X, o.maxBins);
  const B = X.map((r) => Uint8Array.from(r, (v, f) => binOf(edges[f], v)));
  const n = y.length;
  const base = Math.log(Math.max(1e-6, y.reduce((a, b) => a + b, 0) / n) / Math.max(1e-6, 1 - y.reduce((a, b) => a + b, 0) / n));
  const F = new Float64Array(n).fill(base);
  const Fv = new Float64Array(yv.length).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  let a = o.seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const trees = [];
  let bestLoss = Infinity;
  let bestIter = 0;
  const curve = [];
  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = Math.max(1e-6, p * (1 - p)); }
    const idx = [];
    for (let i = 0; i < n; i++) if (rand() < o.subsample) idx.push(i);
    const tree = buildTree(B, idx, g, h, edges, o);
    scaleLeaves(tree, o.lr);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += predictTree(tree, X[i]);
    for (let i = 0; i < yv.length; i++) Fv[i] += predictTree(tree, Xv[i]);
    const vl = logloss(Array.from(Fv, sigmoid), yv);
    curve.push(vl);
    if (vl < bestLoss - 1e-6) { bestLoss = vl; bestIter = t + 1; } else if (t + 1 - bestIter >= o.patience) break;
  }
  return { base, trees: trees.slice(0, bestIter), bestIteration: bestIter, validationLogloss: bestLoss, curve, params: o, importance: importance(trees.slice(0, bestIter), X[0].length) };
}

function scaleLeaves(node, k) {
  if (node.leaf !== undefined) { node.leaf = Math.round(node.leaf * k * 1e6) / 1e6; return; }
  scaleLeaves(node.l, k);
  scaleLeaves(node.r, k);
}

function importance(trees, F) {
  const imp = new Float64Array(F);
  const walk = (n) => { if (n.leaf !== undefined) return; imp[n.f] += n.gain; walk(n.l); walk(n.r); };
  trees.forEach(walk);
  const total = imp.reduce((s, v) => s + v, 0) || 1;
  return Array.from(imp, (v) => v / total);
}

// Strip training-only fields so the artifact stays small.
export function compactTree(node) {
  if (node.leaf !== undefined) return { v: node.leaf };
  return { f: node.f, t: Math.round(node.t * 1e6) / 1e6, l: compactTree(node.l), r: compactTree(node.r) };
}

export function predictCompact(model, x) {
  let z = model.base;
  for (const tree of model.trees) {
    let n = tree;
    while (n.v === undefined) n = x[n.f] <= n.t ? n.l : n.r;
    z += n.v;
  }
  return sigmoid(z);
}
