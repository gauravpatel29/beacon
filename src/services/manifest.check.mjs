// Checks for the UI-state -> API-manifest mapping.
//
//   node src/services/manifest.check.mjs
//
// Pure functions only: no network, no React. Guards the rules that are easy to
// get wrong and invisible in the rendered page - which columns a rollup may
// aggregate, and that a date is never converted without an explicit source
// format.

import {
  buildGranularity,
  buildLiveUpdates,
  humanFormat,
  localWarnings,
  numericColumns,
} from './manifest.js';

let ok = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(
    (cond ? '  PASS  ' : '  FAIL  ') + label +
    (!cond && detail ? '  :: ' + JSON.stringify(detail) : '')
  );
  if (cond) ok += 1;
  else fail += 1;
};



// ─── Granularity: which columns may be aggregated ────────────────────────
console.log('\nGranularity');

const grainFile = {
  columns: ['NPI', 'DATE', 'CALLS', 'SPEND', 'REP', 'NOTES'],
  selectedCols: ['NPI', 'DATE', 'CALLS', 'SPEND', 'REP'], // NOTES deselected
  renameMap: { NPI: 'npi' },
  typeCastMap: {
    NPI: 'string', DATE: 'date', CALLS: 'integer',
    SPEND: 'float', REP: 'string', NOTES: 'string',
  },
  dateConfigs: [{ col: 'DATE', format: '%d/%m/%Y' }],
  dateSourceFormats: { DATE: '%d-%m-%Y' },
  granularityConfig: {
    dateCol: 'DATE', geoCol: 'NPI', detected: 'Daily', target: 'Monthly', numOps: {},
  },
};

const nums = numericColumns(grainFile);
check('only numeric columns offered',
  JSON.stringify(nums) === JSON.stringify(['CALLS', 'SPEND']), nums);
check('date key excluded', !nums.includes('DATE'));
check('geo key excluded', !nums.includes('NPI'));
check('text columns excluded', !nums.includes('REP') && !nums.includes('NOTES'));
check('deselected column excluded', !nums.includes('NOTES'));
check('numeric geo key still excluded', !numericColumns({
  ...grainFile, typeCastMap: { ...grainFile.typeCastMap, NPI: 'integer' },
}).includes('NPI'));

const g = buildGranularity(grainFile);
check('untouched numeric columns still sent as sum',
  JSON.stringify(g.numeric) === JSON.stringify({ CALLS: 'sum', SPEND: 'sum' }), g.numeric);
check('keys use post-rename names', g.geo_column === 'npi' && g.date_column === 'DATE', g);
check('from/to carried', g.from === 'Daily' && g.to === 'Monthly', g);

const overridden = {
  ...grainFile,
  granularityConfig: { ...grainFile.granularityConfig, numOps: { SPEND: 'average' } },
};
check('explicit op wins, others still default',
  JSON.stringify(buildGranularity(overridden).numeric)
    === JSON.stringify({ CALLS: 'sum', SPEND: 'average' }),
  buildGranularity(overridden).numeric);

check('same-grain target is a no-op', buildGranularity({
  ...grainFile, granularityConfig: { ...grainFile.granularityConfig, target: 'Daily' },
}) === null);

// ─── Date source format ──────────────────────────────────────────────────
console.log('\nDate source format');

// The server detected %d-%m-%Y, which is not one of the three target options.
const dateFile = {
  columns: ['DATE'], selectedCols: ['DATE'], renameMap: {},
  typeCastMap: { DATE: 'date' },
  dateConfigs: [{ col: 'DATE', format: '%Y-%m-%d' }],
  dateSourceFormats: { DATE: '%d-%m-%Y' },
  profile: [{ column: 'DATE', ambiguous_date: false, date_candidates: [{ format: '%d-%m-%Y' }] }],
};

const lu = buildLiveUpdates(dateFile);
check('detected source format is sent as `from`',
  lu.date_formats[0].from === '%d-%m-%Y' && lu.date_formats[0].to === '%Y-%m-%d', lu.date_formats);
check('date column gets no dtype cast (date_formats owns it)',
  !lu.dtype_changes.some((d) => d.column === 'DATE'), lu.dtype_changes);

// Ambiguous columns still get the top-ranked format, and the warning names the
// alternative. The source is read-only in the UI, so this warning is the only
// place a wrong reading can surface.
const ambiguous = {
  ...dateFile,
  profile: [{
    column: 'DATE',
    ambiguous_date: true,
    ambiguous_between: ['%d-%m-%Y', '%m-%d-%Y'],
    date_candidates: [{ format: '%d-%m-%Y' }, { format: '%m-%d-%Y' }],
  }],
};
check('ambiguity is warned about, in readable formats',
  localWarnings(ambiguous).some((w) => w.includes('MM-DD-YYYY') && !w.includes('%')),
  localWarnings(ambiguous));

const cleared = { ...dateFile, dateSourceFormats: {} };
check('undetected source sends no date_format (never guesses)',
  buildLiveUpdates(cleared).date_formats.length === 0, buildLiveUpdates(cleared).date_formats);
check('and warns instead of blocking',
  localWarnings(cleared).some((w) => w.includes('left as text')));

// ─── Display formatting ──────────────────────────────────────────────────
console.log('\nDisplay formatting');

// Every pattern core/profile.py can return.
const ALL_FORMATS = [
  '%d/%m/%Y', '%Y/%m/%d', '%Y/%d/%m', '%m/%d/%Y', '%m-%d-%Y', '%d-%m-%Y',
  '%Y-%d-%m', '%Y-%m-%d', '%d.%m.%Y', '%Y%m%d', '%d-%b-%Y', '%d %b %Y',
  '%b %d, %Y', '%d-%B-%Y', '%B %d, %Y', '%Y-%m-%d %H:%M:%S',
  '%Y-%m-%dT%H:%M:%S', '%d/%m/%Y %H:%M:%S', '%m/%d/%Y %H:%M:%S',
];
check('no percent codes reach the screen for any detectable format',
  ALL_FORMATS.every((p) => !humanFormat(p).includes('%')),
  ALL_FORMATS.filter((p) => humanFormat(p).includes('%')));
check('day/month/year read correctly', humanFormat('%d-%m-%Y') === 'DD-MM-YYYY', humanFormat('%d-%m-%Y'));
check('separators preserved', humanFormat('%d.%m.%Y') === 'DD.MM.YYYY', humanFormat('%d.%m.%Y'));
check('month names kept distinct', humanFormat('%B %d, %Y') === 'Month DD, YYYY', humanFormat('%B %d, %Y'));
check('minutes not confused with month', humanFormat('%Y-%m-%d %H:%M:%S') === 'YYYY-MM-DD HH:mm:ss',
  humanFormat('%Y-%m-%d %H:%M:%S'));
check('empty input is safe', humanFormat('') === '' && humanFormat(undefined) === '');

// Display is cosmetic only: the API must still receive strftime.
check('the manifest still carries raw strftime, not the label',
  buildLiveUpdates(dateFile).date_formats[0].from === '%d-%m-%Y',
  buildLiveUpdates(dateFile).date_formats[0]);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
