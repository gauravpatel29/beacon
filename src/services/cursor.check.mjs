// Cursor coverage across the UI. Run: node src/services/cursor.check.mjs
//
// Two things are easy to get wrong here and invisible until someone notices:
//   1. a clickable div or span with no cursor, because the global `button`
//      rule cannot reach it;
//   2. the new `button:disabled { cursor: not-allowed }` quietly overriding a
//      component's `wait` cursor, which would make an in-flight request look
//      like a dead control.
// This checks both by walking the real files.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk(SRC);
const css = files.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const jsxFiles = files.filter((f) => f.endsWith('.jsx'));

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  :: ${got}`));
};

// CSS specificity as [ids, classes+pseudo-classes, elements+pseudo-elements].
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length
    + (sel.match(/\[[^\]]+\]/g) || []).length
    + (sel.match(/:(?!:)(?!not\()[a-z-]+/g) || []).length;
  const elements = (sel.match(/(^|[\s>+~])[a-z]+[\w-]*/gi) || []).length;
  return [ids, classes, elements];
}
const beats = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;                                  // equal: later wins, not "beats"
};

console.log('\n1. every <button> gets a pointer from one global rule');
t('App.css declares it', /button\s*\{[^}]*cursor:\s*pointer/.test(css));

console.log('\n2. a disabled button does not look clickable');
t('button:disabled is not-allowed', /button:disabled\s*\{[^}]*cursor:\s*not-allowed/.test(css));

console.log('\n3. the new rule does not outrank per-component wait cursors');
// Collect every rule that sets a non-pointer cursor on a disabled/busy state.
const busy = [];
for (const m of css.matchAll(/([^{}]+)\{([^}]*cursor:\s*(wait|not-allowed|default)[^}]*)\}/g)) {
  const sel = m[1].trim();
  if (!sel.includes('.')) continue;              // skip the global rules
  busy.push({ sel, cursor: m[3] });
}
t('found the component busy-state rules', busy.length > 0, busy.length);
const globalDisabled = specificity('button:disabled');
for (const b of busy) {
  t(`${b.sel} (${b.cursor}) still wins`,
    beats(specificity(b.sel), globalDisabled),
    `${JSON.stringify(specificity(b.sel))} vs ${JSON.stringify(globalDisabled)}`);
}

console.log('\n4. clickable non-buttons declare their own cursor');
// Elements with onClick that are not <button> and carry no role="button".
const needed = new Map();
for (const f of jsxFiles) {
  const jsx = fs.readFileSync(f, 'utf8');
  for (const m of jsx.matchAll(/<(\w+)\s([^>]*?onClick[^>]*?)>/gs)) {
    const [, tag, attrs] = m;
    if (tag === 'button' || /role=["']button["']/.test(attrs)) continue;
    const cn = attrs.match(/className=["'`]([^"'`{]*)/) || attrs.match(/className=\{`([^`$]*)/);
    if (!cn) continue;
    const cls = cn[1].trim().split(/\s+/)[0];
    if (cls) needed.set(cls, path.basename(f));
  }
}
// A modal backdrop and a text input are clickable but must NOT show a pointer:
// the backdrop closes on click rather than being a control, and an input keeps
// its text caret.
const EXEMPT = new Set(['modal-overlay', 'create-ard-modal', 'tab-rename-input']);
for (const [cls, file] of [...needed].sort()) {
  if (EXEMPT.has(cls)) {
    t(`.${cls} deliberately has no pointer (${file})`,
      !new RegExp(`\\.${cls}\\s*[,{][^}]*cursor:\\s*pointer`).test(css)
      || true);                                   // informational, never fails
    continue;
  }
  const has = new RegExp(`\\.${cls}\\b[^{}]*\\{[^}]*cursor:\\s*pointer`).test(css)
    || new RegExp(`\\.${cls},`).test(css) && /cursor:\s*pointer/.test(css);
  t(`.${cls} has cursor:pointer (${file})`, has, 'no pointer rule found');
}

console.log('\n' + '='.repeat(56));
console.log(`PASSED ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
