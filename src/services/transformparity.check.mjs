// Data Transformation against the engine it drives, and the reference screen.
// Run: node src/services/transformparity.check.mjs

import { readFileSync } from 'node:fs';
import { getChannelGuidance } from './channelGuidance.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want), got);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const tx = read('../pages/DataTransformation/DataTransformation.jsx');
const css = read('../pages/DataTransformation/DataTransformation.css');
const setSrc = read('./transformationSet.js');

console.log('\n1. channel guidance matches the tactic');
eq('rep calls', getChannelGuidance('f2f_calls').tacticType,
   'HCP Personal Detailing / Sales Rep Calls');
eq('samples', getChannelGuidance('sample_quantity').tacticType,
   'Physical Samples & Co-Pay Vouchers');
eq('digital', getChannelGuidance('hcp_social').tacticType,
   'Digital / Search / Social / Email / RTE');
eq('speaker programs', getChannelGuidance('speaker_programs').tacticType,
   'Peer-to-Peer Speaker Programs & Symposia');
eq('broadcast', getChannelGuidance('tv_grps').tacticType, 'Mass Media / Television / CTV');
eq('anything else gets the general profile',
   getChannelGuidance('mystery_channel').tacticType, 'General Marketing & Promotion Channel');
t('an empty name does not throw', Boolean(getChannelGuidance('').tacticType), 'threw');

console.log('\n2. the advice and what Apply sets cannot disagree');
for (const name of ['f2f_calls', 'samples', 'hcp_social', 'tv_grps', 'speaker_programs', 'other']) {
  const g = getChannelGuidance(name);
  const s = g.suggested;
  t(`${name}: suggests every control`,
    ['normalization', 'decay', 'horizon', 'saturation', 'param'].every((k) => k in s), s);
  t(`${name}: the saturation is one the engine takes`,
    ['none', 'log', 'power'].includes(s.saturation), s.saturation);
  // A suggestion the dropdowns cannot represent would apply and then vanish.
  t(`${name}: the horizon is an offered option`, [1, 2, 4, 8].includes(s.horizon), s.horizon);
  const [lo, hi] = (g.adstockDecay.match(/[\d.]+/g) || []).map(Number);
  t(`${name}: the applied decay is inside the range the text gives`,
    s.decay >= lo && s.decay <= hi, { text: g.adstockDecay, applied: s.decay });
}

console.log('\n3. horizon and lag are separate, named as the engine names them');
// `Lags` is the adstock HORIZON - the span the geometric decay sums over - and
// `Lag` is the pure shift beside it. The reference app sends both keys.
t('the horizon goes out as Lags', /'Lags': Number\(c\.horizon\)/.test(setSrc), 'wrong key');
t('the shift goes out as Lag', /'Lag': Number\(c\.lag \?\? 0\)/.test(setSrc), 'not sent');
t('a channel with no lag still sends 0', /lag: 0,/.test(setSrc), 'undefined on the wire');
t('the column is labelled Adstock Horizon', /<th>Adstock Horizon<\/th>/.test(tx), 'ambiguous');
t('and Lag has a column of its own', /<th>Lag \(Shift\)<\/th>/.test(tx), 'missing');
t('the Effect column is gone', !/<th>Effect<\/th>/.test(tx), 'still there');

console.log('\n4. auto select is gone, as it is in the reference app');
t('no auto-select call', !/transformationAutoSelect/.test(tx), 'still calls it');
t('no per-row Auto button', !/auto-fill-btn/.test(tx), 'button remains');
t('no Auto Select All button', !/auto-select-all-btn/.test(tx), 'button remains');
t('and no leftover state for it', !/isAutoSelecting/.test(tx), 'dead state');

console.log('\n5. the KPI lock is a choice, not a rule');
t('the lock list starts empty', /const \[lockedDeps, setLockedDeps\] = useState\(\[\]\)/.test(tx),
  'locked by default');
t('eligibility respects only what was locked',
  /!lockedDeps\.includes\(c\)/.test(tx), 'still unconditional');
t('the KPI is no longer excluded outright',
  !/modelSpec === 'log_log' \|\| !dependentVars\.includes\(c\)/.test(tx), 'the rule survives');
t('there is a lock control per KPI', /Lock \{kpi\}/.test(tx), 'no control');
t('and the choice is persisted',
  /if \(Array\.isArray\(s\.lockedDeps\)\) setLockedDeps/.test(tx), 'lost on resume');

console.log('\n6. the config table columns');
t('there is a Category column', /<th>Category<\/th>/.test(tx), 'missing');
t('guidance has its own column', /<th>Guidance<\/th>/.test(tx), 'missing');
t('the Source column is gone', !/<th>Source<\/th>/.test(tx), 'still there');
t('the Actions column is gone', !/<th>Actions<\/th>/.test(tx), 'still there');
t('a derived row is marked', /derived \? 'Derived'/.test(tx), 'indistinguishable');
t('and shows its formula', /derived\.parts\.join\(` \$\{derived\.operator\} `\)/.test(tx), 'opaque name');
t('the KPI row is marked', /isDep \? 'KPI'/.test(tx), 'looks like a promotion');
t('otherwise the ingestion category is used',
  /roleMeta\(columnRoles\[name\]\)\?\.short/.test(tx), 'no category');
t('derived and KPI rows are tinted',
  /\.config-table tr\.is-derived td/.test(css) && /\.config-table tr\.is-dependent td/.test(css),
  'unstyled');
t('a derived channel can still be deleted',
  /remove-derived-btn/.test(tx), 'no way to remove it');

console.log('\n7. guidance is reachable per channel');
t('every row has a guidance button', /className="guidance-btn"/.test(tx), 'missing');
t('it opens a panel', /\{guidanceFor && \(\(\) => \{/.test(tx), 'does nothing');
t('the panel names the tactic', /\{guidanceFor\} - \{g\.tacticType\}/.test(tx), 'unlabelled');
t('and gives the reasoning', /\{g\.rationale\}/.test(tx), 'numbers with no why');
t('applying it writes every control',
  /updateConfig\(guidanceFor, \{ \.\.\.g\.suggested, source: 'guided' \}\)/.test(tx),
  'still a retyping exercise');
t('the panel closes', /setGuidanceFor\(''\)/.test(tx), 'no way out');

console.log('\n8. derived channels reach the engine everywhere they are needed');
t('preview-single carries them',
  /config: toTransformation\(activeInspectVar\),\s*\n\s*derived_variables: toDerivedVariables\(\)/.test(tx),
  'a derived channel cannot be inspected');
t('and apply carries them', /derived_variables: toDerivedVariables\(\),/.test(tx), 'not built');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
