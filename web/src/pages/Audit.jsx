import { useState } from 'react';
import { useApp } from '../App.jsx';
import { api, useApi, int, when } from '../lib.js';

const PAGE = 50;
const WHO = { agent: 'Paylazar', detector: 'Paylazar', human: 'Team', razorpay: 'Razorpay', policy: 'Guardrails', system: 'Paylazar' };

export default function Audit() {
  const { notify } = useApp();
  const [f, setF] = useState({ caseId: '', actor: '' });
  const [offset, setOffset] = useState(0);
  const [check, setCheck] = useState(null);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: PAGE, offset }).filter(([, v]) => v !== ''));
  const list = useApi(`/audit?${qs}`, { deps: [qs.toString()] });
  const verify = async () => { try { setCheck(await api('/audit/verify')); } catch (e) { notify(e.message, true); } };
  const set = (k) => (e) => { setOffset(0); setF({ ...f, [k]: e.target.value }); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Audit log</h1><p>Every detection, decision, guardrail check, approval, message and payment, in order. Each entry is linked to the one before it, so any later change is detected.</p></div>
        <div className="row">
          <button className="btn" onClick={verify}>Verify integrity</button>
          <a className="btn" href="/api/audit.csv" download>Export CSV</a>
        </div>
      </div>
      {check && <div className={`notice ${check.ok ? 'good' : 'bad'} mb`}>{check.ok ? <span><b>Intact.</b> All {int(check.checked)} entries verified.</span> : <span><b>Integrity check failed</b> at entry #{check.brokenAt}.</span>}</div>}
      <div className="toolbar mb">
        <div className="field"><label>Case ID</label><input className="input" value={f.caseId} onChange={set('caseId')} placeholder="order_…" /></div>
        <div className="field"><label>Who</label>
          <select className="input" value={f.actor} onChange={set('actor')}>
            <option value="">Everyone</option><option value="agent">Paylazar</option><option value="human">People</option><option value="policy">Guardrails</option>
          </select>
        </div>
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th className="r">#</th><th>Time</th><th>Who</th><th>What</th><th>Case</th></tr></thead>
            <tbody>
              {list.data?.entries.map((e) => (
                <tr key={e.seq}>
                  <td className="r num muted">{e.seq}</td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{when(e.ts)}</td>
                  <td className="small">{WHO[e.actor] ?? e.actor}</td>
                  <td className="small">{e.summary}</td>
                  <td className="small mono">{e.caseId ? <a href={`#/cases?c=${encodeURIComponent(e.caseId)}`}>{e.caseId}</a> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && !list.data.entries.length && <div className="empty">No entries yet.</div>}
        </div>
        {list.data?.total > 0 && (
          <div className="panel-body row between small">
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {int(list.data.total)}</span>
            <div className="row">
              <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
              <button className="btn sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Older</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
