// The chart tooltip's content mapping. Run: node src/services/charttooltip.check.mjs
//
// recharts does the hit-testing now, so what is left for us is the box itself:
// turning a recharts `payload` into the rows the tooltip shows. That mapping is
// ours, and getting it wrong shows the user a correct-looking wrong number.
//
// Replaces charthover.check.mjs, which tested the hand-drawn SVG hit-testing
// that recharts has taken over.

const fmt = (v) => (Number.isFinite(v)
  ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(Number(v).toFixed(2)).toLocaleString())
  : '—');

// Mirrors ChartTooltip in pages/DataReview/DataReview.jsx.
function tooltip({ active, payload, label, title, rows, indexed = false }) {
  if (!active || !payload || !payload.length) return null;
  return {
    heading: title ? title(label, payload) : label,
    lines: rows
      ? rows(label, payload)
      : payload.map((p) => ({
          label: p.name ?? p.dataKey,
          value: indexed ? `${Number(p.value).toFixed(1)} (Index)` : fmt(p.value),
          color: p.color || p.stroke || p.fill,
        })),
  };
}

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${JSON.stringify(got)}`));
};

console.log('\n1. renders nothing when there is nothing to show');
t('inactive -> null', tooltip({ active: false, payload: [{ value: 1 }] }) === null);
t('no payload -> null', tooltip({ active: true, payload: [] }) === null);
t('missing payload -> null', tooltip({ active: true }) === null);

console.log('\n2. trend: one row per series, coloured to match its line');
let r = tooltip({
  active: true, label: '2026-01-04',
  payload: [
    { name: 'trx', value: 4097, color: '#1d4ed8' },
    { name: 'calls', value: 38366, color: '#10b981' },
  ],
});
t('heading is the x value', r.heading === '2026-01-04', r.heading);
t('a row per series', r.lines.length === 2, r.lines);
t('thousands are grouped, not raw', r.lines[0].value === '4,097', r.lines[0].value);
t('series colour carried through', r.lines[1].color === '#10b981', r.lines[1]);
t('falls back to dataKey when unnamed',
  tooltip({ active: true, payload: [{ dataKey: 'nbrx', value: 3 }] }).lines[0].label === 'nbrx');

console.log('\n3. indexed view reads as an index, not a count');
r = tooltip({ active: true, label: 'w1', indexed: true, payload: [{ name: 'trx', value: 112.37 }] });
t('suffixed and to 1dp', r.lines[0].value === '112.4 (Index)', r.lines[0].value);
r = tooltip({ active: true, label: 'w1', indexed: false, payload: [{ name: 'trx', value: 112.37 }] });
t('not suffixed when off', r.lines[0].value === '112.37', r.lines[0].value);

console.log('\n4. histogram adds a share that is not a series');
r = tooltip({
  active: true, label: '10.0 - 20.0',
  payload: [{ value: 250 }],
  rows: (label, p) => {
    const count = p[0]?.value ?? 0;
    const total = 1000;
    return [
      { label: 'Records', value: count.toLocaleString(), color: '#1d2a6b' },
      { label: 'Share', value: total ? `${((count / total) * 100).toFixed(1)}%` : '—' },
    ];
  },
});
t('bin range is the heading', r.heading === '10.0 - 20.0', r.heading);
t('record count shown', r.lines[0].value === '250', r.lines[0]);
t('share computed against the total', r.lines[1].value === '25.0%', r.lines[1]);

console.log('\n5. scatter names both axes from the hovered point');
r = tooltip({
  active: true,
  payload: [{ payload: { x: 12.5, y: 3400 } }],
  title: () => 'Binned average',
  rows: (label, p) => {
    const pt = p[0]?.payload || {};
    return [
      { label: 'calls', value: fmt(pt.x), color: '#94a3b8' },
      { label: 'trx', value: fmt(pt.y), color: '#1d4ed8' },
    ];
  },
});
t('custom heading used', r.heading === 'Binned average', r.heading);
t('x formatted', r.lines[0].value === '12.5', r.lines[0].value);
t('y grouped', r.lines[1].value === '3,400', r.lines[1].value);

console.log('\n6. number formatting holds up at the edges');
t('zero', fmt(0) === '0', fmt(0));
t('negative', fmt(-1234.6) === '-1,235', fmt(-1234.6));
t('trailing zeros trimmed', fmt(5.0) === '5', fmt(5.0));
t('non-numeric falls back to a dash', fmt(undefined) === '—', fmt(undefined));
t('NaN falls back to a dash', fmt(NaN) === '—', fmt(NaN));

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
