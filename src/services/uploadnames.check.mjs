// A workflow cannot hold two files of the same name.
// Run: node src/services/uploadnames.check.mjs
//
// The upload call used to send overwrite=true, so re-uploading a name that was
// already in the workflow silently REPLACED the stored dataset - and with it
// the manifest committed against that name. Nothing warned; the file list just
// showed the same name with different data behind it.
//
// Also checks the two labels that moved on this screen, so the status does not
// drift back into the tab panel or the removed footer note reappear.

import { readFileSync } from 'node:fs';
import { partitionNewFiles } from './manifest.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};

const f = (name) => ({ name });
const names = (list) => list.map((x) => x.name);

console.log('\n1. a name already in the workflow is refused');
let r = partitionNewFiles(['calls.csv', 'sales.csv'], [f('calls.csv')]);
t('the duplicate is not uploaded', r.accepted.length === 0, names(r.accepted));
t('and is reported back by name', r.duplicates[0] === 'calls.csv', r.duplicates);

r = partitionNewFiles(['calls.csv'], [f('calls.csv'), f('emails.csv')]);
t('the rest of the selection still uploads', names(r.accepted).join() === 'emails.csv',
  names(r.accepted));
t('only the collision is reported', r.duplicates.join() === 'calls.csv', r.duplicates);

console.log('\n2. case does not make a name different');
// The object store keys on the name; "Calls.csv" and "calls.csv" would collide
// there even though the strings differ.
r = partitionNewFiles(['calls.csv'], [f('CALLS.CSV')]);
t('upper case is still the same file', r.accepted.length === 0, names(r.accepted));
t('reported with the name as the user typed it', r.duplicates[0] === 'CALLS.CSV', r.duplicates);
r = partitionNewFiles(['Calls.CSV'], [f('calls.csv')]);
t('and in the other direction', r.accepted.length === 0, names(r.accepted));

console.log('\n3. collisions inside one selection count too');
// Picking the same file twice, or two files of one name from two folders.
r = partitionNewFiles([], [f('a.csv'), f('a.csv'), f('b.csv')]);
t('the first one is kept', names(r.accepted).join() === 'a.csv,b.csv', names(r.accepted));
t('the second is refused', r.duplicates.join() === 'a.csv', r.duplicates);
r = partitionNewFiles([], [f('a.csv'), f('A.csv')]);
t('case-folded within the batch as well', r.accepted.length === 1, names(r.accepted));

console.log('\n4. the ordinary case is untouched');
r = partitionNewFiles(['calls.csv'], [f('emails.csv'), f('tv.csv')]);
t('all new names accepted', names(r.accepted).join() === 'emails.csv,tv.csv', names(r.accepted));
t('nothing reported', r.duplicates.length === 0, r.duplicates);
r = partitionNewFiles([], []);
t('an empty selection is not an error',
  r.accepted.length === 0 && r.duplicates.length === 0, r);
t('undefined inputs are not an error',
  partitionNewFiles(undefined, undefined).accepted.length === 0);

console.log('\n5. the upload call does not ask the server to overwrite');
const page = readFileSync(new URL('../pages/DataIngestion/DataIngestion.jsx', import.meta.url), 'utf8');
t('overwrite:false is passed explicitly', /uploadFiles\([^)]*overwrite:\s*false/s.test(page),
  (page.match(/uploadFiles\([^)]*\)/s) || [])[0]);
t('the screen filters the selection before uploading',
  page.includes('partitionNewFiles('), 'not called');

console.log('\n6. no category status at all');
// The picker that would let anyone act on a category is not on the Assign
// Category tab, so every status about one reported work that could not be
// done: a count of unmapped files, an all-clear for a gate that no longer
// exists, and an amber row per file.
t('the file-list status line is gone', !page.includes('file-list-status'), 'still rendered');
t('and the banners it replaced are still gone',
  !page.includes('mapping-success-banner'), 'a banner came back');
t('no Unmapped label on a row', !/>\s*Unmapped\s*</.test(page), 'label remains');
t('and no amber unmapped row', !/unmapped-label/.test(page), 'styling remains');
// The gate went with them; nothing computes a category count now.
t('the category gate is gone',
  !/const canProceed|const unmappedCount|const hasRequiredCategories/.test(page), 'dead code');
// A file that HAS a category still says so: that is information, not a
// demand for action.
t('a categorised file still shows its category',
  /\{categoryInfo && \(/.test(page), 'the category is hidden too');
// Nothing guesses a category from the filename. The guess was written
// straight into the file's category, so it reached the manifest looking like
// a deliberate choice - and it was made by substring, which put any file
// named "sample" into hcp_promo.
t('no category is guessed from the filename',
  !/suggestCategory|guessCategory/.test(page), 'a guess remains');
t('a fresh upload carries no category',
  /category: null, columns,/.test(page), 'the upload path assigns one');
t('but a category committed to the spec is still restored',
  /category: spec\.config_metadata\?\.category \|\| null/.test(page), 'stored categories dropped');
t('and a file without one writes nothing to the manifest',
  /if \(file\.category\) meta\.category = file\.category;/
    .test(readFileSync(new URL('./manifest.js', import.meta.url), 'utf8')),
  'null would be written through');
t('the "Edit remaps" footer note is gone',
  !page.includes('Edit remaps'), 'still present');
const css = readFileSync(new URL('../pages/DataIngestion/DataIngestion.css', import.meta.url), 'utf8');
t('and its CSS went with it', !css.includes('.file-list-status {'), 'dead rule left behind');
t('and the dead footer rule was removed too', !css.includes('.file-list-footer'), 'still in CSS');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
