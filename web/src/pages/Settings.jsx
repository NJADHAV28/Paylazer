import { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import { api, useApi } from '../lib.js';

const NUMBER_FIELDS = [
  ['contactWindowStart', 'Contact from (hour, IST)'],
  ['contactWindowEnd', 'Contact until (hour, IST)'],
  ['maxContactsPerWeek', 'Contacts per case, per week'],
  ['maxContactsTotal', 'Contacts per case, in total'],
  ['minAutoAmount', 'Smallest amount to act on (₹)'],
  ['invoiceTermsDays', 'Invoice due after (days), if no expiry is set'],
];

export default function Settings() {
  const { meta, notify, refresh } = useApp();
  const s = useApi('/settings');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data) setForm({ ...s.data, doNotContact: s.data.doNotContact.join('\n') }); }, [s.data]);
  if (!form) return <div className="page empty">Loading…</div>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const docs = meta.policyDocs;

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, doNotContact: form.doNotContact.split('\n') };
      for (const [k] of NUMBER_FIELDS) body[k] = Number(form[k]);
      body.holdoutPct = Number(form.holdoutPct);
      await api('/settings', { method: 'PUT', body });
      notify('Settings saved');
      s.reload();
      refresh();
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Settings</h1><p>How Paylazar works for your business. Every change is recorded in the audit log.</p></div>
        <button className="btn primary" onClick={save} disabled={busy}>{busy && <span className="spinner" />}Save changes</button>
      </div>

      <div className="grid g2">
        <div className="stack" style={{ gap: 16 }}>
          <div className="panel">
            <div className="panel-head"><h2>Business</h2></div>
            <div className="panel-body stack">
              <div className="field"><label>Business name</label><input className="input" value={form.businessName} onChange={set('businessName')} placeholder="Shown on payment links and messages" /></div>
              <div className="field"><label>Holdout (%)</label><input className="input" type="number" min="0" max="50" value={form.holdoutPct} onChange={set('holdoutPct')} style={{ maxWidth: 120 }} /><span className="hint">{docs.holdoutPct} Applies to new cases.</span></div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><div><h2>Do not contact</h2><p>One email or phone number per line. These customers are never contacted.</p></div></div>
            <div className="panel-body"><textarea className="input" rows={6} value={form.doNotContact} onChange={set('doNotContact')} placeholder={'someone@example.com\n+919800000000'} /></div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Guardrails</h2></div>
          <div className="panel-body grid g2">
            {NUMBER_FIELDS.map(([k, label]) => (
              <div className="field" key={k}><label>{label}</label><input className="input" type="number" min="0" value={form[k]} onChange={set(k)} />{docs[k] && <span className="hint">{docs[k]}</span>}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
