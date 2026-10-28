// What Paylazar recognises in a Razorpay account, why money gets stuck, and
// what it can actually do about it.

export const CASE_TYPES = {
  payment_failed: { label: 'Failed payment', short: 'Payments', windowHours: 72 },
  checkout_abandoned: { label: 'Abandoned checkout', short: 'Checkout', windowHours: 72 },
  subscription_failed: { label: 'Failed subscription charge', short: 'Subscriptions', windowHours: 240 },
  invoice_overdue: { label: 'Overdue invoice', short: 'Invoices', windowHours: 24 * 45 },
  link_unpaid: { label: 'Unpaid payment link', short: 'Payment links', windowHours: 24 * 14 },
};
export const TYPE_ORDER = Object.keys(CASE_TYPES);

// Root causes, derived from Razorpay's error_source / error_step / error_reason
// and entity state. "unknown" is used rather than guessing.
export const CAUSES = {
  insufficient_funds: { label: 'Insufficient funds', fix: 'Send a payment link the next morning, when balances are more likely to have cleared' },
  issuer_downtime: { label: 'Bank or network issue', fix: 'Wait for the bank to recover, then send a UPI-friendly link' },
  auth_failure: { label: 'OTP / PIN / 3DS failure', fix: 'Send a payment link so the customer can retry with UPI' },
  card_invalid: { label: 'Card expired or invalid', fix: 'Ask the customer to pay with another method' },
  risk_decline: { label: 'Declined by risk checks', fix: 'Offer another payment method' },
  limit_exceeded: { label: 'Transaction limit exceeded', fix: 'Offer UPI / netbanking or a split payment' },
  customer_cancelled: { label: 'Customer cancelled', fix: 'One gentle reminder with a link, then stop' },
  payment_timeout: { label: 'Payment timed out', fix: 'Send a fresh link quickly' },
  no_attempt: { label: 'Left before paying', fix: 'Reminder with a link to complete the order' },
  retries_exhausted: { label: 'Auto-retries exhausted', fix: 'Resend the subscription invoice and follow up personally' },
  partial_payment: { label: 'Partially paid', fix: 'Remind about the balance due' },
  not_delivered: { label: 'Invoice not delivered', fix: 'Resend by SMS and email' },
  overdue: { label: 'Past due', fix: 'Reminder sequence, then a personal call' },
  link_expired: { label: 'Link expired unpaid', fix: 'Share a fresh link' },
  unknown: { label: 'Not enough information', fix: 'Send a payment link and watch the outcome' },
};

export const CHANNELS = {
  team_link: 'Razorpay Dashboard (your team)',
  team_call: 'Phone call (your team)',
  team_whatsapp: 'WhatsApp (your team)',
  team_review: 'Finance review',
};

// Every intervention is a task for a person, with the exact steps or script.
// `approval` tasks need a second person to approve before anyone acts.
export const ACTIONS = {
  manual_link_task: { label: 'Share a payment link', channel: 'team_link', contact: true, desc: 'Create a Payment Link in the Razorpay Dashboard for the amount due and send it to the customer.' },
  manual_invoice_task: { label: 'Resend the invoice', channel: 'team_link', contact: true, desc: 'Open the invoice in the Razorpay Dashboard and resend it by email and SMS.' },
  call_task: { label: 'Call the customer', channel: 'team_call', contact: true, desc: 'A phone call with a prepared script.' },
  whatsapp_task: { label: 'WhatsApp the customer', channel: 'team_whatsapp', contact: true, desc: 'A ready-to-send WhatsApp message.' },
  payment_plan_review: { label: 'Offer an instalment plan', channel: 'team_review', contact: false, approval: true, desc: 'Finance decides whether to offer instalments.' },
  formal_notice: { label: 'Formal payment notice', channel: 'team_review', contact: true, approval: true, desc: 'A formal demand notice. Always needs approval.' },
};

// Playbooks: ordered steps with the earliest time each may run, expressed as
// hours after the case opened (or after the previous step).
export const PLAYBOOKS = {
  payment_failed: [
    { action: 'manual_link_task', after: (c) => (c.cause === 'insufficient_funds' ? 'next_morning' : c.cause === 'customer_cancelled' ? 2 : c.cause === 'issuer_downtime' ? 'bank_recovered' : 0.25) },
    { action: 'call_task', after: 24, minAmount: 2000 },
  ],
  checkout_abandoned: [
    { action: 'manual_link_task', after: 0.75 },
    { action: 'call_task', after: 24, minAmount: 5000 },
  ],
  subscription_failed: [
    { action: 'manual_invoice_task', after: 0, fallback: 'manual_link_task' },
    { action: 'whatsapp_task', after: 48 },
  ],
  invoice_overdue: [
    { action: 'manual_invoice_task', after: 0 },
    { action: 'call_task', after: 72 },
    { action: 'whatsapp_task', after: 120 },
    { action: 'payment_plan_review', after: 168, when: (c) => (c.risk?.score ?? 0) >= 0.5 },
    { action: 'formal_notice', after: 336, when: (c) => c.amount >= 100000 && (c.risk?.score ?? 0) >= 0.5 },
  ],
  link_unpaid: [
    { action: 'manual_link_task', after: 0 },
    { action: 'call_task', after: 72, minAmount: 5000 },
  ],
};
