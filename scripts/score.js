// npm run score -- input.csv [output.csv]
// Scores customers with the trained repayment-risk model. Download the column
// template from the Models page, or see models/MODEL_CARD.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { scoreCsv } from '../server/ml/scoring.js';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run score -- input.csv [output.csv]');
  process.exit(1);
}
const r = scoreCsv(readFileSync(input, 'utf8'));
if (output) {
  writeFileSync(output, r.csv);
  const ok = r.rows.filter((x) => x.score != null);
  console.log(`Scored ${ok.length} of ${r.rows.length} rows with ${r.model} -> ${output}`);
  console.log(`High risk: ${ok.filter((x) => x.tier === 'high').length} · medium: ${ok.filter((x) => x.tier === 'medium').length} · low: ${ok.filter((x) => x.tier === 'low').length}`);
  for (const e of r.rows.filter((x) => x.error).slice(0, 5)) console.log(`  row ${e.row}: ${e.error}`);
} else process.stdout.write(`${r.csv}\n`);
