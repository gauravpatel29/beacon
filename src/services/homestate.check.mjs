// The Home workflow list shows the stage a workflow actually reached.
// Run: node src/services/homestate.check.mjs
//
// It did not. Two things were wrong at once:
//
//  1. The sidebar workflow switcher I added defined `.workflow-chip` - white
//     text, full width - and CSS here is global, so it also hit Home's stage
//     pill: white on a white card, i.e. invisible.
//  2. STAGE_TONES and the stage filter were written against the pipeline card
//     titles, which are not the labels a workflow is stored with.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const homeJsx = read('../pages/Home/Home.jsx');
const homeCss = read('../pages/Home/Home.css');
const sidebarCss = read('../components/Sidebar/Sidebar.css');
const switcher = read('../components/Sidebar/WorkflowSwitcher.jsx');
const stages = read('./workflowStages.js');

// Classes a stylesheet styles on their own - a rule whose selector is just
// `.foo` (optionally with a pseudo-class). Those are the dangerous ones: a
// second file defining `.foo` alone collides unconditionally. Compound and
// descendant selectors like `.sidebar-item.active` are already scoped by the
// ancestor they name, so sharing `active` between files is harmless.
const classesIn = (css) => {
  const found = new Set();
  // Selector text is everything before a `{` that is not inside a block.
  for (const [, selectors] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const part of selectors.split(',')) {
      const m = /^\s*\.([a-zA-Z][\w-]*)\s*(:{1,2}[\w-]+(\([^)]*\))?)?\s*$/.exec(part);
      if (m) found.add(m[1]);
    }
  }
  return found;
};

console.log('\n1. the sidebar no longer overwrites Home\'s stage pill');
const sidebarClasses = classesIn(sidebarCss);
t('Home still defines .workflow-chip', classesIn(homeCss).has('workflow-chip'), 'Home lost its pill');
t('the sidebar does not', !sidebarClasses.has('workflow-chip'), 'collision is back');
t('the sidebar chip is namespaced', sidebarClasses.has('wf-switch-chip'), 'not renamed');
t('and the markup uses the new names',
  /className=\{`wf-switch-chip/.test(switcher) && !/workflow-chip/.test(switcher),
  'JSX and CSS disagree');

console.log('\n2. no other class is defined by both files');
// The same mistake anywhere else would be just as invisible.
const homeClasses = classesIn(homeCss);
const shared = [...sidebarClasses].filter((c) => homeClasses.has(c));
t('sidebar and Home share no class names', shared.length === 0, shared);

console.log('\n3. every recorded stage has a tone of its own');
const recorded = [...stages.matchAll(/stage: '([^']+)'/g)].map((m) => m[1]);
// Every stage a screen can record, whatever the count - the point of the loop
// below is that none of them falls through to the neutral tone.
t('workflowStages declares the stages', recorded.length >= 4, recorded);
const tones = homeJsx.slice(homeJsx.indexOf('const STAGE_TONES'));
for (const stage of recorded) {
  const row = new RegExp(`'${stage}': '(\\w+)'`).exec(tones);
  t(`'${stage}' is toned`, Boolean(row), 'falls back to neutral');
  if (row) t(`  and not as neutral`, row[1] !== 'neutral', row[1]);
}

console.log('\n4. the stage filter offers labels that can actually match');
// It listed card titles, so choosing "Data Stitching & ARD Creation" - the
// only stitching entry on offer - matched no workflow at all.
t('the filter is built from the recorded stages',
  /WORKFLOW_STAGES = \['Not Started', \.\.\.Object\.values\(STAGES\)\.map/.test(homeJsx),
  'still built from pipelineCards');
t('STAGES is imported for it', /import \{ STAGES,[^}]*\} from '\.\.\/\.\.\/services\/workflowStages\.js'/.test(homeJsx), 'not imported');
t('the filter compares against the same accessor',
  /workflowStage === stageOf\(workflow\)/.test(homeJsx), 'compares something else');
t('and the pill reads the same accessor',
  /const stage = stageOf\(workflow\)/.test(homeJsx), 'pill and filter could disagree');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
