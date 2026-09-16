// No long dashes anywhere in the app source.
// Run: node src/services/nolongdash.check.mjs
//
// Em and en dashes are a standing house rule here. They were used three ways:
// as a sentence break in prose, as a separator in a label ("Step 1 - Select
// Model Level"), and as the "no value" placeholder in a table cell. A spaced
// hyphen reads the same in the first two; a bare hyphen does in the third.
//
// Checked in comments as well as rendered text. A comment is not UI, but the
// rule is about what gets written in this repository, and leaving them in the
// source is how they find their way back into a label.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

// U+2014 em dash, U+2013 en dash, and the HTML entities for both. U+2012
// (figure dash) and U+2015 (horizontal bar) are here too: they are the same
// character to a reader and would pass a check that only looked for the
// common two.
const LONG_DASH = /[‒–—―]/;
const ENTITY = /&(?:mdash|ndash|horbar);|&#82(?:1[1-2]|10|12);|&#x201[2-5];/i;

const SOURCE = new Set(['.js', '.jsx', '.mjs', '.css', '.html']);

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};

// This file is excluded from its own scan: the fixtures in section 3 are the
// very characters it hunts for, and a guard that fails on its own test data
// reports nothing useful about the app.
const SELF = fileURLToPath(import.meta.url);
const files = walk(SRC)
  .filter((f) => SOURCE.has(path.extname(f)))
  .filter((f) => path.resolve(f) !== path.resolve(SELF));

console.log('\n1. no long dash characters');
const offenders = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (LONG_DASH.test(line)) {
      offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
    }
  });
}
t('the source is clear of em and en dashes', offenders.length === 0, offenders.slice(0, 8));

console.log('\n2. and none written as an entity or an escape');
// An entity renders as one just as surely as the character does.
const escaped = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (ENTITY.test(line) || /\\u201[2-5]/.test(line)) {
      escaped.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
    }
  });
}
t('no entity or escape form either', escaped.length === 0, escaped.slice(0, 8));

console.log('\n3. the check is looking at something');
// A guard that silently scans nothing always passes.
t('source files were scanned', files.length > 20, files.length);
t('and the pattern does catch one', LONG_DASH.test('a — b'), 'pattern is inert');
t('including the en dash', LONG_DASH.test('2020–2021'), 'en dash would slip through');
t('and the entity form', ENTITY.test('a &mdash; b'), 'entity would slip through');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
