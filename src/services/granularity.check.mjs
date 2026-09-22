// Granularity: detected without a button, and configured before the join.
// Run: node src/services/granularity.check.mjs
//
// Two changes, one cause. The grain of a file was only ever known after
// somebody pressed Detect Granularity on an Ingestion tab, so until then a
// monthly file offered a Week-on-Week trend. And that tab asked the question
// one file at a time, on the screen where it least matters - two files at
// different grains cannot be joined on a date, which only becomes apparent on
// the stitching screen.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const ingest = read('../pages/DataIngestion/DataIngestion.jsx');
const stitch = read('../pages/Datastitching/Datastitching.jsx');
const panel = read('../components/Granularity/GranularityPanel.jsx');
const css = read('../components/Granularity/GranularityPanel.css');
const api = read('./api.js');

console.log('\n1. the trend detects its own grain');
t('detection runs from the trend section',
  /detectGranularity\(file\.workflowId, file\.filename, \{/.test(ingest), 'still needs a button');
t('it asks about the renamed column',
  /date_column: renamedName\(file, effectiveXAxis\)/.test(ingest), 'would miss a renamed date');
t('and against the draft edits, as the preview does',
  /live_updates: buildLiveUpdates\(file\)/.test(ingest) && /filters: buildFilters\(file\)/.test(ingest),
  'detects on raw text');
t('it re-runs when the file or the column changes',
  /const detectKey = `\$\{file\.filename\}\|\$\{effectiveXAxis\}`/.test(ingest), 'runs once only');
// A column with two distinct dates cannot be graded; that is not an error
// worth a banner over a chart that still works.
t('a failed detection falls back quietly',
  /if \(!cancelled\) setAutoGrain\(''\)/.test(ingest), 'an error for a working chart');
t('an explicit rollup still outranks it',
  /granularityConfig\?\.target\s*\n?\s*\|\| file\.granularityConfig\?\.detected\s*\n?\s*\|\| autoGrain/.test(ingest),
  'detection would override a configured rollup');

console.log('\n2. the panel lives on the stitching screen, before the join');
t('the panel exists', /function GranularityPanel/.test(panel), 'missing');
t('stitching renders it', /<GranularityPanel/.test(stitch), 'not mounted');
// Order matters: it is a pre-join step, so it must come before the file
// pickers that feed the join.
t('and renders it BEFORE the source files',
  stitch.indexOf('<GranularityPanel') < stitch.indexOf('Source Files'), 'after the join setup');
t('it refreshes the screen after a rollup',
  /onApplied=\{\(\) => loadEverything\(\)\}/.test(stitch), 'row counts would go stale');

console.log('\n1b. the section waits for the answer');
// The period buttons are derived from the grain, so drawing them first shows
// Week-on-Week on a monthly file and withdraws it a moment later.
t('there is a loading state while detecting',
  /const \[isDetectingGrain, setIsDetectingGrain\] = useState\(true\)/.test(ingest), 'no loader');
t('it starts true, so the first paint is the loader',
  /useState\(true\)/.test(ingest), 'a flash of the wrong buttons');
t('the whole section is held back',
  /if \(isDetectingGrain \|\| \(isLoadingFull && !usingFullFile\)\) \{/.test(ingest),
  'buttons render before the grain is known');
t('and it says what it is waiting for',
  /Detecting the time grain of this file/.test(ingest), 'an unexplained spinner');
// A file with no date column has nothing to detect; it must not spin forever.
t('nothing to detect settles the loader',
  /Nothing to detect against\. Settle rather than spin forever\./.test(ingest), 'spins forever');
t('and a failed detection settles it too',
  /finally \{\s*\n\s*if \(!cancelled\) setIsDetectingGrain\(false\)/.test(ingest),
  'an error would leave it spinning');
t('the spinner is styled', /\.trend-spinner \{/.test(read('../pages/DataIngestion/DataIngestion.css')),
  'unstyled');
t('and respects reduced motion',
  /prefers-reduced-motion: reduce\) \{\s*\n?\s*\.trend-spinner/.test(read('../pages/DataIngestion/DataIngestion.css')),
  'spins regardless');

console.log('\n2b. and no longer on Data Ingestion');
t('the tab is gone from the walkthrough',
  /const TAB_ORDER = \['mapping', 'standardize', 'filter', 'review'\]/.test(ingest),
  'still in the tab order');
t('the tab button is gone', !/activeTab === 'granularity'/.test(ingest), 'button remains');
t('and so are its helpers',
  !/handleDetectGranularity|modifyGranularity|setGranularityField|GRAN_OPTIONS/.test(ingest),
  'dead code left behind');
// The manifest field stays. If Apply from this screen stopped sending the
// rollup, configuring one on Stitching and then touching anything here would
// silently undo it.
t('the rollup is still restored from the committed spec',
  /granularityConfig: restoreGranularity\(spec\.granularity, renameMap\)/.test(ingest),
  'a rollup would be lost on reload');
t('so buildSpec still reproduces it',
  /export function buildGranularity/.test(read('./manifest.js')), 'Apply here would clear it');

console.log('\n3. the three pickers the panel needs');
for (const [label, id] of [['file', 'gran-file'], ['date column', 'gran-date'],
                           ['grouping column', 'gran-geo']]) {
  t(`there is a ${label} picker`, new RegExp(`id="${id}"`).test(panel), 'missing');
}
t('the file list comes from the caller', /files\.map\(\(f\) =>/.test(panel), 'fetches its own');
t('columns follow the chosen file', /const columns = useMemo\(\(\) => detail\?\.columns/.test(panel),
  'a stale column list');
t('the column pickers are disabled until a file is chosen',
  /disabled=\{!columns\.length\}/.test(panel), 'empty dropdowns');

console.log('\n4. detection here is automatic too');
t('no Detect button', !/Detect Granularity/.test(panel), 'a button to forget');
t('it runs when a date column is chosen',
  /detectGranularity\(workflowId, filename, \{ date_column: dateCol \}\)/.test(panel), 'manual');
t('and reports what it found',
  /distinct dates/.test(panel), 'a grain with no evidence for it');
t('the target list follows the detected grain',
  /const targets = GRAIN_TARGETS\[detected\] \|\| \[\]/.test(panel), 'offers a finer grain');
t('a file already at the coarsest grain says so',
  /is the coarsest grain this file can be rolled up to/.test(panel), 'an empty dropdown');

console.log('\n5. applying writes a manifest, not a browser-side rollup');
t('it PATCHes the spec', /commitSpec\(workflowId, filename, \{/.test(panel), 'rolls up locally');
// A PATCH that sent only `granularity` would drop the renames and casts the
// file already carries.
t('and merges into the committed spec',
  /\.\.\.\(spec\.live_updates \? \{ live_updates: spec\.live_updates \} : \{\}\)/.test(panel),
  'would undo the file\'s other edits');
t('the granularity block carries both grains',
  /from: detected,\s*\n\s*to: target,/.test(panel), 'the engine cannot tell what changed');
t('column names are sent post-rename',
  /date_column: renamedIn\(spec, dateCol\)/.test(panel), 'names a column the engine has not got');
// The engine needs an operation per column; sending only the touched ones
// would silently sum the rest under a UI that showed a choice.
t('every aggregatable column gets an operation',
  /for \(const col of aggregatable\) numeric\[col\] = numOps\[col\] \|\| 'sum'/.test(panel),
  'silently defaults');
t('a same-grain rollup cannot be applied',
  /target !== detected/.test(panel), 'a no-op request');
t('the panel reopens on what is committed',
  /const g = meta\.spec\?\.granularity;/.test(panel), 'an empty form over a configured file');

console.log('\n6. wiring');
t('commitSpec is exported', /export const commitSpec =/.test(api), 'missing');
t('detectGranularity is exported', /export const detectGranularity =/.test(api), 'missing');
t('a wide file scrolls its operation list',
  /\.gran-ops-grid \{[^}]*max-height/.test(css), 'a very tall column');
t('the panel has its own stylesheet', /\.gran-panel \{/.test(css), 'unstyled');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
