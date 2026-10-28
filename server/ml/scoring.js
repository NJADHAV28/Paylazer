// Scoring helpers for the repayment-risk model: single histories (the "Try it"
// form) and CSV batches (UI upload and `npm run score`).

import { scoreRepayment, loadRepayment } from './repayment.js';
import { parseCsv } from '../agent/importer.js';

const WORDS = {
  none: -2, nothing: -2, 'nothing billed': -2, 'no bill': -2,
  paid: -1, 'on time': -1, on_time: -1, 'paid on time': -1, ontime: -1,
  partial: 0, 'partly paid': 0, 'part paid': 0, 'partially paid': 0,
};

export function parseStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s in WORDS) return WORDS[s];
  const m = s.match(/^(\d+)\s*(month|months|m)?\s*(late)?$/) || s.match(/^late\s*(\d+)/);
  if (m) return Math.min(8, Math.max(1, Number(m[1])));
  const n = Number(s);
  if (Number.isInteger(n) && n >= -2 && n <= 8) return n;
  throw new Error(`Unrecognised status "${v}" (use paid, partial, none, or months late 1-8)`);
}

export function validateHistory(h) {
  const ok = (a) => Array.isArray(a) && a.length === 6;
  if (!h || !ok(h.status) || !ok(h.bill) || !ok(h.paid)) throw Object.assign(new Error('history needs status, bill and paid arrays of 6 cycles (most recent first)'), { status: 400 });
  const out = { status: h.status.map(parseStatus), bill: h.bill.map(Number), paid: h.paid.map(Number) };
  if ([...out.bill, ...out.paid].some((v) => !Number.isFinite(v) || v < 0)) throw Object.assign(new Error('Bill and paid amounts must be non-negative numbers'), { status: 400 });
  return out;
}

export function scoreOne(h) {
  if (!loadRepayment()) throw Object.assign(new Error('Model not trained: run npm run train'), { status: 412 });
  return scoreRepayment(validateHistory(h));
}

export const TEMPLATE = [
  ['customer', ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`status_${i}`, `bill_${i}`, `paid_${i}`])].join(','),
  ['Example on-time customer', ...Array(6).fill(['paid', '5000', '5000']).flat()].join(','),
  ['Example slipping customer', '2', '8000', '0', '1', '7000', '500', 'partial', '6000', '3000', 'paid', '6000', '6000', 'paid', '5000', '5000', 'paid', '5000', '5000'].join(','),
].join('\n');

// Cycle 1 is the most recent bill. Returns rows plus a CSV with the scores appended.
export function scoreCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw Object.assign(new Error('The file has no data rows'), { status: 400 });
  const [head, ...data] = rows;
  const h = head.map((x) => x.trim().toLowerCase());
  const col = (n) => h.indexOf(n);
  const need = [1, 2, 3, 4, 5, 6].flatMap((i) => [`status_${i}`, `bill_${i}`, `paid_${i}`]);
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw Object.assign(new Error(`Missing columns: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}. Download the template.`), { status: 400 });
  const out = [];
  for (const [i, r] of data.entries()) {
    try {
      const pick = (k) => [1, 2, 3, 4, 5, 6].map((j) => r[col(`${k}_${j}`)]);
      const s = scoreOne({ status: pick('status'), bill: pick('bill'), paid: pick('paid') });
      out.push({ row: i + 2, customer: col('customer') >= 0 ? r[col('customer')] : '', score: s.score, tier: s.tier, flagged: s.flagged, error: null, raw: r });
    } catch (e) {
      out.push({ row: i + 2, customer: col('customer') >= 0 ? r[col('customer')] : '', score: null, tier: null, flagged: null, error: e.message, raw: r });
    }
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v ?? ''));
  const csv = [[...head, 'risk_score', 'risk_tier', 'flagged', 'error'].map(esc).join(',')]
    .concat(out.map((o) => [...o.raw, o.score == null ? '' : o.score.toFixed(4), o.tier ?? '', o.flagged == null ? '' : o.flagged ? 'yes' : 'no', o.error ?? ''].map(esc).join(',')))
    .join('\n');
  return { rows: out.map(({ raw, ...rest }) => rest), csv, model: loadRepayment().version };
}
