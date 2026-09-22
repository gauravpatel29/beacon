// The ingestion screen's Time-Series Trend: whole file, date axis only.
// Run: node src/services/trendrollup.check.mjs
//
// Two things were wrong with it. It charted `file.previewRows` - the first
// hundred rows - because the comment above it said no endpoint returned a raw
// file's full content; one does, the same `/csv` the Data Review page uses for
// an ARD. And the X axis offered every column, so a total could be plotted
// against a region code: a line joining categories in alphabetical order,
// which looks like a trend and is not one.
//
// Sections 1-4 run the rollup for real. The rest reads the screen.

import { readFileSync } from 'node:fs';
import {
  AGGREGATIONS, aggregateTrend, aggregationsFor, weekStartOf, isDateLikeName,
} from './trendRollup.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want), got);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const ingest = read('../pages/DataIngestion/DataIngestion.jsx');

console.log('\n1. weeks start on a Monday, whatever day the row falls on');
// Without a fixed weekday, consecutive buckets hold different numbers of days
// and the line steps on the bucketing rather than on the data.
eq('a Monday is its own week start', weekStartOf('2026-01-05'), '2026-01-05');
eq('a Wednesday rolls back to it', weekStartOf('2026-01-07'), '2026-01-05');
eq('a Sunday belongs to the week that began six days earlier',
   weekStartOf('2026-01-11'), '2026-01-05');
eq('the next Monday starts a new one', weekStartOf('2026-01-12'), '2026-01-12');
eq('across a month boundary', weekStartOf('2026-02-01'), '2026-01-26');
t('nonsense in, null out', weekStartOf('not-a-date') === null, weekStartOf('not-a-date'));

console.log('\n2. a full week of daily rows is one point, and the sum is right');
const daily = [
  { d: '2026-01-05', v: 1 }, { d: '2026-01-06', v: 2 }, { d: '2026-01-07', v: 3 },
  { d: '2026-01-08', v: 4 }, { d: '2026-01-09', v: 5 }, { d: '2026-01-10', v: 6 },
  { d: '2026-01-11', v: 7 }, // Sunday - same week
  { d: '2026-01-12', v: 10 }, // next Monday
];
const weekly = aggregateTrend(daily, 'd', ['v'], 'week', true);
eq('two weekly points', weekly.points.map((p) => p.date), ['2026-01-05', '2026-01-12']);
eq('the first week sums all seven days', weekly.points[0].v, 28);
eq('and the second holds only its own row', weekly.points[1].v, 10);

const monthly = aggregateTrend(daily, 'd', ['v'], 'month', true);
eq('one monthly point', monthly.points.length, 1);
eq('holding every row', monthly.points[0].v, 38);

console.log('\n3. DD/MM/YYYY buckets by month, not by the first two fields');
// slice(0, 7) on "01/04/2026" gives "01/04" - the day and the month - so
// April and the 4th of January landed in the same bucket.
const ddmm = [
  { d: '01/04/2026', v: 5 }, // 1 April
  { d: '04/01/2026', v: 7 }, // 4 January
  { d: '20/04/2026', v: 3 }, // 20 April
];
const byMonth = aggregateTrend(ddmm, 'd', ['v'], 'month', true);
eq('January and April are separate buckets',
   byMonth.points.map((p) => p.date), ['2026-01', '2026-04']);
eq('January holds its own row', byMonth.points[0].v, 7);
eq('April holds both of its rows', byMonth.points[1].v, 8);
eq('and they come out in date order, not text order',
   byMonth.points.map((p) => p.date), [...byMonth.points.map((p) => p.date)].sort());

console.log('\n4. the awkward rows');
const messy = [
  { d: '2026-01-05', v: '3' },      // numeric text
  { d: '2026-01-05', v: '' },       // blank
  { d: '2026-01-05', v: 'n/a' },    // not a number
  { d: 'garbage', v: 99 },          // unparseable date
  { d: '', v: 50 },                 // no date at all
  { d: null, v: 50 },
];
const m = aggregateTrend(messy, 'd', ['v'], 'week', true);
eq('one bucket survives', m.points.length, 1);
eq('numeric text counts, blanks and non-numbers do not', m.points[0].v, 3);
eq('the unparseable date is counted, not bucketed', m.unparseable, 1);
t('a missing date is skipped without inflating that count', m.unparseable === 1, m.unparseable);

// The rows come from the resolved frame, so a renamed column arrives under
// its new name while the pill still shows the old one.
const renamed = [{ week: '2026-01-05', scripts: 4 }, { week: '2026-01-06', scripts: 6 }];
const mapped = aggregateTrend(renamed, 'week', ['trx'], 'week', true, (c) => (c === 'trx' ? 'scripts' : c));
eq('a renamed metric is read through keyFor', mapped.points[0].trx, 10);
const unmapped = aggregateTrend(renamed, 'week', ['trx'], 'week', true);
eq('and without it the series would be flat zero', unmapped.points[0].trx, 0);

console.log('\n4b. the period buttons follow the file\'s granularity');
// A rollup only ever goes coarser. Week-on-Week on monthly data drew one point
// per month under a weekly label - each month's single row landing in the week
// of whatever day it carried.
eq('daily data can be seen three ways', aggregationsFor('Daily'), ['dod', 'wow', 'mom']);
eq('weekly data cannot be broken into days', aggregationsFor('Weekly'), ['wow', 'mom']);
eq('monthly data offers only months', aggregationsFor('Monthly'), ['mom']);
eq('yearly data offers only years', aggregationsFor('Yearly'), ['yoy']);
eq('the manifest spells it capitalised; either works', aggregationsFor('monthly'), ['mom']);
// Guessing wrong would remove a view the user can reach today.
eq('an undetected granularity keeps both of the old options',
   aggregationsFor(''), ['wow', 'mom']);
eq('and so does an unrecognised one', aggregationsFor('Fortnightly'), ['wow', 'mom']);
for (const [key, opt] of Object.entries(AGGREGATIONS)) {
  t(`${key} names a period and an axis`, Boolean(opt.period && opt.label && opt.xLabel), opt);
}
// weekStartOf returns the Monday, so the axis names the start of the bucket.
eq('the weekly axis names the start, not the end', AGGREGATIONS.wow.xLabel, 'Week starting');

const spread = [
  { d: '2026-01-05', v: 1 }, { d: '2026-01-06', v: 2 },
  { d: '2026-03-20', v: 4 }, { d: '2027-02-01', v: 8 },
];
eq('day buckets keep every date apart',
   aggregateTrend(spread, 'd', ['v'], 'day', true).points.map((p) => p.date),
   ['2026-01-05', '2026-01-06', '2026-03-20', '2027-02-01']);
eq('year buckets collapse to the year',
   aggregateTrend(spread, 'd', ['v'], 'year', true).points.map((p) => p.date),
   ['2026', '2027']);
eq('and sum across it', aggregateTrend(spread, 'd', ['v'], 'year', true).points[0].v, 7);

console.log('\n5. the chart is built from the whole file');
t('the full csv is fetched', /getCsv\(file\.workflowId, file\.filename\)/.test(ingest),
  'still preview-only');
t('and parsed without retyping the values',
  /header: true, skipEmptyLines: true/.test(ingest) && !/dynamicTyping: true/.test(ingest),
  'an ID like 0123 would become 123');
t('the rollup reads those rows', /const sourceRows = usingFullFile \? fullRows : previewRows/.test(ingest),
  'fetch is unused');
t('the preview is the fallback, not the source',
  /setFullRows\(null\);[\s\S]{0,200}setFullError\(/.test(ingest), 'a failed fetch empties the chart');
t('the note says which is being drawn',
  /All \{sourceRows\.length\.toLocaleString\(\)\} rows in this file/.test(ingest), 'unlabelled');
t('and the old preview-only caveat is gone',
  !/a full-file\s*\n?\s*rollup requires a backend endpoint/.test(ingest), 'stale caveat');
t('unreadable dates are reported', /trend\.unparseable > 0/.test(ingest), 'rows vanish silently');

console.log('\n6. it refetches when the resolved frame changes');
// A filter or a drop changes what /csv returns; the chart must not keep
// showing the frame from before it.
t('a signature covers rows and columns',
  /const frameSignature = `\$\{file\.filename\}\|\$\{file\.totalRows \|\| 0\}\|`/.test(ingest),
  'only keyed on filename');
t('the columns are in it', /\$\{\(file\.previewColumns \|\| \[\]\)\.join\(','\)\}/.test(ingest),
  'a rename would not refetch');
t('and it is the effect dep', /\}, \[frameSignature, file\.workflowId\]\)/.test(ingest), 'never refetches');

console.log('\n7. the X axis offers date columns only');
t('the pills come from dateColumns', /\{dateColumns\.map\(\(c\) => \(/.test(ingest),
  'every column is still offered');
t('not from the raw column list',
  !/\{\(file\.columns \|\| \[\]\)\.map\(\(c\) => \([\s\S]{0,200}setXAxisKey/.test(ingest),
  'the old list survives');
t('the label says so', /X Axis - Select Date Column/.test(ingest), 'label unchanged');
t('a typed date column wins over a name match',
  /if \(typed\.length\) return typed;/.test(ingest), 'week_number could displace a real date');
t('name matching is still there for an untyped file',
  /\.filter\(isDateLikeName\)/.test(ingest) && isDateLikeName('order_date'), 'no fallback');
t('a stored choice that is no longer a date column is dropped',
  /xAxisKey && dateColumns\.includes\(xAxisKey\)/.test(ingest), 'strands the chart');
t('with no date column, the message says what to do',
  /No date column in this file yet/.test(ingest), 'dead end');

console.log('\n7b. the screen wires those buttons up');
// Detection runs on its own now. It used to need the Detect Granularity
// button on the Granularity tab, so until somebody pressed it a monthly file
// offered Week-on-Week - and that tab is being removed.
t('granularity is detected without a button press',
  /detectGranularity\(file\.workflowId, file\.filename, \{/.test(ingest), 'still manual');
t('detection sees the renamed column and the draft edits',
  /date_column: renamedName\(file, effectiveXAxis\)/.test(ingest)
  && /live_updates: buildLiveUpdates\(file\)/.test(ingest),
  'detects against the raw column');
t('it re-runs when the file or the date column changes',
  /const detectKey = `\$\{file\.filename\}\|\$\{effectiveXAxis\}`/.test(ingest), 'runs once');
t('a failure costs the narrowing, not the chart',
  /if \(!cancelled\) setAutoGrain\(''\)/.test(ingest), 'an error banner for a chart that works');
// A configured rollup still wins: after rolling daily up to monthly the file
// IS monthly, whatever its raw dates say.
t('a configured rollup still outranks detection',
  /file\.granularityConfig\?\.target\s*\n?\s*\|\| file\.granularityConfig\?\.detected\s*\n?\s*\|\| autoGrain/.test(ingest),
  'detection would override an explicit choice');
t('the buttons are rendered from the allowed list',
  /\{aggOptions\.map\(\(key\) => \(/.test(ingest), 'still two hardcoded buttons');
t('and no hardcoded pair survives',
  !/onClick=\{\(\) => setAggregation\('wow'\)\}/.test(ingest), 'WoW is always offered');
t('an unsupported stored choice is corrected',
  /if \(!aggOptions\.includes\(aggregation\)\) setAggregation\(aggOptions\[0\]\)/.test(ingest),
  'no button would show as active');
t('and is never used to bucket in the meantime',
  /const activeAgg = aggOptions\.includes\(aggregation\) \? aggregation : aggOptions\[0\]/.test(ingest),
  'one render with the wrong period');
t('the rollup uses the shared period', /AGGREGATIONS\[activeAgg\]\.period/.test(ingest),
  'its own mapping');
t('so does the axis label', /AGGREGATIONS\[activeAgg\]\.xLabel/.test(ingest), 'label could disagree');
t('and the note says what the file is',
  /This file is \{String\(fileGrain\)\.toLowerCase\(\)\}/.test(ingest),
  'one button with no explanation');

console.log('\n8. the date range spans the file, in one format');
t('bounds are normalised before sorting',
  /\.map\(\(r\) => toIsoDate\(String\(r\[derived\(effectiveXAxis\)\] \?\? ''\)\)\)/.test(ingest),
  'DD/MM/YYYY sorted as text puts the 1st of every month first');
t('and the range filter compares the same way',
  /const v = toIsoDate\(String\(r\[xCol\] \?\? ''\)\)/.test(ingest), 'bounds and rows disagree');
t('over every row, not the preview', /\}, \[sourceRows, effectiveXAxis, xAxisIsDateLike\]\)/.test(ingest),
  'bounds from the first hundred rows');

console.log('\n9. the controls on that row line up');
const icss = read('../pages/DataIngestion/DataIngestion.css');
// The pill stood taller than the date inputs and sat higher than them too: the
// toggle brings a bottom margin from the layout it came from, and a centred
// flex row counts that margin as part of its height.
t('the toggle drops its margin inside this row',
  /\.trend-controls-row \.agg-toggle \{[^}]*margin-bottom: 0/.test(icss),
  'centres do not line up');
t('the inputs match the toggle button height',
  /\.trend-date-range input \{[^}]*padding: 0\.5rem/.test(icss), 'shorter than the pill');
t('the row wraps instead of overflowing',
  /\.trend-controls-row \{[^}]*flex-wrap: wrap/.test(icss), 'metric links run off the edge');
t('the date range is a class, not inline styles',
  /className="trend-date-range"/.test(ingest)
  && !/style=\{\{ display: 'flex', alignItems: 'center', gap: '0\.4rem' \}\}/.test(ingest),
  'inline styles are back');
t('reset range is a real button, reachable by keyboard',
  /<button type="button" className="trend-range-reset"/.test(ingest), 'a span with an onClick');
t('the date inputs are labelled',
  /htmlFor="trend-from"/.test(ingest) && /htmlFor="trend-to"/.test(ingest), 'bare inputs');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
