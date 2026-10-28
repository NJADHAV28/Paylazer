// The only external connection is NaraRouter (AI). Its key can come from .env
// (takes priority) or be entered on the Connections page, in which case it is
// stored in the local Paylazar database. The API never returns it in full.

import { getSetting, setSetting } from './db.js';

export const NARA_BASE_URL = process.env.NARA_BASE_URL || 'https://router.bynara.id';
export const DEFAULT_MODEL = 'claude-opus-5';

export const FIELDS = {
  NARA_API_KEY: { secret: true, label: 'NaraRouter API key' },
  PAYLAZAR_MODEL: { secret: false, label: 'Model' },
};

// Older .env files used ANTHROPIC_API_KEY for the same key.
const ENV_ALIASES = { NARA_API_KEY: ['NARA_API_KEY', 'ANTHROPIC_API_KEY'], PAYLAZAR_MODEL: ['PAYLAZAR_MODEL'] };
const fromEnv = (name) => (ENV_ALIASES[name] ?? [name]).map((k) => process.env[k]).find(Boolean) || '';

export function cred(name) {
  return fromEnv(name) || getSetting('credentials', {})[name] || '';
}

export function credSource(name) {
  if (fromEnv(name)) return 'env';
  return getSetting('credentials', {})[name] ? 'app' : null;
}

const mask = (v) => (v.length <= 8 ? '••••' : `${v.slice(0, 6)}••••${v.slice(-4)}`);

export function maskedCredentials() {
  return Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => {
    const v = cred(k);
    return [k, { label: f.label, set: !!v, source: credSource(k), preview: v ? (f.secret ? mask(v) : v) : null }];
  }));
}

export function saveCredentials(patch) {
  const stored = { ...getSetting('credentials', {}) };
  const changed = [];
  for (const [k, raw] of Object.entries(patch ?? {})) {
    if (!(k in FIELDS)) continue;
    const v = String(raw ?? '').trim();
    if (k === 'NARA_API_KEY' && v && (/\s/.test(v) || v.length < 12)) throw Object.assign(new Error('That does not look like a NaraRouter key (it should start with sk-nry-)'), { status: 400 });
    if (k === 'PAYLAZAR_MODEL' && v && !/^[\w./:-]+$/.test(v)) throw Object.assign(new Error('Model name contains invalid characters'), { status: 400 });
    if (v) stored[k] = v;
    else delete stored[k];
    changed.push(k);
  }
  setSetting('credentials', stored);
  return changed;
}
