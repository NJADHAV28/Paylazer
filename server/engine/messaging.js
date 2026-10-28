// Copy for payment-link descriptions, WhatsApp tasks and call scripts.

export const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const first = (c) => (c.customer?.name ?? '').split(' ')[0] || 'there';

const REASON = {
  insufficient_funds: { en: 'the bank reported a low balance', hi: 'bank ne balance kam bataya' },
  issuer_downtime: { en: 'the bank had a temporary issue', hi: 'bank mein temporary dikkat thi' },
  auth_failure: { en: 'the OTP / PIN step did not go through', hi: 'OTP / PIN verify nahi hua' },
  card_invalid: { en: 'the card could not be used', hi: 'card se payment nahi ho paya' },
  payment_timeout: { en: 'the payment timed out', hi: 'payment time out ho gaya' },
};

export function linkDescription(c, merchant) {
  const what = {
    payment_failed: 'Complete your payment',
    checkout_abandoned: 'Complete your order',
    subscription_failed: 'Renew your subscription',
    invoice_overdue: `Invoice ${c.ref ?? ''} payment`,
    link_unpaid: 'Payment due',
  }[c.type];
  return `${what} - ${merchant}`.slice(0, 2048);
}

export function whatsappText(c, merchant, link) {
  const r = REASON[c.cause];
  if (c.customer?.lang === 'hinglish') {
    return `Namaste ${first(c)} ji, ${merchant} ki taraf se: aapka ${inr(c.amount)} ka payment abhi pending hai${r ? ` (${r.hi})` : ''}. Aap yahan UPI, card ya netbanking se pay kar sakte hain: ${link}\nMessages band karne ke liye STOP likhein.`;
  }
  return `Hi ${first(c)}, this is ${merchant}. Your payment of ${inr(c.amount)} is still pending${r ? ` (${r.en})` : ''}. You can pay by UPI, card or netbanking here: ${link}\nReply STOP to opt out.`;
}

export function callScript(c, merchant, link) {
  const r = REASON[c.cause];
  return [
    `Introduce yourself: "Hello ${first(c)}, this is <your name> from ${merchant}."`,
    `Purpose: "I'm calling about a payment of ${inr(c.amount)}${r ? ` that didn't go through because ${r.en}` : ' that is still pending'}."`,
    `Offer help: "I can send you a link right now. You can pay by UPI in under a minute." Link: ${link}`,
    'If they are busy, ask for a better time and note it as a promise date.',
    'If they mention a dispute, financial difficulty, or ask not to be contacted, stop, thank them, and mark the case accordingly.',
    'Call only between 08:00 and 19:00. Never threaten or mention legal consequences.',
  ];
}

export function formalNotice(c, merchant) {
  return `Dear ${c.customer?.name ?? 'Customer'},\n\nOur records show that ${c.ref ? `invoice ${c.ref}` : 'an amount'} of ${inr(c.amount)} remains unpaid${c.overdueDays ? ` ${c.overdueDays} days after its due date` : ''}. We request payment within 15 days. If the amount remains unpaid, ${merchant} may need to consider legal action under the applicable terms.\n\nIf you believe this is in error, please reply so we can review it.\n\n${merchant}`;
}
