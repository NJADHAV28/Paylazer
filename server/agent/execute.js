// Records the human side of recovery: approvals, rejections and the outcome
// of each task your team completes.

import { ACTIONS } from '../engine/catalog.js';
import { listActions, getAction, saveAction, getCase, saveCase, appendAudit } from '../db.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Closes out tasks for cases that resolved in the meantime.
export function tidyActions(now = new Date()) {
  for (const a of listActions({ status: 'proposed,task_open' })) {
    const c = getCase(a.caseId);
    if (c && c.status !== 'open') {
      Object.assign(a, { status: 'cancelled', doneAt: now.toISOString(), note: c.status === 'recovered' ? 'Customer paid' : 'Case closed' });
      saveAction(a);
    }
  }
}

export function approveAction(id, by, now = new Date()) {
  const a = getAction(id);
  if (!a) throw err('Action not found', 404);
  if (a.status !== 'proposed') throw err(`Action is ${a.status}`, 409);
  Object.assign(a, { approvedBy: by, approvedAt: now.toISOString(), status: 'task_open' });
  saveAction(a);
  appendAudit({ caseId: a.caseId, actor: 'human', type: 'APPROVED', summary: `${by} approved: ${a.label}`, data: { actionId: a.id } });
  return a;
}

export function rejectAction(id, by, note = '') {
  const a = getAction(id);
  if (!a) throw err('Action not found', 404);
  if (!['proposed', 'task_open'].includes(a.status)) throw err(`Action is ${a.status}`, 409);
  Object.assign(a, { status: 'rejected', doneAt: new Date().toISOString(), rejectedBy: by, note });
  saveAction(a);
  appendAudit({ caseId: a.caseId, actor: 'human', type: 'REJECTED', summary: `${by} rejected: ${a.label}${note ? ` ("${note}")` : ''}`, data: { actionId: a.id } });
  return a;
}

// Outcome of a call / WhatsApp / review task done by a person.
export function completeTask(id, { by, outcome, note = '', promiseDate = null }) {
  const a = getAction(id);
  if (!a) throw err('Action not found', 404);
  if (a.status !== 'task_open') throw err(`Action is ${a.status}`, 409);
  const allowed = ['reached', 'no_answer', 'promised', 'disputed', 'opted_out', 'done'];
  if (!allowed.includes(outcome)) throw err(`outcome must be one of ${allowed.join(', ')}`);
  if (outcome === 'promised' && (!promiseDate || Number.isNaN(Date.parse(promiseDate)))) throw err('promiseDate is required for a promise');
  const c = getCase(a.caseId);
  Object.assign(a, { status: 'done', doneAt: new Date().toISOString(), doneBy: by, outcome, note });
  saveAction(a);
  if (ACTIONS[a.action].contact && outcome !== 'done') c.contacts = [...(c.contacts ?? []), a.doneAt];
  c.lastActionSec = Math.floor(Date.now() / 1000);
  if (outcome === 'promised') {
    c.promise = { date: new Date(promiseDate).toISOString(), by, recordedAt: a.doneAt };
  }
  if (outcome === 'disputed') c.flags = { ...c.flags, disputed: true };
  if (outcome === 'opted_out') c.flags = { ...c.flags, optedOut: true };
  saveCase(c);
  appendAudit({ caseId: c.id, actor: 'human', type: 'TASK_DONE', summary: `${by}: ${a.label}, outcome "${outcome.replace('_', ' ')}"${outcome === 'promised' ? ` (promised ${promiseDate})` : ''}${note ? `. ${note}` : ''}`, data: { actionId: a.id, outcome } });
  return a;
}

// Manual controls on a case.
export function flagCase(caseId, { flag, by }) {
  const c = getCase(caseId);
  if (!c) throw err('Case not found', 404);
  if (!['optedOut', 'disputed'].includes(flag)) throw err('flag must be optedOut or disputed');
  c.flags = { ...c.flags, [flag]: true };
  saveCase(c);
  for (const a of listActions({ caseId, status: 'proposed,task_open' })) {
    Object.assign(a, { status: 'cancelled', note: `Case marked ${flag}` });
    saveAction(a);
  }
  appendAudit({ caseId, actor: 'human', type: 'CASE_FLAGGED', summary: `${by} marked the case ${flag === 'optedOut' ? 'do not contact' : 'disputed'}; open tasks cancelled` });
  return c;
}

export function recordPromise(caseId, { date, by, note = '' }) {
  const c = getCase(caseId);
  if (!c) throw err('Case not found', 404);
  if (!date || Number.isNaN(Date.parse(date))) throw err('A valid promise date is required');
  c.promise = { date: new Date(date).toISOString(), by, note, recordedAt: new Date().toISOString() };
  saveCase(c);
  appendAudit({ caseId, actor: 'human', type: 'PROMISE_TO_PAY', summary: `${by} recorded a promise to pay by ${date}${note ? ` (${note})` : ''}` });
  return c;
}

export function closeCase(caseId, { by, reason }) {
  const c = getCase(caseId);
  if (!c) throw err('Case not found', 404);
  if (c.status !== 'open') throw err(`Case is already ${c.status}`, 409);
  Object.assign(c, { status: 'closed', closedAt: new Date().toISOString(), stop: { rule: 'CLOSED_BY_USER', reason } });
  saveCase(c);
  for (const a of listActions({ caseId, status: 'proposed,task_open' })) {
    Object.assign(a, { status: 'cancelled', note: 'Case closed' });
    saveAction(a);
  }
  appendAudit({ caseId, actor: 'human', type: 'STOPPED', summary: `${by} closed the case${reason ? `: ${reason}` : ''}`, data: { rule: 'CLOSED_BY_USER' } });
  return c;
}
