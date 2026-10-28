// Root cause of a failed Razorpay payment, from the error fields Razorpay
// returns (error_source, error_step, error_reason, error_description). Every
// match is recorded as evidence; nothing matched means "unknown".

const RULES = [
  { cause: 'insufficient_funds', test: /insufficient|low balance|not enough balance|exceeds balance/ },
  { cause: 'auth_failure', test: /otp|\bpin\b|authenticat|3ds|3-d secure|incorrect_?(otp|pin)|verification/ },
  { cause: 'card_invalid', test: /expired|invalid[_ ]card|card[_ ]number|invalid[_ ]cvv|card[_ ]not[_ ]supported|card_declined|do not honou?r/ },
  { cause: 'risk_decline', test: /risk|fraud|suspicious|blocked/ },
  { cause: 'limit_exceeded', test: /limit/ },
  { cause: 'customer_cancelled', test: /cancel|user[_ ]dropped|closed the|declined by (the )?(user|customer)/ },
  { cause: 'payment_timeout', test: /timed[_ ]?out|timeout/ },
  { cause: 'issuer_downtime', test: /technical|server[_ ]error|unavailable|downtime|bank[_ ]error|gateway[_ ]error|network|not reachable/ },
];

export function providerOf(p) {
  if (p.method === 'upi') return p.vpa?.includes('@') ? `UPI @${p.vpa.split('@')[1].toLowerCase()}` : 'UPI';
  if (p.method === 'card') return `Card ${p.card?.issuer ?? p.card?.network ?? ''}`.trim();
  if (p.method === 'netbanking') return `Netbanking ${p.bank ?? ''}`.trim();
  if (p.method === 'wallet') return `Wallet ${p.wallet ?? ''}`.trim();
  if (p.method === 'emandate' || p.method === 'nach') return `Mandate ${p.bank ?? ''}`.trim();
  return p.method ?? 'unknown';
}

export function diagnosePayment(p, { activeIncidents = [] } = {}) {
  const evidence = [];
  const text = [p.error_reason, p.error_description, p.error_code].filter(Boolean).join(' ').toLowerCase().replaceAll('_', ' ');
  const reason = (p.error_reason ?? '').toLowerCase();
  for (const f of ['error_source', 'error_step', 'error_reason', 'error_code']) if (p[f]) evidence.push({ field: f, value: p[f] });
  let cause = 'unknown';
  for (const r of RULES) {
    if (r.test.test(text) || r.test.test(reason)) { cause = r.cause; break; }
  }
  // A timeout or unexplained failure on the bank's side during a measured
  // degradation is attributed to the bank.
  const provider = providerOf(p);
  const incident = activeIncidents.find((i) => i.provider === provider);
  if (incident && ['unknown', 'payment_timeout', 'issuer_downtime'].includes(cause) && (p.error_source ?? 'bank') !== 'customer') {
    cause = 'issuer_downtime';
    evidence.push({ field: 'payment_health', value: `${provider} failure rate ${(incident.rate * 100).toFixed(0)}% vs ${(incident.baseline * 100).toFixed(0)}% normal` });
  }
  if (cause === 'payment_timeout' && ['bank', 'gateway'].includes(p.error_source)) cause = 'issuer_downtime';
  return { cause, provider, evidence, incidentId: incident?.id ?? null };
}
