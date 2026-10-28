import { useState } from 'react';
import { useApp } from '../App.jsx';
import { api, useApi, pct, int, date } from '../lib.js';
import { Reliability } from '../components/charts.jsx';

const STATUS_OPTIONS = [['paid', 'Paid on time'], ['partial', 'Paid part'], ['1', '1 month late'], ['2', '2 months late'], ['3', '3+ months late'], ['none', 'Nothing billed']];
const CYCLE = ['Last bill', '2nd last', '3rd last', '4th last', '5th last', '6th last'];
const FEATURE = (n) => n
  .replace(/^status_(\d)$/, (_, i) => `${CYCLE[i]}: how late`)
  .replace(/^m(\d)=(\w+)$/, (_, i, b) => `${CYCLE[i]}: ${{ none: 'nothing billed', paid: 'paid on time', partial: 'paid part', late1: '1 month late', late2: '2 months late', late3p: '3+ months late' }[b]}`)
  .replace(/^pay_ratio_(\d)$/, (_, i) => `Share of the ${CYCLE[Number(i) + 1].toLowerCase()} bill paid`)
  .replace('pay_ratio_mean', 'Average share of bills paid').replace('late_cycles', 'Number of late bills').replace('max_delay', 'Longest delay')
  .replace('recent_late', 'Late on the last bill').replace('late_2plus_ever', 'Ever 2+ months late').replace('worsening', 'Paying later than before')
  .replace('no_payment_recent', 'Paid nothing last cycle').replace('bill_growth', 'Bill growing').replace('empty_cycles', 'Cycles with no bill')
  .replace(/^nothing_due_(\d)$/, (_, i) => `Nothing due on the ${CYCLE[Number(i) + 1].toLowerCase()} bill`);

function Metric({ label, value, hint }) {
  return <div><div className="muted small">{label}</div><div style={{ fontSize: 20, fontWeight: 600 }} className="num">{value}</div>{hint && <div className="muted small">{hint}</div>}</div>;
}

function TryIt({ threshold }) {
  const { notify } = useApp();
  const [cycles, setCycles] = useState(Array.from({ length: 6 }, () => ({ status: 'paid', bill: '5000', paid: '5000' })));
  const [res, setRes] = useState(null);
  const set = (i, k) => (e) => setCycles(cycles.map((c, j) => (j === i ? { ...c, [k]: e.target.value } : c)));
  const score = async () => {
    try {
      setRes(await api('/models/repayment/score', { method: 'POST', body: { history: { status: cycles.map((c) => c.status), bill: cycles.map((c) => Number(c.bill)), paid: cycles.map((c) => Number(c.paid)) } } }));
    } catch (e) { notify(e.message, true); }
  };
  const color = res ? (res.tier === 'high' ? 'var(--bad)' : res.tier === 'medium' ? 'var(--warn)' : 'var(--good)') : undefined;
  return (
    <div className="grid g3">
      <div className="span2 table-wrap">
        <table className="t">
          <thead><tr><th>Billing cycle</th><th>How it was paid</th><th className="r">Bill (₹)</th><th className="r">Paid (₹)</th></tr></thead>
          <tbody>
            {cycles.map((c, i) => (
              <tr key={i}>
                <td className="small">{CYCLE[i]}</td>
                <td><select className="input" value={c.status} onChange={set(i, 'status')}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                <td><input className="input num" style={{ textAlign: 'right' }} inputMode="numeric" value={c.bill} onChange={set(i, 'bill')} /></td>
                <td><input className="input num" style={{ textAlign: 'right' }} inputMode="numeric" value={c.paid} onChange={set(i, 'paid')} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stack">
        <button className="btn primary" onClick={score}>Score this customer</button>
        {res ? (
          <div className="panel" style={{ padding: 16 }}>
            <div className="muted small">Chance of not paying the next bill</div>
            <div style={{ fontSize: 32, fontWeight: 650, color }} className="num">{pct(res.score)}</div>
            <div className="row" style={{ gap: 6 }}><span className={`badge ${res.tier === 'high' ? 'bad' : res.tier === 'medium' ? 'warn' : 'good'}`}>{res.tier} risk</span>{res.flagged && <span className="badge bad">Flagged</span>}</div>
            <div className="small muted" style={{ marginTop: 8 }}>Flagged at {pct(threshold, 0)} or above. Bill sizes only matter relative to each other.</div>
          </div>
        ) : <div className="small muted">Set how each of the last six bills was paid, then score. The same inputs are built automatically from a customer's earlier Razorpay invoices.</div>}
      </div>
    </div>
  );
}

function Batch() {
  const { notify } = useApp();
  const [res, setRes] = useState(null);
  const [name, setName] = useState('');
  const run = async (f) => {
    if (!f) return;
    setName(f.name);
    try { setRes(await api('/models/repayment/score-csv', { method: 'POST', body: { csv: await f.text() } })); } catch (e) { setRes(null); notify(e.message, true); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name.replace(/\.csv$/i, '') + '-scored.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };
  const ok = res?.rows.filter((r) => r.score != null) ?? [];
  return (
    <div className="stack">
      <div className="row">
        <a className="btn" href="/api/models/repayment/template.csv">Download template</a>
        <label className="btn primary" style={{ cursor: 'pointer' }}>Score a CSV file<input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => run(e.target.files[0])} /></label>
        {res && <button className="btn" onClick={download}>Download results</button>}
      </div>
      <div className="small muted">One row per customer: how each of the last six bills was paid (paid, partial, none, or months late), the bill amount and the amount paid, with cycle 1 the most recent. The template shows the layout.</div>
      {res && (
        <>
          <div className="row small">
            <span className="badge">{int(ok.length)} scored</span>
            <span className="badge bad">{int(ok.filter((r) => r.tier === 'high').length)} high</span>
            <span className="badge warn">{int(ok.filter((r) => r.tier === 'medium').length)} medium</span>
            <span className="badge good">{int(ok.filter((r) => r.tier === 'low').length)} low</span>
            {res.rows.length > ok.length && <span className="badge">{int(res.rows.length - ok.length)} with errors</span>}
          </div>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="t">
              <thead><tr><th>Row</th><th>Customer</th><th className="r">Risk</th><th>Tier</th></tr></thead>
              <tbody>{res.rows.slice(0, 200).map((r) => <tr key={r.row}><td className="muted small">{r.row}</td><td className="small">{r.customer || '–'}</td><td className="r num">{r.score == null ? '–' : pct(r.score)}</td><td className="small">{r.error ? <span style={{ color: 'var(--bad)' }}>{r.error}</span> : r.tier}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function Models() {
  const { notify } = useApp();
  const { data, reload } = useApi('/models');
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="page empty">Loading…</div>;
  const r = data.repayment;
  const s = data.recovery;
  const rd = data.recoveryReadiness;
  const train = async () => {
    setBusy(true);
    try { await api('/models/recovery/train', { method: 'POST' }); notify('Model trained on your history'); reload(); } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const t = r?.metrics.test;
  const th = t?.atThreshold;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Models</h1><p>Trained only on real data and evaluated on records the model never saw during training.</p></div>
      </div>

      {!r && <div className="notice warn mb"><span>The repayment-risk model isn't available yet.</span></div>}

      {r && (
        <>
          <div className="panel mb">
            <div className="panel-head">
              <div><h2>Repayment risk</h2><p>Chance a customer will not pay their next bill, from how they paid their last six. Scores overdue invoices and failed subscriptions automatically.</p></div>
            </div>
            <div className="panel-body stack" style={{ gap: 20 }}>
              <div className="row" style={{ gap: 32 }}>
                <Metric label="Test AUC" value={t.auc.toFixed(3)} hint="0.5 = guessing, 1 = perfect" />
                <Metric label="Accuracy" value={pct(th.accuracy)} hint={`at the ${th.threshold} threshold`} />
                <Metric label="Catches" value={pct(th.recall, 0)} hint="of customers who default" />
                <Metric label="Precision" value={pct(th.precision, 0)} hint="of flagged customers default" />
                <Metric label="Brier score" value={t.brier.toFixed(3)} hint="lower is better" />
              </div>
              <div className="grid g2">
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 8 }}>How it was trained</h3>
                  <dl className="kv small">
                    <dt>Data</dt><dd><a href={r.dataset.url} target="_blank" rel="noreferrer">{r.dataset.name}</a> · {r.dataset.licence}</dd>
                    <dt>Records</dt><dd>{int(r.dataset.rows)} real customers, {int(r.dataset.positives)} defaulted</dd>
                    <dt>Split</dt><dd>{int(r.dataset.split.train)} train · {int(r.dataset.split.validation)} validation · {int(r.dataset.split.test)} test ({r.dataset.split.method})</dd>
                    <dt>Inputs</dt><dd>{r.dataset.featuresUsed}</dd>
                    <dt>Final model</dt><dd>{r.params.model}</dd>
                    <dt>Trained</dt><dd>{date(r.trainedAt)}</dd>
                  </dl>
                </div>
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 8 }}>Models compared</h3>
                  <table className="t">
                    <thead><tr><th>Candidate</th><th className="r">Validation AUC</th><th className="r">Test AUC</th></tr></thead>
                    <tbody>
                      {r.candidates.map((c) => (
                        <tr key={c.type}><td>{c.label} {c.selected && <span className="badge good">chosen</span>}</td><td className="r num">{c.validationAuc.toFixed(4)}</td><td className="r num">{c.testAuc.toFixed(4)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="small muted" style={{ marginTop: 6 }}>Chosen on the validation set; the test set was used once, only to report these numbers.</div>
                  <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>At the flagging threshold ({th.threshold})</h3>
                  <table className="t" style={{ maxWidth: 380 }}>
                    <thead><tr><th></th><th className="r">Flagged</th><th className="r">Not flagged</th></tr></thead>
                    <tbody>
                      <tr><td>Defaulted</td><td className="r num">{int(th.tp)}</td><td className="r num">{int(th.fn)}</td></tr>
                      <tr><td>Paid</td><td className="r num">{int(th.fp)}</td><td className="r num">{int(th.tn)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="grid g2">
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 8 }}>Calibration on test customers</h3>
                  <Reliability points={t.calibration} />
                  <div className="small muted">Points near the dashed line mean a predicted 30% really is about 30%.</div>
                </div>
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 8 }}>By how the last bill was paid</h3>
                  <table className="t">
                    <thead><tr><th>Last bill</th><th className="r">Customers</th><th className="r">Defaulted</th><th className="r">Predicted</th></tr></thead>
                    <tbody>{r.segments.map((g) => <tr key={g.key}><td className="small">{g.label}</td><td className="r num small">{int(g.n)}</td><td className="r num small">{pct(g.observed)}</td><td className="r num small">{pct(g.predicted)}</td></tr>)}</tbody>
                  </table>
                  {r.importance?.length > 0 && (
                    <>
                      <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>What the model relies on most</h3>
                      {r.importance.slice(0, 6).map((f) => (
                        <div key={f.name} style={{ marginBottom: 6 }}>
                          <div className="row between small"><span>{FEATURE(f.name)}</span><span className="num muted">{pct(f.share, 0)}</span></div>
                          <div className="meter"><span style={{ width: `${(f.share / r.importance[0].share) * 100}%` }} /></div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
              <div className="notice"><span><b>Limits.</b> The data is Taiwanese credit-card repayments from 2005. Only payment behaviour is used (on time, late or partial, and the share of each bill paid), never absolute amounts, demographics or credit limits, so the patterns carry over to invoices and subscriptions. Customers with no earlier Razorpay invoices get no score.</span></div>
            </div>
          </div>

          <div className="panel mb">
            <div className="panel-head"><div><h2>Try it</h2><p>Score one customer by hand</p></div></div>
            <div className="panel-body"><TryIt threshold={r.params.threshold} /></div>
          </div>

          <div className="panel mb">
            <div className="panel-head"><div><h2>Score a list of customers</h2><p>Upload a CSV, get the same file back with risk scores added</p></div></div>
            <div className="panel-body"><Batch /></div>
          </div>
        </>
      )}

      <div className="panel">
        <div className="panel-head">
          <div><h2>Would pay anyway</h2><p>Learned from your own Razorpay history: the chance a case recovers with no follow-up. It moves money that would otherwise be lost to the top of the queue.</p></div>
        </div>
        <div className="panel-body stack">
          {s ? (
            <>
              <div className="row" style={{ gap: 26 }}>
                <Metric label="AUC (newest cases)" value={s.metrics.test.auc.toFixed(3)} />
                <Metric label="Log loss" value={s.metrics.test.logloss.toFixed(3)} />
                <Metric label="Recovered on their own" value={pct(s.metrics.test.baseRate)} />
                <Metric label="Trained on" value={int(s.data.examples)} hint="real closed cases" />
              </div>
              <div className="small dim">{s.data.split}. Cases from {date(s.data.from)} to {date(s.data.to)}. Trained {date(s.trainedAt)}.</div>
            </>
          ) : (
            <div className="dim">Trains once there are {rd.minExamples} closed cases Paylazar did not touch (imported history plus the holdout), with at least {rd.minPerClass} of each outcome. Importing a few months of Razorpay payments is usually enough.</div>
          )}
          <div>
            <div className="row between small"><span>Closed untouched cases available</span><span className="num muted">{int(rd.examples)} / {rd.minExamples} · {int(rd.positives)} recovered · {int(rd.negatives)} not</span></div>
            <div className="meter"><span style={{ width: `${Math.min(100, (rd.examples / rd.minExamples) * 100)}%` }} /></div>
          </div>
          <div><button className="btn primary" disabled={!rd.ready || busy} onClick={train}>{busy && <span className="spinner" />}{s ? 'Retrain on latest history' : 'Train'}</button></div>
        </div>
      </div>
    </div>
  );
}
