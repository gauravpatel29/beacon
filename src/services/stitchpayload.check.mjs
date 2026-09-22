// The field names Data Stitching sends for each operation.
// Run: node src/services/stitchpayload.check.mjs
//
// The backend's StitchStep model sets extra="ignore" and defaults step_type
// to "join". A step sent as {operation: 'rollup'} therefore had `operation`
// silently dropped and ran as a plain LEFT JOIN - no grouping, no
// aggregation, no grain change - and the four other wrongly-named fields
// (target_key, date_key, aggregations, and the key arrays) went with it.
//
// Nothing errored, because ignoring unknown fields is not an error. Verified
// against the engine: 4 HCP rows "rolled up" to DMA came back as 4 rows still
// at HCP grain with the DMA column merged on, where the correct payload
// returns 2 rows with Calls summed and Reach averaged per its agg rule.
//
// These names are read from routers/v2_ard.py's StitchStep and the reads in
// core/stitching.py, and match the reference client.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};

const page = readFileSync(new URL('../pages/Datastitching/Datastitching.jsx', import.meta.url), 'utf8');
// Only the payload builder; comments elsewhere mention the old names on
// purpose, to record what went wrong.
const builder = (page.match(/const payloadFor = \(steps\) => \(\{[\s\S]*?\n  \}\);/) || [''])[0]
  .replace(/^\s*\/\/.*$/gm, '');

console.log('\n1. every step declares step_type');
// This is the field that selects the operation. Without it the step is a join.
for (const op of ['rollup', 'allocate', 'join']) {
  t(`the ${op} step sends step_type: '${op}'`,
    new RegExp(`step_type: '${op}'`).test(builder), 'missing');
}
t("no step sends `operation`", !/\boperation: '/.test(builder), 'a step would run as a join');

console.log('\n2. the rollup step uses the names the engine reads');
const rollup = (builder.match(/if \(s\.operationType === 'rollup'\) \{[\s\S]*?\n      \}/) || [''])[0];
for (const [field, source] of [
  ['source_file', 's.sourceFile'],
  ['mapping_file', 's.bridgeFile'],
  ['source_entity_key', 's.sourceKey'],
  ['mapping_source_key', 's.matchKey'],
  ['target_entity_key', 's.targetKey'],
  ['time_key', 's.dateKey'],
]) {
  t(`${field} carries ${source}`,
    new RegExp(`${field}: ${source.replace('.', '\\.')}`).test(rollup), 'wrong name or source');
}
// Without agg_rules the engine sums every numeric column, whatever the user
// picked per column.
t('agg_rules carries the per-column choices',
  /agg_rules: s\.aggregations \|\| \{\}/.test(rollup), 'aggregations would be ignored');
for (const dead of ['left_file', 'right_file', 'left_key', 'right_key', 'target_key', 'date_key', 'aggregations:']) {
  t(`the rollup step no longer sends ${dead}`, !rollup.includes(dead), 'stale name');
}

console.log('\n3. the allocate step too');
const alloc = (builder.match(/if \(s\.operationType === 'allocate'\) \{[\s\S]*?\n      \}/) || [''])[0];
for (const [field, source] of [
  ['source_file', 's.higherGrainFile'],
  ['target_file', 's.lowerGrainStructureFile'],
  ['mapping_file', 's.crosswalkFile'],
  ['source_grain_key', 's.sourceGrainKey'],
  ['target_grain_key', 's.targetGrainKey'],
  ['time_key', 's.dateKey'],
]) {
  t(`${field} carries ${source}`,
    new RegExp(`${field}: ${source.replace('.', '\\.')}`).test(alloc), 'wrong name or source');
}
// `method` is not a field on the model, so it was dropped and every
// allocation ran as "equal" whatever was chosen.
t('allocation_method is sent, not `method`',
  /allocation_method: s\.allocationMethod \|\| 'equal'/.test(alloc) && !/\bmethod: /.test(alloc),
  'weighted allocation would silently run as equal');
t('the weights file is weight_file, not weight_dataset',
  /weight_file: s\.weightDatasetFile/.test(alloc) && !/weight_dataset:/.test(alloc), 'stale name');
t('and only the weighted method sends them',
  /\.\.\.\(isWeighted \? \{/.test(alloc), 'sent unconditionally');

console.log('\n4. the join step is unchanged apart from step_type');
const join = builder.slice(builder.indexOf('const base = {'));
t('left_file and right_file stay as they were',
  /left_file: s\.leftFile/.test(join) && /right_file: s\.rightFile/.test(join), 'changed');
t('the key arrays stay arrays',
  /left_key: filled\.map\(\(p\) => p\.left\)/.test(join), 'changed');
t('a cross join still omits the keys',
  /if \(s\.joinType === 'cross'\) return base;/.test(join), 'keys always sent');

console.log('\n5. the aggregation rules match the engine and the reference UI');
// AGGREGATION_FUNCTIONS in core/stitching.py. An unknown name is NOT an
// error there - `.get(rule, "sum")` falls back to sum - so the screen's old
// "average" and "weighted_average" quietly summed the column instead.
const ENGINE_AGGS = ['sum', 'avg', 'min', 'max', 'count', 'distinct_count', 'first', 'last'];
const aggBlock = (page.match(/const AGG_OPTIONS = \[[\s\S]*?\];/) || [''])[0];
for (const a of ENGINE_AGGS) {
  t(`"${a}" is offered`, new RegExp(`value: '${a}'`).test(aggBlock), 'missing');
}
t('"average" is no longer offered', !/value: 'average'/.test(page), 'the engine would sum it');
t('"weighted_average" is no longer offered',
  !/value: 'weighted_average'/.test(page), 'the engine would sum it');
t('a stale saved value reads as sum rather than blank',
  /const aggValue = \(v\) => \(AGG_VALUES\.has\(v\) \? v : 'sum'\);/.test(page), 'blank dropdown');
t('and the dropdown uses that reader',
  /value=\{aggValue\(\(step\.aggregations \|\| \{\}\)\[col\]\)\}/.test(page), 'reads the raw value');

console.log('\n6. only metric columns get an aggregation rule');
const tokens = (page.match(/const ID_TOKENS = \[[\s\S]*?\];/) || [''])[0];
const isMetric = new Function(
  tokens + '\n' + (page.match(/function isMetricColumn\(colName\) \{[\s\S]*?\n\}/) || [''])[0]
  + '\nreturn isMetricColumn;'
)();
for (const col of ['SALES(Trx)', 'Calls', 'Speaker_Attendees', 'Digital_Impressions', 'TRx']) {
  t(`"${col}" is offered a rule`, isMetric(col), 'metric skipped');
}
// Keys, geography and dates are what the rollup groups BY.
for (const col of ['NPI ID', 'npi_id', 'npi-id', 'MONTH', 'DMA', 'DMA Code',
                   'zip_code', 'account_id', 'state', 'week', 'year']) {
  t(`"${col}" is not offered a rule`, !isMetric(col), 'a group-by column offered as a metric');
}
t('the target key is excluded as well',
  /!\[step\.sourceKey, step\.dateKey, step\.targetKey\]\.includes\(c\)/.test(page),
  'the grain column would be aggregated');
t('the rows render from that filtered list',
  /\{aggregatableCols\.map\(\(col\) => \(/.test(page), 'still every column');

console.log('\n7. the console logging of every payload is gone');
// It was there to read error messages back while the names were guesses.
t('no rollup payload log', !/rollup step payload/.test(page), 'debug logging left in');
t('no allocate payload log', !/allocate step payload/.test(page), 'debug logging left in');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
