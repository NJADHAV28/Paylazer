// Self-recovery model trained on the merchant's own Razorpay history: the chance
// a case gets paid with no help from Paylazar. Learned only from cases Paylazar
// never touched (imported history + holdout), evaluated on a time-based split.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { trainLogistic, predictLogistic, auc, binaryLogloss, calibration } from './linear.js';
import { listCases } from '../db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT = process.env.PAYLAZAR_RECOVERY_MODEL ?? join(root, 'data', 'models', 'recovery.json');
export const MIN_EXAMPLES = 200;
export const MIN_PER_CLASS = 20;

const IST = 5.5 * 3600;
function features(c) {
  const hour = Math.floor(((c.openedSec + IST) % 86400) / 3600);
  const day = new Date((c.openedSec + IST) * 1000).getUTCDay();
  return [
    [`type=${c.type}`, 1], [`cause=${c.cause}`, 1], [`method=${c.method ?? 'none'}`, 1], [`provider=${c.provider ?? 'none'}`, 1],
    ['amount_log', Math.log10(Math.max(1, c.amount)) / 6], [`hour=${hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`, 1],
    ['weekend', day === 0 || day === 6 ? 1 : 0], ['repeat_attempts', (c.attempts ?? 0) >= 2 ? 1 : 0],
    ['has_contact', c.customer?.email || c.customer?.contact ? 1 : 0],
  ];
}

const encode = (c, index, grow, names) => {
  const idx = [0];
  const val = [1];
  for (const [n, v] of features(c)) {
    let i = index.get(n);
    if (i === undefined && grow) { i = names.length; names.push(n); index.set(n, i); }
    if (i !== undefined && v) { idx.push(i); val.push(v); }
  }
  return { idx, val };
};

export function trainingData() {
  return listCases({ limit: 1e6 }).filter((c) => (c.group === 'historical' || c.group === 'holdout') && c.status !== 'open').sort((a, b) => a.openedSec - b.openedSec);
}

export function readiness() {
  const data = trainingData();
  const pos = data.filter((c) => c.recovered).length;
  return { examples: data.length, positives: pos, negatives: data.length - pos, ready: data.length >= MIN_EXAMPLES && pos >= MIN_PER_CLASS && data.length - pos >= MIN_PER_CLASS, minExamples: MIN_EXAMPLES, minPerClass: MIN_PER_CLASS };
}

export function trainRecovery() {
  const r = readiness();
  if (!r.ready) throw Object.assign(new Error(`Not enough real history yet: ${r.examples} closed cases (${r.positives} recovered). Need ${MIN_EXAMPLES}+, with at least ${MIN_PER_CLASS} of each outcome.`), { status: 409 });
  const data = trainingData();
  const cut = Math.floor(data.length * 0.8);
  const train = data.slice(0, cut);
  const test = data.slice(cut);
  const names = ['__bias'];
  const index = new Map([['__bias', 0]]);
  const X = train.map((c) => encode(c, index, true, names));
  const w = trainLogistic(X, train.map((c) => (c.recovered ? 1 : 0)), names.length, { epochs: 20, lr: 0.05, l2: 1e-3 });
  const pt = test.map((c) => predictLogistic(w, encode(c, index, false)));
  const yt = test.map((c) => (c.recovered ? 1 : 0));
  const artifact = {
    name: 'self-recovery',
    version: `sr-${createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 8)}`,
    trainedAt: new Date().toISOString(),
    data: { examples: data.length, train: train.length, test: test.length, from: data[0].openedAt, to: data.at(-1).openedAt, split: 'time-based: oldest 80% train, newest 20% test' },
    metrics: { test: { n: yt.length, baseRate: yt.reduce((a, b) => a + b, 0) / yt.length, auc: auc(pt, yt), logloss: binaryLogloss(pt, yt), calibration: calibration(pt, yt, 5) } },
    names, weights: w,
  };
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, JSON.stringify(artifact));
  cached = null;
  return artifact;
}

let cached = null;
export function loadRecovery() {
  if (cached) return cached;
  if (!existsSync(ARTIFACT)) return null;
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  cached = { ...a, index: new Map(a.names.map((n, i) => [n, i])) };
  return cached;
}

export function scoreSelfRecovery(c) {
  const m = loadRecovery();
  return m ? predictLogistic(m.weights, encode(c, m.index, false)) : null;
}
