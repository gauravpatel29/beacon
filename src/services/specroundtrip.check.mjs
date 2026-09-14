// Does a committed manifest survive a page refresh?
// Run: node src/services/specroundtrip.check.mjs
//
// Written after: Apply Configuration saved correctly, but refreshing the
// ingestion screen showed the Filter and Granularity tabs empty again. The
// resume path read `live_updates` out of the stored spec but hardcoded those
// two to blank, so the tabs lost their state - and the next Apply then sent an
// empty `filters`/`granularity` and wiped what was stored. Silent config loss.
//
// This works at the whole-spec level: build a spec the way Apply does, read it
// back the way the resume path does, and rebuild. Round two must equal round
// one. The filter chain has its own, finer-grained checks in
// filterchain.check.mjs; what matters here is that the two halves of the spec
// survive together, through buildSpec.

import {
  buildSpec, emptyCondition, restoreFilterChain, restoreGranularity,
} from './manifest.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};

const card = (column, kind, fields) => ({ column, kind, cond: { ...emptyCondition(), ...fields } });

// A file configured the way the screen would: one rename, a four-card filter
// chain mixing both operators, and a weekly rollup.
const file = {
  columns: ['npi', 'week_end_date', 'trx', 'region'],
  selectedCols: ['npi', 'week_end_date', 'trx', 'region'],
  renameMap: { npi: 'hcp_id' },
  typeCastMap: { trx: 'integer', week_end_date: 'date', npi: 'string', region: 'string' },
  filterConfig: {
    chain: [
      card('trx', 'number', { min: '10', max: '900' }),
      card('week_end_date', 'date', { start: '2026-01-01', end: '2026-06-30' }),
      card('region', 'string', { values: ['East', 'West'], notNull: true }),
      card('npi', 'string', { luhn: true }),
    ],
    operators: ['and', 'or', 'and'],
    draft: null,
  },
  granularityConfig: {
    dateCol: 'week_end_date', geoCol: 'npi',
    detected: 'Weekly', target: 'Monthly',
    numOps: { trx: 'average' },
  },
};

console.log('\n1. what Apply sends');
const spec1 = buildSpec(file);
t('a chain of four cards', spec1.filter_chain.items.length === 4,
  spec1.filter_chain.items.length);
t('three operators, one per gap', spec1.filter_chain.operators.length === 3,
  spec1.filter_chain.operators);
t('the operators are the ones chosen',
  JSON.stringify(spec1.filter_chain.operators) === '["and","or","and"]',
  spec1.filter_chain.operators);
t('filters is the flat projection of the chain',
  JSON.stringify(spec1.filters)
    === JSON.stringify(spec1.filter_chain.items.flatMap((i) => i.filters)), spec1.filters);
t('columns are post-rename', spec1.filters.some((f) => f.column === 'hcp_id'), spec1.filters);
t('granularity built', spec1.granularity && spec1.granularity.to === 'Monthly', spec1.granularity);
t('the category rides along', JSON.stringify(spec1.config_metadata) === '{}', spec1.config_metadata);

console.log('\n2. what the screen reads back on refresh');
const restoredFilter = restoreFilterChain(spec1, file.renameMap);
const restoredGran = restoreGranularity(spec1.granularity, file.renameMap);

t('all four cards come back', restoredFilter.chain.length === 4, restoredFilter.chain.length);
t('and all three operators', JSON.stringify(restoredFilter.operators) === '["and","or","and"]',
  restoredFilter.operators);
t('renames undone - keyed by the ORIGINAL name, not hcp_id',
  restoredFilter.chain[3].column === 'npi', restoredFilter.chain[3]);
t('numeric bounds restored',
  restoredFilter.chain[0].cond.min === '10' && restoredFilter.chain[0].cond.max === '900',
  restoredFilter.chain[0]);
t('numeric kind restored', restoredFilter.chain[0].kind === 'number', restoredFilter.chain[0].kind);
t('date bounds restored',
  restoredFilter.chain[1].cond.start === '2026-01-01'
  && restoredFilter.chain[1].cond.end === '2026-06-30', restoredFilter.chain[1]);
t('date kind restored', restoredFilter.chain[1].kind === 'date', restoredFilter.chain[1].kind);
t('categorical values restored',
  JSON.stringify(restoredFilter.chain[2].cond.values) === '["East","West"]',
  restoredFilter.chain[2]);
t('not_null restored alongside the values, in the SAME card',
  restoredFilter.chain[2].cond.notNull === true, restoredFilter.chain[2]);
t('luhn restored', restoredFilter.chain[3].cond.luhn === true, restoredFilter.chain[3]);

t('granularity date/geo keyed by original names',
  restoredGran.dateCol === 'week_end_date' && restoredGran.geoCol === 'npi', restoredGran);
t('detected grain restored, so the tab need not re-detect',
  restoredGran.detected === 'Weekly', restoredGran.detected);
t('target restored', restoredGran.target === 'Monthly', restoredGran.target);
t('per-column operation restored', restoredGran.numOps.trx === 'average', restoredGran.numOps);

console.log('\n3. the round trip is stable - a second Apply sends the same spec');
const reopened = {
  ...file,
  filterConfig: { ...restoredFilter, draft: null },
  granularityConfig: restoredGran,
};
const spec2 = buildSpec(reopened);
t('the whole spec is identical after the round trip',
  JSON.stringify(spec1) === JSON.stringify(spec2),
  { before: spec1, after: spec2 });

console.log('\n4. an unconfigured file stays unconfigured');
const blankFile = {
  columns: ['a'], selectedCols: ['a'], renameMap: {}, typeCastMap: {},
  filterConfig: { chain: [], operators: [], draft: null },
  granularityConfig: { dateCol: '', geoCol: '', detected: null, target: '', numOps: {} },
};
const blankSpec = buildSpec(blankFile);
t('no filters sent', blankSpec.filters.length === 0, blankSpec.filters);
t('an empty chain is still sent, so clearing filters is recorded',
  blankSpec.filter_chain && blankSpec.filter_chain.items.length === 0, blankSpec.filter_chain);
t('and it is a valid chain - no operators for no gaps',
  blankSpec.filter_chain.operators.length === 0, blankSpec.filter_chain.operators);
t('no granularity key at all when incomplete',
  !('granularity' in blankSpec), Object.keys(blankSpec));
const blankBack = restoreFilterChain(blankSpec, {});
t('and it restores to an empty chain, not a crash',
  blankBack.chain.length === 0 && blankBack.operators.length === 0, blankBack);
const blankGran = restoreGranularity(null, {});
t('no granularity -> a blank tab, not a crash',
  blankGran.dateCol === '' && blankGran.detected === null && blankGran.target === '', blankGran);

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
