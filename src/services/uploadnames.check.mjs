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

console.log('\n6. the labels that moved to the file list');
t('the category status renders in the file list panel',
  page.includes('file-list-status'), 'file-list-status missing');
t('and no longer in the tab panel banner',
  !/mapping-warning-banner[\s\S]{0,200}still\s*\n?\s*need/.test(page), 'still in the banner');
// The all-clear belongs with the count it replaces: one line in one place that
// changes colour, rather than a warning in one panel and a tick in another.
t('the all-clear is in the file list too',
  /file-list-status is-ready[\s\S]{0,120}All files mapped/.test(page), 'not in the panel');
t('and is gone from the tab panel',
  !page.includes('mapping-success-banner'), 'still rendered in the tab panel');
t('it shows only when the screen can actually proceed',
  /\{canProceed && \([\s\S]{0,160}file-list-status is-ready/.test(page), 'shown unconditionally');
t('the warning and the all-clear are mutually exclusive',
  /\{unmappedCount > 0 && \(/.test(page) && /\{canProceed && \(/.test(page)
  && page.indexOf('canProceed = unmappedCount === 0') > 0,
  'both could show at once');
t('the "Edit remaps" footer note is gone',
  !page.includes('Edit remaps'), 'still present');
const css = readFileSync(new URL('../pages/DataIngestion/DataIngestion.css', import.meta.url), 'utf8');
t('the status has a style to render with', css.includes('.file-list-status'), 'no CSS rule');
t('and the dead footer rule was removed too', !css.includes('.file-list-footer'), 'still in CSS');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
