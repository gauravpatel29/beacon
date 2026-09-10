// Mirrors payloadFor + validateStep from Datastitching.jsx after the change.
const payloadFor = (steps, targetGrain = 'hcp') => ({
  steps: steps.map((s) => {
    const base = { left_file: s.leftFile, right_file: s.rightFile, join_type: s.joinType };
    if (s.joinType === 'cross') return base;
    const filled = (s.keyPairs || []).filter((p) => p.left && p.right);
    return { ...base, left_key: filled.map((p) => p.left), right_key: filled.map((p) => p.right) };
  }),
  target_grain: targetGrain,
});

const validateStep = (step) => {
  if (!step.leftFile || !step.rightFile) return 'Choose both a left and right dataset.';
  if (step.joinType === 'cross') return null;
  const pairs = step.keyPairs || [];
  const filled = pairs.filter((p) => p.left && p.right);
  if (!filled.length) return 'At least one key pair is required.';
  if (pairs.some((p) => Boolean(p.left) !== Boolean(p.right)))
    return 'Every key pair needs a column on both sides, or remove the row.';
  const lk = filled.map((p) => p.left);
  if (new Set(lk).size !== lk.length) return 'The same left column is used in more than one key pair.';
  return null;
};

let ok = 0, fail = 0;
const check = (l, c, x = '') => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x ? '  :: ' + JSON.stringify(x) : ''));
  c ? ok++ : fail++;
};

const S = (over = {}) => ({ leftFile: 'a.csv', rightFile: 'b.csv', joinType: 'left',
  keyPairs: [{ left: 'npi', right: 'NPI' }], ...over });

// one pair
let p = payloadFor([S()]).steps[0];
check('single pair -> 1 key each side',
  JSON.stringify(p.left_key) === '["npi"]' && JSON.stringify(p.right_key) === '["NPI"]', p);

// three pairs - impossible with the old fixed ID+date model
p = payloadFor([S({ keyPairs: [
  { left: 'npi', right: 'NPI' }, { left: 'month', right: 'Month' }, { left: 'geo', right: 'Geo' }] })]).steps[0];
check('three pairs -> 3 keys each side, order preserved',
  JSON.stringify(p.left_key) === '["npi","month","geo"]'
  && JSON.stringify(p.right_key) === '["NPI","Month","Geo"]', p);

// counts always match, even with a blank row present
p = payloadFor([S({ keyPairs: [{ left: 'npi', right: 'NPI' }, { left: '', right: '' }] })]).steps[0];
check('blank row dropped, counts stay equal',
  p.left_key.length === p.right_key.length && p.left_key.length === 1, p);

// cross sends no keys at all
p = payloadFor([S({ joinType: 'cross', keyPairs: [{ left: 'npi', right: 'NPI' }] })]).steps[0];
check('cross omits key arrays', !('left_key' in p) && !('right_key' in p), p);

// validation
check('half-filled pair rejected before sending',
  validateStep(S({ keyPairs: [{ left: 'npi', right: '' }] })) !== null);
check('no pairs rejected', validateStep(S({ keyPairs: [] })) !== null);
check('duplicate left column rejected',
  validateStep(S({ keyPairs: [{ left: 'npi', right: 'NPI' }, { left: 'npi', right: 'Month' }] })) !== null);
check('cross needs no keys', validateStep(S({ joinType: 'cross', keyPairs: [] })) === null);
check('valid multi-key accepted',
  validateStep(S({ keyPairs: [{ left: 'npi', right: 'NPI' }, { left: 'month', right: 'Month' }] })) === null);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
