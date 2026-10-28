import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASE_TYPES, CAUSES, ACTIONS, CHANNELS, TYPE_ORDER } from './engine/catalog.js';
import { DEFAULT_POLICY, POLICY_DOCS } from './engine/policy.js';
import { verifyChain } from './engine/audit.js';
import * as db from './db.js';
import { paymentHealth } from './agent/health.js';
import { measure } from './agent/measure.js';
import { tick, startLoop } from './agent/loop.js';
import { approveAction, rejectAction, completeTask, flagCase, recordPromise, closeCase } from './agent/execute.js';
import { currentPolicy, updatePolicy, merchantName } from './agent/settings.js';
import { analyse as analyseImport, commit as commitImport } from './agent/importer.js';
import { loadRepayment } from './ml/repayment.js';
import { loadRecovery, readiness, trainRecovery } from './ml/recovery.js';
import { scoreOne, scoreCsv, TEMPLATE } from './ml/scoring.js';
import { draftForCase, aiInfo } from './ai/copilot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => String(req.body?.by ?? '').trim() || 'Team member';

// Razorpay exports and scoring files can be large.
app.use(['/api/import', '/api/models/repayment/score-csv'], express.json({ limit: '40mb' }));
app.use(express.json({ limit: '1mb' }));

// ---- connection status (the AI key is read from .env only) ----
app.get('/api/connection', (_req, res) => {
  res.json({ ai: aiInfo(), data: { counts: db.entityCounts(), lastImport: db.getSetting('lastImport') }, lastTick: db.getSetting('lastTick') });
});

// ---- import of Razorpay Dashboard exports ----
app.post('/api/import/analyse', (req, res) => {
  const { entities: _e, ...summary } = analyseImport(req.body?.kind, String(req.body?.csv ?? ''), req.body?.unit ?? 'auto');
  res.json(summary);
});
app.post('/api/import/commit', ah(async (req, res) => {
  const r = commitImport(req.body?.kind, String(req.body?.csv ?? ''), req.body?.unit);
  db.setSetting('lastImport', { at: new Date().toISOString(), kind: req.body?.kind, rows: r.imported });
  const t = await tick();
  res.json({ ...r, detected: t.detected, ai: t.ai });
}));

// ---- overview ----
app.get('/api/overview', (_req, res) => {
  const counts = db.entityCounts();
  res.json({ ...measure(), recent: db.auditEntries({ limit: 12, order: 'DESC' }), incidents: paymentHealth().incidents, hasData: Object.values(counts).some(Boolean), ai: aiInfo() });
});

app.get('/api/meta', (_req, res) => res.json({ caseTypes: CASE_TYPES, typeOrder: TYPE_ORDER, causes: CAUSES, actions: ACTIONS, channels: CHANNELS, policyDocs: POLICY_DOCS, defaultPolicy: DEFAULT_POLICY }));

// ---- cases ----
const row = (c) => ({
  id: c.id, type: c.type, status: c.status, group: c.group, amount: c.amount, customer: c.customer?.name ?? c.customer?.email ?? c.customer?.contact ?? null,
  cause: c.cause, causeLabel: c.causeLabel, provider: c.provider, risk: c.risk?.score ?? null, selfRecovery: c.selfRecovery ?? null, ai: !!c.aiDiagnosis && c.aiDiagnosis.cause === c.cause,
  openedAt: c.openedAt, closedAt: c.closedAt, recovered: c.recovered?.amount ?? 0, via: c.recovered?.via ?? null,
  contacts: c.contacts?.length ?? 0, nextStep: c.nextStep ?? null, nextStepAt: c.nextStepSec ? new Date(c.nextStepSec * 1000).toISOString() : null, live: c.live,
});

app.get('/api/cases', (req, res) => {
  const { status, type, group, q, scope = 'live' } = req.query;
  let rows = db.listCases({ status: status || undefined, type: type || undefined, group: group || undefined, live: scope === 'history' ? false : scope === 'all' ? undefined : true, limit: 5000 }).map(row);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => `${r.id} ${r.customer ?? ''}`.toLowerCase().includes(needle));
  }
  res.json({ total: rows.length, rows: rows.slice(0, 500) });
});

app.get('/api/cases/:id', (req, res) => {
  const c = db.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json({ case: c, entity: db.getEntity(c.entityKind, c.entityId), actions: db.listActions({ caseId: c.id }), events: db.auditEntries({ caseId: c.id }) });
});

app.post('/api/cases/:id/flag', (req, res) => res.json(flagCase(req.params.id, { flag: req.body?.flag, by: who(req) })));
app.post('/api/cases/:id/promise', (req, res) => res.json(recordPromise(req.params.id, { date: req.body?.date, by: who(req), note: req.body?.note })));
app.post('/api/cases/:id/close', (req, res) => res.json(closeCase(req.params.id, { by: who(req), reason: req.body?.reason })));
app.post('/api/cases/:id/draft', ah(async (req, res) => {
  const c = db.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(await draftForCase(c, currentPolicy(), merchantName()));
}));

// ---- action queue ----
app.get('/api/actions', (req, res) => {
  const list = db.listActions({ status: req.query.status || undefined, limit: 1000 });
  res.json(list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)));
});
app.post('/api/actions/:id/approve', (req, res) => res.json(approveAction(req.params.id, who(req))));
app.post('/api/actions/:id/reject', (req, res) => res.json(rejectAction(req.params.id, who(req), req.body?.note)));
app.post('/api/actions/:id/complete', (req, res) => res.json(completeTask(req.params.id, { by: who(req), outcome: req.body?.outcome, note: req.body?.note, promiseDate: req.body?.promiseDate })));

// ---- payment health ----
app.get('/api/health', (_req, res) => res.json(paymentHealth()));

// ---- models ----
app.get('/api/models', (_req, res) => {
  const strip = (m) => (m ? Object.fromEntries(Object.entries(m).filter(([k]) => !['weights', 'names', 'index', 'logistic', 'gbdt'].includes(k))) : null);
  res.json({ repayment: strip(loadRepayment()), recovery: strip(loadRecovery()), recoveryReadiness: readiness(), ai: aiInfo() });
});
app.post('/api/models/repayment/score', (req, res) => res.json(scoreOne(req.body?.history)));
app.post('/api/models/repayment/score-csv', (req, res) => res.json(scoreCsv(String(req.body?.csv ?? ''))));
app.get('/api/models/repayment/template.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="repayment-risk-template.csv"');
  res.send(TEMPLATE);
});
app.post('/api/models/recovery/train', (_req, res) => {
  const a = trainRecovery();
  db.appendAudit({ actor: 'system', type: 'MODEL_TRAINED', summary: `Self-recovery model ${a.version} trained on ${a.data.examples} real cases (test AUC ${a.metrics.test.auc.toFixed(3)})` });
  res.json({ version: a.version, metrics: a.metrics, data: a.data });
});

// ---- audit ----
app.get('/api/audit', (req, res) => {
  const { caseId, type, actor } = req.query;
  const limit = Math.min(500, Number(req.query.limit ?? 50));
  const offset = Number(req.query.offset ?? 0);
  res.json({ total: db.auditCount({ caseId, type, actor }), entries: db.auditEntries({ caseId, type, actor, limit, offset, order: 'DESC' }) });
});
app.get('/api/audit/verify', (_req, res) => res.json(verifyChain(db.auditEntries())));
app.get('/api/audit.csv', (_req, res) => {
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = ['seq,timestamp,case_id,actor,type,summary,prev_hash,hash'];
  for (const e of db.auditEntries()) lines.push([e.seq, e.ts, e.caseId, e.actor, e.type, e.summary, e.prevHash, e.hash].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="paylazar-audit.csv"');
  res.send(lines.join('\n'));
});

// ---- settings ----
app.get('/api/settings', (_req, res) => res.json(currentPolicy()));
app.put('/api/settings', (req, res) => {
  const next = updatePolicy(req.body);
  db.appendAudit({ actor: 'human', type: 'SETTINGS_CHANGED', summary: `Settings updated (${Object.keys(req.body ?? {}).join(', ')})` });
  res.json(next);
});

// ---- web app ----
const dist = join(root, 'web', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message ?? 'Internal error' });
});

export { app };

if (process.env.PAYLAZAR_NO_LISTEN !== '1') {
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => {
    const ai = aiInfo();
    console.log(`Paylazar running on http://localhost:${port}`);
    console.log(ai.configured ? `  AI: NaraRouter (${ai.model})` : '  AI: off. Add your NaraRouter key on the Connections page or as NARA_API_KEY in .env.');
    if (!loadRepayment()) console.log('  Repayment-risk model missing: run "npm run train".');
    startLoop();
  });
}
