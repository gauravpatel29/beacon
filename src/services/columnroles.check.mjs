// Column categories: declared once at ingestion, read everywhere after.
// Run: node src/services/columnroles.check.mjs
//
// The file category says what a FILE is. It says nothing about the columns in
// it, so every screen downstream guessed its own way - Data Transformation
// matched names to find the date and the KPI, Data Review guessed which columns
// were metrics, Model Configuration guessed again. Three heuristics, three
// chances to disagree about the same column, and no way for the user to correct
// any of them except per screen, every time.
//
// Sections 1-4 run the service for real; the rest reads the screens.

import { readFileSync } from 'node:fs';
import {
  COLUMN_ROLES, ROLE_IDS, columnsInRole, guessColumnRole, mergeRoles,
  restoreColumnRoles, roleMeta, rolePartition, rolesFor, rolesFromDatasets,
} from './columnRoles.js';
import { buildConfigMetadata } from './manifest.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want), got);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const ingest = read('../pages/DataIngestion/DataIngestion.jsx');
const tx = read('../pages/DataTransformation/DataTransformation.jsx');

console.log('\n1. the five roles, named as the engine-side app names them');
eq('there are five', ROLE_IDS.length, 5);
// The ids travel in the manifest, so they have to match the reference app
// exactly or a spec written by one is unreadable by the other.
eq('the ids match the reference app', ROLE_IDS, [
  'Cross-sectional Variable', 'Dependent Variable', 'Time Variable',
  'Independent Promotions', 'Baseline Variables',
]);
t('each carries a short label and a hint',
  COLUMN_ROLES.every((r) => r.short && r.hint && r.tone), COLUMN_ROLES);

console.log('\n2. the name-based guess');
eq('a KPI', guessColumnRole('trx'), 'Dependent Variable');
eq('sales by any name', guessColumnRole('total_revenue'), 'Dependent Variable');
eq('a date', guessColumnRole('week_end_date'), 'Time Variable');
eq('a geography', guessColumnRole('npi_id'), 'Cross-sectional Variable');
eq('a DMA', guessColumnRole('dma'), 'Cross-sectional Variable');
eq('a population column', guessColumnRole('population'), 'Baseline Variables');
eq('a macro factor too', guessColumnRole('macro_trend'), 'Baseline Variables');
// The first matching rule wins, so a name carrying two signals resolves to the
// earlier one: `hcp_universe` is read as a geography, not a population. That is
// the reference app's ordering, and it is exactly the call the table on the
// ingestion screen exists to let the user overrule.
eq('an ambiguous name resolves to the earlier rule',
   guessColumnRole('hcp_universe'), 'Cross-sectional Variable');
eq('anything else is promotion', guessColumnRole('f2f_calls'), 'Independent Promotions');
// The reference app tested for "id" anywhere in the name, which files
// `paid_search` and `video_impressions` - both promotions - as geography.
eq('paid_search is a promotion, not a geography',
   guessColumnRole('paid_search'), 'Independent Promotions');
eq('and so is video_impressions',
   guessColumnRole('video_impressions'), 'Independent Promotions');
eq('while npi_id is still a geography', guessColumnRole('npi_id'), 'Cross-sectional Variable');
eq('an empty name does not throw', guessColumnRole(''), 'Independent Promotions');

console.log('\n3. assigned beats guessed, and only for real columns');
const assigned = { calls: 'Baseline Variables', gone: 'Dependent Variable' };
const roles = rolesFor(['calls', 'trx'], assigned);
eq('an assignment overrides the guess', roles.calls, 'Baseline Variables');
eq('an unassigned column still gets one', roles.trx, 'Dependent Variable');
t('a role for a column that is not there is dropped', !('gone' in roles), roles);
eq('an unknown role falls back to the guess',
   rolesFor(['trx'], { trx: 'Nonsense' }).trx, 'Dependent Variable');
eq('columnsInRole reads them back', columnsInRole(roles, 'Baseline Variables'), ['calls']);

const part = rolePartition(['week', 'npi', 'trx', 'calls', 'pop'], { calls: 'Independent Promotions' });
eq('a partition covers every role', Object.keys(part).sort(),
   ['roles', ...ROLE_IDS].sort());
eq('the time column lands in Time', part['Time Variable'], ['week']);
eq('the KPI in Dependent', part['Dependent Variable'], ['trx']);
eq('the geography in Cross-sectional', part['Cross-sectional Variable'], ['npi']);
eq('the population column in Baseline', part['Baseline Variables'], ['pop']);

console.log('\n4. roles from many files become one map');
// A screen works on an ARD - several files joined - so it needs one map.
const merged = mergeRoles([{ npi: 'Cross-sectional Variable' }, { trx: 'Dependent Variable' }]);
eq('both files contribute', Object.keys(merged).sort(), ['npi', 'trx']);
eq('a column in two files keeps the first role',
   mergeRoles([{ x: 'Baseline Variables' }, { x: 'Independent Promotions' }]).x,
   'Baseline Variables');
eq('read straight off a /files response',
   rolesFromDatasets([
     { spec: { config_metadata: { column_roles: { npi: 'Cross-sectional Variable' } } } },
     { spec: { config_metadata: {} } },
     { spec: null },
   ]),
   { npi: 'Cross-sectional Variable' });
eq('nothing declared anywhere is an empty map', rolesFromDatasets([]), {});

console.log('\n5. they ride in the manifest, under the name the rest of the app sees');
const file = {
  category: 'sales',
  columns: ['week', 'trx', 'calls', 'scrap'],
  selectedCols: ['week', 'trx', 'calls'],
  renameMap: { trx: 'scripts' },
  columnRoles: { week: 'Time Variable', trx: 'Dependent Variable', calls: 'Independent Promotions', scrap: 'Baseline Variables' },
};
const meta = buildConfigMetadata(file);
eq('the file category is still there', meta.category, 'sales');
eq('a renamed column is keyed by its NEW name', meta.column_roles.scripts, 'Dependent Variable');
t('and not by the old one', !('trx' in meta.column_roles), meta.column_roles);
t('a dropped column contributes no role', !('scrap' in meta.column_roles), meta.column_roles);
eq('the rest come through', meta.column_roles.week, 'Time Variable');
// A file with no roles must not write an empty key, so specs saved before this
// existed stay byte-identical.
t('no roles means no column_roles key',
  !('column_roles' in buildConfigMetadata({ category: 'sales', columns: ['a'] })),
  buildConfigMetadata({ category: 'sales', columns: ['a'] }));

console.log('\n6. and come back mapped to the names the screen works in');
eq('a renamed column is restored under its original name',
   restoreColumnRoles({ scripts: 'Dependent Variable' }, { trx: 'scripts' }),
   { trx: 'Dependent Variable' });
eq('an unrenamed one passes through',
   restoreColumnRoles({ week: 'Time Variable' }, {}), { week: 'Time Variable' });
eq('nothing stored is an empty map', restoreColumnRoles(null, {}), {});

console.log('\n7. the ingestion screen assigns them');
t('there is a table', /function ColumnRoleTable/.test(ingest), 'no table');
t('it is on the Assign Category tab', /<ColumnRoleTable/.test(ingest), 'not rendered');
t('every column gets a row', /columns\.map\(\(col\) => \{/.test(ingest), 'partial');
t('with a sample of its values', /const sampleFor = \(col\)/.test(ingest), 'no samples');
t('a dropped column is shown as dropped, not hidden',
  /role-dropped-tag/.test(ingest), 'the role would vanish on an accidental untick');
t('a rename is shown on the row', /role-renamed-tag/.test(ingest), 'confusing after a rename');
t('there is a count per role', /const counts = Object\.fromEntries/.test(ingest),
  'a file with no dependent variable is invisible');
t('and a one-click reset to the suggestion',
  /onBulk\(rolesFor\(columns\)\)/.test(ingest), 'every row by hand');
t('new uploads open with a guess already applied',
  /columnRoles: rolesFor\(columns\)/.test(ingest), 'an empty table');
t('and a resumed file with what was saved',
  /columnRoles: restoreColumnRoles\(spec\.config_metadata\?\.column_roles, renameMap\)/.test(ingest),
  'roles lost on reload');

console.log('\n8. the transformation screen reads them instead of guessing');
t('it loads the declared roles', /rolesFromDatasets\(uploads\.items\)/.test(tx), 'still guessing');
t('from the uploads, not the ARDs', /listFiles\(id, \{ kind: 'upload' \}\)/.test(tx), 'wrong source');
t('a failure there costs defaults, not the screen',
  /\.catch\(\(\) => \(\{ items: \[\] \}\)\)/.test(tx), 'one failed call blanks the screen');
t('Step 1 is answered from the roles', /const part = rolePartition\(cols, declaredRoles\)/.test(tx),
  'not used');
for (const [field, role] of [
  ['setDateKeys', 'Time Variable'],
  ['setGeoKeys', 'Cross-sectional Variable'],
  ['setDependentVars', 'Dependent Variable'],
  ['setPopKeys', 'Baseline Variables'],
]) {
  t(`${field} comes from ${role}`,
    new RegExp(`${field}\\(part\\['${role}'\\]`).test(tx), 'still a regex guess');
}
t('promotions start selected', /setSelectedVars\(new Set\(part\['Independent Promotions'\]\)\)/.test(tx),
  'nothing ticked');
t('the old regex guesses are gone',
  !/const guessedGeo = cols\.find\(\(c\) => \/npi\|dma\|zip\|id\$\/i/.test(tx), 'a second heuristic survives');
t('the category is shown in the channel table', /<th>Category<\/th>/.test(tx), 'invisible');
t('per row, from the role', /roleMeta\(columnRoles\[c\]\)\?\.short/.test(tx), 'not rendered');

console.log('\n8b. Step 1 is the five categories, not six column lists');
// It was six pickers - Date, Geo, Dependent, ZIP, DMA, Population - each
// listing every column in the ARD. On a sales file that is the same 32 names
// rendered six times, so choosing the date meant reading past thirty
// call-detail columns.
t('the step is named after the categories',
  /Step 1: Column Categorization \(from Ingestion\)/.test(tx), 'old heading');
t('and says where they came from',
  /Variables are categorized according to their Ingestion roles/.test(tx), 'unexplained');
t('there is one card component', /function CategoryCard/.test(tx), 'six pickers');
t('no picker maps over every column any more',
  !/\{columns\.map\(\(c\) => \(\s*<span key=\{c\} className=\{`col-pill/.test(tx),
  'a raw column list survives');
for (const [index, title, hint, role] of [
  [1, 'Time Variable', 'Dates, Weeks, Periods', 'Time Variable'],
  [2, 'Cross-sectional Variable', 'HCP IDs, DMA, Zip, Region Keys', 'Cross-sectional Variable'],
  [3, 'Dependent Variable \\(KPI\\)', 'Sales, TRx, NRx, Revenue', 'Dependent Variable'],
  [4, 'Independent Promotions', 'Calls, Details, Spend, Emails, Media', 'Independent Promotions'],
  [5, 'Baseline Variables', 'Target Population, Macro, Universe', 'Baseline Variables'],
]) {
  t(`card ${index} is ${title.replace(/\\/g, '')}, drawing on ${role}`,
    new RegExp(`index=\\{${index}\\} title="${title}" hint="${hint}"\\s*\\n\\s*role="${role}"`).test(tx),
    'wrong card');
}
// ZIP and DMA had pickers that were never sent to the engine; they only kept a
// column out of the transformable set, which the cross-sectional card does.
t('the ZIP and DMA pickers are gone', !/ZIP Column\(s\)/.test(tx), 'dead controls remain');
t('but a saved ZIP or DMA choice still locks its column',
  /new Set\(\[\.\.\.dateKeys, \.\.\.geoKeys, \.\.\.zipKeys, \.\.\.dmaKeys, \.\.\.popKeys\]\)/.test(tx),
  'an old saved state would put them back in play');
t('the promotions card is the channel inclusion list',
  /selected=\{selectedList\}\s*\n\s*onToggle=\{toggleVarSelect\}/.test(tx), 'read-only');
t('a card with nothing in it says so',
  /No columns mapped to this category/.test(tx), 'looks broken');
t('the count reads selected over available',
  /\{selected\.filter\(\(c\) => columns\.includes\(c\)\)\.length\} \/ \{offered\.length\}/.test(tx),
  'no sense of what is in the card');
t('a column chosen from another category stays visible',
  /const extra = selected\.filter\(\(c\) => columnRoles\[c\] !== role/.test(tx),
  'a selection that cannot be unpicked');
t('and says where it was categorised', /Categorised as \$\{roleMeta/.test(tx), 'unexplained pill');

console.log('\n8c. model formulation replaces the KPI lock note');
t('there is a formulation panel', /Model Formulation &amp; KPI Lock/.test(tx), 'missing');
// The formulation is now recorded on its own. Keeping the KPI out of the
// transformable set is a separate, explicit lock - see transformparity.check.
t('the formulation is recorded', /const \[modelSpec, setModelSpec\]/.test(tx), 'missing');
t('Log-Log is selectable', /setModelSpec\('log_log'\)/.test(tx), 'no choice');
t('carryover moved into the panel',
  /Generate Carryover \(Lag 1 of Sales KPI\)/.test(tx), 'stranded elsewhere');
t('and the formulation is persisted',
  /if \(s\.modelSpec === 'linear_log' \|\| s\.modelSpec === 'log_log'\)/.test(tx), 'lost on resume');
t('it is in the snapshot', /^\s*modelSpec,$/m.test(tx), 'not stored');

console.log('\n9. the role is legible at a glance');
t('each role has a tone', COLUMN_ROLES.every((r) => roleMeta(r.id).tone), 'untoned');
const css = read('../pages/DataIngestion/DataIngestion.css');
for (const tone of ['violet', 'red', 'blue', 'green', 'amber']) {
  t(`the ${tone} chip is styled`, new RegExp(`\\.role-chip\\.tone-${tone}`).test(css), 'unstyled');
}
t('a long file scrolls inside the table rather than burying the tab',
  /\.role-table-wrap \{[^}]*max-height/.test(css), 'unbounded');
t('the header stays put while scrolling',
  /\.role-table thead th \{[^}]*position: sticky/.test(css), 'headers scroll away');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
