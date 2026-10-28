// Repayment-risk model trained on the real UCI "Default of Credit Card Clients"
// dataset (30,000 customers). It predicts the chance a customer will NOT pay
// the next bill from their last six billing cycles. Only scale-free
// behavioural features are used, so the model transfers from NT$ card bills to
// rupee invoice / subscription histories pulled from Razorpay.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainLogistic, predictLogistic, auc, binaryLogloss, calibration } from './linear.js';
import { trainGbdt, compactTree, predictCompact } from './gbdt.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATASET = join(root, 'data', 'datasets', 'uci-credit-default', 'credit-default.csv');
export const ARTIFACT = join(root, 'models', 'repayment-risk.json');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bucket = (s) => (s <= -2 ? 'none' : s === -1 ? 'paid' : s === 0 ? 'partial' : s === 1 ? 'late1' : s === 2 ? 'late2' : 'late3p');

// history: { status[6], bill[6], paid[6] }, most recent cycle first.
// status follows the UCI convention: -2 nothing billed, -1 paid in full on
// time, 0 partially paid / revolving, k>=1 payment delayed k months.
export function repaymentFeatures({ status, bill, paid }) {
  const f = [];
  status.forEach((s, i) => {
    f.push([`m${i}=${bucket(s)}`, 1]);
    f.push([`status_${i}`, clamp(s, -2, 8) / 8]); // ordinal form, useful to trees
  });
  const late = status.filter((s) => s > 0);
  f.push(['late_cycles', late.length / 6]);
  f.push(['max_delay', clamp(Math.max(0, ...status), 0, 8) / 8]);
  f.push(['recent_late', status[0] > 0 ? 1 : 0]);
  f.push(['late_2plus_ever', status.some((s) => s >= 2) ? 1 : 0]);
  f.push(['worsening', status[0] > status[2] ? 1 : 0]);
  let ratioSum = 0;
  let ratioN = 0;
  for (let i = 0; i < 5; i++) {
    const due = bill[i + 1];
    if (due > 0) {
      const r = clamp(paid[i] / due, 0, 1.5);
      f.push([`pay_ratio_${i}`, r]);
      ratioSum += r;
      ratioN++;
    } else f.push([`nothing_due_${i}`, 1]);
  }
  f.push(['pay_ratio_mean', ratioN ? ratioSum / ratioN : 1]);
  f.push(['no_payment_recent', bill[1] > 0 && paid[0] <= 0 ? 1 : 0]);
  const prior = bill.slice(1).filter((b) => b > 0);
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  f.push(['bill_growth', avg > 0 ? clamp(bill[0] / avg, 0, 3) / 3 : 0]);
  f.push(['empty_cycles', bill.filter((b) => b <= 0).length / 6]);
  return f;
}

function loadDataset() {
  const lines = readFileSync(DATASET, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const col = (name) => head.indexOf(name);
  const S = ['PAY_0', 'PAY_2', 'PAY_3', 'PAY_4', 'PAY_5', 'PAY_6'].map(col);
  const B = [1, 2, 3, 4, 5, 6].map((i) => col(`BILL_AMT${i}`));
  const P = [1, 2, 3, 4, 5, 6].map((i) => col(`PAY_AMT${i}`));
  const Y = col('DEFAULT_NEXT_MONTH');
  return lines.slice(1).map((line) => {
    const v = line.split(',').map(Number);
    return { status: S.map((i) => v[i]), bill: B.map((i) => v[i]), paid: P.map((i) => v[i]), y: v[Y] };
  });
}

// Deterministic stratified split.
function split(rows, seed) {
  const h = (i) => createHash('sha1').update(`${seed}:${i}`).digest().readUInt32BE(0) / 2 ** 32;
  const parts = { train: [], val: [], test: [] };
  for (const y of [0, 1]) {
    const group = rows.map((r, i) => ({ r, k: h(i) })).filter((x) => x.r.y === y).sort((a, b) => a.k - b.k).map((x) => x.r);
    const a = Math.floor(group.length * 0.7);
    const b = Math.floor(group.length * 0.85);
    parts.train.push(...group.slice(0, a));
    parts.val.push(...group.slice(a, b));
    parts.test.push(...group.slice(b));
  }
  return parts;
}

function encoder(rows) {
  const names = ['__bias'];
  const index = new Map([['__bias', 0]]);
  for (const r of rows) for (const [n] of repaymentFeatures(r)) if (!index.has(n)) { index.set(n, names.length); names.push(n); }
  return { names, index };
}

const encode = (r, index) => {
  const idx = [0];
  const val = [1];
  for (const [n, v] of repaymentFeatures(r)) {
    const i = index.get(n);
    if (i !== undefined && v !== 0) { idx.push(i); val.push(v); }
  }
  return { idx, val };
};

function ks(p, y) {
  const order = p.map((v, i) => [v, y[i]]).sort((a, b) => b[0] - a[0]);
  const pos = y.filter(Boolean).length;
  const neg = y.length - pos;
  let tp = 0, fp = 0, best = 0;
  for (const [, yy] of order) { if (yy) tp++; else fp++; best = Math.max(best, tp / pos - fp / neg); }
  return best;
}

function atThreshold(p, y, t) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  p.forEach((v, i) => { if (v >= t) { if (y[i]) tp++; else fp++; } else if (y[i]) fn++; else tn++; });
  return { threshold: t, tp, fp, fn, tn, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), accuracy: (tp + tn) / y.length };
}

const dense = (r, index, size) => {
  const x = new Float64Array(size);
  for (const [n, v] of repaymentFeatures(r)) {
    const i = index.get(n);
    if (i !== undefined) x[i] = v;
  }
  return x;
};

function bestThreshold(p, y) {
  let thr = 0.5;
  let bestF1 = -1;
  for (let t = 0.05; t <= 0.9; t += 0.01) {
    const m = atThreshold(p, y, t);
    const f1 = (2 * m.precision * m.recall) / Math.max(1e-9, m.precision + m.recall);
    if (f1 > bestF1) { bestF1 = f1; thr = Math.round(t * 100) / 100; }
  }
  return thr;
}

function evaluate(p, y, thr) {
  return {
    n: y.length, baseRate: y.reduce((a, b) => a + b, 0) / y.length, auc: auc(p, y), logloss: binaryLogloss(p, y),
    brier: p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / p.length, ks: ks(p, y), atThreshold: atThreshold(p, y, thr), calibration: calibration(p, y, 10),
  };
}

// Trains two candidates on the same features: regularised logistic regression
// and gradient-boosted trees. The validation set picks the model and the
// flagging threshold; the test set is only used once, to report both.
export function trainRepayment({ seed = 2026, onLog = () => {} } = {}) {
  const t0 = Date.now();
  const raw = readFileSync(DATASET);
  const rows = loadDataset();
  const { train, val, test } = split(rows, seed);
  const enc = encoder(train);
  const D = enc.names.length;
  const y = train.map((r) => r.y);
  const vy = val.map((r) => r.y);
  const yt = test.map((r) => r.y);
  onLog(`${rows.length} records · ${train.length} train / ${val.length} validation / ${test.length} test · ${D - 1} features`);

  // Candidate 1: logistic regression, L2 tuned on validation.
  const Xs = train.map((r) => encode(r, enc.index));
  let lr = null;
  for (const l2 of [1e-5, 1e-4, 1e-3]) {
    const w = trainLogistic(Xs, y, D, { epochs: 14, lr: 0.05, l2, seed });
    const pv = val.map((r) => predictLogistic(w, encode(r, enc.index)));
    const a = auc(pv, vy);
    if (!lr || a > lr.valAuc) lr = { l2, w, valAuc: a, valLogloss: binaryLogloss(pv, vy), pv };
  }
  onLog(`logistic regression: validation AUC ${lr.valAuc.toFixed(4)} (L2 ${lr.l2})`);

  // Candidate 2: gradient-boosted trees, depth tuned on validation, early stopping.
  const Xd = train.map((r) => dense(r, enc.index, D));
  const Vd = val.map((r) => dense(r, enc.index, D));
  let gb = null;
  for (const maxDepth of [3, 4]) {
    const m = trainGbdt(Xd, y, Vd, vy, { maxDepth, trees: 500, lr: 0.05, seed });
    const model = { base: m.base, trees: m.trees.map(compactTree) };
    const pv = Vd.map((x) => predictCompact(model, x));
    const a = auc(pv, vy);
    onLog(`boosted trees (depth ${maxDepth}): ${m.bestIteration} trees, validation AUC ${a.toFixed(4)}`);
    if (!gb || a > gb.valAuc) gb = { maxDepth, model, valAuc: a, valLogloss: binaryLogloss(pv, vy), pv, iterations: m.bestIteration, importance: m.importance };
  }

  const chosen = gb.valAuc > lr.valAuc ? 'gbdt' : 'logistic';
  const sel = chosen === 'gbdt' ? gb : lr;
  const thr = bestThreshold(sel.pv, vy);
  const predict = (r) => (chosen === 'gbdt' ? predictCompact(gb.model, dense(r, enc.index, D)) : predictLogistic(lr.w, encode(r, enc.index)));
  const pt = test.map(predict);
  const ptOther = chosen === 'gbdt' ? test.map((r) => predictLogistic(lr.w, encode(r, enc.index))) : test.map((r) => predictCompact(gb.model, dense(r, enc.index, D)));
  const testSel = evaluate(pt, yt, thr);
  const testOther = evaluate(ptOther, yt, bestThreshold(chosen === 'gbdt' ? lr.pv : gb.pv, vy));
  onLog(`selected ${chosen === 'gbdt' ? 'boosted trees' : 'logistic regression'} on validation; test AUC ${testSel.auc.toFixed(4)}`);

  const fp = createHash('sha256').update(JSON.stringify([seed, chosen, chosen === 'gbdt' ? gb.model : lr.w])).digest('hex').slice(0, 8);
  const LABELS = { none: 'Nothing billed', paid: 'Paid in full on time', partial: 'Paid part of it', late1: '1 month late', late2: '2 months late', late3p: '3+ months late' };
  const artifact = {
    name: 'repayment-risk',
    version: `rr-${fp}`,
    trainedAt: new Date().toISOString(),
    trainingSeconds: Math.round((Date.now() - t0) / 100) / 10,
    dataset: {
      name: 'Default of Credit Card Clients (UCI ML Repository, id 350)',
      url: 'https://archive.ics.uci.edu/dataset/350/default+of+credit+card+clients',
      licence: 'CC BY 4.0',
      sha256: createHash('sha256').update(raw).digest('hex'),
      rows: rows.length,
      positives: rows.filter((r) => r.y).length,
      split: { train: train.length, validation: val.length, test: test.length, method: 'stratified 70 / 15 / 15, fixed seed' },
      featuresUsed: 'repayment status, share of each bill paid and bill trend over 6 cycles (no absolute amounts, demographics or credit limit)',
    },
    params: {
      model: chosen === 'gbdt' ? `gradient-boosted trees (${gb.iterations} trees, depth ${gb.maxDepth}, learning rate 0.05)` : `logistic regression (L2 ${lr.l2})`,
      type: chosen, seed, threshold: thr,
    },
    candidates: [
      { type: 'logistic', label: 'Logistic regression', validationAuc: lr.valAuc, validationLogloss: lr.valLogloss, testAuc: (chosen === 'logistic' ? testSel : testOther).auc, testLogloss: (chosen === 'logistic' ? testSel : testOther).logloss, selected: chosen === 'logistic' },
      { type: 'gbdt', label: 'Gradient-boosted trees', validationAuc: gb.valAuc, validationLogloss: gb.valLogloss, testAuc: (chosen === 'gbdt' ? testSel : testOther).auc, testLogloss: (chosen === 'gbdt' ? testSel : testOther).logloss, selected: chosen === 'gbdt' },
    ],
    metrics: { validationAuc: sel.valAuc, test: testSel },
    names: enc.names,
    logistic: lr.w,
    gbdt: gb.model,
  };
  artifact.importance = enc.names.map((n, i) => ({ name: n, share: gb.importance[i] })).filter((f) => f.name !== '__bias' && f.share > 0).sort((a, b) => b.share - a.share).slice(0, 10);
  artifact.segments = Object.entries(LABELS).map(([key, label]) => {
    const ix = test.map((r, i) => (bucket(r.status[0]) === key ? i : -1)).filter((i) => i >= 0);
    return { key, label, n: ix.length, observed: ix.reduce((s, i) => s + yt[i], 0) / Math.max(1, ix.length), predicted: ix.reduce((s, i) => s + pt[i], 0) / Math.max(1, ix.length) };
  }).filter((g) => g.n > 0);
  return artifact;
}

export function saveRepayment(artifact) {
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, JSON.stringify(artifact));
  cached = null;
}

let cached = null;
export function loadRepayment() {
  if (cached) return cached;
  if (!existsSync(ARTIFACT)) return null;
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  if (!a.params?.type) return null; // artifact from an older format: retrain
  cached = { ...a, index: new Map(a.names.map((n, i) => [n, i])) };
  return cached;
}

export const tierOf = (score) => (score >= 0.5 ? 'high' : score >= 0.25 ? 'medium' : 'low');

export function scoreRepayment(history) {
  const m = loadRepayment();
  if (!m || !history) return null;
  const score = m.params.type === 'gbdt'
    ? predictCompact(m.gbdt, dense(history, m.index, m.names.length))
    : predictLogistic(m.logistic, encode(history, m.index));
  return { score, tier: tierOf(score), flagged: score >= m.params.threshold, model: m.version, threshold: m.params.threshold };
}

// Turns a customer's previous Razorpay invoices (oldest excluded beyond 6)
// into the six-cycle history the model expects. Returns null with no history.
export function historyFromInvoices(invoices, now = new Date(), termsDays = 15) {
  const t = Math.floor(now.getTime() / 1000);
  const prior = [...invoices].sort((a, b) => (b.date ?? b.created_at) - (a.date ?? a.created_at)).slice(0, 6);
  if (!prior.length) return null;
  const status = [];
  const bill = [];
  const paid = [];
  for (let i = 0; i < 6; i++) {
    const inv = prior[i];
    if (!inv || ['cancelled', 'deleted', 'draft'].includes(inv.status)) { status.push(-2); bill.push(0); paid.push(0); continue; }
    const due = inv.expire_by ?? (inv.date ?? inv.created_at) + termsDays * 86400;
    let s;
    if (inv.status === 'paid') {
      const late = ((inv.paid_at ?? due) - due) / 86400;
      s = late <= 0 ? -1 : Math.min(8, Math.ceil(late / 30));
    } else if (t > due) s = Math.min(8, Math.max(1, Math.ceil((t - due) / 86400 / 30)));
    else s = inv.status === 'partially_paid' ? 0 : -1;
    status.push(s);
    bill.push((inv.amount ?? 0) / 100);
    paid.push((inv.amount_paid ?? 0) / 100);
  }
  return { status, bill, paid };
}
