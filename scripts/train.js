// npm run train: trains the repayment-risk model on the real UCI dataset and
// writes models/repayment-risk.json.
import { trainRepayment, saveRepayment, ARTIFACT } from '../server/ml/repayment.js';
import { writeModelCard } from './model-card.js';

const pc = (v) => `${(v * 100).toFixed(1)}%`;
const a = trainRepayment({ onLog: (m) => console.log(`  ${m}`) });
saveRepayment(a);
const card = writeModelCard(a);
const m = a.metrics.test;
console.log(`\nSaved ${a.version} (${a.params.model}) in ${a.trainingSeconds}s -> ${ARTIFACT}`);
for (const c of a.candidates) console.log(`  ${c.selected ? '*' : ' '} ${c.label.padEnd(24)} validation AUC ${c.validationAuc.toFixed(4)}   test AUC ${c.testAuc.toFixed(4)}`);
console.log(`Test (held out, n=${m.n}): AUC ${m.auc.toFixed(3)} · KS ${m.ks.toFixed(3)} · log-loss ${m.logloss.toFixed(3)} · Brier ${m.brier.toFixed(3)} · default rate ${pc(m.baseRate)}`);
console.log(`At threshold ${a.params.threshold}: precision ${pc(m.atThreshold.precision)} · recall ${pc(m.atThreshold.recall)} · accuracy ${pc(m.atThreshold.accuracy)}`);
console.log(`Model card -> ${card}`);
