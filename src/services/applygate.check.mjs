// Which buttons the ingestion action bar shows.
// Run: node src/services/applygate.check.mjs
//
// Two bugs came from this one small piece of logic, in opposite directions:
//
//   1. Apply only appeared once all four tabs had been visited, and
//      `visitedTabs` is component state - so after a refresh a fully
//      configured file had no Apply button at all.
//   2. Fixing that by marking the tabs visited on resume then removed Next
//      and Back, because Apply was rendered *instead of* Next and Back was
//      gated on having pressed Next during this session.
//
// Navigation and the commit action are separate concerns; this pins that they
// stay separate. Mirrors the action bar in pages/DataIngestion/DataIngestion.jsx.

const TAB_ORDER = ['mapping', 'standardize', 'filter', 'granularity'];

function hasCommittedSpec(dataset) {
  const spec = dataset?.spec || {};
  const lu = spec.live_updates || {};
  return Boolean(
    (lu.column_drops || []).length ||
    (lu.column_renames || []).length ||
    (lu.dtype_changes || []).length ||
    (lu.date_formats || []).length ||
    (spec.filters || []).length ||
    spec.granularity
  );
}

/** visitedTabs after a resume, given what the listing returned. */
const onResume = (items) =>
  (items.some(hasCommittedSpec) ? new Set(TAB_ORDER) : new Set(['mapping']));

/** The buttons rendered, in order. */
function actionBar(activeTab, visited) {
  const all = TAB_ORDER.every((t) => visited.has(t));
  const out = [];
  if (activeTab !== TAB_ORDER[0]) out.push('Back');
  out.push('Preview changes');
  if (activeTab !== TAB_ORDER[TAB_ORDER.length - 1]) out.push('Next');
  if (all) out.push('Apply configuration');
  return out;
}

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${JSON.stringify(got)}`));
};

const FRESH = { filename: 'a.csv', spec: {} };
const CONFIGURED = { filename: 'b.csv', spec: { live_updates: { column_renames: [{ from: 'npi', to: 'hcp_id' }] } } };

console.log('\n1. a fresh upload walks the wizard');
let visited = new Set(['mapping']);
t('first tab: no Back, Next is there, no Apply yet',
  actionBar('mapping', visited).join(' | ') === 'Preview changes | Next',
  actionBar('mapping', visited));
visited = new Set(visited).add('standardize');
t('second tab: Back appears',
  actionBar('standardize', visited).includes('Back'), actionBar('standardize', visited));
visited = new Set(visited).add('filter');
t('third tab: still no Apply', !actionBar('filter', visited).includes('Apply configuration'),
  actionBar('filter', visited));
visited = new Set(visited).add('granularity');
t('last tab: Apply appears, Next does not',
  actionBar('granularity', visited).join(' | ') === 'Back | Preview changes | Apply configuration',
  actionBar('granularity', visited));

console.log('\n2. bug 1: a configured file gets Apply back after a refresh');
const resumed = onResume([CONFIGURED]);
t('all tabs marked visited on resume', resumed.size === 4, [...resumed]);
t('Apply is available immediately, on the first tab',
  actionBar('mapping', resumed).includes('Apply configuration'), actionBar('mapping', resumed));

console.log('\n3. bug 2: navigation survives that fix');
t('first tab keeps Next', actionBar('mapping', resumed).includes('Next'),
  actionBar('mapping', resumed));
t('middle tab keeps both Back and Next',
  ['Back', 'Next'].every((b) => actionBar('filter', resumed).includes(b)),
  actionBar('filter', resumed));
t('middle tab shows all four controls',
  actionBar('filter', resumed).join(' | ') === 'Back | Preview changes | Next | Apply configuration',
  actionBar('filter', resumed));
t('last tab keeps Back', actionBar('granularity', resumed).includes('Back'),
  actionBar('granularity', resumed));

console.log('\n4. the ends of the walkthrough never offer a dead move');
for (const visitedSet of [new Set(['mapping']), resumed]) {
  t(`first tab never offers Back (visited=${visitedSet.size})`,
    !actionBar('mapping', visitedSet).includes('Back'));
  t(`last tab never offers Next (visited=${visitedSet.size})`,
    !actionBar('granularity', visitedSet).includes('Next'));
}

console.log('\n5. a fresh workflow is not unlocked by mistake');
t('all-fresh resume keeps the walkthrough',
  !actionBar('mapping', onResume([FRESH])).includes('Apply configuration'));
t('one configured file among fresh ones is enough',
  actionBar('mapping', onResume([FRESH, CONFIGURED])).includes('Apply configuration'));

console.log('\n6. "configured" means real manifest content');
t('empty spec is not configured', !hasCommittedSpec(FRESH));
t('empty arrays are not configured',
  !hasCommittedSpec({ spec: { live_updates: { column_drops: [] }, filters: [] } }));
t('a filter alone counts',
  hasCommittedSpec({ spec: { filters: [{ type: 'not_null', column: 'trx' }] } }));
t('a rollup alone counts',
  hasCommittedSpec({ spec: { granularity: { from: 'Weekly', to: 'Monthly' } } }));
t('null dataset does not throw', hasCommittedSpec(null) === false);

console.log('\n' + '='.repeat(58));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
