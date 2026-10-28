// Turns stored Razorpay entities into revenue-at-risk cases and resolves them
// against real outcomes. Idempotent: safe to run after every import.

import { createHash } from 'node:crypto';
import { CASE_TYPES, CAUSES } from '../engine/catalog.js';
import { entities, getEntity, getCase, saveCase, appendAudit, getSetting } from '../db.js';
import { diagnosePayment, providerOf } from './diagnose.js';
import { scoreRepayment, historyFromInvoices } from '../ml/repayment.js';
import { scoreSelfRecovery } from '../ml/recovery.js';

const iso = (sec) => new Date(sec * 1000).toISOString();
const PAID = new Set(['captured', 'authorized']);
const ABANDON_AFTER = 30 * 60;

export const groupFor = (id, holdoutPct) =>
  createHash('sha1').update(id).digest().readUInt16BE(0) % 100 < holdoutPct ? 'holdout' : 'agent';

function customerFrom(p, notes = {}) {
  return {
    name: p?.notes?.name ?? p?.notes?.customer_name ?? notes.name ?? notes.customer_name ?? null,
    email: p?.email ?? notes.email ?? null,
    contact: p?.contact ?? notes.contact ?? notes.phone ?? null,
  };
}

// Payment links Paylazar created, by case id.
function paylazarLinks() {
  const map = new Map();
  for (const l of entities('payment_link')) {
    const caseId = l.notes?.paylazar_case;
    if (caseId) map.set(caseId, [...(map.get(caseId) ?? []), l]);
  }
  return map;
}

function candidates(T, policy) {
  const payments = entities('payment');
  const orders = entities('order');
  const invoices = entities('invoice');
  const subs = entities('subscription');
  const links = entities('payment_link');
  const termsDays = policy.invoiceTermsDays ?? 15;
  const out = [];

  // Orders behind invoices and payment links are tracked through those entities.
  const managedOrders = new Set([...invoices.map((i) => i.order_id), ...links.map((l) => l.order_id)].filter(Boolean));
  const byOrder = new Map();
  for (const p of payments) if (p.order_id) byOrder.set(p.order_id, [...(byOrder.get(p.order_id) ?? []), p]);

  for (const o of orders) {
    if (managedOrders.has(o.id) || !o.amount) continue;
    const ps = (byOrder.get(o.id) ?? []).sort((a, b) => a.created_at - b.created_at);
    if (ps.some((p) => p.invoice_id)) continue;
    const failed = ps.filter((p) => p.status === 'failed');
    const firstFail = failed[0];
    const paidPayment = ps.find((p) => PAID.has(p.status) && (!firstFail || p.created_at >= firstFail.created_at));
    if (ps.some((p) => PAID.has(p.status) && firstFail && p.created_at < firstFail.created_at)) continue;
    const resolvedAt = paidPayment?.created_at ?? (o.status === 'paid' ? T : null);
    if (failed.length) {
      const last = failed.at(-1);
      out.push({
        id: o.id, type: 'payment_failed', entityKind: 'order', entityId: o.id, orderId: o.id, ref: o.receipt ?? null,
        amount: o.amount / 100, openedSec: firstFail.created_at, customer: customerFrom(last, o.notes), lastPayment: last,
        attempts: ps.length, method: last.method, provider: providerOf(last),
        resolved: resolvedAt ? { atSec: resolvedAt, amount: (o.amount_paid || paidPayment?.amount || o.amount) / 100, via: 'customer' } : null,
      });
    } else if (!paidPayment && (o.status !== 'paid' || getCase(o.id)) && T - o.created_at >= ABANDON_AFTER) {
      out.push({
        id: o.id, type: 'checkout_abandoned', entityKind: 'order', entityId: o.id, orderId: o.id, ref: o.receipt ?? null,
        amount: o.amount / 100, openedSec: o.created_at + ABANDON_AFTER, customer: customerFrom(null, o.notes), attempts: ps.length,
        cause: ps.length ? 'unknown' : 'no_attempt',
        resolved: o.status === 'paid' ? { atSec: T, amount: (o.amount_paid || o.amount) / 100, via: 'customer' } : null,
      });
    }
  }

  // Payments whose order record we don't have (e.g. only a payments export was
  // imported): group attempts by order id and judge from the payments alone.
  const knownOrders = new Set(orders.map((o) => o.id));
  for (const [orderId, ps] of byOrder) {
    if (knownOrders.has(orderId) || managedOrders.has(orderId) || ps.some((p) => p.invoice_id)) continue;
    const sorted = [...ps].sort((a, b) => a.created_at - b.created_at);
    const failed = sorted.filter((p) => p.status === 'failed');
    if (!failed.length) continue;
    if (sorted.some((p) => PAID.has(p.status) && p.created_at < failed[0].created_at)) continue;
    const paid = sorted.find((p) => PAID.has(p.status) && p.created_at >= failed[0].created_at);
    const last = failed.at(-1);
    out.push({
      id: orderId, type: 'payment_failed', entityKind: 'payment', entityId: last.id, orderId, amount: last.amount / 100,
      openedSec: failed[0].created_at, customer: customerFrom(last), lastPayment: last, attempts: sorted.length, method: last.method, provider: providerOf(last),
      resolved: paid ? { atSec: paid.created_at, amount: paid.amount / 100, via: 'customer' } : null,
    });
  }

  // Failed payments without an order (and not part of an invoice / subscription).
  for (const p of payments) {
    if (p.status !== 'failed' || p.order_id || p.invoice_id || !p.amount) continue;
    const who = p.email || p.contact;
    const later = who && payments.find((q) => PAID.has(q.status) && q.created_at > p.created_at && (q.email === p.email || q.contact === p.contact) && q.amount === p.amount);
    out.push({
      id: p.id, type: 'payment_failed', entityKind: 'payment', entityId: p.id, amount: p.amount / 100, openedSec: p.created_at,
      customer: customerFrom(p), lastPayment: p, attempts: 1, method: p.method, provider: providerOf(p),
      resolved: later ? { atSec: later.created_at, amount: later.amount / 100, via: 'customer' } : null,
    });
  }

  // Subscriptions whose charge failed.
  for (const s of subs) {
    const existing = getCase(s.id);
    if (!['pending', 'halted'].includes(s.status) && !existing) continue;
    const subInvoices = invoices.filter((i) => i.subscription_id === s.id);
    const unpaid = subInvoices.filter((i) => ['issued', 'partially_paid'].includes(i.status)).sort((a, b) => b.created_at - a.created_at)[0];
    const plan = s.plan_id ? getEntity('plan', s.plan_id) : null;
    const amount = unpaid ? unpaid.amount_due / 100 : plan ? ((plan.item?.amount ?? 0) * (s.quantity ?? 1)) / 100 : existing?.amount ?? 0;
    const failedPay = unpaid && payments.filter((p) => p.invoice_id === unpaid.id && p.status === 'failed').sort((a, b) => b.created_at - a.created_at)[0];
    const cust = s.customer_id ? getEntity('customer', s.customer_id) : null;
    const history = historyFromInvoices(subInvoices.filter((i) => i.id !== unpaid?.id), new Date(T * 1000), 3);
    out.push({
      id: s.id, type: 'subscription_failed', entityKind: 'subscription', entityId: s.id, invoiceId: unpaid?.id ?? null, ref: s.plan_id,
      amount, openedSec: failedPay?.created_at ?? existing?.openedSec ?? T, lastPayment: failedPay ?? null,
      customer: { name: cust?.name ?? null, email: cust?.email ?? null, contact: cust?.contact ?? null },
      cause: failedPay ? null : s.status === 'halted' ? 'retries_exhausted' : 'unknown', history,
      resolved: ['active', 'completed'].includes(s.status) ? { atSec: T, amount, via: 'customer' } : null,
      lost: ['cancelled', 'expired'].includes(s.status) ? `Subscription ${s.status}` : null,
    });
  }

  // Standalone invoices past their due date.
  for (const inv of invoices) {
    if (inv.subscription_id || inv.type === 'link') continue;
    const due = inv.expire_by ?? (inv.date ?? inv.created_at) + termsDays * 86400;
    const existing = getCase(inv.id);
    const overdue = ['issued', 'partially_paid'].includes(inv.status) && T > due;
    if (!overdue && !existing) continue;
    const cd = inv.customer_details ?? {};
    const others = invoices.filter((x) => x.id !== inv.id && !x.subscription_id && ((inv.customer_id && x.customer_id === inv.customer_id) || (cd.email && x.customer_details?.email === cd.email)));
    out.push({
      id: inv.id, type: 'invoice_overdue', entityKind: 'invoice', entityId: inv.id, invoiceId: inv.id, ref: inv.invoice_number ?? inv.receipt ?? null,
      amount: existing?.amount ?? inv.amount_due / 100, openedSec: due, overdueDays: Math.max(0, Math.floor((T - due) / 86400)),
      customer: { name: cd.name ?? cd.customer_name ?? null, email: cd.email ?? cd.customer_email ?? null, contact: cd.contact ?? cd.customer_contact ?? null },
      cause: inv.status === 'partially_paid' ? 'partial_payment' : inv.email_status !== 'sent' && inv.sms_status !== 'sent' ? 'not_delivered' : 'overdue',
      history: historyFromInvoices(others.filter((x) => (x.date ?? x.created_at) < (inv.date ?? inv.created_at)), new Date(T * 1000), termsDays),
      resolved: inv.status === 'paid' ? { atSec: inv.paid_at ?? T, amount: existing?.amount ?? inv.amount / 100, via: 'customer' } : null,
      lost: ['cancelled', 'expired', 'deleted'].includes(inv.status) ? `Invoice ${inv.status}` : null,
    });
  }

  // The merchant's own payment links that expired unpaid.
  for (const l of links) {
    if (l.notes?.source === 'paylazar' || l.notes?.paylazar_case) continue;
    const expiredUnpaid = (l.status === 'expired' || (l.status === 'created' && l.expire_by && T > l.expire_by)) && (l.amount_paid ?? 0) < l.amount;
    if (!expiredUnpaid && !getCase(l.id)) continue;
    out.push({
      id: l.id, type: 'link_unpaid', entityKind: 'payment_link', entityId: l.id, ref: l.reference_id ?? null,
      amount: (l.amount - (l.amount_paid ?? 0)) / 100, openedSec: l.expire_by ?? l.updated_at ?? l.created_at,
      customer: { name: l.customer?.name ?? null, email: l.customer?.email ?? null, contact: l.customer?.contact ?? null }, cause: 'link_expired',
      resolved: l.status === 'paid' ? { atSec: T, amount: l.amount_paid / 100, via: 'customer' } : null,
    });
  }
  return out;
}

export function detect(now = new Date(), policy, { incidents = [] } = {}) {
  const T = Math.floor(now.getTime() / 1000);
  const connectedAt = getSetting('sync', {}).connectedAt ?? T;
  const ours = paylazarLinks();
  const stats = { created: 0, historical: 0, recovered: 0, closed: 0 };

  for (const k of candidates(T, policy)) {
    // A payment through a Paylazar link resolves the case, whatever happened to the original order.
    const paidLink = (ours.get(k.id) ?? []).find((l) => l.status === 'paid' || (l.amount_paid ?? 0) > 0);
    if (paidLink && !k.resolved) k.resolved = { atSec: paidLink.updated_at ?? T, amount: (paidLink.amount_paid ?? paidLink.amount) / 100, via: 'paylazar_link' };
    else if (paidLink && k.resolved) k.resolved.via = 'paylazar_link';

    const window = CASE_TYPES[k.type].windowHours * 3600;
    let diag = { cause: k.cause ?? 'unknown', evidence: [], provider: k.provider ?? null, incidentId: null };
    if (k.lastPayment) diag = diagnosePayment(k.lastPayment, { activeIncidents: incidents });
    if (k.cause && !k.lastPayment) diag.cause = k.cause;
    const risk = k.history ? scoreRepayment(k.history) : null;
    const existing = getCase(k.id);

    if (!existing) {
      const live = !k.resolved && !k.lost && T - k.openedSec < window && k.openedSec + window > connectedAt;
      const c = {
        id: k.id, type: k.type, entityKind: k.entityKind, entityId: k.entityId, orderId: k.orderId ?? null, invoiceId: k.invoiceId ?? null,
        ref: k.ref ?? null, amount: k.amount, customer: k.customer, method: k.method ?? null, provider: diag.provider, attempts: k.attempts ?? null,
        overdueDays: k.overdueDays ?? null, cause: diag.cause, causeLabel: CAUSES[diag.cause].label, evidence: diag.evidence, incidentId: diag.incidentId,
        risk, live, group: live ? groupFor(k.id, policy.holdoutPct) : 'historical', openedSec: k.openedSec, openedAt: iso(k.openedSec),
        status: k.resolved ? 'recovered' : k.lost ? 'lost' : live ? 'open' : 'expired',
        recovered: k.resolved ? { amount: k.resolved.amount, at: iso(k.resolved.atSec), via: k.resolved.via } : null,
        closedAt: k.resolved ? iso(k.resolved.atSec) : !live ? iso(Math.min(T, k.openedSec + window)) : null,
        step: 0, contacts: [], flags: {}, links: [], detectedAt: now.toISOString(),
      };
      c.selfRecovery = live ? scoreSelfRecovery(c) : null;
      saveCase(c);
      if (live) {
        stats.created++;
        appendAudit({ caseId: c.id, actor: 'detector', type: 'DETECTED', summary: `${CASE_TYPES[c.type].label}: ₹${c.amount.toLocaleString('en-IN')} at risk${c.group === 'holdout' ? ' (holdout: left alone for measurement)' : ''}`, data: { entity: `${c.entityKind}:${c.entityId}`, amount: c.amount, group: c.group } });
        appendAudit({ caseId: c.id, actor: 'agent', type: 'DIAGNOSED', summary: `${c.causeLabel}${risk ? ` · repayment risk ${Math.round(risk.score * 100)}%` : ''}`, data: { cause: c.cause, evidence: c.evidence, risk } });
      } else stats.historical++;
      continue;
    }

    if (existing.status !== 'open') continue;
    const c = { ...existing, amount: existing.amount, risk: risk ?? existing.risk, invoiceId: k.invoiceId ?? existing.invoiceId, customer: { ...existing.customer, ...Object.fromEntries(Object.entries(k.customer ?? {}).filter(([, v]) => v)) } };
    if (k.resolved) {
      c.status = 'recovered';
      c.recovered = { amount: k.resolved.amount, at: iso(k.resolved.atSec), via: k.resolved.via };
      c.closedAt = c.recovered.at;
      stats.recovered++;
      appendAudit({ caseId: c.id, actor: 'razorpay', type: 'PAYMENT_RECEIVED', summary: `₹${c.recovered.amount.toLocaleString('en-IN')} received ${c.recovered.via === 'paylazar_link' ? 'through a Paylazar payment link' : 'from the customer'}`, data: c.recovered });
    } else if (k.lost) {
      c.status = 'lost';
      c.closedAt = now.toISOString();
      stats.closed++;
      appendAudit({ caseId: c.id, actor: 'razorpay', type: 'STOPPED', summary: k.lost, data: { rule: 'ENTITY_CLOSED' } });
    } else if (T > c.openedSec + CASE_TYPES[c.type].windowHours * 3600) {
      c.status = 'expired';
      c.closedAt = now.toISOString();
      stats.closed++;
      appendAudit({ caseId: c.id, actor: 'policy', type: 'STOPPED', summary: `Recovery window of ${CASE_TYPES[c.type].windowHours / 24} days ended`, data: { rule: 'WINDOW_ENDED' } });
    }
    saveCase(c);
  }
  if (stats.historical) appendAudit({ actor: 'detector', type: 'HISTORY_IMPORTED', summary: `${stats.historical} past ${stats.historical === 1 ? 'case' : 'cases'} imported as a baseline (not acted on)`, data: { count: stats.historical } });
  return stats;
}
