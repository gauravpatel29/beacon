// Weighted impactable share, and the ROI curve's zero-spend point.
// Run: node src/services/impactshare.check.mjs

import { readFileSync } from 'node:fs';
import {
  parsePercent, weightFor, weightedShareTenths,
  weightedShareColumn, weightedSharePercents,
} from './impactShare.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) =>
  t(label, JSON.stringify(got) === JSON.stringify(want), got);

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const config = read('../pages/ModelConfiguration/ModelConfiguration.jsx');
const output = read('../pages/ModelOutput/ModelOutput.jsx');

console.log('\n1. the reference table, reproduced exactly');
// The figures supplied with the request. Each share is multiplied by its
// weight as a FRACTION (55.30% -> 0.553 * 0.6 = 0.3318), the weighted values
// are summed (0.47198), and each is divided by that total.
const W = {
  Carryover_Lag1_Sales: 0.6, Calls: 0.3, RTE_opens: 0.01,
  Digital_Impressions: 0.03, Paid_Social_Impressions: 0.02,
  Paid_Search_Impressions: 0.01, Speaker_Attendees: 0.03,
};
const REFERENCE = [
  ['const', '0.00%', '0.0%'],
  ['Carryover_Lag1_Sales', '55.30%', '70.3%'],
  ['Calls_transformed', '32.40%', '20.6%'],
  ['RTE_opens_transformed', '24.70%', '0.5%'],
  ['Digital_Impressions_transformed', '67.80%', '4.3%'],
  ['Paid_Social_Impressions_transformed', '58.80%', '2.5%'],
  ['Paid_Search_Impressions_transformed', '47.50%', '1.0%'],
  ['Speaker_Attendees_transformed', '12.20%', '0.8%'],
];
const refRows = REFERENCE.map(([Variable, pct]) => ({ Variable, 'Impactable (%)': pct }));
const got = weightedShareColumn(refRows, 'Impactable (%)', (r) => weightFor(W, r.Variable));
REFERENCE.forEach(([name, , want], i) => eq(`${name} reads ${want}`, got[i], want));
eq('and the column totals exactly 100.0',
   Number(got.reduce((s, v) => s + parseFloat(v), 0).toFixed(1)), 100);

console.log('\n2. the weight lookup');
// Coefficients come back as `<name>_transformed`; weights are keyed by the
// name the user typed.
eq('the suffix is stripped for the lookup', weightFor(W, 'Calls_transformed'), 0.3);
eq('an exact key still works', weightFor(W, 'Calls'), 0.3);
eq('an unweighted variable weighs 1', weightFor(W, 'const'), 1);
eq('no weight map at all means 1', weightFor(null, 'anything'), 1);
eq('a zero weight is honoured, not replaced', weightFor({ a: 0 }, 'a'), 0);
eq('a negative weight falls back to 1', weightFor({ a: -2 }, 'a'), 1);
eq('a non-numeric weight falls back to 1', weightFor({ a: 'x' }, 'a'), 1);

console.log('\n3. unweighted behaviour is unchanged');
// Every OLS run has no weights, so this must reduce to plain renormalisation.
const plain = (pcts) => weightedShareColumn(
  pcts.map((p) => ({ 'Impactable (%)': p })), 'Impactable (%)');
eq('already 100 stays put', plain([50, 30, 20]), ['50.0%', '30.0%', '20.0%']);
eq('under 100 is scaled up', plain([40, 30, 20]), ['44.5%', '33.3%', '22.2%']);
eq('a negative floors to zero first', plain([60, 50, -10]), ['54.5%', '45.5%', '0.0%']);
eq('three thirds still total 100.0', plain([1, 1, 1]), ['33.4%', '33.3%', '33.3%']);
eq('an all-negative column is all zeroes', plain([-5, -3]), ['0.0%', '0.0%']);
eq('a blank stays null', plain([50, null, 50]), ['50.0%', null, '50.0%']);
eq('text stays null', plain(['n/a']), [null]);

console.log('\n4. weighting changes the answer, and only through the weights');
const rows = [{ Variable: 'a', p: 50 }, { Variable: 'b', p: 50 }];
eq('equal shares, equal weights, equal halves',
   weightedShareColumn(rows, 'p', () => 1), ['50.0%', '50.0%']);
eq('equal shares, 3:1 weights',
   weightedShareColumn(rows, 'p', (r) => (r.Variable === 'a' ? 3 : 1)), ['75.0%', '25.0%']);
eq('a zero weight removes a row from the total',
   weightedShareColumn(rows, 'p', (r) => (r.Variable === 'a' ? 1 : 0)), ['100.0%', '0.0%']);
eq('scaling every weight changes nothing',
   weightedShareColumn(rows, 'p', () => 7), ['50.0%', '50.0%']);
// A negative share contributes nothing regardless of its weight - the floor
// happens before the multiplication.
eq('a negative share is floored before weighting',
   weightedShareColumn([{ p: -80 }, { p: 20 }], 'p', () => 5), ['0.0%', '100.0%']);
eq('all weights zero gives zeroes, not a division by zero',
   weightedShareColumn(rows, 'p', () => 0), ['0.0%', '0.0%']);

console.log('\n5. the pieces');
eq('parsePercent reads a percent string', parsePercent('12.40%'), 12.4);
eq('parsePercent reads a bare number', parsePercent(12.4), 12.4);
eq('parsePercent rejects text', parsePercent('n/a'), null);
eq('parsePercent rejects a blank', parsePercent(''), null);
eq('tenths sum to 1000', weightedShareTenths([50, 30, 20], [1, 1, 1])
   .reduce((s, v) => s + v, 0), 1000);
eq('percents are the tenths divided by ten',
   weightedSharePercents([{ p: 50 }, { p: 50 }], 'p'), [50, 50]);

console.log('\n6. both screens use it, and use the same weights');
t('Model Configuration imports the shared calculation',
  /import \{ weightedShareColumn, weightFor \} from '\.\.\/\.\.\/services\/impactShare\.js';/.test(config),
  'not imported');
t('its coefficient table weights each share',
  /weightedShareColumn\(visibleRows, c, \(r\) => weightFor\(weights, r\.Variable\)\)/.test(config),
  'still unweighted');
t('the local copy of the calculation is gone',
  !/^function percentColumn\(/m.test(config), 'two copies to drift apart');
t('the table is given the weights the RESULT was run under',
  /weights=\{viewedWeights\}/.test(config), 'reads whatever is in the form now');
t('and those are captured at run time',
  /const runWeights = useCustomPenalties \? \{ \.\.\.priorWeights \} : null;/.test(config),
  'not captured');
t('the run is recorded with its weights',
  /priorWeights: runWeights,/.test(config), 'Model Output cannot match this run');
t('and a loaded history row restores them',
  /if \(m\.priorWeights && typeof m\.priorWeights === 'object'\)/.test(config), 'lost on reload');
t('Model Output imports it too',
  /import \{ weightedSharePercents, weightFor \} from '\.\.\/\.\.\/services\/impactShare\.js';/.test(output),
  'not imported');
t('Impact Share reads the weighted column',
  /\{impactShares\[d\.variable\] \?\? 'NA'\}/.test(output), 'still sales over total');
t('computed from the run\'s own weights',
  /const weights = viewingModel\?\.priorWeights \|\| null;/.test(output), 'uses no weights');
t('and the old sales-over-total formula is gone',
  !/d\.impactableSales \/ highLevelImpact\.salesTotal/.test(output), 'old formula remains');

console.log('\n7. the ROI curve has no fabricated zero-spend point');
// roi at spend 0 is 0/0. The engine substitutes the first step's marginal
// ROI, which is by construction the same number it computes as the ROI at
// that first step - two points, one value, drawn as a flat shoulder.
t('the zero-spend point is dropped',
  /\(currentCurve \|\| \[\]\)\.filter\(\(p\) => Number\(p\.spend\) > 0\)/.test(output),
  'the shoulder remains');
t('the ROI chart plots the filtered series',
  /<LineChart data=\{roiCurve\}/.test(output), 'still plots the raw curve');
t('the x-axis is numeric and anchored at zero',
  /<XAxis type="number" dataKey="spend" domain=\{\[0, 'dataMax'\]\}/.test(output),
  'the scale would not start at 0');
t('the sales chart still shows the full curve',
  /<LineChart data=\{currentCurve\}/.test(output), 'filtered the wrong chart too');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
