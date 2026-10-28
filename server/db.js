// Persistence on Node's built-in SQLite.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS, hashEntry } from './engine/audit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.PAYLAZAR_DB ?? join(root, 'data', 'paylazar-live.db');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entities (kind TEXT, id TEXT, created_at INTEGER, status TEXT, body TEXT, synced_at TEXT, PRIMARY KEY (kind, id));
  CREATE INDEX IF NOT EXISTS entities_kind_created ON entities (kind, created_at);
  CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, type TEXT, status TEXT, grp TEXT, amount REAL, opened_at TEXT, closed_at TEXT, live INTEGER, body TEXT);
  CREATE INDEX IF NOT EXISTS cases_status ON cases (status);
  CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, case_id TEXT, action TEXT, status TEXT, due_at TEXT, created_at TEXT, done_at TEXT, body TEXT);
  CREATE INDEX IF NOT EXISTS actions_status ON actions (status);
  CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, ts TEXT, case_id TEXT, actor TEXT, type TEXT, summary TEXT, data TEXT, prev_hash TEXT, hash TEXT);
  CREATE INDEX IF NOT EXISTS audit_case ON audit (case_id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v) => (v == null ? null : JSON.parse(v));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- settings ----
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// ---- Razorpay entities (raw, as received) ----
export function upsertEntity(kind, e) {
  db.prepare('INSERT OR REPLACE INTO entities (kind, id, created_at, status, body, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, e.id, e.created_at ?? 0, e.status ?? null, JSON.stringify(e), new Date().toISOString());
}
export function getEntity(kind, id) {
  return parse(db.prepare('SELECT body FROM entities WHERE kind = ? AND id = ?').get(kind, id)?.body);
}
export function entities(kind, { since = 0 } = {}) {
  return db.prepare('SELECT body FROM entities WHERE kind = ? AND created_at >= ? ORDER BY created_at').all(kind, since).map((r) => JSON.parse(r.body));
}
export function entityCounts() {
  return Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind').all().map((r) => [r.kind, r.n]));
}

// ---- cases ----
export function saveCase(c) {
  db.prepare('INSERT OR REPLACE INTO cases (id, type, status, grp, amount, opened_at, closed_at, live, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, c.type, c.status, c.group, c.amount, c.openedAt, c.closedAt ?? null, c.live ? 1 : 0, JSON.stringify(c));
}
export function getCase(id) {
  return parse(db.prepare('SELECT body FROM cases WHERE id = ?').get(id)?.body);
}
export function listCases({ status, type, group, live, limit = 2000 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (type) { where.push('type = ?'); args.push(type); }
  if (group) { where.push('grp = ?'); args.push(group); }
  if (live != null) { where.push('live = ?'); args.push(live ? 1 : 0); }
  const sql = `SELECT body FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map((r) => JSON.parse(r.body));
}

// ---- actions ----
export function saveAction(a) {
  db.prepare('INSERT OR REPLACE INTO actions (id, case_id, action, status, due_at, created_at, done_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.id, a.caseId, a.action, a.status, a.dueAt ?? null, a.createdAt, a.doneAt ?? null, JSON.stringify(a));
}
export function getAction(id) {
  return parse(db.prepare('SELECT body FROM actions WHERE id = ?').get(id)?.body);
}
export function listActions({ status, caseId, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    const list = String(status).split(',');
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  if (caseId) { where.push('case_id = ?'); args.push(caseId); }
  const sql = `SELECT body FROM actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map((r) => JSON.parse(r.body));
}

// ---- audit (one global hash chain) ----
export function appendAudit({ caseId = null, actor, type, summary, data = null, ts = new Date().toISOString() }) {
  const last = db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get();
  const e = { seq: (last?.seq ?? 0) + 1, ts, caseId, actor, type, summary, data, prevHash: last?.hash ?? GENESIS };
  e.hash = hashEntry(e.prevHash, e);
  db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(e.seq, e.ts, e.caseId, e.actor, e.type, e.summary, json(e.data), e.prevHash, e.hash);
  return e;
}
const toEntry = (r) => ({ seq: r.seq, ts: r.ts, caseId: r.case_id, actor: r.actor, type: r.type, summary: r.summary, data: parse(r.data), prevHash: r.prev_hash, hash: r.hash });
function auditWhere({ caseId, type, actor }) {
  const where = [];
  const args = [];
  if (caseId) { where.push('case_id = ?'); args.push(caseId); }
  if (type) { where.push('type = ?'); args.push(type); }
  if (actor) { where.push('actor = ?'); args.push(actor); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
export function auditEntries({ limit, offset = 0, order = 'ASC', ...filters } = {}) {
  const w = auditWhere(filters);
  const sql = `SELECT * FROM audit ${w.sql} ORDER BY seq ${order === 'DESC' ? 'DESC' : 'ASC'} ${limit ? 'LIMIT ? OFFSET ?' : ''}`;
  return db.prepare(sql).all(...w.args, ...(limit ? [limit, offset] : [])).map(toEntry);
}
export function auditCount(filters = {}) {
  const w = auditWhere(filters);
  return db.prepare(`SELECT COUNT(*) AS n FROM audit ${w.sql}`).get(...w.args).n;
}
