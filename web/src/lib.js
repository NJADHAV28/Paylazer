import { useEffect, useState, useCallback } from 'react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function useApi(path, { refreshMs = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    if (!path) return;
    api(path).then((data) => setState({ data, error: null, loading: false })).catch((error) => setState((s) => ({ ...s, error, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
    if (!refreshMs) return undefined;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { ...state, reload: load };
}

export const inr = (n, { compact = false } = {}) => {
  const v = Number(n) || 0;
  if (compact && Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (compact && Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: v % 1 ? 2 : 0 })}`;
};
export const pct = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
export const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '–');
export const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '–');

export const STATUS = {
  open: { label: 'Open', cls: 'blue' },
  recovered: { label: 'Recovered', cls: 'good' },
  expired: { label: 'Window ended', cls: '' },
  lost: { label: 'Lost', cls: 'bad' },
  closed: { label: 'Closed', cls: '' },
};
export const ACTION_STATUS = {
  proposed: { label: 'Awaiting approval', cls: 'warn' },
  scheduled: { label: 'Scheduled', cls: 'blue' },
  task_open: { label: 'To do', cls: 'warn' },
  sent: { label: 'Sent', cls: 'good' },
  done: { label: 'Done', cls: 'good' },
  failed: { label: 'Failed', cls: 'bad' },
  blocked: { label: 'Blocked', cls: 'bad' },
  rejected: { label: 'Rejected', cls: '' },
  cancelled: { label: 'Cancelled', cls: '' },
};

export function useRoute() {
  const parse = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    return { path, query: Object.fromEntries(new URLSearchParams(qs ?? '')) };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path, query) => {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  window.location.hash = `${path}${qs ? `?${qs}` : ''}`;
};
