// Does a committed manifest survive a page refresh?
// Run: node src/services/specroundtrip.check.mjs
//
// Written after: Apply Configuration saved correctly, but refreshing the
// ingestion screen showed the Filter and Granularity tabs empty again. The
// resume path read `live_updates` out of the stored spec but hardcoded those
// two to blank, so the tabs lost their state — and the next Apply then sent an
// empty `filters`/`granularity` and wiped what was stored. Silent config loss.
//
// This builds a spec the way the screen does, reads it back the way the resume
// path does, and rebuilds it. Round two must equal round one.

import {
  buildFilterGroups, buildFilters, buildFilterMode, buildGranularity,
  conditionIsSet, emptyCondition, emptyRule, normalizeRule,
  restoreFilterGroups, restoreFilterMode, restoreFilters, restoreGranularity,
} from './manifest.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${JSON.stringify(got)}`));
};

/** A one-condition rule, the shape the Filter tab holds. */
const cond = (kind, fields, mode = 'all') => ({
  kind, mode, conditions: [{ ...emptyCondition(), ...fields }],
});

// A file configured the way the screen would: one rename, four filters,
// a weekly rollup.
const file = {
  columns: ['npi', 'week_end_date', 'trx', 'region'],
  selectedCols: ['npi', 'week_end_date', 'trx', 'region'],
  renameMap: { npi: 'hcp_id' },
  typeCastMap: { trx: 'integer', week_end_date: 'date', npi: 'string', region: 'string' },
  filterConfig: {
    activeColumn: '',
    mode: 'any',
    rules: {
      trx: cond('number', { min: '10', max: '900' }),
      week_end_date: cond('date', { start: '2026-01-01', end: '2026-06-30' }),
      region: cond('string', { values: ['East', 'West'], notNull: true }),
      npi: cond('string', { luhn: true }),
    },
  },
  granularityConfig: {
    dateCol: 'week_end_date', geoCol: 'npi',
    detected: 'Weekly', target: 'Monthly',
    numOps: { trx: 'average' },
  },
};

console.log('\n1. what Apply sends');
const filters1 = buildFilters(file);
const gran1 = buildGranularity(file);
t('four filters built', filters1.length === 5, filters1.map((f) => f.type));
t('columns are post-rename', filters1.some((f) => f.column === 'hcp_id'), filters1);
t('granularity built', gran1 && gran1.to === 'Monthly', gran1);

console.log('\n2. what the screen reads back on refresh');
const restoredRules = restoreFilters(filters1, file.renameMap);
const restoredGran = restoreGranularity(gran1, file.renameMap);
// Every restored rule holds its fields in conditions[0] now.
const only = (col) => restoredRules[col].conditions[0];

t('every filtered column comes back',
  ['trx', 'week_end_date', 'region', 'npi'].every((c) => restoredRules[c]),
  Object.keys(restoredRules));
t('renames undone — keyed by the ORIGINAL name, not hcp_id',
  Boolean(restoredRules.npi) && !restoredRules.hcp_id, Object.keys(restoredRules));
t('numeric bounds restored', only('trx').min === '10' && only('trx').max === '900', only('trx'));
t('numeric kind restored', restoredRules.trx.kind === 'number', restoredRules.trx.kind);
t('date bounds restored',
  only('week_end_date').start === '2026-01-01' && only('week_end_date').end === '2026-06-30',
  only('week_end_date'));
t('date kind restored', restoredRules.week_end_date.kind === 'date', restoredRules.week_end_date.kind);
t('categorical values restored',
  JSON.stringify(only('region').values) === '["East","West"]', only('region'));
t('not_null restored alongside the values', only('region').notNull === true, only('region'));
t('luhn restored', only('npi').luhn === true, only('npi'));
t('a flat spec restores to exactly one condition per column',
  ['trx', 'week_end_date', 'region', 'npi'].every((c) => restoredRules[c].conditions.length === 1),
  Object.fromEntries(Object.entries(restoredRules).map(([k, v]) => [k, v.conditions.length])));

t('granularity date/geo keyed by original names',
  restoredGran.dateCol === 'week_end_date' && restoredGran.geoCol === 'npi', restoredGran);
t('detected grain restored, so the tab need not re-detect',
  restoredGran.detected === 'Weekly', restoredGran.detected);
t('target restored', restoredGran.target === 'Monthly', restoredGran.target);
t('per-column operation restored', restoredGran.numOps.trx === 'average', restoredGran.numOps);

console.log('\n3. the round trip is stable — a second Apply sends the same thing');
const reopened = {
  ...file,
  filterConfig: { activeColumn: '', rules: restoredRules },
  granularityConfig: restoredGran,
};
const filters2 = buildFilters(reopened);
const gran2 = buildGranularity(reopened);
const norm = (fs) => JSON.stringify([...fs].sort((a, b) =>
  `${a.type}${a.column}`.localeCompare(`${b.type}${b.column}`)));
t('filters identical after the round trip', norm(filters1) === norm(filters2),
  { before: norm(filters1), after: norm(filters2) });
t('granularity identical after the round trip',
  JSON.stringify(gran1) === JSON.stringify(gran2), { before: gran1, after: gran2 });

console.log('\n3b. the AND / OR choice survives the round trip');
const mode1 = buildFilterMode(file);
t('OR is sent as "any"', mode1 === 'any', mode1);
t('it comes back as "any"', restoreFilterMode({ filter_mode: mode1 }) === 'any');
t('a second Apply sends the same mode',
  buildFilterMode({
    ...file,
    filterConfig: { ...file.filterConfig, mode: restoreFilterMode({ filter_mode: mode1 }) },
  }) === 'any');
// A spec saved before the mode existed has no field, and must keep behaving
// exactly as it did.
t('AND is the default when nothing was stored',
  restoreFilterMode({}) === 'all' && restoreFilterMode(undefined) === 'all');
t('an unrecognised value falls back to AND rather than guessing',
  restoreFilterMode({ filter_mode: 'maybe' }) === 'all');
t('a file with no mode set sends "all"',
  buildFilterMode({ filterConfig: { rules: {} } }) === 'all');

console.log('\n3c. several conditions on one column');
// "under 10 OR over 500" - the case a flat list cannot express at all.
const split = {
  ...file,
  filterConfig: {
    activeColumn: '',
    mode: 'all',
    rules: {
      trx: {
        kind: 'number',
        mode: 'any',
        conditions: [
          { ...emptyCondition(), max: '10' },
          { ...emptyCondition(), min: '500' },
        ],
      },
      region: cond('string', { values: ['East'], notNull: true }),
    },
  },
};
const groups = buildFilterGroups(split);
const trxGroup = groups.find((g) => g.conditions[0].filters[0].column === 'trx');
const regionGroup = groups.find((g) => g.conditions[0].filters[0].column === 'region');

t('one group per filtered column', groups.length === 2, groups.map((g) => g.mode));
t('the column carries its own mode', trxGroup.mode === 'any', trxGroup.mode);
t('both conditions are sent', trxGroup.conditions.length === 2, trxGroup.conditions.length);
t('each condition is its own bound, not merged into one range',
  trxGroup.conditions[0].filters[0].max === 10 && trxGroup.conditions[1].filters[0].min === 500,
  trxGroup.conditions);
t('an untouched column stays on AND', regionGroup.mode === 'all', regionGroup.mode);
t('not_null and the value list ride in the SAME condition, so they still AND',
  regionGroup.conditions.length === 1 && regionGroup.conditions[0].filters.length === 2,
  regionGroup.conditions);
t('the flat list is the projection of the groups',
  JSON.stringify(buildFilters(split))
    === JSON.stringify(groups.flatMap((g) => g.conditions.flatMap((c) => c.filters))),
  buildFilters(split));

const backFromGroups = restoreFilterGroups({ filter_groups: groups }, file.renameMap);
t('both conditions come back', backFromGroups.trx.conditions.length === 2,
  backFromGroups.trx.conditions);
t('the column mode comes back', backFromGroups.trx.mode === 'any', backFromGroups.trx.mode);
t('the bounds land on the right conditions',
  backFromGroups.trx.conditions[0].max === '10' && backFromGroups.trx.conditions[1].min === '500',
  backFromGroups.trx.conditions);
t('a second Apply sends the identical groups',
  JSON.stringify(buildFilterGroups({
    ...split,
    filterConfig: { activeColumn: '', mode: 'all', rules: backFromGroups },
  })) === JSON.stringify(groups));
t('groups win over the flat list when a spec carries both',
  restoreFilterGroups({ filter_groups: groups, filters: [] }, file.renameMap).trx.conditions.length === 2);
t('a spec with no groups falls back to the flat list',
  Object.keys(restoreFilterGroups({ filters: filters1 }, file.renameMap)).length === 4);

console.log('\n3d. the older flat rule shape still works');
const legacy = { kind: 'number', min: '5', max: '' };
t('normalised into one condition', normalizeRule(legacy).conditions.length === 1);
t('its fields survive', normalizeRule(legacy).conditions[0].min === '5', normalizeRule(legacy));
t('and it defaults to AND', normalizeRule(legacy).mode === 'all');
t('a blank condition is not a filter', conditionIsSet(emptyCondition(), 'number') === false);
t('a bound makes it one', conditionIsSet({ ...emptyCondition(), min: '1' }, 'number') === true);
t('an empty rule reads as unset',
  buildFilterGroups({ filterConfig: { rules: { trx: emptyRule('number') } } }).length === 0);

console.log('\n4. an unconfigured file stays unconfigured');
t('no filters -> empty rules', Object.keys(restoreFilters([], {})).length === 0);
t('undefined filters -> empty rules', Object.keys(restoreFilters(undefined, {})).length === 0);
const blank = restoreGranularity(null, {});
t('no granularity -> a blank tab, not a crash',
  blank.dateCol === '' && blank.detected === null && blank.target === '', blank);

console.log('\n' + '='.repeat(60));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
