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

console.log('\n1. channels with no spend are left out of the request');
t('the request is built from pricedChannels, not deepDive',
  /const channels = pricedChannels\.map\(/.test(page), 'still sends every channel');
t('and pricedChannels requires a positive spend',
  /deepDive\.filter\(\(d\) => Number\(d\.spend\) > 0\)/.test(page), 'zero spend still included');
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

console.log('\n4. the no-spend case is not reported as an error');
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
