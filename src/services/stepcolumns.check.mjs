// How the Add/Edit Join modal resolves key columns, including for a previous
// step's result. Run: node src/services/stepcolumns.check.mjs
//
// Mirrors `stepResultColumns` + `columnsForDataset` in
// pages/Datastitching/Datastitching.jsx.
//
// Written after: adding a second join with "Step 1 Result" as the left dataset
// showed a free-text box instead of a key dropdown, because "Step 1 Result" is
// a virtual name and is never present in the /files listing.

const FILES = [
  { filename: 'sales.csv', columns: ['npi', 'month', 'trx'] },
  { filename: 'calls.csv', columns: ['npi', 'month', 'calls'] },
  { filename: 'xwalk.csv', columns: ['npi', 'dma_name'] },
];

// Shape of joinCards after rebuildCardsFromSteps(), i.e. straight off the dry
// run's lineage.steps_executed.
const CARDS = [
  { step: 1, left: 'sales.csv', right: 'calls.csv',
    columns: ['npi', 'month', 'trx', 'month_step1', 'calls'] },
  { step: 2, left: 'Step 1 Result', right: 'xwalk.csv',
    columns: ['npi', 'month', 'trx', 'month_step1', 'calls', 'dma_name'] },
];

const stepResultColumns = (cards) =>
  Object.fromEntries(
    cards.filter((c) => (c.columns || []).length)
         .map((c) => [`Step ${c.step} Result`, c.columns])
  );

const columnsForDataset = (files, stepCols, name) => {
  const dataset = files.find((f) => f.filename === name);
  if (dataset) return dataset.columns || null;
  const fromStep = stepCols[name];
  return fromStep && fromStep.length ? fromStep : null;
};

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${JSON.stringify(got)}`));
};

console.log('\n1. a real dataset still resolves as before');
const map = stepResultColumns(CARDS);
t('sales.csv -> its own columns',
  JSON.stringify(columnsForDataset(FILES, map, 'sales.csv')) === JSON.stringify(FILES[0].columns));

console.log('\n2. the reported bug: "Step 1 Result" now resolves');
const s1 = columnsForDataset(FILES, map, 'Step 1 Result');
t('returns columns, not null', Array.isArray(s1) && s1.length > 0, s1);
t('dropdown is rendered (leftCols truthy)', Boolean(s1));
t('carries the suffixed clash column a union would miss',
  s1.includes('month_step1'), s1);
t('carries columns from BOTH sides of step 1',
  s1.includes('trx') && s1.includes('calls'), s1);

console.log('\n3. sequencing: step 1 must be known before step 2 is configured');
// rebuildCardsFromSteps runs after every add/edit/delete, so by the time the
// user opens "Add Join" for step 2, step 1 has been dry-run at least once.
const afterFirstStep = stepResultColumns([CARDS[0]]);
t('after step 1 is added, "Step 1 Result" is available',
  Boolean(columnsForDataset(FILES, afterFirstStep, 'Step 1 Result')));
t('"Step 2 Result" is NOT offered yet',
  columnsForDataset(FILES, afterFirstStep, 'Step 2 Result') === null);

console.log('\n4. before any dry run, fall back to free text rather than an empty dropdown');
t('no cards -> null (text input branch)',
  columnsForDataset(FILES, stepResultColumns([]), 'Step 1 Result') === null);
t('a card with no columns -> null, not an empty dropdown',
  columnsForDataset(FILES, stepResultColumns([{ step: 1, columns: [] }]), 'Step 1 Result') === null);

console.log('\n5. an unknown name is still free text');
t('ghost.csv -> null', columnsForDataset(FILES, map, 'ghost.csv') === null);

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
