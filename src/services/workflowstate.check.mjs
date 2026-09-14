// Does the app remember what you were doing?
// Run: node src/services/workflowstate.check.mjs
//
// Every screen used to keep its work in component state and nothing wrote the
// workflow's `current_stage`, so Resume always reopened Data Ingestion, the
// Home list showed every workflow as "Not Started", and every selection was
// gone. These assertions pin the wiring that fixed it, because it is invisible
// at runtime until you close the tab and come back.

import { readFileSync } from 'node:fs';
import { resumeRouteFor, STAGES } from './workflowStages.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SCREENS = [
  { key: 'ingestion', rel: '../pages/DataIngestion/DataIngestion.jsx', component: 'DataIngestion' },
  { key: 'stitching', rel: '../pages/Datastitching/Datastitching.jsx', component: 'Datastitching' },
  { key: 'review', rel: '../pages/DataReview/DataReview.jsx', component: 'DataReview' },
  { key: 'transformation', rel: '../pages/DataTransformation/DataTransformation.jsx', component: 'DataTransformation' },
];

console.log('\n1. resume sends you where you left off');
t('a stored route is honoured',
  resumeRouteFor({ current_route: '/data-stitching' }) === '/data-stitching');
t('data review too', resumeRouteFor({ current_route: '/data-review' }) === '/data-review');
// A route from an older build, or a stage that no longer exists, must not
// strand the user on a blank screen.
t('an unknown route falls back to ingestion',
  resumeRouteFor({ current_route: '/legacy-eda' }) === '/data-ingestion');
t('a missing route falls back too', resumeRouteFor({}) === '/data-ingestion');
t('so does a null workflow', resumeRouteFor(null) === '/data-ingestion');
t('and an empty string', resumeRouteFor({ current_route: '' }) === '/data-ingestion');

console.log('\n2. every stage maps to a route the router actually serves');
const app = read('../App.jsx');
for (const [key, entry] of Object.entries(STAGES)) {
  t(key + ' -> ' + entry.route + ' is a real route',
    app.includes('path="' + entry.route + '"'), entry.route);
}

console.log('\n3. every screen records that it was opened');
for (const s of SCREENS) {
  t(s.key + " calls recordStage('" + s.key + "')",
    read(s.rel).includes("recordStage('" + s.key + "')"), s.rel);
}

console.log('\n4. and does it from the PAGE component, not a helper');
// recordStage was once wired into ValuePicker - a search box inside the
// ingestion page - so the stage was recorded only when that box mounted, and
// the screen-state hook beside it read variables not in its scope.
for (const s of SCREENS) {
  const src = read(s.rel);
  const call = src.indexOf('recordStage(');
  const fns = [...src.matchAll(/^function (\w+)/gm)].map((m) => ({ name: m[1], at: m.index }));
  const owner = fns.filter((f) => f.at < call).pop();
  t(s.component + ' records from the page component',
    Boolean(owner) && owner.name === s.component, owner ? owner.name : '(module scope)');
}

console.log('\n5. Home resumes into the stored route');
const home = read('../pages/Home/Home.jsx');
t('resume uses resumeRouteFor', /navigate\(resumeRouteFor\(workflow\)\)/.test(home), 'hardcoded');
t('and no longer hardcodes ingestion in resume',
  !/const resumeWorkflow[\s\S]{0,220}navigate\('\/data-ingestion'\)/.test(home), 'hardcoded');

console.log('\n6. every screen persists its configuration');
const PERSISTED = {
  ingestion: ['activeTab', 'openFile', 'pendingCategories', 'visitedTabs'],
  review: ['dateKey', 'geoKey', 'kpiColumn', 'selectedMetrics', 'corrSelectedCols',
           'outlierMethod', 'outlierThreshold', 'removalThreshold', 'clusterThreshold',
           'activeTab', 'corrSubTab'],
  transformation: ['dateKeys', 'geoKeys', 'dependentVars', 'popKeys', 'carryover',
                   'selectedVars', 'derivedVars', 'configs', 'transformSetName'],
};
for (const s of SCREENS) {
  if (s.key === 'stitching') continue; // bespoke, covered in section 7
  const src = read(s.rel);
  t(s.key + ' uses the shared hook', src.includes("useScreenState('" + s.key + "'"), s.rel);
  const snap = src.slice(src.indexOf('snapshot: () =>'), src.indexOf('restore:'));
  for (const field of PERSISTED[s.key]) {
    t(s.key + ' saves ' + field, snap.includes(field), field);
  }
}

console.log('\n7. stitching persists the recipe, not the rendered result');
const stitch = read(SCREENS[1].rel);
t('it restores saved drafts', stitch.includes("loadScreenState('stitching')"), 'no restore');
t('and saves them back', stitch.includes("saveScreenState('stitching'"), 'no save');
t('saving is gated on the restore finishing', stitch.includes('hasRestored.current'),
  'ungated: a blank initial state would overwrite real work');
t('the save is debounced', /setTimeout\(\(\) => \{ saveScreenState\('stitching'/.test(stitch),
  'not debounced');
t('steps are stored', /steps:\s*d\.steps/.test(stitch), 'steps missing');
t('join cards are NOT', !/joinCards:\s*d\.joinCards/.test(stitch), 'cards persisted');
t('previews are NOT', !/activePreview:\s*d\.activePreview/.test(stitch), 'preview persisted');
t('cards are rebuilt from the restored steps',
  /rebuildCardsFromSteps\(draft\.steps\)/.test(stitch), 'no rebuild');

console.log('\n8. results are recomputed, never stored');
// A saved chart, table or transformed frame would outlive the data it came
// from, and nothing about it would say so.
for (const s of SCREENS) {
  const src = read(s.rel);
  const snap = s.key === 'stitching'
    ? src.slice(src.indexOf('const persistableState'), src.indexOf('const restoreDrafts'))
    : src.slice(src.indexOf('snapshot: () =>'), src.indexOf('restore:'));
  t(s.key + ' stores no computed result',
    !/(statsResult|transformResult|correlation:|corrRaw|histRaw|scatterRaw|preview:|joinCards)/.test(snap),
    snap.slice(0, 200));
}

console.log('\n9. a Set is never handed to JSON');
// JSON.stringify(new Set([1])) is "{}" - it loses the contents without error.
const SETS = {
  ingestion: ['visitedTabs'],
  stitching: ['selectedFiles'],
  transformation: ['selectedVars'],
};
for (const [key, names] of Object.entries(SETS)) {
  const src = read(SCREENS.find((x) => x.key === key).rel);
  for (const name of names) {
    t(key + ' converts ' + name,
      new RegExp('Array\\.from\\((\\w+\\.)?' + name + '\\b').test(src),
      'a raw Set serialises as {}');
  }
}

console.log('\n10. loading the saved ARD does not re-guess over the saved config');
for (const key of ['review', 'transformation']) {
  const src = read(SCREENS.find((x) => x.key === key).rel);
  t(key + ' guards the reset with keepConfig',
    src.includes('const keepConfig = restoredArd.current === filename;'), 'no guard');
  t(key + ' waits for the restore before choosing an ARD',
    src.includes('if (!stateRestored) return'), 'races the restore');
}

console.log('\n11. file specs are not duplicated into workflow state');
// They live in the manifest against each dataset, which is what derives the
// frame. A second copy here would be free to disagree with the one that runs.
const svc = read('./workflowState.js') + read('./workflowStages.js');
t('the state service stores no filters', !/filters|granularity/i.test(svc), 'spec leaked in');
const ingest = read(SCREENS[0].rel);
const ingestSnap = ingest.slice(ingest.indexOf('snapshot: () =>'), ingest.indexOf('restore:'));
t('ingestion saves screen position, not the manifest',
  !/filterConfig|granularityConfig|renameMap|typeCastMap/.test(ingestSnap),
  ingestSnap.slice(0, 200));

console.log('\n12. a double mount must not undo the restore');
// React StrictMode mounts every screen twice in development. A restore that
// runs on both passes rebuilds each draft from its defaults, blanking the join
// cards the first pass had already replayed: they flashed up and vanished, and
// never came back because the step count had not changed so nothing re-fired.
t('stitching cancels the first pass instead of restoring twice',
  /let cancelled = false;\s*\n\s*loadEverything\(\(\) => cancelled\)/.test(stitch),
  'loadEverything() runs unguarded on both mounts');
t('the rebuild re-fires when cards are cleared while steps stand',
  /draft\.joinCards\.length[,\]]/.test(stitch),
  'keyed only on the step count, so a cleared card list stays cleared');
t('but does not loop after a failed rebuild',
  stitch.includes('!draft.pipelineError'), 'a failed rebuild would retry forever');
for (const key of ['review', 'transformation']) {
  const src = read(SCREENS.find((x) => x.key === key).rel);
  t(key + ' does not consume restoredArd, so the second mount keeps the config',
    !src.includes('restoredArd.current = null'),
    'cleared on the first pass; the second re-guesses over the restored config');
}

console.log('\n13. no ARD exists until the user creates one');
t('the screen opens with no tabs', /const DEFAULT_TABS = \[\];/.test(stitch),
  'a default tab is still declared');
t('and no drafts', /useState\(\{\}\);/.test(stitch), 'drafts are pre-seeded');
t('with nothing selected', /useState\(''\);[\s\S]{0,80}setDrafts\] = useState\(\{\}\)/.test(stitch)
  || /const \[activeTabId, setActiveTabId\] = useState\(''\)/.test(stitch), 'a tab id is preselected');
// The grain is not asked for at all. The build endpoint validates a
// target_grain but never passes it to the join - execute_pipeline takes only
// the steps, the frames and a preview size - so it was a label, not a choice.
t('no grain picker is rendered', !stitch.includes('custom-grain-select'), 'picker still present');
t('and a valid grain is still sent, since the endpoint requires one',
  /const targetGrain = 'hcp';/.test(stitch), 'target_grain would fail validation');
// With no grain to vary the filename, two unnamed ARDs would both default to
// __ard_hcp__.csv and the second build would replace the first.
t('the default ARD name comes from the tab, so two cannot collide',
  stitch.includes('slugify(activeTab?.title)'), 'default name no longer unique per tab');
t('slugify turns a tab title into a filename', /function slugify\(title\)/.test(stitch),
  'helper missing');
// activeTab is null before the first ARD, so nothing may dereference it.
t('the content is guarded on an ARD existing', stitch.includes('{activeTab && ('), 'ungated');
t('and an empty state is shown instead', stitch.includes('No ARD yet.'), 'no empty state');
t('nothing dereferences activeTab unguarded',
  !/activeTab\.(grain|title)\b/.test(stitch.replace(/activeTab\?\./g, ''))
  || /\{activeTab && \(/.test(stitch),
  'activeTab.grain or .title read without a guard');
t('removing the last tab selects nothing, not a missing id',
  stitch.includes("setActiveTabId(remaining[0]?.id || '')"), "falls back to a hardcoded 'hcp'");

console.log('\n14. saved sessions carrying the old fixed tabs are migrated');
// Emptying DEFAULT_TABS was not enough: a workflow saved while the screen
// still opened with HCP and DMA tabs has them in state_data, and the restore
// put them straight back. They have to be dropped on the way in.
t('the restore drops unused legacy tabs',
  stitch.includes('isUnusedLegacyTab'), 'legacy tabs restore unchanged');
t('a legacy tab holding joins is kept, not discarded',
  /removable === false\s*\n?\s*&& !\(saved\.drafts/.test(stitch)
  || stitch.includes("tab.removable === false\n      && !(saved.drafts"),
  'work would be thrown away with the tab');
t('a kept legacy tab becomes removable like any other',
  /removable: true, editing: false/.test(stitch), 'stays permanently fixed');
t('and carries no grain, which is no longer a concept here',
  !stitch.includes('legacyGrain') && !stitch.includes('customGrain'),
  'dead grain state survived the removal');
t('dropping every tab leaves the screen empty rather than restoring nothing',
  /if \(!tabsToKeep\.length\) return false;/.test(stitch), 'no empty fallback');

console.log('\n15. naming a new ARD can be finished by clicking, not only by Enter');
t('the name box is controlled',
  /value=\{renameValue\}/.test(stitch), 'uncontrolled: a button outside it could not read the value');
t('there is a confirm button', stitch.includes('tab-rename-save'), 'Enter is the only way to commit');
// Clicking the button blurs the input first, and the blur handler commits too.
// Preventing mousedown keeps focus so the click commits exactly once.
t('the click does not blur the input out from under itself',
  /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/.test(stitch), 'commits twice on click');
t('Enter still commits', /if \(e\.key === 'Enter'\) finishRenameTab/.test(stitch), 'Enter broken');
t('Escape abandons the edit', /if \(e\.key === 'Escape'\) cancelRenameTab/.test(stitch),
  'no way out of an accidental edit');
t('an empty name cannot be submitted',
  /disabled=\{!renameValue\.trim\(\)\}/.test(stitch), 'a blank name would be accepted');
t('a blank name falls back to the existing title',
  /String\(newTitle\)\.trim\(\) \|\| t\.title/.test(stitch), 'a tab could end up unnamed');
t('adding an ARD seeds the box with the suggested name',
  stitch.includes('setRenameValue(suggested)'), 'the box opens empty');

console.log('\n16. renaming an existing ARD is discoverable');
t('there is a rename control, not only a double-click',
  stitch.includes('tab-edit-btn'), 'rename is hidden behind a double-click');
t('it starts the same rename flow',
  /className="tab-edit-btn"[\s\S]{0,220}startRenameTab\(t\.id, e\)/.test(stitch),
  'the edit button does something else');
const stitchCss = read('../pages/Datastitching/Datastitching.css');
t('rename and delete are revealed on hover',
  /\.grain-tab:hover \.tab-edit-btn/.test(stitchCss), 'always visible, or never');
// Keyboard users never hover, so focus has to reveal them as well.
t('and on keyboard focus', /\.tab-edit-btn:focus-visible/.test(stitchCss),
  'unreachable without a mouse');
// Revealing with display/visibility would resize the tab as the pointer
// arrives, moving the control out from under the cursor.
t('revealed by opacity, so the tab does not resize',
  /\.tab-edit-btn,\s*\n\.tab-remove-x \{[^}]*opacity: 0/.test(stitchCss), 'layout shifts on hover');
t('the name box no longer stretches the whole tab',
  /\.tab-rename-input \{[^}]*width: 9rem/.test(stitchCss), 'still full width');

console.log('\n17. a deleted file leaves nothing behind');
// Saved state referenced files by name. Removing one on the ingestion screen
// left its name in state_data, so Stitching restored joins against a file that
// was gone and Data Review restored columns that went with it - which reached
// the API as "None of [...] are in the [columns]".
const svcFull = read('./workflowState.js');
t('there is a purge for one dataset', svcFull.includes('export async function forgetFile'),
  'nothing cleans up after a delete');
t('ingestion drops its pending category',
  /delete pendingCategories\[filename\]/.test(svcFull), 'a category outlives its file');
t('and forgets it as the open file',
  /openFile === filename \? null/.test(svcFull), 'reopens a file that is gone');
t('stitching drops the file from the picked set',
  /selectedFiles \|\| \[\]\)\.filter\(\(f\) => f !== filename\)/.test(svcFull), 'still ticked');
// A step feeds the next through "Step N Result", so the steps after a broken
// one cannot resolve either.
t('and truncates the joins at the first step that named it',
  svcFull.includes('firstBroken') && /steps\.slice\(0, firstBroken\)/.test(svcFull),
  'later steps would reference a step that no longer runs');
const ingestPage = read('../pages/DataIngestion/DataIngestion.jsx');
t('the ingestion screen calls it on delete',
  /forgetFile\(file\.filename\)/.test(ingestPage), 'delete leaves state behind');
t('only after the delete actually succeeded',
  ingestPage.indexOf('forgetFile(file.filename)') > ingestPage.indexOf('await deleteFile('),
  'a failed delete would prune state for a file still present');

console.log('\n18. a restored selection is checked against the columns present');
// The purge covers deletes made in this app. A dataset can also change shape
// underneath a saved config, so the reader validates as well.
const rev = read('../pages/DataReview/DataReview.jsx');
t('restored columns are filtered to the ones that exist',
  rev.includes('const present = new Set(cols)'), 'restores names blindly');
t('a single column falls back to the guess', /const keepOne = \(saved, fallback\)/.test(rev),
  'keeps a column that is gone');
t('and an emptied list falls back too', /const keepMany = \(saved, fallback\)/.test(rev),
  'an empty metric list would plot nothing');
t('the guesses are computed before the branch, so both paths can use them',
  rev.indexOf('const guessedDate') < rev.indexOf('if (keepConfig) {'),
  'the resume path has no fallback to use');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
