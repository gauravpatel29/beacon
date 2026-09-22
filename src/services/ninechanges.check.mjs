// The nine changes requested together. One file so a later edit that undoes
// any of them fails loudly rather than quietly.
// Run: node src/services/ninechanges.check.mjs

import { readFileSync } from 'node:fs';
import { formatRoi, isRoiCapped, ROI_CAP } from './formatRoi.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) =>
  t(label, JSON.stringify(got) === JSON.stringify(want), got);

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const transform = read('../pages/DataTransformation/DataTransformation.jsx');
const config = read('../pages/ModelConfiguration/ModelConfiguration.jsx');
const output = read('../pages/ModelOutput/ModelOutput.jsx');
const optim = read('../pages/Optimization/Optimization.jsx');

console.log('\n1. the outlier histogram drops its x-axis ticks');
// The tick was the bin's ordinal, not its range - the tooltip already
// reports the range properly.
t('MiniBarChart takes a showXTicks prop', /showXTicks = true \}\) \{/.test(transform), 'no prop');
t('and the axis honours it',
  /tick=\{showXTicks \? \{ fontSize: 8, fill: '#8a94a3' \} : false\}/.test(transform), 'tick is fixed');
t('the outlier histogram passes false', /showXTicks=\{false\}/.test(transform), 'still showing ticks');
// Other histograms are untouched: they are not what was asked about.
const otherHistograms = transform.match(/<MiniBarChart bins=\{inspectDetail/g) || [];
t('the inspect histograms keep their ticks', otherHistograms.length === 2, otherHistograms.length);

console.log('\n2. a baseline variable stays out of the promotions card');
// CategoryCard renders any SELECTED column that is out of its role as an
// extra pill. Handed selectedList - promotions + baselines + the log-log KPI
// - the promotions card grew a pill for every baseline variable picked.
t('the promotions card gets its own selection',
  /selected=\{selectedVarList\}/.test(transform), 'still handed the merged list');
t('selectedVarList is exactly the promotions set',
  /const selectedVarList = useMemo\(\(\) => \[\.\.\.selectedVars\], \[selectedVars\]\);/.test(transform),
  'not derived from selectedVars alone');
t('the merged list is still what Step 2 configures',
  /const chosen = \[\.\.\.selectedVars, \.\.\.popKeys\];/.test(transform), 'Step 2 lost its channels');
t('the baseline card still drives popKeys',
  /selected=\{popKeys\}/.test(transform), 'baseline card rewired');

console.log('\n3. Model Configuration selects no channels by default');
t('a first load selects nothing',
  /setSelectedChannels\(\(prev\) => prev\.filter\(\(c\) => list\.includes\(c\)\)\);/.test(config),
  'still defaults to every channel');
t('the old "select everything" fallback is gone',
  !/return kept\.length \? kept : list;/.test(config), 'fallback remains');
t('Select all is still one click', /onClick=\{\(\) => setSelectedChannels\(channelColumns\)\}/.test(config),
  'no way to select them all');

console.log('\n4. excluding the const changes the model, not just the table');
t('the run payload carries include_const', /include_const: !hideConstRow,/.test(config), 'display only');
t('and it sits in the shared body, so OLS and Ridge both get it',
  /const baseBody = \(\) => \(\{[\s\S]*?include_const: !hideConstRow,[\s\S]*?\}\);/.test(config),
  'only one model type honours it');
t('the label says what it now does',
  /Exclude const from model/.test(config), 'still says "Hide const row"');
t('and the old wording is gone', !/>\s*Hide const row\s*</.test(config), 'old label remains');

console.log('\n5. ROI past the cap reads as a bound, not a figure');
eq('a large ROI is capped', formatRoi(340.18), '>10x');
eq('just over the cap is capped', formatRoi(10.01), '>10x');
eq('exactly the cap is not', formatRoi(10), '10.00x');
eq('an ordinary ROI is unchanged', formatRoi(2.345), '2.35x');
eq('zero is unchanged', formatRoi(0), '0.00x');
eq('a negative is unchanged', formatRoi(-3.5), '-3.50x');
eq('a large negative is capped the other way', formatRoi(-512), '<-10x');
eq('null falls back', formatRoi(null), 'NA');
eq('undefined falls back', formatRoi(undefined), 'NA');
eq('a non-number falls back', formatRoi('n/a'), 'NA');
eq('Infinity falls back rather than reading >10x', formatRoi(Infinity), 'NA');
eq('the fallback is configurable', formatRoi(null, { fallback: 'Na' }), 'Na');
eq('a numeric string still formats', formatRoi('3.2'), '3.20x');
t('isRoiCapped agrees with the formatter',
  isRoiCapped(11) && isRoiCapped(-11) && !isRoiCapped(10) && !isRoiCapped(NaN));
eq('the cap is ten', ROI_CAP, 10);
// Every screen that shows an ROI multiple goes through it.
for (const [name, src] of [['ModelOutput', output], ['Optimization', optim]]) {
  t(`${name} imports the shared formatter`,
    /import \{ formatRoi \} from '\.\.\/\.\.\/services\/formatRoi\.js';/.test(src), 'not imported');
  t(`${name} has no raw "toFixed(2)}x" left`,
    !/toFixed\(2\)\}x/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'a raw ROI remains');
}

console.log('\n6. no spend box against baseline demand');
t('the spend cards render spendableChannels',
  /\{spendableChannels\.map\(\(d\) => \(/.test(output), 'still every channel');
t('which excludes the baseline tier',
  /deepDive\.filter\(\(d\) => d\.bucket !== 'baseline'\)/.test(output), 'baseline still spendable');
t('and says so when nothing is left',
  /No promotional channels in this model\./.test(output), 'empty row');
t('the deep-dive table still shows every channel',
  /\{deepDive\.map\(\(d\) => \(/.test(output), 'deep-dive was filtered too');

console.log('\n7. Long-Term ROI is gone from the deep-dive table');
t('the header no longer lists it', !/<th>Long-Term ROI<\/th>/.test(output), 'header remains');
t('and no cell renders it', !/d\.longTermRoi !== undefined \?/.test(output), 'cell remains');
t('but the engine still returns it for other readers',
  /longTermRoi/.test(output), 'dropped from the model entirely');

console.log('\n8. a re-run overwrites the model of the same name');
t('an existing row is looked up by name',
  /const existing = prev\.find\(\(m\) => \(m\.name \|\| ''\)\.trim\(\)\.toLowerCase\(\) === key\);/.test(config),
  'no lookup');
t('its id is kept so references still resolve',
  /id: existing\?\.id \|\| `model-\$\{Date\.now\(\)\}`,/.test(config), 'a new id orphans the old one');
t('the row is replaced in place',
  /return prev\.map\(\(m\) => \(m\.id === existing\.id \? row : m\)\);/.test(config), 'appends instead');
t('a genuinely new name is still prepended',
  /return \[row, \.\.\.prev\]\.slice\(0, 30\);/.test(config), 'new models lost');
t('and the warning says it will overwrite',
  /Running will overwrite that model\./.test(config), 'still calls it a duplicate');

console.log('\n9. Starting Iteration is gone from Optimization');
t('the column header is gone',
  !/<th>Starting Iteration \(iter\)<\/th>/.test(optim), 'header remains');
t('and the input with it', !/updateBound\(idx, 'iter'/.test(optim), 'input remains');
t('the section heading no longer promises it',
  !/Channel Constraints &amp; Starting Iteration/.test(optim), 'heading remains');
t('nor does the description',
  !/and starting iteration/.test(optim), 'description remains');
// The payload contract is unchanged - iter still defaults to 1.
t('the payload still sends iter', /iter: Number\(b\.iter\) \|\| 1,/.test(optim), 'contract changed');
t('and each channel still starts at 1', /iter: 1 \}/.test(optim), 'no default left');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
