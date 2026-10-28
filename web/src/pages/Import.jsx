import { useState } from 'react';
import { useApp } from '../App.jsx';
import { api, inr, int, when, go } from '../lib.js';

const KINDS = [
  ['payment', 'Payments', 'Dashboard → Transactions → Payments → Export. Needed to find failed payments and their reasons.'],
  ['order', 'Orders', 'Dashboard → Transactions → Orders → Export. Finds checkouts that were never paid.'],
  ['invoice', 'Invoices', 'Dashboard → Invoices → Export. Finds overdue invoices.'],
];
const FIELD_LABEL = { id: 'ID', amount: 'Amount', status: 'Status', created_at: 'Created at', order_id: 'Order ID', invoice_id: 'Invoice ID', method: 'Method', email: 'Email', contact: 'Phone', error_description: 'Error description', error_reason: 'Error reason', error_source: 'Error source', error_step: 'Error step', error_code: 'Error code', bank: 'Bank', vpa: 'UPI ID', amount_paid: 'Amount paid', amount_due: 'Amount due', expire_by: 'Due / expiry', paid_at: 'Paid at', invoice_number: 'Invoice number', name: 'Customer name', receipt: 'Receipt', currency: 'Currency', wallet: 'Wallet' };

export default function Import() {
  const { notify, refresh } = useApp();
  const [kind, setKind] = useState('payment');
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState('');
  const [unit, setUnit] = useState('auto');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [drag, setDrag] = useState(false);

  const analyse = async (text = csv, k = kind, u = unit) => {
    setBusy(true);
    try { setReport(await api('/import/analyse', { method: 'POST', body: { kind: k, csv: text, unit: u } })); } catch (e) { setReport(null); notify(e.message, true); } finally { setBusy(false); }
  };
  const load = async (f) => {
    if (!f) return;
    if (f.size > 35 * 1024 * 1024) return notify('File is larger than 35 MB: export a shorter date range', true);
    const text = await f.text();
    setFile(f);
    setCsv(text);
    setDone(null);
    setUnit('auto');
    analyse(text, kind, 'auto');
  };
  const commit = async () => {
    setBusy(true);
    try {
      const r = await api('/import/commit', { method: 'POST', body: { kind, csv, unit: report.unit } });
      setDone(r);
      notify(`Imported ${int(r.imported)} ${kind}s`);
      refresh();
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Import data</h1><p>Bring in your real Razorpay data from Dashboard exports. Files are read on this computer only. Import payments first, then orders and invoices; re-import any time to pick up new payments and outcomes.</p></div>
      </div>

      <div className="grid g3 mb">
        {KINDS.map(([k, label, hint]) => (
          <button key={k} className="panel" onClick={() => { setKind(k); if (csv) analyse(csv, k, unit); }}
            style={{ textAlign: 'left', padding: 16, cursor: 'pointer', borderColor: kind === k ? 'var(--accent)' : undefined, boxShadow: kind === k ? '0 0 0 3px rgba(31,95,214,0.12)' : undefined }}>
            <div style={{ fontWeight: 600 }}>{label}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>
          </button>
        ))}
      </div>

      <label
        className="panel mb"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]); }}
        style={{ display: 'block', padding: 28, textAlign: 'center', cursor: 'pointer', borderStyle: 'dashed', borderWidth: 2, background: drag ? 'var(--accent-soft)' : undefined }}
      >
        <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => load(e.target.files[0])} />
        <div style={{ fontWeight: 600 }}>{file ? file.name : `Drop your ${KINDS.find((x) => x[0] === kind)[1].toLowerCase()} export here`}</div>
        <div className="small muted">{file ? `${(file.size / 1024).toFixed(0)} KB · click to choose another file` : 'or click to choose a CSV file'}</div>
      </label>

      {report && (
        <div className="grid g3">
          <div className="panel span2">
            <div className="panel-head"><div><h2>Preview</h2><p>{int(report.rows)} rows in the file{report.valid != null ? ` · ${int(report.valid)} ready to import${report.invalid ? ` · ${int(report.invalid)} will be skipped` : ''}` : ''}</p></div></div>
            <div className="panel-body stack">
              {report.missing.length > 0 && <div className="notice bad"><span><b>Required columns not found:</b> {report.missing.map((f) => FIELD_LABEL[f] ?? f).join(', ')}. Check that this is a {kind} export.</span></div>}
              {!report.missing.length && (
                <div className="field" style={{ maxWidth: 360 }}>
                  <label>Amounts in this file are in</label>
                  <div className="segmented" style={{ alignSelf: 'flex-start' }}>
                    {[['rupees', 'Rupees (₹499.00)'], ['paise', 'Paise (49900)']].map(([u, label]) => (
                      <button key={u} className={report.unit === u ? 'on' : ''} onClick={() => { setUnit(u); analyse(csv, kind, u); }}>{label}</button>
                    ))}
                  </div>
                  {!report.unit && <span className="hint" style={{ color: 'var(--warn)' }}>All amounts are whole numbers, so please choose. Razorpay Dashboard exports normally use rupees.</span>}
                </div>
              )}
              {report.sample?.length > 0 && (
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>ID</th><th className="r">Amount</th><th>Status</th><th>Created</th>{kind === 'payment' && <th>Error</th>}</tr></thead>
                    <tbody>{report.sample.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td className="r num">{inr(r.amount)}</td><td>{r.status}</td><td className="small">{when(r.created)}</td>{kind === 'payment' && <td className="small">{r.error ?? '–'}</td>}</tr>)}</tbody>
                  </table>
                </div>
              )}
              {report.errors?.length > 0 && <div className="notice warn small"><div>{report.errors.map((e) => <div key={e}>{e}</div>)}</div></div>}
              {report.valid > 0 && !done && (
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={commit}>{busy && <span className="spinner" />}Import {int(report.valid)} {kind}s</button>
                  <span className="small muted">Already-imported rows are updated, not duplicated.</span>
                </div>
              )}
              {done && (
                <div className="notice good">
                  <span><b>Imported {int(done.imported)} {kind}s.</b> {done.detected.created} new cases to work on, {done.detected.historical} past cases added to your baseline. <a href="#/cases" onClick={(e) => { e.preventDefault(); go('/cases'); }}>View cases</a></span>
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h2>Column mapping</h2></div>
            <div className="panel-body">
              <dl className="kv small" style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
                {Object.entries(report.mapped).map(([f, h]) => <div key={f} style={{ display: 'contents' }}><dt>{FIELD_LABEL[f] ?? f}</dt><dd className="mono">{h}</dd></div>)}
              </dl>
              {report.statuses && <div className="small muted" style={{ marginTop: 12 }}>Statuses: {report.statuses.map((s) => `${s.status || 'blank'} ${int(s.n)}`).join(' · ')}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
