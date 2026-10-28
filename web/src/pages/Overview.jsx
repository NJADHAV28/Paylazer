import { useApp } from '../App.jsx';
import { useApi, inr, pct, int, when } from '../lib.js';

function Stat({ label, value, foot }) {
  return (
    <div className="panel stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="foot">{foot}</div>
    </div>
  );
}

export function Setup({ hasData }) {
  return (
    <div className="panel mb">
      <div className="panel-head"><div><h2>Get started</h2><p>Paylazar works only with your real Razorpay data.</p></div></div>
      <div className="panel-body">
        <ol className="steps">
          <li className={hasData ? 'done' : ''}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 240 }}><b>Import your Razorpay data</b><div className="small dim">Export Payments (and Orders or Invoices) as CSV from the Razorpay Dashboard and drop them in. Past cases become your baseline; recent ones become cases to work on.</div></div>
              <a className={`btn ${hasData ? '' : 'primary'}`} href="#/import">{hasData ? 'Import more' : 'Import data'}</a>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}

function Experiment({ e }) {
  if (e.uplift) {
    const u = e.uplift;
    return (
      <div className="panel-body stack">
        <div className="row" style={{ gap: 28 }}>
          <div><div className="muted small">With Paylazar</div><div style={{ fontSize: 22, fontWeight: 600 }} className="num">{pct(e.agent.rate)}</div><div className="muted small">{int(e.agent.recoveredN)} of {int(e.agent.n)} cases</div></div>
          <div><div className="muted small">Without (holdout)</div><div style={{ fontSize: 22, fontWeight: 600 }} className="num">{pct(e.holdout.rate)}</div><div className="muted small">{int(e.holdout.recoveredN)} of {int(e.holdout.n)} cases</div></div>
          <div><div className="muted small">Difference</div><div style={{ fontSize: 22, fontWeight: 600, color: u.diff > 0 ? 'var(--good)' : 'var(--bad)' }} className="num">{u.diff > 0 ? '+' : ''}{(u.diff * 100).toFixed(1)} pts</div><div className="muted small">±{(u.ci95 * 100).toFixed(1)} pts (95% confidence)</div></div>
        </div>
        <div className={`notice ${u.significant && u.diff > 0 ? 'good' : ''}`}>
          {u.significant
            ? <span>{u.diff > 0 ? 'Paylazar is recovering measurably more' : 'Paylazar is currently recovering less'} than the holdout. Estimated extra recovery: <b>{inr(u.incremental, { compact: true })}</b>.</span>
            : <span>The difference is not yet statistically clear. It firms up as more cases mature.</span>}
        </div>
      </div>
    );
  }
  const need = e.minPerGroup;
  return (
    <div className="panel-body stack">
      <div className="dim">Paylazar compares cases it works on with a random {`holdout`} group it leaves alone. A result appears once each group has {need} cases that are at least {e.maturityHours} hours old or closed.</div>
      {[['With Paylazar', e.agent.n], ['Holdout', e.holdout.n]].map(([label, n]) => (
        <div key={label}>
          <div className="row between small"><span>{label}</span><span className="num muted">{int(n)} / {need}</span></div>
          <div className="meter"><span style={{ width: `${Math.min(100, (n / need) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export default function Overview() {
  const { meta } = useApp();
  const { data } = useApi('/overview', { refreshMs: 30000 });
  if (!data) return <div className="page empty">Loading…</div>;
  const t = data.totals;
  const hasData = t.liveCases + t.historicalCases > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Overview</h1><p>Money at risk in your Razorpay account right now, and what has been recovered.</p></div>
      </div>

      {!data.hasData && <Setup hasData={data.hasData} />}

      {data.incidents.length > 0 && (
        <div className="notice warn mb">
          <div><b>Payment degradation:</b> {data.incidents.map((i) => `${i.provider} is failing ${pct(i.rate, 0)} of payments (normally ${pct(i.baseline, 0)})`).join('; ')}. Follow-ups for affected customers wait until it recovers. <a href="#/health">Payment health</a></div>
        </div>
      )}

      <div className="grid g4 mb">
        <Stat label="Open at risk" value={inr(t.openValue, { compact: true })} foot={`${int(t.openCases)} open cases`} />
        <Stat label="Recovered, last 30 days" value={inr(t.recovered30d, { compact: true })} foot={`${int(t.recoveredCases30d)} cases`} />
        <Stat label="Paid after your follow-up" value={inr(t.afterFollowUp30d, { compact: true })} foot={`${int(t.afterFollowUpCases30d)} cases, last 30 days`} />
        <Stat label="Needs your attention" value={int(t.awaitingApproval + t.openTasks)} foot={<a href="#/actions">{t.awaitingApproval} to approve · {t.openTasks} {t.openTasks === 1 ? 'task' : 'tasks'}</a>} />
      </div>

      <div className="grid g2 mb">
        <div className="panel">
          <div className="panel-head"><div><h2>Is it working?</h2><p>Paylazar vs a randomly held-out group ({`${data.experiment.matured}`} matured cases)</p></div></div>
          <Experiment e={data.experiment} />
        </div>
        <div className="panel">
          <div className="panel-head"><div><h2>Before Paylazar</h2><p>What recovered on its own in your imported history</p></div></div>
          <div className="panel-body">
            {data.baseline.n ? (
              <div className="stack">
                <div className="row" style={{ gap: 28 }}>
                  <div><div className="muted small">Cases</div><div style={{ fontSize: 22, fontWeight: 600 }} className="num">{int(data.baseline.n)}</div></div>
                  <div><div className="muted small">Recovered without help</div><div style={{ fontSize: 22, fontWeight: 600 }} className="num">{pct(data.baseline.rate)}</div></div>
                  <div><div className="muted small">Value recovered</div><div style={{ fontSize: 22, fontWeight: 600 }} className="num">{pct(data.baseline.valueRate)}</div></div>
                </div>
                <div className="dim small">{inr(data.baseline.recovered, { compact: true })} of {inr(data.baseline.atRisk, { compact: true })} came back without any follow-up.</div>
              </div>
            ) : <div className="muted">Appears after the first import.</div>}
          </div>
        </div>
      </div>

      <div className="grid g3">
        <div className="panel span2">
          <div className="panel-head"><h2>By case type</h2></div>
          {hasData ? (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Type</th><th className="r">Open</th><th className="r">Open value</th><th className="r">Recovered, Paylazar</th><th className="r">Recovered, holdout</th><th className="r">Recovered, history</th></tr></thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.type} className="click" onClick={() => { window.location.hash = `/cases?type=${r.type}`; }}>
                      <td>{meta.caseTypes[r.type].label}</td>
                      <td className="r num">{int(r.open)}</td>
                      <td className="r num">{inr(r.openValue, { compact: true })}</td>
                      <td className="r num">{r.agent.n ? `${pct(r.agent.rate, 0)} (${r.agent.n})` : '–'}</td>
                      <td className="r num">{r.holdout.n ? `${pct(r.holdout.rate, 0)} (${r.holdout.n})` : '–'}</td>
                      <td className="r num">{r.historical.n ? `${pct(r.historical.rate, 0)} (${r.historical.n})` : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty"><h3>No cases yet</h3>Cases appear as soon as your Razorpay account has failed payments, unpaid orders, halted subscriptions or overdue invoices.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Recent activity</h2><a href="#/audit" className="small">Audit log</a></div>
          <div className="panel-body">
            {data.recent.length ? (
              <div className="timeline">
                {data.recent.map((e) => (
                  <div key={e.seq} style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="small">{e.summary}</div>
                    <div className="cell-sub">{when(e.ts)}{e.caseId ? <> · <a href={`#/cases?c=${encodeURIComponent(e.caseId)}`}>{e.caseId}</a></> : ''}</div>
                  </div>
                ))}
              </div>
            ) : <div className="muted">Nothing yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
