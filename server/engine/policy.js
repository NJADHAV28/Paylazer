// Guardrails applied to every proposed action before it can reach a customer.

import { ACTIONS } from './catalog.js';

export const DEFAULT_POLICY = {
  holdoutPct: 10, // share of new cases left on Razorpay's default behaviour, for honest measurement
  contactWindowStart: 8, // RBI Fair Practices Code: contact between 08:00 and 19:00
  contactWindowEnd: 19,
  maxContactsPerWeek: 3,
  maxContactsTotal: 6,
  minAutoAmount: 100,
  doNotContact: [],
  bannedPhrases: ['legal action', 'police', 'arrest', 'jail', 'court', 'blacklist', 'defaulter', 'last warning', 'consequences', 'shame'],
};

export const POLICY_DOCS = {
  holdoutPct: 'Percentage of new cases Paylazar leaves alone, so recovery can be compared against what would have happened anyway.',
  contactWindowStart: 'Earliest hour (IST) a customer may be contacted.',
  contactWindowEnd: 'Latest hour (IST). Sends planned later wait until the next morning.',
  maxContactsPerWeek: 'Maximum customer contacts per case in any 7 days.',
  maxContactsTotal: 'Lifetime contacts per case. When it is reached, the case is closed for manual follow-up.',
  minAutoAmount: 'Smallest amount (₹) Paylazar creates follow-up tasks for.',
  doNotContact: 'Emails or phone numbers that must never be contacted.',
};

const IST_OFFSET = 5.5 * 3600 * 1000;
export const istHour = (d) => {
  const t = new Date(d.getTime() + IST_OFFSET);
  return t.getUTCHours() + t.getUTCMinutes() / 60;
};

// Next moment at hour `h` IST strictly after `d` (or `d` itself if exactly then).
export function nextIstHour(d, h) {
  const ist = new Date(d.getTime() + IST_OFFSET);
  const target = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), Math.floor(h), Math.round((h % 1) * 60)) - IST_OFFSET);
  return target.getTime() >= d.getTime() ? target : new Date(target.getTime() + 86400000);
}

export const inWindow = (d, p) => istHour(d) >= p.contactWindowStart && istHour(d) < p.contactWindowEnd;

export function nextWindowOpen(d, p) {
  return inWindow(d, p) ? d : nextIstHour(d, p.contactWindowStart);
}

const contactsSince = (c, ms, now) => (c.contacts ?? []).filter((t) => now.getTime() - new Date(t).getTime() < ms).length;

export function checkAction(c, actionId, now, p) {
  const action = ACTIONS[actionId];
  const blocks = [];
  const dnc = new Set((p.doNotContact ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  if (c.group === 'holdout') blocks.push({ code: 'HOLDOUT', msg: 'Holdout case: left on default behaviour for measurement' });
  if (c.flags?.optedOut) blocks.push({ code: 'OPTED_OUT', msg: 'Customer asked not to be contacted' });
  if (c.flags?.disputed) blocks.push({ code: 'DISPUTED', msg: 'Disputed: needs a person, not reminders' });
  if (action.contact) {
    if ([c.customer?.email, c.customer?.contact].some((v) => v && dnc.has(String(v).toLowerCase()))) blocks.push({ code: 'DO_NOT_CONTACT', msg: 'On the do-not-contact list' });
    if (contactsSince(c, 7 * 86400000, now) >= p.maxContactsPerWeek) blocks.push({ code: 'WEEKLY_CAP', msg: `${p.maxContactsPerWeek} contacts in the last 7 days`, temporary: true });
    if ((c.contacts ?? []).length >= p.maxContactsTotal) blocks.push({ code: 'TOTAL_CAP', msg: `Contact limit of ${p.maxContactsTotal} reached` });
  }
  if (action.contact && c.amount < p.minAutoAmount) blocks.push({ code: 'LOW_VALUE', msg: `Below ₹${p.minAutoAmount}` });
  if (actionId === 'manual_invoice_task' && !c.invoiceId) blocks.push({ code: 'NO_INVOICE', msg: 'No Razorpay invoice to resend' });
  const deferUntil = action.contact && !inWindow(now, p) ? nextWindowOpen(now, p) : null;
  return { ok: blocks.length === 0, blocks, deferUntil, needsApproval: !!action.approval };
}

// Content guardrail for any outbound text (templates and Claude drafts alike).
export function lintMessage(text, { channel, merchant, approvedLegal = false }, p) {
  const issues = [];
  const lower = text.toLowerCase();
  for (const phrase of p.bannedPhrases) {
    if (lower.includes(phrase) && !(approvedLegal && phrase === 'legal action')) issues.push({ code: 'BANNED_PHRASE', msg: `Contains "${phrase}"` });
  }
  if (channel === 'team_whatsapp' && !/stop/i.test(text)) issues.push({ code: 'NO_OPT_OUT', msg: 'Missing STOP opt-out line' });
  if (merchant && !text.includes(merchant)) issues.push({ code: 'NO_IDENTITY', msg: 'Business name missing' });
  if (/\b\d{12,}\b/.test(text)) issues.push({ code: 'PII', msg: 'Looks like a full card or account number' });
  return issues;
}
