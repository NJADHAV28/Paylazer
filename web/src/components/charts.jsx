import { useRef, useState, useLayoutEffect } from 'react';

function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

export function Legend({ items }) {
  return <div className="legend">{items.map((it) => <span key={it.label}><i className="swatch" style={{ background: it.color }} />{it.label}</span>)}</div>;
}

// Multi-series line chart. null values are gaps (no data), never zeros.
export function LineChart({ series, xLabels, height = 240, yFormat = (v) => v, yMax, xFormat = (x) => x }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const pad = { l: 44, r: 16, t: 10, b: 26 };
  const n = xLabels.length;
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const max = yMax ?? niceMax(Math.max(0.01, ...vals) * 1.1);
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const step = Math.ceil(n / Math.max(2, Math.floor((width - pad.l - pad.r) / 80)));
  const segments = (values) => {
    const out = [];
    let cur = [];
    values.forEach((v, i) => {
      if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push([x(i), y(v)]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  return (
    <div className="chart" ref={ref}>
      <svg height={height} role="img" aria-label="line chart"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad.l) / (width - pad.l - pad.r)) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="gridline" x1={pad.l} x2={width - pad.r} y1={y(f * max)} y2={y(f * max)} />
            <text className="axis-label" x={pad.l - 8} y={y(f * max) + 4} textAnchor="end">{yFormat(f * max)}</text>
          </g>
        ))}
        {xLabels.map((lab, i) => (i === n - 1 || (i % step === 0 && n - 1 - i >= step * 0.75)) && (
          <text key={i} className="axis-label" x={x(i)} y={height - 6} textAnchor="middle">{xFormat(lab, i)}</text>
        ))}
        {series.map((s) => (
          <g key={s.label}>
            {segments(s.values).map((seg, k) => (seg.length === 1
              ? <circle key={k} cx={seg[0][0]} cy={seg[0][1]} r="2.5" fill={s.color} />
              : <polyline key={k} className="series-line" stroke={s.color} points={seg.map((p) => p.join(',')).join(' ')} />))}
          </g>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="#d0d5dd" />}
        {hover != null && series.map((s) => s.values[hover] != null && <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r="4" fill={s.color} stroke="#fff" strokeWidth="2" />)}
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ left: x(hover), top: pad.t + 20 }}>
          <div className="tt-title">{xFormat(xLabels[hover], hover)}</div>
          {series.map((s) => (
            <div className="tt-row" key={s.label}><span><i className="swatch" style={{ background: s.color }} />{s.label}</span><b className="num">{s.values[hover] == null ? 'no payments' : yFormat(s.values[hover])}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

// Reliability diagram: observed rate vs predicted probability per bin.
export function Reliability({ points, height = 240, color = 'var(--s1)' }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const pad = { l: 44, r: 12, t: 10, b: 34 };
  const max = Math.min(1, niceMax(Math.max(...points.flatMap((p) => [p.predicted, p.observed])) * 1.05));
  const x = (v) => pad.l + (v / max) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  return (
    <div className="chart" ref={ref}>
      <svg height={height} role="img" aria-label="calibration chart" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="gridline" x1={pad.l} x2={width - pad.r} y1={y(f * max)} y2={y(f * max)} />
            <text className="axis-label" x={pad.l - 8} y={y(f * max) + 4} textAnchor="end">{Math.round(f * max * 100)}%</text>
            <text className="axis-label" x={x(f * max)} y={height - 18} textAnchor="middle">{Math.round(f * max * 100)}%</text>
          </g>
        ))}
        <text className="axis-label" x={(width + pad.l) / 2} y={height - 2} textAnchor="middle">predicted probability → share that actually defaulted</text>
        <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} stroke="#98a2b3" strokeDasharray="4 4" />
        <polyline className="series-line" stroke={color} points={points.map((p) => `${x(p.predicted)},${y(p.observed)}`).join(' ')} />
        {points.map((p) => <circle key={p.bin} cx={x(p.predicted)} cy={y(p.observed)} r={hover === p ? 6 : 4} fill={color} stroke="#fff" strokeWidth="2" onMouseEnter={() => setHover(p)} />)}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: x(hover.predicted), top: y(hover.observed) }}>
          <div className="tt-title">Bin {Math.round(hover.lo * 100)}–{Math.round(hover.hi * 100)}%</div>
          <div className="tt-row"><span>Predicted</span><b className="num">{(hover.predicted * 100).toFixed(1)}%</b></div>
          <div className="tt-row"><span>Observed</span><b className="num">{(hover.observed * 100).toFixed(1)}%</b></div>
          <div className="tt-row"><span>Customers</span><b className="num">{hover.n.toLocaleString('en-IN')}</b></div>
        </div>
      )}
    </div>
  );
}
