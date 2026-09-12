// Which preview the panel shows, for each draft state. Mirrors the
// `shownPreview` ternary in pages/Datastitching/Datastitching.jsx.
const shownFor = (draft, cards = []) => {
  const previewedCard = draft.activePreview ? cards[draft.activePreview.cardIndex] : null;
  return draft.activePreview
    ? { kind: 'step', heading: previewedCard ? `Step ${previewedCard.step} result — ${previewedCard.left} + ${previewedCard.right}` : null,
        isLoading: draft.activePreview.isLoading, error: draft.activePreview.error, data: draft.activePreview.data }
    : draft.generatedArd
    ? { kind: 'ard', heading: `Generated ${draft.generatedArd.filename}` + (draft.generatedArd.version ? ` (version ${draft.generatedArd.version})` : ''),
        isLoading: false, error: null, data: draft.generatedArd, isGenerated: true }
    : null;
};

let pass = 0, fail = 0;
const t = (label, cond, got) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: got ${JSON.stringify(got)}`)); };

const cards = [{ step: 1, left: 'sales.csv', right: 'xwalk.csv' }];
const ard = { filename: 'HCP_Master_ARD.csv', version: 2, row_count: 3,
              columns: ['npi', 'trx'], preview: [{ npi: '1', trx: 5 }] };

console.log('\n1. nothing configured -> placeholder');
t('no preview, no ard -> null', shownFor({ activePreview: null, generatedArd: null }) === null);

console.log('\n2. the reported bug: after Generate the ARD is shown');
const g = shownFor({ activePreview: null, generatedArd: ard }, cards);
t('shows the generated ARD', g?.kind === 'ard', g?.kind);
t('heading names the file and version', g.heading === 'Generated HCP_Master_ARD.csv (version 2)', g.heading);
t('renders the ARD columns', JSON.stringify(g.data.columns) === '["npi","trx"]', g.data.columns);
t('renders the ARD rows', g.data.preview.length === 1, g.data.preview);
t('row count available for the count line', g.data.row_count === 3, g.data.row_count);
t('flagged as generated, not a step', g.isGenerated === true, g.isGenerated);
t('never stuck loading', g.isLoading === false && g.error === null, [g.isLoading, g.error]);

console.log('\n3. an ARD with no version still reads cleanly');
const nov = shownFor({ activePreview: null, generatedArd: { ...ard, version: undefined } }, cards);
t('no dangling separator', nov.heading === 'Generated HCP_Master_ARD.csv', nov.heading);

console.log('\n4. an open step preview wins over the generated ARD');
const both = shownFor({ activePreview: { cardIndex: 0, data: { columns: ['a'], preview: [], row_count: 0 }, isLoading: false, error: null }, generatedArd: ard }, cards);
t('step preview takes precedence', both.kind === 'step', both.kind);
t('step heading used', both.heading === 'Step 1 result — sales.csv + xwalk.csv', both.heading);

console.log('\n5. hiding the step preview falls back to the ARD');
t('ard returns after hide', shownFor({ activePreview: null, generatedArd: ard }, cards).kind === 'ard');

console.log('\n6. step preview states still pass through');
const load = shownFor({ activePreview: { cardIndex: 0, data: null, isLoading: true, error: null }, generatedArd: null }, cards);
t('loading propagates', load.isLoading === true && load.data === null, load);
const errp = shownFor({ activePreview: { cardIndex: 0, data: null, isLoading: false, error: 'boom' }, generatedArd: null }, cards);
t('error propagates', errp.error === 'boom', errp.error);

console.log('\n' + '='.repeat(50));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
