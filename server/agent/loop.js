// The loop: watch payment health, detect and resolve cases from your imported
// Razorpay data, ask NaraRouter about failures the rules can't explain, and
// plan the next task for each open case.

import { appendAudit, getSetting, setSetting, listCases, saveCase, getEntity } from '../db.js';
import { CAUSES } from '../engine/catalog.js';
import { paymentHealth } from './health.js';
import { detect } from './detect.js';
import { planCases } from './decide.js';
import { tidyActions } from './execute.js';
import { currentPolicy } from './settings.js';
import { aiConfigured, aiDiagnose, describeError } from '../ai/copilot.js';

let ticking = null;
const AI_MIN_CONFIDENCE = 0.6;
const AI_PER_TICK = 10;

function trackIncidents(incidents) {
  const open = new Set(getSetting('openIncidents', []));
  const now = new Set(incidents.map((i) => i.id));
  for (const i of incidents) {
    if (!open.has(i.id)) appendAudit({ actor: 'detector', type: 'INCIDENT_DETECTED', summary: `${i.provider}: ${(i.rate * 100).toFixed(0)}% of payments failing in the last hour vs ${(i.baseline * 100).toFixed(0)}% normally`, data: i });
  }
  for (const id of open) if (!now.has(id)) appendAudit({ actor: 'detector', type: 'INCIDENT_RESOLVED', summary: `${id.replace('INC-', '')} back to normal` });
  setSetting('openIncidents', [...now]);
}

// Open live cases the rules marked "unknown" get one NaraRouter look each.
export async function aiDiagnoseOpenCases(limit = AI_PER_TICK) {
  if (!aiConfigured()) return { checked: 0, updated: 0 };
  const todo = listCases({ status: 'open', live: true }).filter((c) => c.cause === 'unknown' && !c.aiDiagnosis && c.entityKind === 'payment').slice(0, limit);
  let updated = 0;
  for (const c of todo) {
    const payment = getEntity('payment', c.entityId);
    try {
      const d = await aiDiagnose(payment);
      c.aiDiagnosis = d ?? { cause: 'unknown', confidence: 0, explanation: 'No error details to read', model: null };
      if (d && d.cause !== 'unknown' && d.confidence >= AI_MIN_CONFIDENCE) {
        c.cause = d.cause;
        c.causeLabel = CAUSES[d.cause].label;
        c.evidence = [...(c.evidence ?? []), { field: 'ai', value: `${d.model}: ${d.explanation}` }];
        updated++;
        appendAudit({ caseId: c.id, actor: 'agent', type: 'AI_DIAGNOSED', summary: `NaraRouter (${d.model}) read the error as "${c.causeLabel}" (${Math.round(d.confidence * 100)}% sure): ${d.explanation}`, data: d });
      }
    } catch (err) {
      c.aiDiagnosis = { cause: 'unknown', confidence: 0, explanation: describeError(err), error: true };
    }
    saveCase(c);
  }
  return { checked: todo.length, updated };
}

export function tick() {
  ticking ??= (async () => {
    const p = currentPolicy();
    const now = new Date();
    const health = paymentHealth(now);
    trackIncidents(health.incidents);
    const detected = detect(now, p, { incidents: health.incidents });
    const ai = await aiDiagnoseOpenCases();
    tidyActions(now);
    const planned = planCases(now, p, { incidents: health.incidents });
    setSetting('lastTick', { at: now.toISOString(), detected, ai, planned });
    return { detected, ai, planned };
  })().finally(() => { ticking = null; });
  return ticking;
}

export function startLoop() {
  tick().catch((e) => console.error('tick failed', e));
  // Cases move on with time (next-morning follow-ups, recovery windows), so re-plan every minute.
  setInterval(() => tick().catch((e) => console.error('tick failed', e)), 60000);
}
