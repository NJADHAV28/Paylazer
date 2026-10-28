import { DEFAULT_POLICY } from '../engine/policy.js';
import { getSetting, setSetting } from '../db.js';

export const currentPolicy = () => ({ ...DEFAULT_POLICY, businessName: '', invoiceTermsDays: 15, ...getSetting('policy', {}) });

export function updatePolicy(patch) {
  const base = currentPolicy();
  const next = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in base)) continue;
    const def = base[k];
    if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`${k} must be a non-negative number`), { status: 400 });
      next[k] = n;
    } else if (typeof def === 'boolean') next[k] = !!v;
    else if (Array.isArray(def)) next[k] = (Array.isArray(v) ? v : String(v).split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
    else next[k] = String(v).trim();
  }
  if (next.contactWindowStart >= next.contactWindowEnd || next.contactWindowEnd > 24) throw Object.assign(new Error('Contact window must start before it ends'), { status: 400 });
  if (next.holdoutPct > 50) throw Object.assign(new Error('Holdout cannot exceed 50%'), { status: 400 });
  setSetting('policy', next);
  return next;
}

export const merchantName = (p = currentPolicy()) => p.businessName || 'our team';
