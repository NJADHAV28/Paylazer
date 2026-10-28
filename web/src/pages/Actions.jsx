import { useState } from 'react';
import { useApp } from '../App.jsx';
import { api, useApi, inr, when, ACTION_STATUS } from '../lib.js';
import { userName, setUserName } from './Cases.jsx';

const TABS = [
  ['proposed', 'Needs approval'],
  ['task_open', 'Team tasks'],
  ['done,rejected,cancelled', 'History'],
];

function ActionCard({ a, meta, onDone }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [promise, setPromise] = useState('');
  const by = () => userName() || 'Team member';
  const post = async (path, body, msg) => {
    setBusy(true);
    try { await api(`/actions/${encodeURIComponent(a.id)}/${path}`, { method: 'POST', body: { by: by(), ...body } }); notify(msg); onDone(); } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const p = a.preview ?? {};
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{a.label}</h2>
          <p>{inr(a.amount)} · {a.customer?.name ?? a.customer?.email ?? 'Unknown customer'} · {meta.caseTypes[a.caseType]?.label} · <a href={`#/cases?c=${encodeURIComponent(a.caseId)}`}>{a.caseId}</a></p>
        </div>
        <div className="row">
          <span className={`badge ${ACTION_STATUS[a.status]?.cls}`}>{ACTION_STATUS[a.status]?.label}</span>
          {a.approvalRequired && a.status === 'proposed' && <span className="badge warn">Policy requires approval</span>}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="small dim">{a.channel} · created {when(a.createdAt)}{new Date(a.dueAt) > new Date() ? ` · do after ${when(a.dueAt)}` : ''}</div>
        {p.text && <pre className="block">{p.text}</pre>}
        {p.script && <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{p.script.map((s) => <li key={s}>{s}</li>)}</ol>}
        {a.result?.shortUrl && <div className="small">Link: <a href={a.result.shortUrl} target="_blank" rel="noreferrer">{a.result.shortUrl}</a></div>}
        {a.error && <div className="notice bad small">{a.error}</div>}
        {a.approvedBy && <div className="small muted">Approved by {a.approvedBy}{a.doneBy ? ` · done by ${a.doneBy}` : ''}{a.outcome ? ` · outcome: ${a.outcome.replace('_', ' ')}` : ''}{a.note ? ` · ${a.note}` : ''}</div>}

        {a.status === 'proposed' && (
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => post('approve', {}, 'Approved: now a task for the team')}>{busy && <span className="spinner" />}Approve</button>
            <input className="input" style={{ maxWidth: 260 }} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => post('reject', { note }, 'Rejected')}>Reject</button>
          </div>
        )}
        {a.status === 'task_open' && (
          <div className="stack">
            <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => post('complete', { outcome: 'reached', note }, 'Recorded')}>Spoke to customer</button>
              <button className="btn" disabled={busy} onClick={() => post('complete', { outcome: 'no_answer', note }, 'Recorded')}>No answer</button>
              <input type="date" className="input" style={{ width: 160 }} value={promise} onChange={(e) => setPromise(e.target.value)} aria-label="Promise date" />
              <button className="btn" disabled={busy || !promise} onClick={() => post('complete', { outcome: 'promised', promiseDate: promise, note }, 'Promise recorded')}>Promised to pay</button>
              <button className="btn" disabled={busy} onClick={() => post('complete', { outcome: 'disputed', note }, 'Marked disputed')}>Disputed</button>
              <button className="btn danger" disabled={busy} onClick={() => post('complete', { outcome: 'opted_out', note }, 'Will not be contacted again')}>Asked not to be contacted</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Actions() {
  const { meta, refresh } = useApp();
  const [tab, setTab] = useState(TABS[0][0]);
  const [name, setName] = useState(userName());
  const list = useApi(`/actions?status=${tab}`, { refreshMs: 20000, deps: [tab] });
  const counts = useApi('/actions?status=proposed,task_open', { refreshMs: 20000 });
  const count = (s) => counts.data?.filter((a) => a.status === s).length ?? 0;
  const done = () => { list.reload(); counts.reload(); refresh(); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Action queue</h1><p>What Paylazar wants to do next, ordered by the money most likely to be lost without help.</p></div>
        <div className="field" style={{ width: 220 }}><label>Your name (for the audit log)</label><input className="input" value={name} onChange={(e) => { setName(e.target.value); setUserName(e.target.value); }} placeholder="e.g. Priya, Finance" /></div>
      </div>
      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}{!k.includes(',') && <span className="count">{count(k)}</span>}</button>
        ))}
      </div>
      <div className="stack">
        {list.data?.map((a) => <ActionCard key={a.id} a={a} meta={meta} onDone={done} />)}
        {list.data && !list.data.length && (
          <div className="panel empty">
            <h3>{tab === 'proposed' ? 'Nothing to approve' : tab === 'task_open' ? 'No open tasks' : 'No history yet'}</h3>
            {tab === 'proposed' ? 'New proposals appear as cases reach their next step.' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
