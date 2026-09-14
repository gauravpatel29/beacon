// The sidebar says which workflow you are in, and lets you change it.
// Run: node src/services/sidebar.check.mjs
//
// Every screen reads the active workflow from storage on mount and nothing on
// screen named it, so there was no way to tell which workflow you were looking
// at - or to move between them without going back to Home. The collapse
// control also sat half outside the sidebar, where its own overflow clipped it.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const bar = read('../components/Sidebar/Sidebar.jsx');
const sw = read('../components/Sidebar/WorkflowSwitcher.jsx');
const css = read('../components/Sidebar/Sidebar.css');

console.log('\n1. the sidebar names the current workflow');
t('the switcher is rendered', bar.includes('<WorkflowSwitcher'), 'not mounted');
t('it reads the active id from the same place the screens do',
  sw.includes('storedWorkflowId()'), 'a second source of truth');
t('and resolves it to a name', /workflow_name \|\| .*\.name/.test(sw), 'shows a raw id');
t('with a fallback when nothing is selected',
  sw.includes('No workflow selected'), 'renders blank');
t('and one when the list cannot be loaded',
  sw.includes("loadFailed ? 'Workflow'"), 'a failed fetch leaves it empty');

console.log('\n2. it can switch workflows');
t('selecting one stores it', sw.includes('selectWorkflow(workflow.id)'), 'selection is not saved');
t('and opens that workflow where it left off',
  sw.includes('resumeRouteFor(workflow)'), 'always lands on the same screen');
// Screens read the workflow once, on mount. Navigating to the route already
// open remounts nothing, so the panels would keep showing the old workflow.
t('switching while already on the target route reloads',
  /route === location\.pathname\) window\.location\.reload\(\)/.test(sw),
  'the screen would keep the previous workflow');
t('re-selecting the current workflow does nothing',
  /if \(workflow\.id === activeId\) return;/.test(sw), 'pointless reload');
t('the list refreshes on navigation, so a new workflow appears',
  /\}, \[location\.pathname[^\]]*\]\)/.test(sw), 'stale after creating one');

console.log('\n3. the menu behaves like a menu');
t('an outside click closes it', sw.includes("addEventListener('mousedown'"), 'stays open');
t('Escape closes it', /e\.key === 'Escape'\) setOpen\(false\)/.test(sw), 'no keyboard exit');
t('listeners are removed again', sw.includes("removeEventListener('mousedown'"), 'leaks');
t('it is announced as a listbox', /role="listbox"/.test(sw), 'no role');
t('and the current one is marked selected',
  /aria-selected=\{w\.id === activeId\}/.test(sw), 'no selected state');
t('a long list scrolls instead of running off screen',
  /\.workflow-menu-list \{[^}]*overflow-y: auto/.test(css), 'unbounded');

console.log('\n4. the collapse control');
t('it is in the header row, not floating', /\.sidebar-head \{/.test(css), 'no header row');
t('and no longer positioned outside the sidebar',
  !/\.sidebar-toggle-btn \{[^}]*right: -16px/.test(css), 'still hanging off the edge');
t('it reports its state to assistive tech',
  /aria-expanded=\{!collapsed\}/.test(bar), 'no state exposed');
t('and has a label that changes with it',
  /aria-label=\{collapsed \? 'Expand sidebar' : 'Collapse sidebar'\}/.test(bar), 'static label');

console.log('\n5. the dropdown is not clipped by the sidebar');
// Any overflow value other than visible makes the sidebar a clipping box, and
// an absolutely positioned menu inside it disappears at the edge.
t('the sidebar does not clip its children',
  /\.sidebar \{[^}]*overflow: visible/.test(css), 'overflow would clip the menu');
t('the nav list carries the scrollbar instead',
  /\.sidebar-nav \{[^}]*overflow-y: auto/.test(css), 'nothing scrolls when the list is long');
t('and can shrink to do so', /\.sidebar-nav \{[^}]*min-height: 0/.test(css),
  'a flex child will not scroll without it');

console.log('\n6. collapsed state stays usable');
t('the chip falls back to an initial', sw.includes('wf-switch-chip-initial'), 'name is cut off');
t('the full name is still available as a tooltip',
  /title=\{collapsed \? label/.test(sw), 'no way to read it');
t('the header stacks when there is no room',
  /\.sidebar\.collapsed \.sidebar-head \{[^}]*flex-direction: column/.test(css), 'controls overlap');
t('a long name cannot widen the sidebar',
  /\.wf-switch-chip-name \{[^}]*text-overflow: ellipsis/.test(css), 'layout would stretch');

console.log('\n7. the chip and the toggle line up');
// The chip is two lines tall and the toggle one, so centring left a small
// square floating beside a taller block.
t('the row stretches them to a shared height',
  /\.sidebar-head \{[^}]*align-items: stretch/.test(css), 'centred, so the heights differ');
t('the toggle takes its height from the row',
  !/\.sidebar-head[\s\S]{0,40}\n\.sidebar-toggle-btn \{[^}]*height: 30px/.test(css)
  && /\.sidebar-toggle-btn \{[^}]*flex: 0 0 34px/.test(css),
  'fixed height would not match the chip');
t('and gets its own height back once stacked',
  /\.sidebar\.collapsed \.sidebar-toggle-btn \{[^}]*height: 30px/.test(css),
  'stretches to nothing in a column');

console.log('\n8. Manage and + New, on one line, over the current screen');
const dlg = read('../components/Sidebar/WorkflowDialog.jsx');
t('both actions are in one footer row', /workflow-menu-foot/.test(sw), 'no footer row');
t('Manage is there', />\s*Manage\s*</.test(sw), 'missing');
t('+ New is there', />\s*\+ New\s*</.test(sw), 'missing');
t('and + New sits at the end of the line',
  /\.workflow-menu-foot \{[^}]*justify-content: space-between/.test(css), 'not pushed to the end');
// The point of the change: neither should abandon the screen in progress.
t('neither navigates to Home', !/navigate\('\/'/.test(sw), 'still leaves the screen');
t('they open a dialog instead', /setDialog\('manage'\)/.test(sw) && /setDialog\('create'\)/.test(sw),
  'no dialog');
t('the dialog is rendered over the current screen',
  /<WorkflowDialog/.test(sw) && /position: fixed/.test(read('../components/Sidebar/WorkflowDialog.css')),
  'not an overlay');

console.log('\n9. the dialog can actually manage');
t('it lists workflows', dlg.includes('listWorkflows('), 'no list');
t('creates one', dlg.includes('createWorkflow('), 'cannot create');
t('renames one', dlg.includes('updateWorkflow('), 'cannot rename');
t('deletes one', dlg.includes('deleteWorkflow('), 'cannot delete');
t('and opens one', dlg.includes('selectWorkflow('), 'cannot switch');
// Deleting is irreversible and takes the files with it.
t('deleting asks first', /window\.confirm\(/.test(dlg), 'silent destruction');
t('and drops the selection when it was the one in use',
  /workflow\.id === activeId\) forgetWorkflow\(\)/.test(dlg),
  'the app would point at a workflow that is gone');
t('a new workflow opens at the start, not wherever you were standing',
  /current_route: '\/data-ingestion'/.test(dlg), 'resumes into an empty workflow');
t('the sidebar refreshes after the dialog closes',
  /onClose=\{\(\) => \{[\s\S]*?reload\(\)/.test(sw), 'a rename would not show');
t('Escape closes the dialog', /e\.key === 'Escape'\) onClose\(\)/.test(dlg), 'no keyboard exit');
t('a click inside does not close it',
  /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(dlg), 'closes on any click');

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
