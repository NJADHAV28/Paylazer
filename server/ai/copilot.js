// All AI in Paylazar runs through NaraRouter (Anthropic-compatible /v1/messages):
// drafting messages for the team and diagnosing failures that Razorpay's error
// codes don't explain. Without a key, templates and rules are used instead.

import Anthropic from '@anthropic-ai/sdk';
import { CASE_TYPES, CAUSES } from '../engine/catalog.js';
import { whatsappText, callScript } from '../engine/messaging.js';
import { lintMessage } from '../engine/policy.js';
import { cred, NARA_BASE_URL, DEFAULT_MODEL } from '../credentials.js';

const config = () => ({ key: cred('NARA_API_KEY'), model: cred('PAYLAZAR_MODEL') || DEFAULT_MODEL, baseURL: NARA_BASE_URL });
export const aiConfigured = () => !!config().key;
export function aiInfo() {
  const c = config();
  let provider = c.baseURL;
  try { provider = new URL(c.baseURL).host; } catch { /* keep raw */ }
  return { configured: !!c.key, model: c.model, provider };
}

let client = null;
let clientId = '';
function getClient() {
  const c = config();
  const id = `${c.baseURL}|${c.key}`;
  if (!client || clientId !== id) {
    clientId = id;
    // The key goes in both headers; NaraRouter accepts either.
    client = new Anthropic({ apiKey: c.key, baseURL: c.baseURL, defaultHeaders: { 'x-api-key': c.key, Authorization: `Bearer ${c.key}` }, maxRetries: 1, timeout: 60000 });
  }
  return client;
}

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function parseJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'NaraRouter rejected the API key';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This key cannot use that model on NaraRouter';
  if (err instanceof Anthropic.NotFoundError) return 'NaraRouter does not know that model name';
  if (err instanceof Anthropic.RateLimitError) return 'NaraRouter rate limit or credit limit reached';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach NaraRouter';
  if (err instanceof Anthropic.APIError) return `NaraRouter error ${err.status ?? ''}`.trim();
  return err.message;
}

async function askJson(system, user, maxTokens = 1500) {
  const { model } = config();
  const res = await getClient().messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  if (res.stop_reason === 'refusal') throw new Error('The model declined this request');
  return parseJsonObject(textOf(res));
}

export async function testAi() {
  const { key, model } = config();
  if (!key) throw Object.assign(new Error('Add your NaraRouter API key first'), { status: 412 });
  try {
    const res = await getClient().messages.create({ model, max_tokens: 200, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
    return { ok: true, model: res.model ?? model, provider: aiInfo().provider, reply: textOf(res).trim().slice(0, 80) };
  } catch (err) {
    throw Object.assign(new Error(describeError(err)), { status: 502 });
  }
}

// Claude models NaraRouter listed publicly; used when the live list can't be fetched.
export const KNOWN_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8'];

export async function listModels() {
  if (!aiConfigured()) return { models: KNOWN_MODELS, live: false };
  try {
    const ids = [];
    for await (const m of getClient().models.list()) ids.push(m.id);
    return { models: ids.length ? ids.sort() : KNOWN_MODELS, live: ids.length > 0 };
  } catch {
    return { models: KNOWN_MODELS, live: false };
  }
}

// ---------- message drafting ----------
const DRAFT_SYSTEM = `You help an Indian business recover payments from its own customers.
Write warm, short, factual messages that comply with the RBI Fair Practices Code: never threaten or shame, never mention police, arrest, jail, court, blacklists or "defaulter", always name the business, and end WhatsApp messages with an opt-out line ("Reply STOP to opt out." / "Messages band karne ke liye STOP likhein.").
Hinglish means Romanised Hindi mixed with English, as people actually text in India.
Use only the facts provided. Do not invent amounts, dates or reasons.
Reply with only a JSON object with the string keys "whatsapp_en", "whatsapp_hinglish" and "call_opening" (the first two sentences for a phone call). Each WhatsApp message must be under 320 characters and end with the opt-out line.`;

export async function draftForCase(c, policy, merchant) {
  const link = c.links?.at(-1)?.shortUrl ?? '<payment link>';
  let draft = null;
  let source = 'template';
  let note = null;
  if (aiConfigured()) {
    try {
      const facts = {
        business: merchant, case_type: CASE_TYPES[c.type].label, amount_inr: c.amount, reference: c.ref,
        reason: c.causeLabel, customer_first_name: (c.customer?.name ?? '').split(' ')[0] || null, payment_link: link,
        overdue_days: c.overdueDays,
      };
      draft = await askJson(DRAFT_SYSTEM, `Draft the outreach.\n${JSON.stringify(facts)}`);
      for (const k of ['whatsapp_en', 'whatsapp_hinglish', 'call_opening']) if (typeof draft[k] !== 'string') throw new Error('The model returned an incomplete draft');
      source = config().model;
    } catch (err) {
      note = `${describeError(err)}: showing templates`;
    }
  }
  if (!draft) {
    draft = {
      whatsapp_en: whatsappText({ ...c, customer: { ...c.customer, lang: 'en' } }, merchant, link),
      whatsapp_hinglish: whatsappText({ ...c, customer: { ...c.customer, lang: 'hinglish' } }, merchant, link),
      call_opening: callScript(c, merchant, link).slice(0, 2).join(' '),
    };
  }
  const lint = {
    whatsapp_en: lintMessage(draft.whatsapp_en, { channel: 'team_whatsapp', merchant }, policy),
    whatsapp_hinglish: lintMessage(draft.whatsapp_hinglish, { channel: 'team_whatsapp', merchant }, policy),
  };
  return { ...draft, source, note, lint };
}

// ---------- AI diagnosis ----------
// Only for failed payments whose Razorpay error fields matched no rule. The
// model must pick one of the known causes, or "unknown"; anything else is ignored.
const PAYMENT_CAUSES = ['insufficient_funds', 'issuer_downtime', 'auth_failure', 'card_invalid', 'risk_decline', 'limit_exceeded', 'customer_cancelled', 'payment_timeout', 'unknown'];
const DIAG_SYSTEM = `You classify why an Indian online payment failed, from the error fields a payment gateway returned.
Allowed causes: ${PAYMENT_CAUSES.map((k) => `"${k}" (${CAUSES[k].label})`).join(', ')}.
Use "unknown" if the fields do not support a clear answer. Do not guess from the amount or the customer.
Reply with only a JSON object: {"cause": "<one allowed cause>", "confidence": <0 to 1>, "explanation": "<one short sentence citing the field>"}.`;

export async function aiDiagnose(payment) {
  const fields = Object.fromEntries(['error_code', 'error_description', 'error_reason', 'error_source', 'error_step', 'method', 'bank', 'wallet'].map((k) => [k, payment?.[k] ?? null]));
  if (!Object.values(fields).slice(0, 5).some(Boolean)) return null; // nothing to read
  const out = await askJson(DIAG_SYSTEM, JSON.stringify(fields), 400);
  if (!PAYMENT_CAUSES.includes(out.cause)) return null;
  const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
  return { cause: out.cause, confidence, explanation: String(out.explanation ?? '').slice(0, 300), model: config().model };
}
