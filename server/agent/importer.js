// Imports Razorpay Dashboard exports (CSV) for merchants who do not want to
// share API keys. Rows become the same entities the API sync produces.

import { upsertEntity, appendAudit } from '../db.js';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Accepted header spellings (API field names, Dashboard report labels).
const ALIASES = {
  id: ['id', 'payment_id', 'order_id_primary', 'invoice_id_primary', 'entity_id'],
  amount: ['amount', 'amount_inr', 'payment_amount', 'order_amount', 'invoice_amount', 'total_amount'],
  amount_paid: ['amount_paid', 'paid_amount'],
  amount_due: ['amount_due', 'due_amount', 'balance'],
  currency: ['currency'],
  status: ['status', 'payment_status', 'order_status', 'invoice_status'],
  order_id: ['order_id'],
  invoice_id: ['invoice_id'],
  method: ['method', 'payment_method'],
  bank: ['bank', 'bank_name'],
  wallet: ['wallet'],
  vpa: ['vpa', 'upi_id'],
  email: ['email', 'customer_email', 'email_id'],
  contact: ['contact', 'customer_contact', 'phone', 'mobile', 'contact_number'],
  name: ['name', 'customer_name'],
  error_code: ['error_code'],
  error_description: ['error_description', 'failure_reason', 'error_message'],
  error_reason: ['error_reason'],
  error_source: ['error_source'],
  error_step: ['error_step'],
  receipt: ['receipt'],
  invoice_number: ['invoice_number', 'invoice_no'],
  created_at: ['created_at', 'created', 'created_on', 'date', 'payment_date', 'issued_at', 'invoice_date'],
  expire_by: ['expire_by', 'due_date', 'expiry', 'expires_at'],
  paid_at: ['paid_at', 'paid_on', 'payment_received_on'],
};

const REQUIRED = {
  payment: ['id', 'amount', 'status', 'created_at'],
  order: ['id', 'amount', 'status', 'created_at'],
  invoice: ['id', 'amount', 'status', 'created_at'],
};

export function mapHeaders(headers) {
  const n = headers.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = n.findIndex((h) => names.includes(h));
    if (i >= 0) map[field] = i;
  }
  return map;
}

const IST = '+05:30';
export function parseTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return Number(s);
  if (/^\d{12,13}$/.test(s)) return Math.floor(Number(s) / 1000);
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/); // dd/mm/yyyy (Indian format)
  if (m) return Math.floor(Date.parse(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] ?? '0').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}${IST}`) / 1000);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/); // no zone: treat as IST
  if (m) return Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${IST}`) / 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const money = (v, unit) => {
  const raw = String(v ?? '').replace(/[₹,\s]/g, '');
  if (raw === '') return null; // empty cell means "not given", not zero
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return unit === 'paise' ? Math.round(n) : Math.round(n * 100);
};

function guessUnit(rows, col) {
  if (col === undefined) return 'rupees';
  const vals = rows.slice(0, 200).map((r) => String(r[col] ?? '').replace(/[₹,\s]/g, '')).filter(Boolean);
  return vals.some((v) => v.includes('.')) ? 'rupees' : 'unknown';
}

function toEntity(kind, r, map, unit) {
  const get = (f) => (map[f] !== undefined ? String(r[map[f]] ?? '').trim() : '');
  const id = get('id');
  if (!id) return { error: 'missing id' };
  const created = parseTime(get('created_at'));
  if (!created) return { error: `bad date "${get('created_at')}"` };
  const amount = money(get('amount'), unit);
  if (amount == null) return { error: `bad amount "${get('amount')}"` };
  const status = get('status').toLowerCase();
  const base = { id, entity: kind, amount, currency: get('currency') || 'INR', status, created_at: created, _source: 'csv_import' };
  if (kind === 'payment') {
    return {
      ...base, order_id: get('order_id') || null, invoice_id: get('invoice_id') || null, method: get('method').toLowerCase() || null,
      bank: get('bank') || null, wallet: get('wallet') || null, vpa: get('vpa') || null, email: get('email') || null, contact: get('contact') || null,
      error_code: get('error_code') || null, error_description: get('error_description') || null, error_reason: get('error_reason') || null,
      error_source: get('error_source') || null, error_step: get('error_step') || null, notes: get('name') ? { name: get('name') } : {},
    };
  }
  if (kind === 'order') {
    const paid = money(get('amount_paid'), unit);
    return { ...base, amount_paid: paid ?? (status === 'paid' ? amount : 0), receipt: get('receipt') || null, notes: { email: get('email') || undefined, contact: get('contact') || undefined, name: get('name') || undefined } };
  }
  const paid = money(get('amount_paid'), unit) ?? (status === 'paid' ? amount : 0);
  return {
    ...base, type: 'invoice', invoice_number: get('invoice_number') || null, amount_paid: paid, amount_due: money(get('amount_due'), unit) ?? amount - paid,
    date: created, expire_by: parseTime(get('expire_by')), paid_at: parseTime(get('paid_at')), email_status: 'sent', sms_status: 'sent',
    customer_details: { name: get('name') || null, email: get('email') || null, contact: get('contact') || null },
  };
}

export function analyse(kind, csv, unit = 'auto') {
  if (!REQUIRED[kind]) throw Object.assign(new Error('kind must be payment, order or invoice'), { status: 400 });
  const rows = parseCsv(csv);
  if (rows.length < 2) throw Object.assign(new Error('The file has no data rows'), { status: 400 });
  const [headers, ...data] = rows;
  const map = mapHeaders(headers);
  const missing = REQUIRED[kind].filter((f) => map[f] === undefined);
  const detected = guessUnit(data, map.amount);
  const useUnit = unit === 'auto' ? (detected === 'unknown' ? null : detected) : unit;
  const result = { kind, rows: data.length, headers, mapped: Object.fromEntries(Object.entries(map).map(([f, i]) => [f, headers[i]])), missing, unit: useUnit, unitDetected: detected, sample: [], errors: [] };
  if (missing.length || !useUnit) return result;
  const entities = [];
  data.forEach((r, i) => {
    const e = toEntity(kind, r, map, useUnit);
    if (e.error) { if (result.errors.length < 10) result.errors.push(`Row ${i + 2}: ${e.error}`); }
    else entities.push(e);
  });
  result.valid = entities.length;
  result.invalid = data.length - entities.length;
  result.sample = entities.slice(0, 5).map((e) => ({ id: e.id, amount: e.amount / 100, status: e.status, created: new Date(e.created_at * 1000).toISOString(), method: e.method ?? null, error: e.error_description ?? e.error_reason ?? null }));
  result.statuses = Object.entries(entities.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] ?? 0) + 1 }), {})).map(([status, n]) => ({ status, n }));
  result.entities = entities;
  return result;
}

export function commit(kind, csv, unit) {
  const r = analyse(kind, csv, unit);
  if (r.missing.length) throw Object.assign(new Error(`Missing columns: ${r.missing.join(', ')}`), { status: 400 });
  if (!r.unit) throw Object.assign(new Error('Choose whether amounts are in rupees or paise'), { status: 400 });
  for (const e of r.entities) upsertEntity(kind, e);
  appendAudit({ actor: 'human', type: 'DATA_IMPORTED', summary: `Imported ${r.valid} ${kind}s from a Razorpay export${r.invalid ? ` (${r.invalid} rows skipped)` : ''}`, data: { kind, valid: r.valid, invalid: r.invalid } });
  return { imported: r.valid, skipped: r.invalid, errors: r.errors };
}
