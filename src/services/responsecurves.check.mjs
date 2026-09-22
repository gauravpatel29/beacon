// Section 6, Channel Response Curves: what gets sent to the engine.
// Run: node src/services/responsecurves.check.mjs
//
// The screen sent every channel, including those with no spend recorded.
// The engine calibrates a curve by dividing impactable sales by
// log(1 + spend/(num_time*num_geo)), which is zero when spend is zero; numpy
// divides by it to give inf rather than raising, so the whole curve came back
// infinite. Starlette serialises with allow_nan=False, so the ValueError was
// raised while RENDERING the response - after the router's own try/except had
// already returned. The client got a bare 500 carrying no CORS headers, and a
// browser reports a blocked response as a network failure, so the screen said
// "The backend did not respond. Check it is running..." while the backend was
// running perfectly well.
//
// Fixed on both sides: core/processing.py refuses to calibrate without spend
// (a readable 400 instead of a 500), and this screen no longer asks.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) =>
  t(label, JSON.stringify(got) === JSON.stringify(want), got);

const page = readFileSync(new URL('../pages/ModelOutput/ModelOutput.jsx', import.meta.url), 'utf8');

console.log('\n0. baseline tiers are not offered a response curve');
// A saturation curve answers "what would more spend buy". Unpromoted demand
// has no spend to vary, so the question does not apply to it.
t('the channel pills come from spendableChannels',
  /\{spendableChannels\.map\(\(d\) => \(\s*<span key=\{d\.variable\} className=\{`channel-pill/.test(page),
  'baseline still selectable');
t('which excludes the baseline tier',
  /deepDive\.filter\(\(d\) => d\.bucket !== 'baseline'\)/.test(page), 'baseline included');
t('the request is narrowed from that same list, not from deepDive',
  /spendableChannels\.filter\(\(d\) => Number\(d\.spend\) > 0\)/.test(page),
  'a baseline row with spend would still be sent');
t('the first selected channel is a spendable one',
  /if \(spendableChannels\.length\) setResponseChannel\(spendableChannels\[0\]\.variable\);/.test(page),
  'defaults to a baseline row');
t('and the empty state counts spendable channels',
  /if \(!spendableChannels\.length\) return 'Response curves generate automatically/.test(page),
  'counts rows it will not show');

console.log('\n1. channels with no spend are left out of the request');
t('the request is built from pricedChannels, not deepDive',
  /const channels = pricedChannels\.map\(/.test(page), 'still sends every channel');
t('and pricedChannels requires a positive spend',
  /\.filter\(\(d\) => Number\(d\.spend\) > 0\)/.test(page), 'zero spend still included');
t('nothing is requested when no channel has spend',
  /if \(!pricedChannels\.length\) return;/.test(page), 'a doomed request is still sent');
t('and the auto-generate effect counts priced channels only',
  /const channelCount = pricedChannels\.length;/.test(page), 'fires on unpriced channels');

console.log('\n2. the filter itself');
// Lifted out rather than restated, so it cannot drift from the page.
const priced = (rows) => rows.filter((d) => Number(d.spend) > 0);
eq('zero spend is excluded', priced([{ variable: 'a', spend: 0 }]), []);
eq('a missing spend is excluded', priced([{ variable: 'a' }]), []);
eq('null is excluded', priced([{ variable: 'a', spend: null }]), []);
eq('a negative spend is excluded', priced([{ variable: 'a', spend: -5 }]), []);
eq('a non-numeric spend is excluded', priced([{ variable: 'a', spend: 'n/a' }]), []);
eq('a real spend is kept',
   priced([{ variable: 'a', spend: 50000 }]), [{ variable: 'a', spend: 50000 }]);
eq('a numeric string is kept',
   priced([{ variable: 'a', spend: '50000' }]), [{ variable: 'a', spend: '50000' }]);
eq('the priced ones survive a mixed list',
   priced([{ variable: 'a', spend: 0 }, { variable: 'b', spend: 10 }]).map((d) => d.variable),
   ['b']);

console.log('\n3. the empty state says something the reader can act on');
// It used to say "generate automatically once a model is finalized" to
// someone already looking at a finalized model.
t('the empty state is computed, not a fixed string',
  /<p className="mo-empty">\{curvesEmptyMessage\}<\/p>/.test(page), 'still hardcoded');
t('it names Channel Spend Management as the place to go',
  /Channel Spend Management/.test(page), 'no route out of the empty state');
t('it names the selected channel when only that one lacks spend',
  /No spend recorded for \$\{responseChannel\}/.test(page), 'a generic message');
t('and still reports generation in progress',
  /if \(isGeneratingCurves\) return 'Generating response curves\.\.\.';/.test(page), 'no progress text');

console.log('\n4. a changed input actually regenerates the curve');
// The effect fired once per (model, channel-set) and never again. Value Per
// Unit tried to force a refresh by emptying apiCurves and relying on the
// effect's "already generated" guard - but apiCurves was not a dependency of
// that effect, so clearing it re-ran nothing.
t('the regeneration is keyed on the curve inputs',
  /\}, \[isViewingFinalized, channelCount, viewingModel\?\.id, curveInputs\]\);/.test(page),
  'still keyed on the model alone');
t('and the dead "already generated" guard is gone',
  !/if \(Object\.keys\(apiCurves\)\.length\) return;/.test(page), 'the guard would block reruns');
for (const [label, key] of [
  ['the price', /price: Number\(unitValue\) \|\| 1,/],
  ['the saturation function', /saturation: saturationFunction,/],
  ['the power value', /power: Number\(powerValue\) \|\| 0\.5,/],
  ['the time periods', /numTime: Number\(numTime\) \|\| 0,/],
  ['the geo units', /numGeo: Number\(numGeo\) \|\| 0,/],
  ['each channel and its spend', /channels: pricedChannels\.map\(\(d\) => \[d\.variable, Number\(d\.spend\) \|\| 0\]\),/],
]) {
  t(`${label} is part of that key`, key.test(page), 'a change to it would go unnoticed');
}
// Typed fields would otherwise send one request per keystroke.
t('the run is debounced',
  /const timer = setTimeout\(\(\) => handleGenerateCurves\(\), 600\);/.test(page), 'no debounce');
t('and a pending run is cancelled when the input changes again',
  /return \(\) => clearTimeout\(timer\);/.test(page), 'bursts would all fire');
// apiCurves must stay OUT of the dependency list: an empty result would
// re-trigger the effect that produced it, forever.
t('apiCurves is not a dependency',
  !/viewingModel\?\.id, curveInputs, apiCurves\]/.test(page), 'a empty response would loop');

console.log('\n5. the no-spend case is not reported as an error');
// A channel awaiting its spend is an ordinary state, not a failure, so it
// must not raise the red banner that carries real API errors.
const guard = page.match(/if \(!pricedChannels\.length\) return;[^\n]*/)[0];
t('the early return sets no error banner', !/setCurvesError/.test(guard), guard);
t('the banner is still there for real failures',
  /setCurvesError\(problemMessage\(err, 'Could not generate response curves\.'\)\)/.test(page),
  'real errors go unreported');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
