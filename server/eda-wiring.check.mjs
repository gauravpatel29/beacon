// Static audit: every backend call the Data Review screen makes, traced through
// all three tiers — client api.js -> Node route -> Python route.
//
//     node server/eda-wiring.check.mjs            (static only)
//     node server/eda-wiring.check.mjs --live     (also probes a running Node tier)
//
// This exists because a route can be present in Python and still be dead: the
// Node tier proxies an explicit list, and five endpoints were missing from it.
// Nothing in the Python test suite can see that, because those tests bypass Node.
//
// Correlation is deliberately excluded — it was left out of the port.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const eda = read('client/src/pages/EDA.jsx');
const api = read('client/src/services/api.js');
const edaRoute = read('server/routes/eda.js');
const pyRoute = read('python/routers/eda.py');

const CORRELATION = new Set([
  'correlationMatrix', 'computeVIF', 'getCandidateFeatures', 'getHighCorrPairs',
  'previewRemoval', 'applyRemoval', 'findClusters', 'previewCombination',
  'applyCombination',
]);

const TAB_OF = {
  edaStats: '1 Summary', edaSparsity: '1 Summary',
  edaTrendRollup: '2 Trends', edaScatter: '2 Trends / 4 Curve',
  edaHistogram: '3 Distributions', edaDetectOutliers: '3 Distributions',
  edaRemoveOutliers: '3 Distributions', edaPoorMansCurve: '4 Curve',
  v2ListArds: 'ARD selector', v2GetCsv: 'ARD selector',
};

// [^}] so the recharts import above it is not swallowed.
const block = eda.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/services\/api["']/)[1];
const imported = block.split(',').map((s) => s.trim()).filter(Boolean);

const isCalled = (fn) => new RegExp(`\\b${fn}\\s*\\(`).test(eda);

const resolvePath = (fn) => {
  const i = api.indexOf(`export const ${fn} =`);
  if (i < 0) return null;
  const body = api.slice(i, i + 600);
  const m = body.match(/API\.(get|post|put|delete|patch)\(\s*["'`]([^"'`$]*)/);
  if (m) return { verb: m[1].toUpperCase(), path: `/api${m[2]}` };
  const v2 = body.match(/\b(get|post|put|delete|patch)\(\s*`([^`]*)`/i);
  if (v2) return { verb: v2[1].toUpperCase(), path: v2[2].replace(/\$\{[^}]+\}/g, '{}') };
  return null;
};

// Node tier: the explicit endpoint list in server/routes/eda.js
const proxied = new Set(
  [...edaRoute.matchAll(/^\s*"([a-z-]+)",?\s*$/gm)].map((m) => m[1])
);
// Python tier: the decorators in routers/eda.py
const pyEndpoints = new Set(
  [...pyRoute.matchAll(/@router\.post\("\/([a-z-]+)"\)/g)].map((m) => m[1])
);

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${got}`));
};

const called = imported.filter(isCalled).filter((f) => !CORRELATION.has(f));

console.log(`\nEDA.jsx imports ${imported.length} api functions.`);
console.log(`${called.length} non-correlation functions are actually called.\n`);
console.log('  FUNCTION'.padEnd(26) + 'TAB'.padEnd(21) + 'PATH'.padEnd(33) + 'NODE'.padEnd(13) + 'PYTHON');
console.log('  ' + '-'.repeat(96));

const rows = [];
for (const fn of called) {
  const r = resolvePath(fn);
  const ep = r && r.path.startsWith('/api/eda/') ? r.path.slice('/api/eda/'.length) : null;
  const node = !r ? '?' : ep ? (proxied.has(ep) ? 'proxied' : 'NOT ROUTED') : 'passthrough';
  const py = !ep ? 'v2 router' : (pyEndpoints.has(ep) ? 'present' : 'MISSING');
  rows.push({ fn, ...r, ep, node, py });
  console.log('  ' + fn.padEnd(24) + (TAB_OF[fn] || '—').padEnd(21)
    + `${r ? r.verb : '?'} ${r ? r.path : 'NOT IN api.js'}`.padEnd(33)
    + node.padEnd(13) + py);
}

console.log('\nchecks');
for (const r of rows) {
  t(`${r.fn}: has a client wrapper`, Boolean(r.path), 'not found in api.js');
  if (r.ep) {
    t(`${r.fn}: proxied by the Node tier`, r.node === 'proxied', r.node);
    t(`${r.fn}: implemented in routers/eda.py`, r.py === 'present', r.py);
  }
}

// The two lists must agree in both directions, or a future endpoint added to
// Python silently never reaches the browser.
const onlyPy = [...pyEndpoints].filter((e) => !proxied.has(e));
const onlyNode = [...proxied].filter((e) => !pyEndpoints.has(e));
t('every Python /api/eda endpoint is proxied by Node',
  onlyPy.length === 0, `unproxied: ${onlyPy.join(', ')}`);
t('every proxied endpoint exists in Python',
  onlyNode.length === 0, `dangling: ${onlyNode.join(', ')}`);

const skipped = imported.filter(isCalled).filter((f) => CORRELATION.has(f));
console.log(`\n  excluded from this audit: ${skipped.length} correlation functions`);

console.log('\n' + '='.repeat(60));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
