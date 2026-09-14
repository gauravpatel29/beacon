// Every chart axis says what it represents.
// Run: node src/services/axislabels.check.mjs
//
// The Data Review charts drew bare numbers on both axes: a trend line with no
// indication that x was a week and y a metric value, and a histogram whose y
// axis could equally have been a count, a share or a total. Two of the four
// charts had labels and two did not, so this walks every chart in the file
// rather than naming the ones that were wrong at the time.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const review = read('../pages/DataReview/DataReview.jsx');

// Each chart component, from its declaration to the closing brace at column 0.
const charts = [...review.matchAll(/function (\w*Chart)\(([\s\S]*?)\n\}/g)]
  .filter(([, name]) => name !== 'ChartTooltip');

console.log('\n1. every chart in Data Review labels both axes');
t('the charts were found', charts.length >= 4, charts.length);
for (const [, name, body] of charts) {
  const xAxes = (body.match(/<XAxis/g) || []).length;
  const yAxes = (body.match(/<YAxis/g) || []).length;
  const labels = (body.match(/label=\{\{/g) || []).length;
  if (!xAxes && !yAxes) continue; // not a cartesian chart
  t(name + ' labels every axis it draws', labels >= xAxes + yAxes,
    { axes: xAxes + yAxes, labels });
}

console.log('\n2. the labels are styled the same way everywhere');
// Mixed offsets meant a title sat at a different distance from the ticks on
// each chart, which reads as a misalignment rather than a choice.
for (const [, name, body] of charts) {
  if (!/<XAxis/.test(body)) continue;
  t(name + ' uses the shared x style', body.includes('...X_LABEL'), 'inline label style');
  t(name + ' uses the shared y style', body.includes('...Y_LABEL'), 'inline label style');
}
t('the shared styles exist', /const X_LABEL = \{/.test(review) && /const Y_LABEL = \{/.test(review),
  'no shared definition');

console.log('\n3. the chart reserves room for the title');
// An axis title is drawn in the margin. Without the bottom margin it lands on
// top of the tick labels underneath it.
for (const [, name, body] of charts) {
  if (!/<XAxis/.test(body)) continue;
  const margin = body.match(/margin=\{\{[^}]*\}\}/);
  t(name + ' leaves a bottom margin for the x title',
    Boolean(margin) && /bottom:\s*(1[6-9]|[2-9]\d)/.test(margin[0]),
    margin ? margin[0] : 'no margin set');
}

console.log('\n4. labels name the selection, not just the axis');
// "Week ending" / the metric name beats "x" and "y", so the chart can be read
// without hunting for the control that produced it.
t('the trend x axis follows the aggregation',
  /xLabel=\{aggregation === 'mom' \? 'Month' : 'Week ending'\}/.test(review), 'static label');
t('the trend y axis names the metric when only one is plotted',
  /selectedMetrics\.length === 1 \? selectedMetrics\[0\]/.test(review), 'always generic');
t('and says so when the view is indexed',
  /Indexed \(first period = 100\)/.test(review), 'indexed view looks like raw values');
t('the histogram x axis names the column being binned',
  /xLabel=\{`\$\{distVariable\} \(binned\)`\}/.test(review), 'generic label');
t('and its y axis says what is being counted',
  /yLabel="Records"/.test(review), 'unlabelled count');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
