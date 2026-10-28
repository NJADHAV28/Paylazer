// Hash chain for the audit log: each entry commits to the previous hash, so any
// edit or deletion is detectable with verifyChain().

import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

export const hashEntry = (prev, e) =>
  createHash('sha256')
    .update(prev + JSON.stringify([e.seq, e.ts, e.caseId ?? null, e.actor, e.type, e.summary, e.data ?? null]))
    .digest('hex');

export function verifyChain(entries) {
  let prev = GENESIS;
  for (const e of entries) {
    if (e.prevHash !== prev || hashEntry(prev, e) !== e.hash) return { ok: false, brokenAt: e.seq, checked: entries.length };
    prev = e.hash;
  }
  return { ok: true, checked: entries.length, head: prev };
}
