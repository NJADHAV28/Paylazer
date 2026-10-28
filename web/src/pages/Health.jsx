import { useApi, pct, int } from '../lib.js';
import { LineChart, Legend } from '../components/charts.jsx';

const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

export default function Health() {
  const { data } = useApi('/health', { refreshMs: 60000 });
  if (!data) return <div className="page empty">Loading…</div>;
  const has = data.totals.payments7d > 0;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Payment health</h1><p>Failure rates across your real payments, by bank, UPI handle and card issuer. A provider is flagged when its last hour is significantly worse than its own 7-day normal.</p></div>
      </div>
      {!has && <div className="panel empty"><h3>No payments yet</h3>Import a Razorpay payments export to see failure rates by bank, UPI handle and card issuer. <a href="#/import">Import data</a></div>}
      {has && (
        <>
          <div className="grid g3 mb">
            <div className="panel stat"><div className="label">Payments, last 7 days</div><div className="value">{int(data.totals.payments7d)}</div></div>
            <div className="panel stat"><div className="label">Failed</div><div className="value">{int(data.totals.failed7d)}</div><div className="foot">{pct(data.totals.rate7d)} of attempts</div></div>
            <div className="panel stat"><div className="label">Degraded right now</div><div className="value" style={{ color: data.incidents.length ? 'var(--bad)' : 'var(--good)' }}>{data.incidents.length}</div><div className="foot">{data.incidents.length ? data.incidents.map((i) => i.provider).join(', ') : 'All providers within normal range'}</div></div>
          </div>
          <div className="panel mb">
            <div className="panel-head"><div><h2>Failure rate by hour, last 24 hours</h2><p>Busiest providers. Gaps mean no payments in that hour.</p></div><Legend items={data.series.map((s, i) => ({ label: s.provider, color: COLORS[i] }))} /></div>
            <div className="panel-body">
              <LineChart
                xLabels={data.series[0]?.points.map((p) => p.t) ?? []}
                xFormat={(t) => new Date(t * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                yFormat={(v) => `${Math.round(v * 100)}%`}
                series={data.series.map((s, i) => ({ label: s.provider, color: COLORS[i], values: s.points.map((p) => p.rate) }))}
              />
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h2>Providers</h2></div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Provider</th><th className="r">Last hour</th><th className="r">Failure rate</th><th className="r">7-day normal</th><th className="r">Payments (7 days)</th><th>Status</th></tr></thead>
                <tbody>
                  {data.providers.map((p) => (
                    <tr key={p.provider}>
                      <td>{p.provider}</td>
                      <td className="r num">{int(p.recent)}</td>
                      <td className="r num">{pct(p.rate)}</td>
                      <td className="r num">{pct(p.baseline)}</td>
                      <td className="r num">{int(p.recent + p.base)}</td>
                      <td>{p.degraded ? <span className="badge bad">Degraded</span> : p.recent < 20 ? <span className="badge">Too few to judge</span> : <span className="badge good">Normal</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
