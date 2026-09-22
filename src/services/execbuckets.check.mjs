// The Executive Summary's four tiers on Model Output / Response Curves.
// Run: node src/services/execbuckets.check.mjs
//
// classifyChannel used to return the ingestion column role straight through
// as the bucket. The roles recorded at ingestion are 'Baseline Variables',
// 'Independent Promotions', 'Dependent Variable', 'Time Variable' and
// 'Cross-sectional Variable'; the buckets this screen renders are baseline,
// personal, npp and dtc. Nothing matched, so every row with a declared role
// was filed under a key no card or bar reads.
//
// Baseline Demand is where it showed: the baseline variables disappeared
// into an unrendered bucket and the tier became the intercept row alone.
// A negative intercept is ordinary in a model whose baseline contribution is
// positive, so the card read a negative share while the model was fine.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) =>
  t(label, JSON.stringify(got) === JSON.stringify(want), got);

const page = readFileSync(new URL('../pages/ModelOutput/ModelOutput.jsx', import.meta.url), 'utf8');

// Lift the real function out of the page rather than restating it here.
const src = page.match(/const ROLE_TO_BUCKET = \{[\s\S]*?\n\}/)[0]
  + '\n' + page.match(/function classifyChannel\(variable, columnRoles\) \{[\s\S]*?\n\}/)[0]
  + '\nreturn classifyChannel;';
const classify = new Function(src)();

const BUCKETS = ['baseline', 'personal', 'npp', 'dtc'];

console.log('\n1. every answer is a bucket this screen actually renders');
// This is the guarantee that was broken. Whatever the role, the result has
// to be one of the four keys the cards and the stacked bar read.
const ROLES = [
  'Baseline Variables', 'Independent Promotions', 'Dependent Variable',
  'Time Variable', 'Cross-sectional Variable',
];
for (const role of ROLES) {
  const got = classify('tv_spend', { tv_spend: role });
  t(`role "${role}" lands in a real bucket`, BUCKETS.includes(got), got);
}
t('and so does a variable with no role at all',
  BUCKETS.includes(classify('anything', null)), classify('anything', null));
t('an unknown role does not leak through either',
  BUCKETS.includes(classify('calls', { calls: 'Something Else' })),
  classify('calls', { calls: 'Something Else' }));

console.log('\n2. a declared baseline variable reaches Baseline Demand');
// The whole point: these rows must join the intercept in the baseline tier
// instead of vanishing.
eq('a baseline variable is baseline',
   classify('hcp_universe', { hcp_universe: 'Baseline Variables' }), 'baseline');
eq('even when its name suggests a promotion',
   classify('tv_spend', { tv_spend: 'Baseline Variables' }), 'baseline');

console.log('\n3. promotions are still split by name, not lumped together');
// 'Independent Promotions' covers personal, npp and dtc alike, so the role
// cannot decide the bucket - only the name rules can.
eq('an email channel is npp',
   classify('email_sends', { email_sends: 'Independent Promotions' }), 'npp');
eq('a TV channel is dtc',
   classify('tv_grps', { tv_grps: 'Independent Promotions' }), 'dtc');
eq('a call channel is personal',
   classify('calls', { calls: 'Independent Promotions' }), 'personal');
eq('and an unrecognised promotion falls to personal',
   classify('mystery', { mystery: 'Independent Promotions' }), 'personal');

console.log('\n4. the name rules are unchanged when no role is recorded');
eq('const is baseline', classify('const', {}), 'baseline');
eq('an intercept row is baseline', classify('intercept', {}), 'baseline');
eq('a carryover row is baseline', classify('Carryover', {}), 'baseline');
eq('a portal channel is npp', classify('hcp_portal', {}), 'npp');
eq('a social channel is dtc', classify('social_imps', {}), 'dtc');
eq('a sampling channel is personal', classify('sample_qty', {}), 'personal');

console.log('\n5. a tier never reports a negative share');
// The stacked bar already floored at zero; the stat card above it did not,
// so the two disagreed about the same number.
t('the stat card floors the share',
  /const pct = Math\.max\(0, highLevelImpact\.pctBuckets\[bucket\] \|\| 0\)/.test(page),
  'the card can still read negative');
t('and the share chart still does too',
  /Math\.max\(0, highLevelImpact\.pctBuckets\[b\] \|\| 0\)/.test(page), 'the chart stopped');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
