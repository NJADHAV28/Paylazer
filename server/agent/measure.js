// Real measurement: agent vs randomised holdout on matured live cases, plus a
// baseline from the merchant's own history (what recovered with no help).

import { CASE_TYPES, CAUSES, TYPE_ORDER } from '../engine/catalog.js';
import { listCases, listActions } from '../db.js';

const MATURE_HOURS = 72;
const MIN_N = 30;

function rates(cases) {
  const atRisk = cases.reduce((s, c) => s + c.amount, 0);
  const rec = cases.filter((c) => c.recovered);
  const recovered = rec.reduce((s, c) => s + c.recovered.amount, 0);
  return { n: cases.length, recoveredN: rec.length, rate: cases.length ? rec.length / cases.length : null, atRisk, recovered, valueRate: atRisk ? recovered / atRisk : null };
}

export function measure(now = new Date()) {
  const T = now.getTime() / 1000;
  const all = listCases({ limit: 1e6 });
  const live = all.filter((c) => c.live);
  const history = all.filter((c) => c.group === 'historical');
  const matured = live.filter((c) => c.status !== 'open' || T - c.openedSec > Math.min(MATURE_HOURS, CASE_TYPES[c.type].windowHours) * 3600);
  const A = rates(matured.filter((c) => c.group === 'agent'));
  const B = rates(matured.filter((c) => c.group === 'holdout'));
  let uplift = null;
  if (A.n >= MIN_N && B.n >= MIN_N) {
    const d = A.rate - B.rate;
    const se = Math.sqrt((A.rate * (1 - A.rate)) / A.n + (B.rate * (1 - B.rate)) / B.n);
    uplift = { diff: d, ci95: 1.96 * se, significant: Math.abs(d) > 1.96 * se, incremental: d * A.atRisk };
  }

  const open = live.filter((c) => c.status === 'open');
  const since30 = T - 30 * 86400;
  const recent = live.filter((c) => c.recovered && Date.parse(c.recovered.at) / 1000 >= since30);
  // Paid after your team had contacted them at least once.
  const afterFollowUp = recent.filter((c) => (c.contacts ?? []).some((t) => Date.parse(t) <= Date.parse(c.recovered.at)));

  const byType = TYPE_ORDER.map((t) => {
    const lt = live.filter((c) => c.type === t);
    const ht = history.filter((c) => c.type === t);
    return {
      type: t, label: CASE_TYPES[t].short,
      open: lt.filter((c) => c.status === 'open').length,
      openValue: lt.filter((c) => c.status === 'open').reduce((s, c) => s + c.amount, 0),
      agent: rates(matured.filter((c) => c.type === t && c.group === 'agent')),
      holdout: rates(matured.filter((c) => c.type === t && c.group === 'holdout')),
      historical: rates(ht),
    };
  });

  const causeMap = new Map();
  for (const c of [...history, ...live]) {
    const k = causeMap.get(c.cause) ?? { cause: c.cause, label: CAUSES[c.cause]?.label ?? c.cause, cases: [] };
    k.cases.push(c);
    causeMap.set(c.cause, k);
  }
  const byCause = [...causeMap.values()].map((k) => ({ cause: k.cause, label: k.label, ...rates(k.cases) })).sort((a, b) => b.atRisk - a.atRisk);

  const actions = listActions({ limit: 1e6 });
  return {
    asOf: now.toISOString(),
    totals: {
      openCases: open.length, openValue: open.reduce((s, c) => s + c.amount, 0),
      recovered30d: recent.reduce((s, c) => s + c.recovered.amount, 0), recoveredCases30d: recent.length,
      afterFollowUp30d: afterFollowUp.reduce((s, c) => s + c.recovered.amount, 0), afterFollowUpCases30d: afterFollowUp.length,
      awaitingApproval: actions.filter((a) => a.status === 'proposed').length,
      openTasks: actions.filter((a) => a.status === 'task_open').length,
      done: actions.filter((a) => a.status === 'done').length,
      liveCases: live.length, historicalCases: history.length,
    },
    experiment: { matured: matured.length, agent: A, holdout: B, uplift, minPerGroup: MIN_N, maturityHours: MATURE_HOURS },
    baseline: rates(history),
    byType, byCause,
  };
}
