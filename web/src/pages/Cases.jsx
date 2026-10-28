import { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import { api, useApi, inr, pct, int, when, go, STATUS, ACTION_STATUS } from '../lib.js';

export const userName = () => { try { return localStorage.getItem('paylazar.name') ?? ''; } catch { return ''; } };
export const setUserName = (v) => { try { localStorage.setItem('paylazar.name', v); } catch { /* private mode */ } };

const ACTOR_DOT = { agent: 'agent', detector: 'agent', human: 'human', razorpay: 'razorpay', policy: 'policy' };

function CaseSheet({ id, onClose, onChanged }) {
  const { meta, notify, conn } = useApp();
  const { data, reload } = useApi(`/cases/${encodeURIComponent(id)}`, { deps: [id] });
  const [busy, setBusy] = useState(null);
  const [promise, setPromise] = useState('');
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const act = async (label, path, body = {}) => {
    setBusy(label);
    try {
      await api(`/cases/${encodeURIComponent(id)}/${path}`, { method: 'POST', body: { by: userName() || 'Team member', ...body } });
      notify(`${label}: done`);
      reload();
      onChanged();
    } catch (e) { notify(e.message, true); } finally { setBusy(null); }
  };
  const makeDraft = async () => {
    setBusy('draft');
    try { setDraft(await api(`/cases/${encodeURIComponent(id)}/draft`, { method: 'POST' })); } catch (e) { notify(e.message, true); } finally { setBusy(null); }
  };

  const c = data?.case;
  const canAct = c && c.status === 'open' && c.live;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label={`Case ${id}`}>
        <div className="sheet-head">
          <div>
            <div className="muted small mono">{id}</div>
            {c && <h2 style={{ fontSize: 19, marginTop: 2 }}>{inr(c.amount)} · {c.customer?.name ?? c.customer?.email ?? 'Unknown customer'}</h2>}
            {c && <div className="row small" style={{ marginTop: 6, gap: 6 }}><span className={`badge ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span><span className="badge">{meta.caseTypes[c.type].label}</span>{c.group === 'holdout' && <span className="badge">Holdout</span>}{c.group === 'historical' && <span className="badge">History</span>}</div>}
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="sheet-body">
          {!c && <div className="empty">Loading…</div>}
          {c && (
            <>
              {c.recovered && <div className="notice good"><span><b>{inr(c.recovered.amount)} recovered</b> on {when(c.recovered.at)} {c.recovered.via === 'paylazar_link' ? 'through a Paylazar payment link' : 'by the customer'}.</span></div>}
              {c.group === 'holdout' && c.status === 'open' && <div className="notice"><span>This case is in the holdout group. Paylazar leaves it alone so recovery can be measured fairly.</span></div>}
              {c.promise && <div className="notice info"><span>Promised to pay by <b>{new Date(c.promise.date).toLocaleDateString('en-IN')}</b> (recorded by {c.promise.by}){c.promise.broken ? ' and missed; follow-up resumed.' : '. Follow-ups pause until then.'}</span></div>}

              {canAct && c.group === 'agent' && (
                <div className="panel">
                  <div className="panel-body stack">
                    <div className="row">
                      <button className="btn" disabled={!!busy} onClick={() => act('Marked disputed', 'flag', { flag: 'disputed' })}>Mark disputed</button>
                      <button className="btn" disabled={!!busy} onClick={() => act('Do not contact', 'flag', { flag: 'optedOut' })}>Do not contact</button>
                      <button className="btn danger" disabled={!!busy} onClick={() => act('Case closed', 'close', { reason: 'Closed manually' })}>Close case</button>
                    </div>
                    <div className="row">
                      <div className="field" style={{ width: 180 }}><label>Customer promised to pay by</label><input type="date" className="input" value={promise} onChange={(e) => setPromise(e.target.value)} /></div>
                      <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={!promise || !!busy} onClick={() => act('Promise recorded', 'promise', { date: promise })}>Record promise</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="panel">
                <div className="panel-head"><h2>Details</h2></div>
                <div className="panel-body">
                  <dl className="kv">
                    <dt>Razorpay record</dt><dd className="mono">{c.entityKind} {c.entityId}{c.ref ? ` · ${c.ref}` : ''}</dd>
                    <dt>At risk since</dt><dd>{when(c.openedAt)}</dd>
                    <dt>Customer</dt><dd>{[c.customer?.name, c.customer?.email, c.customer?.contact].filter(Boolean).join(' · ') || 'No contact details on Razorpay'}</dd>
                    {c.provider && <><dt>Payment method</dt><dd>{c.provider}{c.attempts ? ` · ${c.attempts} attempt${c.attempts > 1 ? 's' : ''}` : ''}</dd></>}
                    {c.overdueDays != null && <><dt>Overdue</dt><dd>{c.overdueDays} days</dd></>}
                    <dt>Reason</dt><dd><b>{c.causeLabel}</b><div className="dim small">{meta.causes[c.cause]?.fix}</div></dd>
                    {c.evidence?.length > 0 && <><dt>Razorpay said</dt><dd className="small">{c.evidence.map((e) => <div key={e.field}><span className="muted">{e.field}:</span> <span className="mono">{String(e.value)}</span></div>)}</dd></>}
                    {c.risk && <><dt>Repayment risk</dt><dd><b>{pct(c.risk.score, 0)}</b> <span className={`badge ${c.risk.tier === 'high' ? 'bad' : c.risk.tier === 'medium' ? 'warn' : 'good'}`}>{c.risk.tier}</span><div className="dim small">From this customer's previous Razorpay invoices. <a href="#/models">About the model</a></div></dd></>}
                    {c.selfRecovery != null && <><dt>Would pay anyway</dt><dd>{pct(c.selfRecovery, 0)} <span className="dim small">(learned from your history)</span></dd></>}
                    {c.status === 'open' && c.nextStep && <><dt>Next step</dt><dd>{meta.actions[c.nextStep]?.label} {c.nextStepSec ? `· ${when(new Date(c.nextStepSec * 1000).toISOString())}` : ''}</dd></>}
                  </dl>
                </div>
              </div>

              {data.actions.length > 0 && (
                <div className="panel">
                  <div className="panel-head"><h2>Actions</h2></div>
                  <div className="table-wrap">
                    <table className="t">
                      <tbody>
                        {data.actions.map((a) => (
                          <tr key={a.id}>
                            <td>{a.label}<div className="cell-sub">{a.channel}{a.result?.shortUrl ? <> · <a href={a.result.shortUrl} target="_blank" rel="noreferrer">{a.result.shortUrl}</a></> : ''}{a.error ? ` · ${a.error}` : ''}</div></td>
                            <td><span className={`badge ${ACTION_STATUS[a.status]?.cls}`}>{ACTION_STATUS[a.status]?.label ?? a.status}</span></td>
                            <td className="r cell-sub">{when(a.doneAt ?? a.dueAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {canAct && (
                <div className="panel">
                  <div className="panel-head">
                    <div><h2>Message for your team</h2><p>{conn?.ai?.configured ? 'Drafted from this case’s facts, then checked against your content rules.' : 'Prepared from templates and checked against your content rules.'}</p></div>
                    <button className="btn sm" disabled={!!busy} onClick={makeDraft}>{busy === 'draft' && <span className="spinner" />}{draft ? 'Redraft' : 'Prepare'}</button>
                  </div>
                  {draft && (
                    <div className="panel-body stack">
                      {[['WhatsApp, English', draft.whatsapp_en, draft.lint.whatsapp_en], ['WhatsApp, Hinglish', draft.whatsapp_hinglish, draft.lint.whatsapp_hinglish]].map(([label, text, issues]) => (
                        <div key={label}>
                          <div className="row between small"><b>{label}</b>{issues.length ? <span className="badge bad">{issues.map((i) => i.msg).join(', ')}</span> : <span className="badge good">Passes content rules</span>}</div>
                          <pre className="block" style={{ marginTop: 6 }}>{text}</pre>
                        </div>
                      ))}
                      <div><b className="small">Call opening</b><pre className="block" style={{ marginTop: 6 }}>{draft.call_opening}</pre></div>
                      {draft.note && <div className="muted small">{draft.note}</div>}
                    </div>
                  )}
                </div>
              )}

              <div className="panel">
                <div className="panel-head"><h2>Timeline</h2><p>{data.events.length} entries in the audit log</p></div>
                <div className="panel-body timeline">
                  {data.events.length ? data.events.map((e) => (
                    <div key={e.seq} className="tl">
                      <div className="tl-when">{when(e.ts)}</div>
                      <div className={`tl-dot ${ACTOR_DOT[e.actor] ?? ''}`} />
                      <div className="small">{e.summary}</div>
                    </div>
                  )) : <div className="muted">Past case imported as a baseline. No actions were taken.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default function Cases() {
  const { meta, route } = useApp();
  const q = route.query;
  const scope = q.scope ?? 'live';
  const [search, setSearch] = useState(q.q ?? '');
  const params = new URLSearchParams(Object.entries({ scope, status: q.status, type: q.type, group: q.group, q: q.q }).filter(([, v]) => v));
  const list = useApi(`/cases?${params}`, { refreshMs: 30000, deps: [params.toString()] });
  const setQ = (patch) => go('/cases', { ...q, ...patch });

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Cases</h1><p>Every payment, order, subscription and invoice from your Razorpay account that needs follow-up.</p></div>
      </div>
      <div className="tabs">
        <button className={scope === 'live' ? 'on' : ''} onClick={() => setQ({ scope: 'live', c: undefined })}>Live</button>
        <button className={scope === 'history' ? 'on' : ''} onClick={() => setQ({ scope: 'history', c: undefined })}>History (baseline)</button>
      </div>
      <div className="toolbar mb">
        <div className="field wide"><label>Search</label><input className="input" placeholder="Case ID or customer" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQ({ q: search })} /></div>
        <div className="field"><label>Type</label>
          <select className="input" value={q.type ?? ''} onChange={(e) => setQ({ type: e.target.value })}><option value="">All types</option>{meta.typeOrder.map((t) => <option key={t} value={t}>{meta.caseTypes[t].label}</option>)}</select>
        </div>
        <div className="field"><label>Status</label>
          <select className="input" value={q.status ?? ''} onChange={(e) => setQ({ status: e.target.value })}><option value="">Any status</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </div>
        {scope === 'live' && (
          <div className="field"><label>Group</label>
            <select className="input" value={q.group ?? ''} onChange={(e) => setQ({ group: e.target.value })}><option value="">Both</option><option value="agent">Paylazar</option><option value="holdout">Holdout</option></select>
          </div>
        )}
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Case</th><th>Type</th><th className="r">Amount</th><th>Reason</th><th>Status</th><th>Next</th><th>Opened</th></tr></thead>
            <tbody>
              {list.data?.rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => setQ({ c: r.id })}>
                  <td>{r.customer ?? <span className="muted">Unknown</span>}<div className="cell-sub mono">{r.id}</div></td>
                  <td>{meta.caseTypes[r.type].short}</td>
                  <td className="r num">{inr(r.amount)}</td>
                  <td>{r.causeLabel}{r.risk != null && <div className="cell-sub">Risk {pct(r.risk, 0)}</div>}</td>
                  <td><span className={`badge ${STATUS[r.status]?.cls}`}>{STATUS[r.status]?.label}</span>{r.group === 'holdout' && <div className="cell-sub">Holdout</div>}</td>
                  <td className="small">{r.status === 'recovered' ? <span style={{ color: 'var(--good)' }}>{inr(r.recovered)} {r.via === 'paylazar_link' ? 'via link' : ''}</span> : r.nextStep ? <>{meta.actions[r.nextStep]?.label}<div className="cell-sub">{when(r.nextStepAt)}</div></> : <span className="muted">–</span>}</td>
                  <td className="cell-sub">{when(r.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && !list.data.rows.length && <div className="empty"><h3>No cases</h3>{scope === 'live' ? 'Nothing needs follow-up right now.' : 'History appears after the first Razorpay import.'}</div>}
        </div>
        {list.data?.total > 500 && <div className="panel-body muted small">Showing 500 of {int(list.data.total)}. Narrow the filters to see more.</div>}
      </div>
      {q.c && <CaseSheet id={q.c} onClose={() => setQ({ c: undefined })} onChanged={list.reload} />}
    </div>
  );
}
