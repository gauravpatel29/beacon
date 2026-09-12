// The correlation treatments' apply step. Run: node src/services/treatments.check.mjs
//
// Mirrors applyRemoval / applyCombination in pages/DataReview/DataReview.jsx.
// Before this, both treatments identified candidates and stopped - the screen
// showed what it would do and then did nothing.

const ROWS = [
  { npi: '1', tv: 10, radio: 20, print: 5, trx: 100 },
  { npi: '2', tv: 30, radio: 60, print: 15, trx: 200 },
];
const COLUMNS = ['npi', 'tv', 'radio', 'print', 'trx'];

function applyRemoval(rows, columns, pairs) {
  const drop = new Set(pairs.map((p) => p.drop));
  return {
    columns: columns.filter((c) => !drop.has(c)),
    rows: rows.map((r) => {
      const next = { ...r };
      for (const c of drop) delete next[c];
      return next;
    }),
  };
}

function applyCombination(rows, columns, clusters, method, dropOriginals, name) {
  const names = clusters.map((cluster, i) =>
    (clusters.length === 1 && name.trim()) ? name.trim() : `${name.trim() || 'combined'}_${i + 1}`);
  const outRows = rows.map((r) => {
    const next = { ...r };
    clusters.forEach((cluster, i) => {
      const values = cluster.map((c) => Number(r[c]) || 0);
      const total = values.reduce((a, b) => a + b, 0);
      next[names[i]] =
        method === 'mean' ? total / (values.length || 1)
        : method === 'weighted' ? values.reduce((acc, v) => acc + (total ? (v / total) * v : 0), 0)
        : total;
      if (dropOriginals) for (const c of cluster) delete next[c];
    });
    return next;
  });
  const dropped = new Set(dropOriginals ? clusters.flat() : []);
  return { rows: outRows, columns: [...columns.filter((c) => !dropped.has(c)), ...names] };
}

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${JSON.stringify(got)}`));
};

console.log('\n1. removal actually drops the columns');
let r = applyRemoval(ROWS, COLUMNS, [{ drop: 'radio' }, { drop: 'print' }]);
t('columns removed', r.columns.join() === 'npi,tv,trx', r.columns);
t('row keys removed too', !('radio' in r.rows[0]) && !('print' in r.rows[0]), r.rows[0]);
t('untouched columns survive with their values',
  r.rows[1].tv === 30 && r.rows[1].trx === 200, r.rows[1]);
t('the same column dropped twice is handled once',
  applyRemoval(ROWS, COLUMNS, [{ drop: 'tv' }, { drop: 'tv' }]).columns.length === 4);

console.log('\n2. combination: sum');
r = applyCombination(ROWS, COLUMNS, [['tv', 'radio']], 'sum', true, 'paid_media');
t('named column created', r.columns.includes('paid_media'), r.columns);
t('sum is correct (10+20, 30+60)',
  r.rows[0].paid_media === 30 && r.rows[1].paid_media === 90,
  [r.rows[0].paid_media, r.rows[1].paid_media]);
t('originals dropped when asked', !('tv' in r.rows[0]) && !r.columns.includes('radio'), r.columns);

console.log('\n3. combination: mean, keeping originals');
r = applyCombination(ROWS, COLUMNS, [['tv', 'radio']], 'mean', false, 'paid_media');
t('mean is correct (15, 45)',
  r.rows[0].paid_media === 15 && r.rows[1].paid_media === 45,
  [r.rows[0].paid_media, r.rows[1].paid_media]);
t('originals kept when unchecked',
  r.columns.includes('tv') && r.columns.includes('radio'), r.columns);
t('no duplicate column entries', new Set(r.columns).size === r.columns.length, r.columns);

console.log('\n4. combination: weighted stays on the inputs\' scale');
r = applyCombination(ROWS, COLUMNS, [['tv', 'radio']], 'weighted', false, 'paid_media');
// 10 and 20: shares 1/3 and 2/3 -> 10/3 + 40/3 = 16.67, between the inputs and
// below the plain sum of 30.
const w = r.rows[0].paid_media;
t('weighted sits between the inputs, under the plain sum', w > 10 && w < 30, w);
t('weighted is not the mean', Math.abs(w - 15) > 0.5, w);

console.log('\n5. several clusters get suffixed names');
r = applyCombination(ROWS, COLUMNS, [['tv', 'radio'], ['print', 'trx']], 'sum', true, 'grp');
t('two composites created',
  r.columns.includes('grp_1') && r.columns.includes('grp_2'), r.columns);
t('each cluster summed independently',
  r.rows[0].grp_1 === 30 && r.rows[0].grp_2 === 105, [r.rows[0].grp_1, r.rows[0].grp_2]);
t('every original dropped', !r.columns.some((c) => ['tv', 'radio', 'print', 'trx'].includes(c)),
  r.columns);

console.log('\n6. a blank name still produces usable columns');
r = applyCombination(ROWS, COLUMNS, [['tv', 'radio']], 'sum', false, '   ');
t('falls back to combined_1', r.columns.includes('combined_1'), r.columns);

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
