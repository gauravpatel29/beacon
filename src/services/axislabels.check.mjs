// Every chart axis says what it represents, and every chart can be hovered.
// Run: node src/services/axislabels.check.mjs
//
// Data Review drew bare numbers on both axes: a trend line with no indication
// that x was a week and y a metric value. Data Transformation was worse - its
// inspector charts were hand-drawn SVGs with no axes and no hover at all, so a
// shape was visible but no value could be read off it.
//
// Both screens now share one chart stack: recharts for the drawing, and one
// tooltip component so the same number is never formatted two ways.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const review = read('../pages/DataReview/DataReview.jsx');
const tx = read('../pages/DataTransformation/DataTransformation.jsx');
const shared = read('../components/charts/ChartTooltip.jsx');
const theme = read('../components/charts/chartTheme.js');
const sharedCss = read('../components/charts/ChartTooltip.css');

// Each chart component, from its declaration to the closing brace at column 0.
const chartsIn = (src) => [...src.matchAll(/function (\w*Chart)\(([\s\S]*?)\n\}/g)]
  .filter(([, name]) => name !== 'ChartTooltip');

console.log('\n1. every chart labels both axes');
for (const [file, src] of [['DataReview', review], ['DataTransformation', tx]]) {
  const charts = chartsIn(src);
  t(file + ' has charts to check', charts.length >= 2, charts.length);
  for (const [, name, body] of charts) {
    const axes = (body.match(/<XAxis/g) || []).length + (body.match(/<YAxis/g) || []).length;
    if (!axes) continue; // not a cartesian chart
    const labels = (body.match(/label=\{\{/g) || []).length;
    t(`${file}/${name} labels every axis it draws`, labels >= axes, { axes, labels });
  }
}

console.log('\n2. the labels are styled the same way everywhere');
// Mixed offsets meant a title sat at a different distance from the ticks on
// each chart, which reads as a misalignment rather than a choice.
for (const [file, src] of [['DataReview', review], ['DataTransformation', tx]]) {
  for (const [, name, body] of chartsIn(src)) {
    if (!/<XAxis/.test(body)) continue;
    t(`${file}/${name} uses the shared x style`, body.includes('...X_LABEL'), 'inline style');
    t(`${file}/${name} uses the shared y style`, body.includes('...Y_LABEL'), 'inline style');
  }
}

console.log('\n3. the chart reserves room for the title');
// An axis title is drawn in the margin. Without a bottom margin it lands on
// top of the tick labels underneath it.
for (const [, name, body] of chartsIn(review)) {
  if (!/<XAxis/.test(body)) continue;
  const margin = body.match(/margin=\{\{[^}]*\}\}/);
  t('DataReview/' + name + ' leaves a bottom margin',
    Boolean(margin) && /bottom:\s*(1[6-9]|[2-9]\d)/.test(margin[0]),
    margin ? margin[0] : 'no margin set');
}
t('DataTransformation shares one margin with room for the title',
  /const CHART_MARGIN = \{[^}]*bottom: (1[6-9]|[2-9]\d)/.test(tx), 'title would overlap');

console.log('\n4. labels name the selection, not just the axis');
t('the trend x axis follows the aggregation',
  /xLabel=\{aggregation === 'mom' \? 'Month' : 'Week ending'\}/.test(review), 'static label');
t('the trend y axis names the metric when only one is plotted',
  /selectedMetrics\.length === 1 \? selectedMetrics\[0\]/.test(review), 'always generic');
t('and says so when the view is indexed',
  /Indexed \(first period = 100\)/.test(review), 'indexed view looks like raw values');
t('the review histogram names the column being binned',
  /xLabel=\{`\$\{distVariable\} \(binned\)`\}/.test(review), 'generic label');
t('the inspector histograms name the channel',
  /xLabel=\{activeInspectVar\}/.test(tx), 'generic label');
t('and mark the transformed side', /\(transformed\)/.test(tx), 'both sides look identical');
t('the inspector curves name the KPI',
  /yLabel=\{`Average \$\{dependentVars\[0\]/.test(tx), 'unlabelled response');

console.log('\n5. the inspector charts use recharts now');
t('the hand-drawn SVGs are gone', !/<svg viewBox/.test(tx), 'still drawing by hand');
t('recharts is imported', /from 'recharts'/.test(tx), 'no recharts');
t('the histogram is a BarChart', /<BarChart/.test(tx), 'not converted');
t('the curve is a LineChart', /<LineChart/.test(tx), 'not converted');
t('the histogram x axis carries the real bin ranges',
  /binLabels=\{inspectDetail\.binsBefore\}/.test(tx), 'axis would count bins, not values');

console.log('\n6. hover works, through the shared tooltip');
t('both charts render a Tooltip', (tx.match(/<Tooltip/g) || []).length >= 2, 'no hover');
t('using the shared component', /content=\{[\s\S]{0,60}<ChartTooltip/.test(tx), 'its own box');
t('the histogram reports the count and its share',
  /label: 'Share'/.test(tx), 'a bar with no context');
t('the curve names the KPI in the row',
  /label: yLabel, value: fmt/.test(tx), 'unlabelled value');

console.log('\n7. one tooltip implementation, not two');
const importsShared = (src) =>
  /import \{[\s\S]{0,160}ChartTooltip[\s\S]{0,160}\} from '\.\.\/\.\.\/components\/charts\/ChartTooltip\.jsx'/
    .test(src);
t('the component lives in components/charts',
  /export function ChartTooltip/.test(shared), 'not extracted');
t('Data Review imports it', importsShared(review), 'not imported');
t('and no longer defines its own', !/^function ChartTooltip/m.test(review), 'a second copy survives');
t('Data Transformation imports it too', importsShared(tx), 'not shared');
t('the axis styles are shared',
  /export const X_LABEL/.test(theme) && !/^const X_LABEL/m.test(review), 'duplicated');
// Two formatters would eventually disagree about the same number.
t('and the number formatting',
  /export const fmt/.test(theme) && !/^const fmt/m.test(review), 'duplicated');
t('the styles moved with the component', /\.chart-tooltip \{/.test(sharedCss), 'CSS left behind');
t('and left no copy in DataReview.css',
  !/\.chart-tooltip-swatch/.test(read('../pages/DataReview/DataReview.css')), 'duplicated CSS');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
