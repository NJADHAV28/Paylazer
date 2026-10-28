// Moves each open case through its playbook: decides the next step and when it
// is due, checks guardrails, and queues the action (for approval or sending).

import { ACTIONS, PLAYBOOKS, CHANNELS } from '../engine/catalog.js';
import { checkAction, nextIstHour } from '../engine/policy.js';
import { linkDescription, whatsappText, callScript, formalNotice, inr } from '../engine/messaging.js';
import { listCases, listActions, saveCase, saveAction, appendAudit } from '../db.js';
import { merchantName } from './settings.js';

const HOUR = 3600;
const PERMANENT_STOP = new Set(['DO_NOT_CONTACT', 'OPTED_OUT', 'DISPUTED', 'TOTAL_CAP']);
const OPEN_ACTION = 'proposed,task_open';

function dueAt(step, c, base, now, incidents) {
  const after = typeof step.after === 'function' ? step.after(c) : step.after;
  if (after === 'next_morning') return nextIstHour(new Date(base * 1000), 10).getTime() / 1000;
  if (after === 'bank_recovered') {
    const down = incidents.some((i) => i.provider === c.provider);
    // Hold while the provider is degraded, but never longer than 6 hours.
    return down && now < base + 6 * HOUR ? now + 15 * 60 : base + 0.25 * HOUR;
  }
  return base + after * HOUR;
}

export function preview(c, actionId, p) {
  const m = merchantName(p);
  const link = c.links?.at(-1)?.shortUrl ?? '<payment link>';
  const to = [c.customer?.email, c.customer?.contact].filter(Boolean).join(' / ') || 'no contact on file';
  switch (actionId) {
    case 'whatsapp_task': return { text: whatsappText(c, m, link) };
    case 'call_task': return { script: callScript(c, m, link), text: `Call ${c.customer?.name ?? 'the customer'} on ${c.customer?.contact ?? '(no phone on file)'}` };
    case 'manual_link_task': return { text: `In the Razorpay Dashboard, open Payment Links → Create Payment Link. Amount ${inr(c.amount)}, description "${linkDescription(c, m)}". Send it to ${to}, then mark this task done.` };
    case 'manual_invoice_task': return { text: `In the Razorpay Dashboard, open Invoices → ${c.ref ?? c.invoiceId} and resend it by email and SMS to ${to}. Amount due ${inr(c.amount)}.` };
    case 'formal_notice': return { text: formalNotice(c, m) };
    case 'payment_plan_review': return { text: `Repayment risk ${Math.round((c.risk?.score ?? 0) * 100)}%. Consider offering ${inr(c.amount)} in three instalments.` };
    default: return { text: ACTIONS[actionId].desc };
  }
}

export function planCases(now, p, { incidents = [] } = {}) {
  const T = Math.floor(now.getTime() / 1000);
  let queued = 0;
  for (const c of listCases({ status: 'open' })) {
    if (!c.live || c.group !== 'agent') continue;
    if (listActions({ caseId: c.id, status: OPEN_ACTION }).length) continue;

    if (c.promise && !c.promise.broken) {
      const until = Math.floor(new Date(c.promise.date).getTime() / 1000) + 30 * HOUR; // promised day + grace
      if (T < until) continue;
      c.promise.broken = true;
      appendAudit({ caseId: c.id, actor: 'agent', type: 'PROMISE_BROKEN', summary: `Promised payment by ${c.promise.date.slice(0, 10)} did not arrive; resuming follow-up` });
    }

    const steps = PLAYBOOKS[c.type];
    let idx = c.step;
    while (idx < steps.length && ((steps[idx].when && !steps[idx].when(c)) || (steps[idx].minAmount && c.amount < steps[idx].minAmount))) idx++;
    if (idx >= steps.length) {
      if (!c.playbookDone) { c.playbookDone = true; saveCase(c); }
      continue;
    }
    const step = steps[idx];
    const base = c.lastActionSec ?? c.openedSec;
    const due = dueAt(step, c, base, T, incidents);
    if (due > T) {
      if (c.nextStepSec !== Math.round(due)) { c.nextStepSec = Math.round(due); c.nextStep = step.action; saveCase(c); }
      continue;
    }
    let actionId = step.action;
    if (actionId === 'manual_invoice_task' && !c.invoiceId) actionId = step.fallback ?? 'manual_link_task';

    const chk = checkAction(c, actionId, now, p);
    if (!chk.ok) {
      const codes = chk.blocks.map((b) => b.code);
      if (chk.blocks.every((b) => b.temporary)) continue;
      appendAudit({ caseId: c.id, actor: 'policy', type: 'POLICY_BLOCK', summary: `${ACTIONS[actionId].label} blocked: ${chk.blocks.map((b) => b.msg).join('; ')}`, data: { action: actionId, blocks: codes } });
      if (codes.some((x) => PERMANENT_STOP.has(x))) {
        c.status = 'closed';
        c.closedAt = now.toISOString();
        c.stop = { rule: codes.find((x) => PERMANENT_STOP.has(x)), at: c.closedAt };
        appendAudit({ caseId: c.id, actor: 'policy', type: 'STOPPED', summary: 'Automation stopped by a guardrail; left for manual follow-up', data: c.stop });
      } else {
        c.step = idx + 1; // skip a step that cannot apply to this case
      }
      saveCase(c);
      continue;
    }

    const a = {
      id: `act_${c.id}_${idx}`, caseId: c.id, action: actionId, label: ACTIONS[actionId].label, channel: CHANNELS[ACTIONS[actionId].channel],
      approvalRequired: !!ACTIONS[actionId].approval,
      status: chk.needsApproval ? 'proposed' : 'task_open',
      dueAt: new Date((chk.deferUntil ?? now).getTime()).toISOString(), createdAt: now.toISOString(),
      // Money most likely to be lost without help comes first.
      priority: Math.round(c.amount * (1 - (c.selfRecovery ?? 0)) * (c.risk ? 0.5 + c.risk.score : 1)),
      preview: preview(c, actionId, p), amount: c.amount, caseType: c.type, customer: c.customer,
    };
    saveAction(a);
    c.step = idx + 1;
    c.lastActionSec = T;
    c.nextStep = null;
    c.nextStepSec = null;
    saveCase(c);
    queued++;
    appendAudit({
      caseId: c.id, actor: 'agent', type: a.status === 'task_open' ? 'TASK_CREATED' : 'ACTION_PROPOSED',
      summary: `${a.label}${a.status === 'proposed' ? ' (waiting for approval)' : ' (task for your team)'}${chk.deferUntil ? `, to do after ${String(p.contactWindowStart).padStart(2, '0')}:00 IST` : ''}`,
      data: { actionId: a.id, action: actionId, step: idx + 1 },
    });
  }
  return { queued };
}
