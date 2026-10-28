// CSV import, in-app credentials, scoring and the trained model. The CSV rows
// below are test inputs shaped like a Razorpay Dashboard export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYLAZAR_DB = ':memory:';
process.env.PAYLAZAR_NO_LISTEN = '1';
for (const k of ['NARA_API_KEY', 'ANTHROPIC_API_KEY', 'NARA_BASE_URL', 'PAYLAZAR_MODEL']) delete process.env[k];

const { parseCsv, parseTime, analyse, commit } = await import('../agent/importer.js');
const { maskedCredentials, saveCredentials, cred } = await import('../credentials.js');
const { aiInfo } = await import('../ai/copilot.js');
const { tick } = await import('../agent/loop.js');
const { updatePolicy } = await import('../agent/settings.js');
const db = await import('../db.js');
const { scoreCsv, TEMPLATE, parseStatus } = await import('../ml/scoring.js');
const { loadRepayment } = await import('../ml/repayment.js');

const ist = (d) => {
  const t = new Date(Date.now() - d * 3600 * 1000 + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
};
const PAYMENTS = [
  'Payment Id,Amount,Currency,Status,Order Id,Method,Bank,Email,Contact,Error Code,Error Description,Error Reason,Error Source,Created At',
  `pay_c1,"1,499.00",INR,failed,order_c1,upi,,neha@example.com,+919811111111,BAD_REQUEST_ERROR,"Payment failed due to insufficient balance",insufficient_funds,bank,${ist(1)}`,
  `pay_c2,2999.00,INR,captured,order_c2,card,,kabir@example.com,+919822222222,,,,,${ist(30)}`,
  `pay_c3,799.00,INR,failed,,netbanking,HDFC,old@example.com,,GATEWAY_ERROR,"Bank was unable to process",bank_technical_error,bank,${ist(24 * 40)}`,
].join('\n');
const ORDERS = [
  'id,amount,amount_paid,status,receipt,created_at',
  `order_c1,1499.00,0,attempted,rcpt_1,${ist(1.1)}`,
  `order_c2,2999.00,2999.00,paid,rcpt_2,${ist(30.1)}`,
].join('\n');

test('CSV parser handles quotes, commas and newlines inside fields', () => {
  const rows = parseCsv('a,b\n"x, y","line1\nline2"\n"he said ""hi""",3\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2'], ['he said "hi"', '3']]);
});

test('dates: dd/mm/yyyy is read as Indian time, unix and ISO work', () => {
  assert.equal(parseTime('02/11/2026 10:30:00'), Date.parse('2026-11-02T10:30:00+05:30') / 1000);
  assert.equal(parseTime('1793606400'), 1793606400);
  assert.equal(parseTime('2026-11-02T05:00:00Z'), Date.parse('2026-11-02T05:00:00Z') / 1000);
  assert.equal(parseTime('not a date'), null);
});

test('import analysis maps Dashboard headers and detects rupee amounts', () => {
  const a = analyse('payment', PAYMENTS, 'auto');
  assert.deepEqual(a.missing, []);
  assert.equal(a.unit, 'rupees');
  assert.equal(a.valid, 3);
  assert.equal(a.entities[0].amount, 149900); // stored in paise like the API
  assert.equal(a.entities[0].error_reason, 'insufficient_funds');
  const ints = analyse('order', 'id,amount,status,created_at\no1,149900,attempted,1793606400', 'auto');
  assert.equal(ints.unit, null, 'whole numbers are ambiguous: the user must choose rupees or paise');
  assert.ok(analyse('payment', 'id,amount\nx,1', 'auto').missing.includes('status'));
});

test('imported data flows through the same pipeline; no API keys means team tasks, not sends', async () => {
  updatePolicy({ holdoutPct: 0, contactWindowStart: 0, contactWindowEnd: 24, businessName: 'Acme Store' });
  commit('payment', PAYMENTS, 'rupees');
  commit('order', ORDERS, 'rupees');
  await tick();
  const c1 = db.getCase('order_c1');
  assert.equal(c1.type, 'payment_failed');
  assert.equal(c1.cause, 'insufficient_funds');
  assert.equal(c1.amount, 1499);
  assert.equal(c1.live, true);
  assert.equal(db.getCase('order_c2'), null, 'a paid order is never a case');
  const old = db.getCase('pay_c3');
  assert.equal(old.group, 'historical');
  // Push the case past its "next morning" timing and plan again.
  c1.openedSec -= 26 * 3600;
  db.saveCase(c1);
  await tick();
  const a = db.listActions({ caseId: 'order_c1' })[0];
  assert.equal(a.action, 'manual_link_task');
  assert.equal(a.status, 'task_open');
  assert.match(a.preview.text, /Razorpay Dashboard/);
});

test('a payments-only export still finds failures that belong to orders', async () => {
  commit('payment', `id,amount,status,order_id,method,email,error_reason,error_source,created_at
pay_only1,750.00,failed,order_missing,upi,z@example.com,incorrect_pin,customer,${ist(2)}`, 'rupees');
  await tick();
  const c = db.getCase('order_missing');
  assert.equal(c.type, 'payment_failed');
  assert.equal(c.cause, 'auth_failure');
  assert.equal(c.amount, 750);
});

test('the NaraRouter key entered in the app is masked, and .env wins', () => {
  assert.equal(aiInfo().configured, false);
  assert.throws(() => saveCredentials({ NARA_API_KEY: 'short' }), /NaraRouter key/);
  saveCredentials({ NARA_API_KEY: 'sk-nry-abcdefghijkl1234', PAYLAZAR_MODEL: 'claude-sonnet-5' });
  assert.deepEqual(aiInfo(), { configured: true, model: 'claude-sonnet-5', provider: 'router.bynara.id' });
  const m = maskedCredentials();
  assert.equal(m.NARA_API_KEY.preview, 'sk-nry••••1234');
  assert.ok(!JSON.stringify(m).includes('abcdefghijkl'));
  process.env.ANTHROPIC_API_KEY = 'sk-nry-from-old-env-file';
  assert.equal(cred('NARA_API_KEY'), 'sk-nry-from-old-env-file', 'older .env name still works');
  assert.equal(maskedCredentials().NARA_API_KEY.source, 'env');
  delete process.env.ANTHROPIC_API_KEY;
  saveCredentials({ NARA_API_KEY: '', PAYLAZAR_MODEL: '' });
  assert.deepEqual(aiInfo(), { configured: false, model: 'claude-opus-5', provider: 'router.bynara.id' });
});

test('trained model: boosted trees chosen on validation, clears the quality bar on unseen test data', () => {
  const m = loadRepayment();
  assert.ok(m, 'run npm run train');
  assert.equal(m.dataset.rows, 30000);
  const sel = m.candidates.find((c) => c.selected);
  const other = m.candidates.find((c) => !c.selected);
  assert.ok(sel.validationAuc >= other.validationAuc, 'selection used validation, not test');
  assert.ok(m.metrics.test.auc > 0.75, `test AUC ${m.metrics.test.auc}`);
  assert.ok(m.metrics.test.brier < 0.14);
  // calibration: each well-populated bin within 8 points of reality
  for (const b of m.metrics.test.calibration.filter((x) => x.n >= 100)) assert.ok(Math.abs(b.predicted - b.observed) < 0.08, `bin ${b.bin}`);
});

test('batch scoring: template scores, bad rows are reported not dropped', () => {
  assert.equal(parseStatus('2 months late'), 2);
  assert.equal(parseStatus('paid'), -1);
  const r = scoreCsv(`${TEMPLATE}\nBroken,soon,1,1,paid,1,1,paid,1,1,paid,1,1,paid,1,1,paid,1,1`);
  assert.equal(r.rows.length, 3);
  const [good, slipping, broken] = r.rows;
  assert.ok(slipping.score > good.score + 0.2, `slipping ${slipping.score} vs on-time ${good.score}`);
  assert.equal(good.tier, 'low');
  assert.match(broken.error, /Unrecognised status/);
  assert.match(r.csv.split('\n')[0], /risk_score,risk_tier,flagged,error$/);
});

