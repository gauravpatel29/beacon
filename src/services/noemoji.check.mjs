// No emoji in button labels. Run: node src/services/noemoji.check.mjs
//
// Buttons carry actions, and an emoji in a label renders differently on every
// platform, breaks alignment against neighbouring buttons, and is read aloud by
// screen readers. The severity a glyph was standing in for is already carried
// by colour.
//
// Typographic symbols are NOT emoji and are left alone: the reload arrow on
// "Restore Original Dataset" and the multiplication sign on a close button are
// monochrome glyphs that were already part of this UI.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

// Pictographic ranges only. U+2190-21FF (arrows) is deliberately NOT here: the
// rightwards arrow on "Get Started" is a typographic glyph, renders the same
// everywhere, and is already aria-hidden. An earlier version of this range
// included it and reported those buttons as offenders.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{FE0F}]/u;
// The same characters written as an escape or an HTML entity in the source.
const ESCAPED = /\\u\{1F|&#1(?:2[0-9]|[3-9][0-9])[0-9]{2};/;

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${got}`));
};

const offenders = [];
let buttons = 0;
for (const file of walk(SRC).filter((f) => f.endsWith('.jsx'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/<button[\s\S]{0,600}?<\/button>/g)) {
    buttons++;
    if (EMOJI.test(m[0]) || ESCAPED.test(m[0])) {
      offenders.push(`${path.basename(file)}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
}

console.log(`\nscanned ${buttons} buttons`);
t('no emoji in any button label', offenders.length === 0, offenders.join(' | '));

console.log('\nthe VIF verdict is text, not a glyph');
const review = fs.readFileSync(path.join(SRC, 'pages/DataReview/DataReview.jsx'), 'utf8');
t('the API\'s emoji prefix is stripped before display',
  review.includes("status: String(v.status || '').replace("), 'strip not found');
t('severity still reaches the badge as a class', review.includes('vifSeverity(v)'));

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
