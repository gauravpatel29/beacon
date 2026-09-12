// What the Filter tab actually sends. Run: node src/services/filters.check.mjs
import { buildFilters, emptyCondition, emptyRule, looksLikeNpi, ruleIsSet } from './manifest.js';

/** A one-condition rule, the shape the Filter tab holds. */
const rule = (kind, fields) => ({ kind, mode: 'all', conditions: [{ ...emptyCondition(), ...fields }] });
import { nullPctColor } from './nullscale.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: got ${JSON.stringify(got)}`));
};

const file = (rules, renameMap = {}) => ({ renameMap, filterConfig: { activeColumn: '', rules } });

console.log('\n1. a column picked but left blank is not a filter');
t('empty rule sends nothing', buildFilters(file({ trx: emptyRule('number') })).length === 0);
t('ruleIsSet false when blank', ruleIsSet(emptyRule('number')) === false);
t('ruleIsSet true once a bound is typed', ruleIsSet(rule('number', { min: '0' })) === true);

console.log('\n2. numeric -> range');
let f = buildFilters(file({ trx: rule('number', { min: '10', max: '99' }) }));
t('one range filter', f.length === 1 && f[0].type === 'range', f);
t('bounds sent as numbers, not strings', f[0].min === 10 && f[0].max === 99, f[0]);
f = buildFilters(file({ trx: rule('number', { min: '', max: '99' }) }));
t('an open lower bound omits min entirely', !('min' in f[0]) && f[0].max === 99, f[0]);
// 0 is a real bound. Sent as '' only when the box is empty.
f = buildFilters(file({ trx: rule('number', { min: '0', max: '' }) }));
t('min of 0 survives (not treated as blank)', f[0].min === 0, f[0]);

console.log('\n3. date -> date_range, ISO');
f = buildFilters(file({ month: rule('date', { start: '2026-01-01', end: '2026-03-31' }) }));
t('one date_range', f.length === 1 && f[0].type === 'date_range', f);
t('ISO passed through', f[0].start === '2026-01-01' && f[0].end === '2026-03-31', f[0]);

console.log('\n4. string -> value_in');
f = buildFilters(file({ region: rule('string', { values: ['East', 'West'] }) }));
t('one value_in', f.length === 1 && f[0].type === 'value_in', f);
t('values carried', JSON.stringify(f[0].values) === '["East","West"]', f[0].values);
t('no values selected sends nothing', buildFilters(file({ region: emptyRule('string') })).length === 0);

console.log('\n5. columns are post-rename (filters run after live_updates)');
f = buildFilters(file({ trx: rule('number', { min: '1' }) }, { trx: 'scripts' }));
t('renamed column used', f[0].column === 'scripts', f[0].column);

console.log('\n6. Luhn is offered only for NPI columns');
t('npi matches', looksLikeNpi({ renameMap: {} }, 'npi'));
t('NPI_ID matches', looksLikeNpi({ renameMap: {} }, 'NPI_ID'));
t('prescriber npi matches', looksLikeNpi({ renameMap: {} }, 'prescriber npi'));
t('"snipping" does not match', !looksLikeNpi({ renameMap: {} }, 'snipping'));
t('"region" does not match', !looksLikeNpi({ renameMap: {} }, 'region'));
t('matches on the renamed form too', looksLikeNpi({ renameMap: { id: 'npi' } }, 'id'));
f = buildFilters(file({ npi: rule('string', { luhn: true }) }));
t('luhn sent for an NPI column', f.length === 1 && f[0].type === 'npi_luhn', f);
// The box is hidden for a non-NPI column, but a rename after ticking it would
// otherwise leave the filter in place.
f = buildFilters(file({ region: rule('string', { luhn: true }) }));
t('luhn NOT sent for a non-NPI column', f.length === 0, f);
f = buildFilters(file({ npi: rule('string', { luhn: true }) }, { npi: 'region' }));
t('renaming npi -> region still allows it (original name matches)', f.length === 1, f);

console.log('\n7. not_null is independent of type');
f = buildFilters(file({ region: rule('string', { notNull: true }) }));
t('not_null sent alone', f.length === 1 && f[0].type === 'not_null', f);
f = buildFilters(file({ trx: rule('number', { notNull: true, min: '5' }) }));
t('not_null and range together', f.length === 2 && f.map((x) => x.type).sort().join() === 'not_null,range', f);

console.log('\n8. every configured column is sent, not only the selected one');
f = buildFilters(file({
  trx: rule('number', { min: '1' }),
  region: rule('string', { values: ['East'] }),
  month: rule('date', { start: '2026-01-01' }),
}));
t('all three sent', f.length === 3, f.map((x) => x.type));

console.log('\n9. the null-percentage scale runs green -> red');
const hue = (c) => Number(c.bar.match(/hsl\((\d+(?:\.\d+)?)/)[1]);
t('0% is green (hue 140)', hue(nullPctColor(0)) === 140, nullPctColor(0));
t('100% is red (hue 0)', hue(nullPctColor(100)) === 0, nullPctColor(100));
t('50% is midway', hue(nullPctColor(50)) === 70, nullPctColor(50));
t('progressive, not banded', hue(nullPctColor(9)) !== hue(nullPctColor(11)), [nullPctColor(9), nullPctColor(11)]);
t('monotonic', hue(nullPctColor(10)) > hue(nullPctColor(20)));
t('out-of-range clamped', hue(nullPctColor(150)) === 0 && hue(nullPctColor(-5)) === 140);
t('track tint is a valid hsla', nullPctColor(50).tint.startsWith('hsla('), nullPctColor(50).tint);

console.log('\n' + '='.repeat(52));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
