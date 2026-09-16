// Bucket width on the Data Review histogram, and straight lines everywhere.
// Run: node src/services/bucketwidth.check.mjs
//
// Two gaps against Aashika's screen:
//
//  1. The histogram had no bucket width control. The endpoint has always taken
//     `bin_width`; nothing sent it, so the server's automatic binning was the
//     only view available - and sqrt(n) bins can hide a mode that a round
//     bucket width makes obvious.
//
//  2. Every line was drawn with recharts' 'monotone', which fits a spline
//     through the points. It invents curve between observations and overshoots
//     past a local maximum. These charts are read for shape, so the line has
//     to join what was measured.

import { readFileSync } from 'node:fs';
import { line, curveLinear, curveMonotoneX } from 'd3-shape';
import { LINE_TYPE } from '../components/charts/chartTheme.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const review = read('../pages/DataReview/DataReview.jsx');
const tx = read('../pages/DataTransformation/DataTransformation.jsx');
const ingest = read('../pages/DataIngestion/DataIngestion.jsx');
const theme = read('../components/charts/chartTheme.js');
const css = read('../pages/DataReview/DataReview.css');

console.log('\n1. straight lines, from one shared constant');
t('the app declares a line type', /export const LINE_TYPE = 'linear'/.test(theme), 'not defined');
t('no spline is left anywhere',
  !/monotone|type="basis"|type="natural"|type="cardinal"/.test(review + tx + ingest),
  'a curve survives');
const lines = (src) => (src.match(/<Line\b/g) || []).length;
const typed = (src) => (src.match(/type=\{LINE_TYPE\}/g) || []).length;
for (const [name, src] of [['DataReview', review], ['DataTransformation', tx],
                           ['DataIngestion', ingest]]) {
  t(`${name} draws lines`, lines(src) > 0, 0);
  t(`${name}: every Line uses the constant`, typed(src) === lines(src),
    { lines: lines(src), typed: typed(src) });
  t(`${name} imports it`, /LINE_TYPE,/.test(src.slice(0, 2000)), 'not imported');
}

// Asserting the prop is set only says what was asked for. This draws the path
// the way recharts does - d3-shape, the library underneath it - and reads the
// commands back. A straight segment is an L; a spline is a C.
const PTS = [[0, 0], [1, 5], [2, 1], [3, 4]];
const CURVES = { linear: curveLinear, monotoneX: curveMonotoneX };
const pathFor = (name) => line().curve(CURVES[name])(PTS);
t('LINE_TYPE is a curve d3 knows', Boolean(CURVES[LINE_TYPE]), LINE_TYPE);
const drawn = pathFor(LINE_TYPE);
t('it draws straight segments', drawn.includes('L') && !drawn.includes('C'), drawn);
t('and is not the spline it replaced', drawn !== pathFor('monotoneX'), drawn);
// Proves the assertion above can fail: the spline really does emit curves.
t('a spline would have emitted curve commands', pathFor('monotoneX').includes('C'),
  pathFor('monotoneX'));

console.log('\n1b. the vertices are visible while there is room');
// The type alone is not enough to SEE: with the points hidden, a dense linear
// series is indistinguishable from a smooth one.
t('the ingestion trend marks each period',
  /dot=\{showVertices \? \{ r: 2\.5/.test(ingest), 'corners are invisible');
t('and drops the markers once they would merge',
  /const showVertices = chartData\.length <= 60/.test(ingest), 'dots would hide the line');

console.log('\n2. the width is a control, not a keystroke');
// Refetching per keystroke would fire a request for "1", "12", "125" on the
// way to 1250 - and the server rebins the whole column each time.
t('the box and the applied width are separate state',
  /const \[binWidthInput, setBinWidthInput\]/.test(review)
  && /const \[binWidth, setBinWidth\]/.test(review), 'one piece of state for both');
t('there is an apply step', /const applyBinWidth = \(\) =>/.test(review), 'no apply');
t('the button calls it', /onClick=\{applyBinWidth\}/.test(review), 'button does nothing');
t('Enter in the box does too',
  /if \(e\.key === 'Enter'\) applyBinWidth\(\)/.test(review), 'mouse only');
t('typing does not refetch',
  !/onChange=\{\(e\) => setBinWidth\(/.test(review), 'a request per keystroke');

console.log('\n3. the request carries it, and only when set');
t('bin_width is sent', /bin_width: binWidth/.test(review), 'control does nothing');
t('and omitted when automatic',
  /\.\.\.\(binWidth \? \{ bin_width: binWidth \} : \{\}\)/.test(review),
  'null would override the server default');
t('the effect refetches when it changes',
  /\}, \[activeTab, activeCsv, distVariable, binWidth\]\)/.test(review), 'chart would go stale');

console.log('\n4. bad input is refused, not sent');
t('zero and below are rejected',
  /!Number\.isFinite\(parsed\) \|\| parsed <= 0/.test(review), 'would divide the span by zero');
t('an absurdly narrow width is refused',
  /span \/ parsed > 500/.test(review), 'tens of thousands of bars');
t('the reason is shown', /\{binWidthError && <p className="bin-width-error"/.test(review),
  'silent no-op');
t('an empty box means automatic',
  /if \(!raw\) \{\s*setBinWidth\(null\);/.test(review), 'no way back to automatic');

console.log('\n5. the badge reads the response, not the box');
// The server does not always use the width asked for: an integer column with
// a small range gets one bucket per value whatever is requested.
t('the width used is taken from the response',
  /width: num\(histRaw\.bin_width\)/.test(review), 'would report the request');
t('the badge renders it', /Active bucket width: \{histogramData\.width\}/.test(review), 'not shown');
t('with the bucket count beside it',
  /\{histogramData\.bins\.length\} \{histogramData\.bins\.length === 1 \? 'bucket' : 'buckets'\}/.test(review),
  'a width alone does not say how many bars');
t('and says when the binning is the server\'s',
  /!binWidth && ' - automatic'/.test(review), 'automatic looks like a chosen width');
t('the box is seeded from the response',
  /if \(!binWidth && d\?\.bin_width\) setBinWidthInput/.test(review), 'starts blank');

console.log('\n6. a width belongs to the column it was chosen for');
t('switching column drops it', /setBinWidth\(null\);\s*setBinWidthInput\(''\)/.test(review),
  '50 carries over onto a 0-1 share column');
// Restore sets the column too, and an unconditional reset there would wipe the
// width that had just been read back with it.
t('but the first column to arrive is not a switch',
  /const lastDistVariable = useRef\(''\)/.test(review)
  && /if \(!previous \|\| previous === distVariable\) return;/.test(review),
  'restoring the width then immediately discards it');

console.log('\n7. the width survives a resume');
t('it is in the save deps', /distVariable, binWidth, outlierVariable/.test(review), 'not saved');
t('it is in the snapshot', /^\s*binWidth,$/m.test(review), 'not stored');
t('and restored only as a positive number',
  /if \(num\(v\.binWidth\) && v\.binWidth > 0\)/.test(review), 'a stored null would be applied');
t('restoring fills the box too',
  /setBinWidthInput\(String\(v\.binWidth\)\)/.test(review), 'box and chart disagree on resume');

console.log('\n8. it is styled like the control beside it');
t('the two controls share a row', /\.dist-controls-row \{/.test(css), 'stacked');
t('the input matches the select', /\.bin-width-row input \{[^}]*1\.5px solid var\(--color-border\)/.test(css),
  'mismatched borders');
t('the row collapses on a narrow screen',
  /@media \(max-width: 720px\) \{\s*\.dist-controls-row/.test(css), 'overflows');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
