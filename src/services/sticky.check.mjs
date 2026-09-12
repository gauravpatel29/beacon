// The sticky tab ribbon's prerequisites. Run: node src/services/sticky.check.mjs
//
// `position: sticky` fails by doing nothing at all — no error, no warning, the
// element just scrolls away. It needs a scrolling ancestor, and it must not be
// clipped by an overflow between itself and that ancestor. Both live in a
// different file (Main_Layout.css) from the rule that depends on them, so this
// pins the relationship.
//
// Deliberately only reads CSS. An earlier attempt to infer DOM structure by
// parsing JSX produced four false alarms out of five and was deleted.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const review = read('pages/DataReview/DataReview.css');
const layout = read('layouts/Main_Layout/Main_Layout.css');

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${got}`));
};

const ruleFor = (css, selector) => {
  const m = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};

console.log('\n1. the ribbon asks to stick');
const tabs = ruleFor(review, '.review-tabs');
t('position: sticky', /position:\s*sticky/.test(tabs), tabs.trim().slice(0, 60));
t('has a top offset (sticky without one never engages)', /\btop:\s*\S+/.test(tabs));
t('sits above the content it overlaps', /z-index:\s*(\d+)/.test(tabs) && Number(tabs.match(/z-index:\s*(\d+)/)[1]) > 0);
t('opaque background, or content shows through',
  /background-color:\s*var\(--color-white\)/.test(tabs), tabs);

console.log('\n2. there is something for it to stick to');
const pageContent = ruleFor(layout, '.page-content');
t('.page-content scrolls', /overflow-y:\s*auto|overflow:\s*auto|overflow:\s*scroll/.test(pageContent),
  pageContent.trim());

console.log('\n3. nothing between the two clips it');
// .review-page is the only element between .review-tabs and .page-content.
const reviewPage = ruleFor(review, '.review-page');
t('.review-page does not set overflow',
  !/overflow/.test(reviewPage), reviewPage.trim());

console.log('\n4. the stats table header keeps its own sticky, in its own scroller');
// Two sticky contexts on one page; the wrapper's overflow is what separates
// them, and the ribbon's z-index is what keeps it on top.
const wrapper = ruleFor(review, '.stats-table-wrapper');
const th = ruleFor(review, '.stats-table th');
t('.stats-table-wrapper scrolls independently', /overflow:\s*auto/.test(wrapper), wrapper.trim());
t('its th is sticky', /position:\s*sticky/.test(th), th.trim().slice(0, 50));
const ribbonZ = Number((tabs.match(/z-index:\s*(\d+)/) || [0, 0])[1]);
const thZ = Number((th.match(/z-index:\s*(\d+)/) || [0, 0])[1]);
t('the ribbon outranks the table header', ribbonZ > thZ, `ribbon ${ribbonZ} vs th ${thZ}`);

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
