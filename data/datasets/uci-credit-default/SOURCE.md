# Default of Credit Card Clients (UCI Machine Learning Repository)

Real repayment records of 30,000 credit-card customers of a Taiwanese bank (April–September 2005).

* Source: https://archive.ics.uci.edu/dataset/350/default+of+credit+card+clients
* Downloaded file: `default of credit card clients.xls`,
  SHA-256 `30c6be3abd8dcfd3e6096c828bad8c2f011238620f5369220bd60cfc82700933`
* Licence: Creative Commons Attribution 4.0 (CC BY 4.0)
* Citation: Yeh, I. C., & Lien, C. H. (2009). The comparisons of data mining techniques for the
  predictive accuracy of probability of default of credit card clients. *Expert Systems with
  Applications*, 36(2), 2473–2480.

`credit-default.csv` is the original sheet converted to CSV (header row kept, the extra
"X1..Y" label row removed, target renamed to `DEFAULT_NEXT_MONTH`). No rows were altered.

Paylazar uses **only the behavioural columns** (`PAY_0`, `PAY_2`–`PAY_6` repayment status,
`BILL_AMT1`–`6`, `PAY_AMT1`–`6`). Demographic columns (sex, education, marriage, age) and the
credit limit are deliberately excluded: they are not available from Razorpay and should not
drive collections decisions.
