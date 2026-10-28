# Paylazar

Paylazar recovers money that is slipping away in a Razorpay business: failed payments, abandoned
checkouts, failed subscription charges, overdue invoices and expired payment links. It works only on
**your real Razorpay data**, imported from Razorpay Dashboard exports. There is no demo or generated data.

The only key it uses is a **NaraRouter** key (https://router.bynara.id), which powers all AI. The
repayment-risk model runs locally and needs no key.

```
Razorpay Dashboard CSV ─► import ─► detect ─► diagnose ─────────► plan ─► guardrails ─► team tasks ─► measure
 (payments, orders,                  cases    rules on Razorpay    playbook +  consent,     link / invoice  vs a real
  invoices)                                   error fields, then   timing      window,      resend in the   holdout,
                                              NaraRouter AI for    (payday,    caps         Dashboard,      audit chain
                                              unexplained ones     bank health)             calls, WhatsApp
```

## What it does

| Case | Found from your export | Resolved when |
|---|---|---|
| Failed payment | Failed payments, grouped by order (works with a payments-only export) | A later payment on the order is captured |
| Abandoned checkout | Orders unpaid 30 minutes after creation | The order is paid |
| Failed subscription | Subscriptions in `pending` / `halted` | The subscription is active again |
| Overdue invoice | Issued invoices past their due date | The invoice is paid |
| Unpaid payment link | Links that expired unpaid | Paid |

* **Diagnosis:** rules read Razorpay's `error_source`, `error_step`, `error_reason` and `error_description`.
  When none match, NaraRouter reads only those error fields (never customer details) and picks a cause.
  It is used only at 60% confidence or higher, and is shown as AI in the case and the audit log.
* **Payment health:** each bank, UPI handle and card issuer is compared with its own 7-day normal.
  Follow-ups for customers of a degraded provider wait until it recovers.
* **Tasks, not robots:** every follow-up is a task with exact steps or a script. Share a payment link or
  resend the invoice from the Razorpay Dashboard, call, or WhatsApp. Messages can be drafted by NaraRouter
  in English and Hinglish, and are checked against content rules. Instalment plans and formal notices
  need approval.
* **Guardrails:** contact only between 08:00 and 19:00 IST (RBI Fair Practices Code), contact caps, a
  do-not-contact list, and a stop on dispute or opt-out.
* **Measurement:** a random holdout (10%) is left alone; the Overview compares recovery with and without
  Paylazar once each group has 30 matured cases. Imported history shows what recovered on its own.
* **Audit log:** every step is SHA-256 chained, verifiable and exportable as CSV.

## Models (real data only)

**Repayment risk** (`models/repayment-risk.json`, model card in `models/MODEL_CARD.md`)

* Trained on the UCI *Default of Credit Card Clients* dataset: 30,000 real customers, CC BY 4.0.
  Provenance and checksum are in `data/datasets/uci-credit-default/SOURCE.md`.
* Uses only behavioural inputs: on-time, late or partial payment over six cycles, and the share of each
  bill paid. Demographics, credit limit and absolute amounts are excluded.
* Two candidates are trained: logistic regression and gradient-boosted trees (implemented in
  `server/ml/gbdt.js`, with early stopping). The validation set picks the model, its depth and the
  flagging threshold. The untouched test set is used once, for the report.

| Candidate | Validation AUC | Test AUC |
|---|---|---|
| Logistic regression | 0.762 | 0.751 |
| **Gradient-boosted trees (chosen)** | **0.773** | **0.758** |

On the 4,501 test customers the final model reaches an accuracy of 79.1% and a KS statistic of 0.433.
It catches 58% of customers who default, and 53% of the customers it flags do default (threshold 0.29).
Calibration stays within a few points: "2 months late" customers defaulted 69.7% of the time, and the
model predicted 68.2%.

Use it:

* **In the app:** Models → *Try it* for one customer, or *Score a list of customers* to upload a CSV and
  download it with scores added.
* **Command line:** `npm run score -- customers.csv scored.csv`. Download the column template from the
  Models page.
* **Retrain:** `npm run train` (about 90 seconds, deterministic). It also rewrites the model card.

**Would pay anyway** (`data/models/recovery.json`, specific to your business)

* Trained on your own Razorpay history: only closed cases Paylazar never touched (imported history plus the
  holdout), with label = paid within the case window.
* Time-based split: oldest 80% for training, newest 20% for testing.
* It will not train until there are 200 such cases with at least 20 of each outcome; the Models page shows
  progress. Once trained, it moves money that would otherwise be lost to the top of the queue.

## Run it

Requires Node.js 22.13+.

```bash
npm run setup     # install server + web dependencies
npm run build
npm start         # http://localhost:8787
```

1. **Add your NaraRouter key** to `.env` (copy `.env.example`):
   ```
   NARA_API_KEY=sk-nry-...
   PAYLAZAR_MODEL=claude-opus-5
   ```
   and restart. NaraRouter's address (`https://router.bynara.id`) is built in. The key is read only from
   `.env`; it never appears in the interface.
2. **Import your data:** **Import data** in the sidebar → drop a Payments CSV exported from the Razorpay Dashboard
   (Transactions → Payments → Export), then Orders and Invoices if you use them. Column names are matched
   automatically, dd/mm/yyyy dates are read as IST, and you confirm whether amounts are in rupees or paise.
   Re-import any time to pick up new payments; existing rows are updated, not duplicated.
3. Your team works through the **Action queue**.

Development: `npm run dev` (API on :8787, UI on :5173). Tests: `npm test` (18 tests). They drive the full
pipeline with test CSV inputs and a local stand-in for NaraRouter; those fixtures live only in `server/test/`.

## Layout

```
server/
  agent/    importer (CSV) · detect · diagnose · health · decide · execute · measure · loop · settings
  credentials.js            NaraRouter key and model from .env
  engine/   catalog (case types, causes, playbooks) · policy (guardrails, content rules) · messaging · audit
  ml/       linear · gbdt (boosted trees) · repayment (UCI model) · scoring · recovery (your history)
  ai/       copilot: NaraRouter client, AI diagnosis, message drafting
  db.js     SQLite (data/paylazar-live.db)
  index.js  API + web app
data/datasets/uci-credit-default/   real training data + SOURCE.md
models/repayment-risk.json          trained model · models/MODEL_CARD.md
web/        React UI: Overview, Cases, Action queue, Payment health, Import data, Models, Settings, Audit log
```
