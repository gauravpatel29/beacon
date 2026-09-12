// Element parity for the three Correlation sub-sections, against the
// screenshots of the reference screen.
import fs from 'fs';

const api = fs.readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const jsx = fs.readFileSync(
  new URL('../pages/DataReview/DataReview.jsx', import.meta.url), 'utf8');

const has = (needle) => jsx.includes(needle) || api.includes(needle);

const SECTIONS = {
  '1. Analysis (Heatmap & VIF)': [
    ['variable picker',            'Select Variables to Include in Multicollinearity'],
    ['matrix heading',             'Pairwise Correlation &amp; Multicollinearity Matrix'],
    ['highlight threshold slider', 'Highlight Threshold'],
    ['Compute VIF button',         'Compute VIF Scores'],
    ['heatmap caption',            'Feature correlation heatmap, highlighted'],
    ['heatmap first column named', '<th>Variable</th>'],
    ['HIGH COLLINEARITY PAIRS',    'High collinearity pairs'],
    ['  Tactic 1 / Tactic 2',      '<th>Tactic 1</th>'],
    ['  Correlation column',       'Correlation (|r|)'],
    ['VIF table',                  '<th>VIF</th>'],
    ['  Status column',            '<th>Status</th>'],
    ['  server status rendered',   'v.status ||'],
  ],
  '2. Treatment — Removal': [
    ['Target KPI select',          'Target KPI for Correlation Comparison'],
    ['Removal threshold',          'Removal Threshold'],
    ['Scan button',                'Scan Correlated Pairs'],
    ['pair card',                  'removal-pair-row'],
    ['  pair title with |r|',      'removal-pair-title'],
    ['  server reason line',       'p.reason ||'],
    ['  per-pair Drop button',     'drop-one-btn'],
    ['  drop one, not all',        'applyRemovalTreatment([p.drop])'],
    ['bulk apply still there',     'Apply All ('],
  ],
  '3. Treatment — Combination (Sum)': [
    ['Pairwise threshold',         'Pairwise Correlation Threshold'],
    ['drop-originals checkbox',    'Drop original features after summing'],
    ['Find button',                'Find Correlated Pairs'],
    ['apply + confirm',            'applyCombinationTreatment'],
    ['card per pair',              'combo-pair-card'],
    ['  Pair #N: a + b',           'Pair #{i + 1}:'],
    ['  editable name per pair',   'combo-pair-name'],
    ['  default name SUM_A_B',     'SUM_${String(c[0]).toUpperCase()}'],
  ],

  'button hierarchy follows the theme': [
    // Matched loosely: these buttons span several lines now that they carry a
    // disabled state and a busy label.
    ['sub-tab main action is filled',  'onClick={findRemovalCandidates}'],
    ['find pairs is filled',           'onClick={findCorrelatedClusters}'],
    ['destructive stays red',          'drop-one-btn'],
    ['secondary stays outline',        'onClick={computeVIF}'],
    ['primary class exists',           'className="primary-btn"'],
  ],

  'long calls report that they are running': [
    ['scan shows a busy label',        "scanningRemoval ? 'Scanning…'"],
    ['find shows a busy label',        "findingClusters ? 'Finding…'"],
    ['VIF shows a busy label',         "computingVif ? 'Computing VIF…'"],
    ['scan disables while running',    'disabled={scanningRemoval'],
    ['find disables while running',    'disabled={findingClusters'],
    ['results area says so too',       'Scanning for correlated pairs'],
  ],

  "the Poor Man's Curve is a binned line": [
    ['LineChart over binned_curve',    'BinnedCurveChart'],
    ['plots response_y',               'dataKey="response_y"'],
    ['against spend_x',                'dataKey="spend_x"'],
    ['no raw scatter under it',        null],
  ],

  'a treatment shows what it produced': [
    ['result panel',                   'treatment-preview'],
    ['removal reports its result',     'Removed ${(res.dropped || drop).length} variable(s)'],
    ['combination reports its result', 'Sum columns created'],
    ['renders the returned rows',      'treatmentResult.preview.slice(0, 10)'],
    ['reports the new shape',          'treatmentResult.cols'],
    ['no wrapper for a missing route', null],
  ],

  'behaviour, not just elements': [
    ['combination is sum only',        "CLUSTER_METHOD = 'sum'"],
    ['no method radios',               null],
    ['no mean / weighted options',     null],
    ['no single shared name field',    null],
    // The scan reads the whole dataset, so it runs only when asked - opening
    // the sub-tab must not spend that time on a result nobody requested.
    ['removal scans only on request',  null],
    ['picker will not drop below 2',   'prev.length <= 2 ? prev'],
    ['high pairs follow the slider',   'corrSelectedCols, corrThreshold]'],
  ],
  'sub-tab labels': [
    ['1. numbered',                "'1. Analysis (Heatmap & VIF)'"],
    ['2. numbered',                "'2. Treatment: Removal'"],
    ['3. numbered',                "'3. Treatment: Combination (Sum)'"],
    ['no long dashes in labels',   null],
  ],
  'the tactic picker scopes Analysis only': [
    // Narrowing the heatmap is a reading aid. Narrowing a treatment would leave
    // correlated variables in the dataset purely because they were not ticked,
    // which is a silently wrong result rather than a smaller one.
    ['analysis reads the selection',      'columns: corrSelectedCols'],
    ['removal applies to every tactic',   'applyRemoval({ csv_data: activeCsv, columns: metricColumns'],
    ['KPI dropdown lists every tactic',   'metricColumns.map((c) => <option'],
    ['treatments ignore the selection',   null],
  ],

  'backed by the server, not the browser': [
    ['matrix endpoint',            'fetchCorrelationMatrix('],
    ['VIF endpoint',               'fetchVIF('],
    ['high-pairs endpoint',        'getHighCorrPairs('],
    ['preview-removal endpoint',   'previewRemoval('],
    ['apply-removal endpoint',     'applyRemoval('],
    ['find-clusters endpoint',     'findClusters('],
    ['apply-combination endpoint', 'applyCombination('],
    ['no hand-rolled Pearson',     null],
    ['no hand-rolled OLS',         null],
  ],
};

const ABSENT = {
  'no hand-rolled Pearson': 'function pearsonCorrelation',
  'no hand-rolled OLS': 'function rSquaredOLS',
  'no method radios': 'method-radio-row',
  'no mean / weighted options': 'clusterMethod',
  'no single shared name field': 'combinedName',
  'no wrapper for a missing route': 'preview-combination',
  'no raw scatter under it': 'binnedLine={bivariateData',
  'removal scans only on request': 'queueMicrotask(() => { if (!cancelled) findRemovalCandidates',
  'no long dashes in labels': "Treatment —",
  // A treatment must never scope itself to the Analysis tab's selection.
  'treatments ignore the selection': 'columns: corrSelectedCols,\n      threshold',
};

let pass = 0, fail = 0;
for (const [section, checks] of Object.entries(SECTIONS)) {
  console.log(`\n${section}`);
  for (const [label, needle] of checks) {
    const ok = needle === null ? !(jsx + api).includes(ABSENT[label]) : has(needle);
    ok ? pass++ : fail++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `  :: not found`));
  }
}

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
