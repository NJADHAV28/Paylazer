// Writes models/MODEL_CARD.md from the trained artifact. Run by `npm run train`,
// or on its own with `node scripts/model-card.js`.
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT } from '../server/ml/repayment.js';

export function writeModelCard(a = JSON.parse(readFileSync(ARTIFACT, 'utf8'))) {
  const t = a.metrics.test;
  const th = t.atThreshold;
  const pc = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
  const card = `# Model card: repayment risk (${a.version})

**What it predicts:** the probability that a customer will **not** pay their next bill, from how they
paid their previous six bills. In Paylazar it scores overdue invoices and failed subscription charges,
using the customer's earlier Razorpay invoices.

**Final model:** ${a.params.model}. Artifact: \`models/repayment-risk.json\` (trained ${a.trainedAt.slice(0, 10)}, ${a.trainingSeconds}s, seed ${a.params.seed}).

## Training data (real)

| | |
|---|---|
| Dataset | [${a.dataset.name}](${a.dataset.url}) |
| Licence | ${a.dataset.licence} |
| Records | ${a.dataset.rows.toLocaleString('en-IN')} real customers, ${a.dataset.positives.toLocaleString('en-IN')} defaulted (${pc(a.dataset.positives / a.dataset.rows)}) |
| CSV checksum | SHA-256 \`${a.dataset.sha256}\` |
| Split | ${a.dataset.split.train} train / ${a.dataset.split.validation} validation / ${a.dataset.split.test} test (${a.dataset.split.method}) |
| Inputs | ${a.dataset.featuresUsed} |

Excluded on purpose: sex, education, marital status, age and credit limit. They are not available
from Razorpay and should not drive collection decisions.

## Method

Two candidates were trained on the same inputs. The validation set alone chose the model, its settings
and the flagging threshold. The test set was used once, to report the numbers below.

| Candidate | Validation AUC | Test AUC | |
|---|---|---|---|
${a.candidates.map((c) => `| ${c.label} | ${c.validationAuc.toFixed(4)} | ${c.testAuc.toFixed(4)} | ${c.selected ? 'chosen' : ''} |`).join('\n')}

## Results on ${t.n.toLocaleString('en-IN')} held-out test customers

| Metric | Value |
|---|---|
| AUC | ${t.auc.toFixed(3)} |
| KS statistic | ${t.ks.toFixed(3)} |
| Log loss | ${t.logloss.toFixed(3)} |
| Brier score | ${t.brier.toFixed(3)} |
| Default rate | ${pc(t.baseRate)} |
| Threshold (chosen on validation) | ${th.threshold} |
| Accuracy at threshold | ${pc(th.accuracy)} |
| Recall (defaulters caught) | ${pc(th.recall)} |
| Precision (flagged who default) | ${pc(th.precision)} |

Confusion matrix at the threshold: ${th.tp} true positives, ${th.fp} false positives, ${th.fn} false negatives, ${th.tn} true negatives.

| Last bill was… | Customers | Actually defaulted | Model's average |
|---|---|---|---|
${a.segments.map((g) => `| ${g.label} | ${g.n} | ${pc(g.observed)} | ${pc(g.predicted)} |`).join('\n')}

## How to use it

* **In the app:** Models → *Try it* for one customer, or *Score a list of customers* for a CSV.
* **Command line:** \`npm run score -- customers.csv scored.csv\`. Columns: \`status_1..6\` (paid, partial, none,
  or months late 1-8), \`bill_1..6\`, \`paid_1..6\`, with cycle 1 the most recent bill.
* **Retrain:** \`npm run train\` (deterministic: same data and seed give the same model).

## Limits

* The data comes from one Taiwanese card issuer in 2005. Behaviour patterns (lateness, partial payment)
  transfer well; absolute levels may differ for your customers. Treat the score as a prior, and compare it
  with your own outcomes over time.
* Customers with no earlier invoices get no score; Paylazar does not guess.
* It ranks risk. It does not decide anything on its own: in Paylazar, escalations it influences (instalment
  plans, formal notices) always need human approval.
`;
  const out = join(dirname(ARTIFACT), 'MODEL_CARD.md');
  writeFileSync(out, card);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(`Wrote ${writeModelCard()}`);
