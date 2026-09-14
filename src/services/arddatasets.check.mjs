// An ARD belongs to the stitching screen, not the ingestion screen.
// Run: node src/services/arddatasets.check.mjs
//
// An ARD is stored as a dataset in the same workflow (kind='ard'), so the
// ingestion screen's file list showed it alongside the CSVs the user had
// uploaded - offering a generated output for categorising and column remapping
// as though it were a source file, and costing a profile and a preview request
// for each one on every resume.
//
// The other half: the tab is the only place an ARD is built and named, so
// deleting the tab while leaving the dataset behind left a file that nothing
// on that screen could reach again.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const api = read('./api.js');
const ingest = read('../pages/DataIngestion/DataIngestion.jsx');
const stitch = read('../pages/Datastitching/Datastitching.jsx');
const state = read('./workflowState.js');
const router = read(
  '../../../../Aashika/beacon/python/routers/v2_files.py',
);

console.log('\n1. the API can ask for one kind of dataset');
t('listFiles takes a kind', /export const listFiles = \(workflowId, \{ kind \} = \{\}\)/.test(api),
  'no filter available');
t('and leaves the query off when none is given',
  /\(kind \? `\?kind=\$\{encodeURIComponent\(kind\)\}` : ''\)/.test(api), 'always filtered');

console.log('\n2. the server does the filtering');
t('the endpoint accepts kind', /kind: Optional\[str\] = Query\(/.test(router), 'no query param');
t('it splits a comma-separated list', /kind\.split\(","\)/.test(router), 'single value only');
t('rows written before `kind` existed count as uploads',
  /\(d\.get\("kind"\) or "upload"\) in wanted/.test(router), 'legacy rows would vanish');
t('and an absent kind still returns everything',
  /if kind:/.test(router) && !/kind: str = Query\("upload"/.test(router),
  'existing callers would silently lose rows');

console.log('\n3. the ingestion screen asks for uploads only');
t('it passes kind=upload', /listFiles\(workflowId, \{ kind: 'upload' \}\)/.test(ingest),
  'still lists every dataset');
t('and there is no unfiltered listFiles left on that screen',
  !/listFiles\(workflowId\)/.test(ingest), 'a second call brings the ARDs back');

console.log('\n4. the stitching screen still hides ARDs from its own pickers');
// An ARD must not be joinable into itself.
t('the join source list drops kind=ard', /f\.kind !== 'ard'/.test(stitch), 'self-join possible');

console.log('\n5. deleting a tab deletes the ARD it built');
t('removeTab is async', /const removeTab = async \(tabId, e\)/.test(stitch), 'cannot await the delete');
t('it finds the dataset from this session or the last',
  /generatedArd\?\.filename \|\| tabDraft\.generatedArdName/.test(stitch), 'a resumed tab would orphan it');
t('the confirm says the dataset goes too',
  /will be deleted too/.test(stitch), 'silent data loss');
t('an empty tab with no ARD still goes without a prompt',
  /if \(stepCount > 0 \|\| builtArd\)/.test(stitch), 'prompts for nothing');
t('the delete is issued', /await deleteFile\(workflowId, builtArd\)/.test(stitch), 'file survives');
t('and deleteFile is imported', /deleteFile,/.test(stitch.split('\n')[1]), 'not imported');

console.log('\n6. the saved state is pruned, but only after the delete lands');
t('forgetFile is called', /await forgetFile\(builtArd\)/.test(stitch), 'state keeps the name');
t('after the delete, not before',
  stitch.indexOf('await forgetFile(builtArd)') > stitch.indexOf('await deleteFile(workflowId, builtArd)'),
  'a failed delete would prune a live dataset');
t('a failure does not blank the screen',
  /setTabError\(problemMessage/.test(stitch) && !/setLoadError\(problemMessage\(err, `Removed/.test(stitch),
  'one bad delete hides the whole screen');

console.log('\n7. the name survives a resume');
t('it is persisted', /generatedArdName: d\.generatedArd\?\.filename \|\| d\.generatedArdName \|\| null/.test(stitch),
  'lost as soon as the build is forgotten');
t('and restored', /generatedArdName: d\.generatedArdName \|\| null/.test(stitch), 'not read back');
t('the default draft declares it', /generatedArdName: null,/.test(stitch), 'undefined field');

console.log('\n8. forgetting a dataset clears every reference to it');
t('the producing tab stops claiming it',
  /draft\.generatedArdName === filename/.test(state), 'the tab would offer to delete it twice');
for (const screen of ['review', 'transformation']) {
  t(`the ${screen} screen's selection is cleared`,
    /for \(const key of \['review', 'transformation'\]\)/.test(state) && /screen\.ard === filename/.test(state),
    'resumes onto a dataset that no longer resolves');
}

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
