// The Filter tab builds an ordered chain of cards with an operator in each gap.
// Run: node src/services/filterchain.check.mjs
//
// Two invariants matter most:
//   * operators.length === items.length - 1, always. The API rejects anything
//     else, so a card that is skipped has to take its operator with it.
//   * a committed chain restores to the same chain, operators included.

import {
  buildFilterChain, buildFilters, describeChainEntry,
  emptyChainEntry, emptyCondition, restoreFilterChain,
} from './manifest.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};

const entry = (column, kind, fields) => ({ column, kind, cond: { ...emptyCondition(), ...fields } });
const file = (chain, operators) => ({
  columns: ['trx', 'region', 'week_end_date', 'npi'],
  selectedCols: ['trx', 'region', 'week_end_date', 'npi'],
  renameMap: { trx: 'scripts' },
  filterConfig: { chain, operators, draft: null },
});

console.log('\n1. a chain of three');
const three = file([
  entry('trx', 'number', { min: '300' }),
  entry('region', 'string', { values: ['East'] }),
  entry('trx', 'number', { max: '150' }),
], ['and', 'or']);
const built = buildFilterChain(three);
t('three cards', built.items.length === 3, built.items.length);
t('two operators, one per gap', built.operators.length === 2, built.operators);
t('the operators are the ones chosen',
  JSON.stringify(built.operators) === '["and","or"]', built.operators);
t('the same column can appear twice in the chain',
  built.items[0].filters[0].column === 'scripts'
  && built.items[2].filters[0].column === 'scripts', built.items);
t('columns are post-rename', built.items[0].filters[0].column === 'scripts', built.items[0]);
t('order is preserved', built.items[1].filters[0].type === 'value_in', built.items[1]);

console.log('\n2. the invariant the API enforces');
for (const n of [1, 2, 3, 4]) {
  const chain = Array.from({ length: n }, () => entry('trx', 'number', { min: '1' }));
  const ops = Array.from({ length: Math.max(0, n - 1) }, () => 'and');
  const c = buildFilterChain(file(chain, ops));
  t(n + ' card(s) -> ' + Math.max(0, n - 1) + ' operator(s)',
    c.operators.length === Math.max(0, c.items.length - 1), c);
}

console.log('\n3. an unconfigured card takes its operator with it');
// The middle card has nothing set, so it and its gap drop out. Without that,
// the trailing operator would shift onto the wrong pair.
const gappy = file([
  entry('trx', 'number', { min: '300' }),
  entry('region', 'string', {}),
  entry('trx', 'number', { max: '150' }),
], ['and', 'or']);
const g = buildFilterChain(gappy);
t('only the two real cards are sent', g.items.length === 2, g.items.length);
t('and exactly one operator survives', g.operators.length === 1, g.operators);
t('it is the operator leading into the card that was kept',
  g.operators[0] === 'or', g.operators);
t('a chain of blanks sends nothing',
  buildFilterChain(file([entry('trx', 'number', {})], [])).items.length === 0);
t('and no operators either',
  buildFilterChain(file([entry('trx', 'number', {})], [])).operators.length === 0);

console.log('\n4. the flat list is the projection of the chain');
t('same filters, same order',
  JSON.stringify(buildFilters(three))
    === JSON.stringify(built.items.flatMap((i) => i.filters)), buildFilters(three));

console.log('\n5. a committed chain comes back as the same chain');
const back = restoreFilterChain(
  { filter_chain: built, filters: buildFilters(three) }, three.renameMap);
t('three cards restored', back.chain.length === 3, back.chain.length);
t('operators restored', JSON.stringify(back.operators) === '["and","or"]', back.operators);
t('renames undone - keyed by the ORIGINAL column',
  back.chain[0].column === 'trx', back.chain[0]);
t('the bounds land on the right cards',
  back.chain[0].cond.min === '300' && back.chain[2].cond.max === '150', back.chain);
t('kinds restored', back.chain[1].kind === 'string', back.chain[1].kind);
t('a second Apply sends the identical chain',
  JSON.stringify(buildFilterChain({ ...three, filterConfig: { ...back, draft: null } }))
    === JSON.stringify(built));

console.log('\n6. older stored shapes convert to a chain');
const fromGroups = restoreFilterChain({
  filter_mode: 'all',
  filter_groups: [
    { mode: 'any', conditions: [
      { filters: [{ type: 'range', column: 'scripts', max: 10 }] },
      { filters: [{ type: 'range', column: 'scripts', min: 500 }] }] },
    { mode: 'all', conditions: [
      { filters: [{ type: 'value_in', column: 'region', values: ['East'] }] }] },
  ],
}, three.renameMap);
t('every condition becomes a card', fromGroups.chain.length === 3, fromGroups.chain.length);
t('within a group its mode becomes the operator',
  fromGroups.operators[0] === 'or', fromGroups.operators);
t('between groups the filter_mode does',
  fromGroups.operators[1] === 'and', fromGroups.operators);
t('operator count still matches the gaps',
  fromGroups.operators.length === fromGroups.chain.length - 1, fromGroups);

const fromFlat = restoreFilterChain({
  filters: [{ type: 'range', column: 'scripts', min: 5 },
            { type: 'value_in', column: 'region', values: ['East'] }],
  filter_mode: 'any',
}, three.renameMap);
t('a flat list becomes one card per filter', fromFlat.chain.length === 2, fromFlat.chain.length);
t('joined by the mode it was stored with', fromFlat.operators[0] === 'or', fromFlat.operators);

const none = restoreFilterChain({}, {});
t('a spec with no filters restores an empty chain',
  none.chain.length === 0 && none.operators.length === 0, none);
t('so does undefined', restoreFilterChain(undefined, {}).chain.length === 0);

console.log('\n7. the card summary says what the filter does');
const d = (e) => describeChainEntry(three, e);
t('a two-sided range',
  d(entry('trx', 'number', { min: '10', max: '90' })) === 'scripts between 10 and 90',
  d(entry('trx', 'number', { min: '10', max: '90' })));
t('one-sided', d(entry('trx', 'number', { min: '10' })) === 'scripts at least 10',
  d(entry('trx', 'number', { min: '10' })));
t('a date window',
  d(entry('week_end_date', 'date', { start: '2026-01-01', end: '2026-03-31' }))
    === 'week_end_date from 2026-01-01 to 2026-03-31',
  d(entry('week_end_date', 'date', { start: '2026-01-01', end: '2026-03-31' })));
t('a single value', d(entry('region', 'string', { values: ['East'] })) === 'region is East',
  d(entry('region', 'string', { values: ['East'] })));
t('a long value list is truncated, with the count',
  d(entry('region', 'string', { values: ['a', 'b', 'c', 'd', 'e'] }))
    === 'region is one of a, b, c and 2 more',
  d(entry('region', 'string', { values: ['a', 'b', 'c', 'd', 'e'] })));
t('flags are spelled out',
  d(entry('npi', 'string', { notNull: true, luhn: true }))
    === 'npi is not empty and passes NPI check',
  d(entry('npi', 'string', { notNull: true, luhn: true })));
t('a blank card says so', d(emptyChainEntry('region', 'string')).endsWith('is unfiltered'),
  d(emptyChainEntry('region', 'string')));

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
