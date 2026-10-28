// End-to-end: Razorpay CSV exports in, cases and team tasks out, AI through a
// local stand-in for NaraRouter. Fixtures exist only in this test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const KEY = 'sk-nry-test-key-123456';
const seen = [];
const nara = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url, apiKey: req.headers['x-api-key'], auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] !== KEY) { res.statusCode = 401; return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'A valid API key is required.' } })); }
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5', type: 'model', display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z' }, { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-sonnet-5' }));
    const b = JSON.parse(body);
    let text = 'OK';
    if (b.system?.includes('classify why')) text = '{"cause":"issuer_downtime","confidence":0.82,"explanation":"error_description says the issuer declined with a reason code"}';
    else if (b.system?.includes('recover payments')) text = 'Here you go: {"whatsapp_en":"Hi Asha, this is Acme Store. Your payment of ₹2,499 is pending. Pay here: <payment link>\\nReply STOP to opt out.","whatsapp_hinglish":"Namaste Asha ji, Acme Store se: aapka ₹2,499 ka payment pending hai. <payment link>\\nMessages band karne ke liye STOP likhein.","call_opening":"Hello Asha, this is Acme Store. I am calling about a pending payment of ₹2,499."}';
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});
await new Promise((r) => nara.listen(0, '127.0.0.1', r));

process.env.PAYLAZAR_DB = process.env.PAYLAZAR_TEST_DB ?? ':memory:';
process.env.PAYLAZAR_NO_LISTEN = '1';
process.env.PAYLAZAR_RECOVERY_MODEL = `${process.env.TEMP ?? '/tmp'}/paylazar-test-recovery-${process.pid}.json`;
process.env.NARA_BASE_URL = `http://127.0.0.1:${nara.address().port}`;
for (const k of ['NARA_API_KEY', 'ANTHROPIC_API_KEY', 'PAYLAZAR_MODEL']) delete process.env[k];

const db = await import('../db.js');
const { commit } = await import('../agent/importer.js');
const { tick } = await import('../agent/loop.js');
const { approveAction, completeTask, flagCase } = await import('../agent/execute.js');
const { updatePolicy } = await import('../agent/settings.js');
const { saveCredentials } = await import('../credentials.js');
const { testAi, listModels } = await import('../ai/copilot.js');
const { checkAction, DEFAULT_POLICY, lintMessage } = await import('../engine/policy.js');
const { verifyChain } = await import('../engine/audit.js');
const { diagnosePayment } = await import('../agent/diagnose.js');
const { readiness, trainRecovery } = await import('../ml/recovery.js');
const { measure } = await import('../agent/measure.js');
const { app } = await import('../index.js');

const D = 86400;
const now = Math.floor(Date.now() / 1000);
const PAYMENTS = [
  'id,amount,status,order_id,method,vpa,email,contact,error_code,error_description,error_reason,error_source,error_step,created_at',
  `pay_A,2499.00,failed,order_A,upi,asha@okhdfcbank,asha@example.com,+919800000001,BAD_REQUEST_ERROR,Payment failed due to insufficient balance,insufficient_funds,bank,payment_authorization,${now - 3600}`,
  `pay_U,1899.00,failed,,card,,unk@example.com,+919800000004,BAD_REQUEST_ERROR,Declined by issuer with reason code R17,,,,${now - 7200}`,
  `pay_OLD,999.00,failed,order_OLD,card,,old@example.com,,BAD_REQUEST_ERROR,OTP verification failed,incorrect_otp,customer,payment_authentication,${now - 20 * D}`,
].join('\n');
const ORDERS = ['id,amount,amount_paid,status,receipt,created_at', `order_A,2499.00,0,attempted,rcpt_A,${now - 3700}`, `order_OLD,999.00,0,attempted,rcpt_O,${now - 20 * D - 60}`].join('\n');
const INVOICES = [
  'id,invoice_number,amount,amount_paid,status,name,email,contact,created_at,expire_by,paid_at',
  `inv_B2B,INV-104,150000.00,0,issued,Zenith Textiles,ap@zenith.in,+919800000002,${now - 30 * D},${now - 10 * D},`,
  `inv_prev1,INV-090,90000.00,90000.00,paid,Zenith Textiles,ap@zenith.in,,${now - 70 * D},${now - 55 * D},${now - 10 * D}`,
  `inv_prev2,INV-071,80000.00,80000.00,paid,Zenith Textiles,ap@zenith.in,,${now - 100 * D},${now - 85 * D},${now - 40 * D}`,
].join('\n');

let server;
let base;
before(async () => {
  updatePolicy({ holdoutPct: 0, contactWindowStart: 0, contactWindowEnd: 24, businessName: 'Acme Store' });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server?.close(); nara.close(); });

test('imports real-format exports and detects the right cases (no AI key yet)', async () => {
  commit('payment', PAYMENTS, 'rupees');
  commit('order', ORDERS, 'rupees');
  commit('invoice', INVOICES, 'rupees');
  await tick();
  const a = db.getCase('order_A');
  assert.equal(a.type, 'payment_failed');
  assert.equal(a.cause, 'insufficient_funds');
  assert.equal(a.nextStep, 'manual_link_task', 'low balance waits for the next morning');
  assert.equal(db.getCase('pay_U').cause, 'unknown', 'rules cannot explain this one');
  const inv = db.getCase('inv_B2B');
  assert.equal(inv.type, 'invoice_overdue');
  assert.equal(inv.amount, 150000);
  assert.ok(inv.risk?.score > 0, 'invoice risk scored from the customer’s earlier invoices');
  assert.equal(db.getCase('order_OLD').group, 'historical');
  assert.ok(!seen.length, 'no AI calls without a key');
});

test('every follow-up is a task for the team with Razorpay Dashboard steps', () => {
  const tasks = db.listActions({ status: 'task_open' });
  const inv = tasks.find((t) => t.caseId === 'inv_B2B');
  assert.equal(inv.action, 'manual_invoice_task');
  assert.match(inv.preview.text, /Razorpay Dashboard.*INV-104/);
  const u = tasks.find((t) => t.caseId === 'pay_U');
  assert.equal(u.action, 'manual_link_task');
});

test('with a NaraRouter key, unexplained failures get an AI diagnosis', async () => {
  saveCredentials({ NARA_API_KEY: KEY, PAYLAZAR_MODEL: 'claude-opus-5' });
  await tick();
  const u = db.getCase('pay_U');
  assert.equal(u.cause, 'issuer_downtime');
  assert.equal(u.aiDiagnosis.model, 'claude-opus-5');
  assert.ok(u.evidence.some((e) => e.field === 'ai'));
  const call = seen.find((s) => s.body?.system?.includes('classify why'));
  assert.equal(call.path, '/v1/messages');
  assert.equal(call.apiKey, KEY);
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.body.model, 'claude-opus-5');
  assert.ok(!JSON.stringify(call.body).includes('unk@example.com'), 'no customer details sent for diagnosis');
  assert.ok(db.auditEntries({ caseId: 'pay_U' }).some((e) => e.type === 'AI_DIAGNOSED'));
  // Cases the rules already explain are never sent to the model.
  assert.ok(!seen.some((s) => JSON.stringify(s.body ?? {}).includes('insufficient balance')));
});

test('key test, model list and drafting go through NaraRouter', async () => {
  const t = await testAi();
  assert.deepEqual([t.ok, t.reply, t.model], [true, 'OK', 'claude-opus-5']);
  const m = await listModels();
  assert.deepEqual(m, { models: ['claude-opus-5', 'claude-sonnet-5'], live: true });
  const d = await (await fetch(`${base}/cases/order_A/draft`, { method: 'POST' })).json();
  assert.equal(d.source, 'claude-opus-5');
  assert.deepEqual(d.lint.whatsapp_en, []);
  saveCredentials({ NARA_API_KEY: 'sk-nry-wrong-key-000000' });
  await assert.rejects(testAi(), /rejected the API key/);
  const fallback = await (await fetch(`${base}/cases/order_A/draft`, { method: 'POST' })).json();
  assert.equal(fallback.source, 'template');
  saveCredentials({ NARA_API_KEY: KEY });
});

test('the key never reaches the interface and there is no way to set it over the API', async () => {
  for (const path of ['/overview', '/cases', '/actions', '/health', '/settings', '/connection', '/models', '/audit']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.ok(!(await r.text()).includes(KEY), `${path} never exposes the key`);
  }
  for (const path of ['/credentials', '/admin/summary', '/ai/test']) assert.equal((await fetch(`${base}${path}`, { method: 'POST' })).status, 404, path);
});

test('task outcomes, promises, approvals and flags', () => {
  const t = db.listActions({ status: 'task_open' }).find((x) => x.caseId === 'pay_U');
  completeTask(t.id, { by: 'Rahul', outcome: 'promised', promiseDate: new Date(Date.now() + 2 * D * 1000).toISOString().slice(0, 10) });
  assert.ok(db.getCase('pay_U').promise);
  assert.equal(db.getCase('pay_U').contacts.length, 1);
  db.saveAction({ id: 'act_notice', caseId: 'inv_B2B', action: 'formal_notice', label: 'Formal payment notice', status: 'proposed', approvalRequired: true, createdAt: new Date().toISOString() });
  assert.equal(approveAction('act_notice', 'Priya').status, 'task_open');
  flagCase('inv_B2B', { flag: 'disputed', by: 'Rahul' });
  assert.ok(checkAction(db.getCase('inv_B2B'), 'call_task', new Date(), DEFAULT_POLICY).blocks.some((b) => b.code === 'DISPUTED'));
  assert.ok(db.listActions({ caseId: 'inv_B2B' }).every((a) => !['proposed', 'task_open'].includes(a.status)), 'flagging cancels open tasks');
});

test('guardrails: contact window, do-not-contact, holdout and content rules', () => {
  const c = { amount: 5000, group: 'agent', customer: { email: 'x@y.in' }, contacts: [], flags: {} };
  const night = new Date('2026-11-02T17:00:00Z'); // 22:30 IST
  const chk = checkAction(c, 'call_task', night, DEFAULT_POLICY);
  assert.equal(chk.deferUntil.toISOString(), '2026-11-03T02:30:00.000Z');
  assert.ok(checkAction(c, 'call_task', night, { ...DEFAULT_POLICY, doNotContact: ['X@Y.IN'] }).blocks.some((b) => b.code === 'DO_NOT_CONTACT'));
  assert.ok(checkAction({ ...c, group: 'holdout' }, 'call_task', night, DEFAULT_POLICY).blocks.some((b) => b.code === 'HOLDOUT'));
  assert.ok(lintMessage('Pay now or we take legal action', { channel: 'team_whatsapp', merchant: 'Acme' }, DEFAULT_POLICY).length >= 2);
});

test('rule diagnosis reads Razorpay error fields and says unknown when it cannot tell', () => {
  assert.equal(diagnosePayment({ error_reason: 'incorrect_otp', error_source: 'customer' }).cause, 'auth_failure');
  assert.equal(diagnosePayment({ error_reason: 'payment_timed_out', error_source: 'bank' }).cause, 'issuer_downtime');
  assert.equal(diagnosePayment({ error_reason: 'something_new' }).cause, 'unknown');
});

test('audit trail is complete and tamper-evident', () => {
  const entries = db.auditEntries();
  for (const t of ['DATA_IMPORTED', 'DETECTED', 'AI_DIAGNOSED', 'TASK_CREATED', 'TASK_DONE', 'APPROVED']) assert.ok(entries.some((e) => e.type === t), t);
  assert.ok(verifyChain(entries).ok);
  const copy = entries.map((e) => ({ ...e }));
  copy[2].summary += ' edited';
  assert.equal(verifyChain(copy).ok, false);
});

test('self-recovery model waits for enough real history; measurement waits for data', () => {
  assert.equal(readiness().ready, false);
  assert.throws(() => trainRecovery(), /Not enough real history/);
  assert.equal(measure().experiment.uplift, null);
});
