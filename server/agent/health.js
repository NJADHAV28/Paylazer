// Payment-health monitor over the merchant's real payments: failure rate per
// provider (bank, UPI handle, card issuer) in the last hour vs its own trailing
// 7-day baseline, flagged with a binomial z-test.

import { entities } from '../db.js';
import { providerOf } from './diagnose.js';

const HOUR = 3600;

export function paymentHealth(now = new Date(), { windowMinutes = 60, minAttempts = 20, minFailures = 8, zThreshold = 3 } = {}) {
  const t = Math.floor(now.getTime() / 1000);
  const payments = entities('payment', { since: t - 7 * 24 * HOUR }).filter((p) => p.status !== 'created');
  const recentFrom = t - windowMinutes * 60;
  const byProvider = new Map();
  for (const p of payments) {
    const key = providerOf(p);
    const s = byProvider.get(key) ?? { provider: key, recent: 0, recentFailed: 0, base: 0, baseFailed: 0 };
    const failed = p.status === 'failed';
    if (p.created_at >= recentFrom) { s.recent++; if (failed) s.recentFailed++; } else { s.base++; if (failed) s.baseFailed++; }
    byProvider.set(key, s);
  }
  const providers = [...byProvider.values()].map((s) => {
    const rate = s.recent ? s.recentFailed / s.recent : null;
    const baseline = s.base ? s.baseFailed / s.base : null;
    let z = null;
    if (rate != null && baseline != null && s.base >= 50) {
      const b = Math.min(0.99, Math.max(0.01, baseline));
      z = (rate - b) / Math.sqrt((b * (1 - b)) / s.recent);
    }
    const degraded = z != null && z > zThreshold && s.recent >= minAttempts && s.recentFailed >= minFailures && rate - baseline > 0.1;
    return { ...s, rate, baseline, z, degraded };
  }).sort((a, b) => b.recent + b.base - (a.recent + a.base));

  const incidents = providers.filter((p) => p.degraded).map((p) => ({
    id: `INC-${p.provider.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}`,
    provider: p.provider, rate: p.rate, baseline: p.baseline, z: p.z, attempts: p.recent,
  }));

  // Hourly failure rate over the last 24h for the busiest providers.
  const top = providers.slice(0, 5).map((p) => p.provider);
  const hours = Array.from({ length: 24 }, (_, i) => t - (23 - i) * HOUR);
  const series = top.map((provider) => ({
    provider,
    points: hours.map((h) => {
      const inHour = payments.filter((p) => providerOf(p) === provider && p.created_at >= h - HOUR && p.created_at < h);
      return { t: h, attempts: inHour.length, rate: inHour.length ? inHour.filter((p) => p.status === 'failed').length / inHour.length : null };
    }),
  }));
  const total = payments.length;
  const failed = payments.filter((p) => p.status === 'failed').length;
  return { asOf: now.toISOString(), totals: { payments7d: total, failed7d: failed, rate7d: total ? failed / total : null }, providers, incidents, series };
}
