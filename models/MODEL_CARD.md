# Model card: repayment risk (rr-74f00edf)

**What it predicts:** the probability that a customer will **not** pay their next bill, from how they
paid their previous six bills. In Paylazar it scores overdue invoices and failed subscription charges,
using the customer's earlier Razorpay invoices.

**Final model:** gradient-boosted trees (118 trees, depth 3, learning rate 0.05). Artifact: `models/repayment-risk.json` (trained 2026-10-27, 83.4s, seed 2026).

## Training data (real)

| | |
|---|---|
| Dataset | [Default of Credit Card Clients (UCI ML Repository, id 350)](https://archive.ics.uci.edu/dataset/350/default+of+credit+card+clients) |
| Licence | CC BY 4.0 |
| Records | 30,000 real customers, 6,636 defaulted (22.1%) |
| CSV checksum | SHA-256 `352117836973607dfd2c6e70c7d4ef0f6f0f6f347a268ae8bf65cf681aa44156` |
| Split | 20999 train / 4500 validation / 4501 test (stratified 70 / 15 / 15, fixed seed) |
| Inputs | repayment status, share of each bill paid and bill trend over 6 cycles (no absolute amounts, demographics or credit limit) |

Excluded on purpose: sex, education, marital status, age and credit limit. They are not available
from Razorpay and should not drive collection decisions.

## Method

Two candidates were trained on the same inputs. The validation set alone chose the model, its settings
and the flagging threshold. The test set was used once, to report the numbers below.

| Candidate | Validation AUC | Test AUC | |
|---|---|---|---|
| Logistic regression | 0.7619 | 0.7513 |  |
| Gradient-boosted trees | 0.7728 | 0.7584 | chosen |

## Results on 4,501 held-out test customers

| Metric | Value |
|---|---|
| AUC | 0.758 |
| KS statistic | 0.433 |
| Log loss | 0.435 |
| Brier score | 0.135 |
| Default rate | 22.1% |
| Threshold (chosen on validation) | 0.29 |
| Accuracy at threshold | 79.1% |
| Recall (defaulters caught) | 57.9% |
| Precision (flagged who default) | 52.5% |

Confusion matrix at the threshold: 577 true positives, 522 false positives, 419 false negatives, 2983 true negatives.

| Last bill was… | Customers | Actually defaulted | Model's average |
|---|---|---|---|
| Nothing billed | 415 | 10.4% | 13.8% |
| Paid in full on time | 823 | 18.5% | 16.3% |
| Paid part of it | 2189 | 12.0% | 13.1% |
| 1 month late | 584 | 34.2% | 34.5% |
| 2 months late | 423 | 69.7% | 68.2% |
| 3+ months late | 67 | 64.2% | 69.9% |

## How to use it

* **In the app:** Models → *Try it* for one customer, or *Score a list of customers* for a CSV.
* **Command line:** `npm run score -- customers.csv scored.csv`. Columns: `status_1..6` (paid, partial, none,
  or months late 1-8), `bill_1..6`, `paid_1..6`, with cycle 1 the most recent bill.
* **Retrain:** `npm run train` (deterministic: same data and seed give the same model).

## Limits

* The data comes from one Taiwanese card issuer in 2005. Behaviour patterns (lateness, partial payment)
  transfer well; absolute levels may differ for your customers. Treat the score as a prior, and compare it
  with your own outcomes over time.
* Customers with no earlier invoices get no score; Paylazar does not guess.
* It ranks risk. It does not decide anything on its own: in Paylazar, escalations it influences (instalment
  plans, formal notices) always need human approval.
