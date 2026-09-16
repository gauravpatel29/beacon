// Model Configuration runs the real engine, and offers what the engine takes.
// Run: node src/services/modelconfig.check.mjs
//
// The screen used to fit the regression in the browser: a hand-rolled
// Gauss-Jordan solve of the normal equations, behind a 300ms "queued" pause so
// the status badge had something to show. That produced a coefficient and an
// R-squared and nothing else - no impactable sales, no spend, no ROI, no
// carryover-derived long-term factor - so nothing it produced could be carried
// into Model Output or Optimization. `/api/modelling` does the fit now.
//
// It was also missing configuration the engine needs. Sections 3-6 cover the
// gaps against the reference app: the geography column, the HCP/DMA level
// toggle, the full ridge controls, and stage 2.

import { readFileSync } from 'node:fs';
import { buildApplyPayload, dependentNames, toTransformation } from './transformationSet.js';

let pass = 0, fail = 0;
const t = (label, cond, got) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  :: ' + JSON.stringify(got)));
};
const eq = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want), got);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const page = read('../pages/ModelConfiguration/ModelConfiguration.jsx');
const css = read('../pages/ModelConfiguration/ModelConfiguration.css');
const api = read('./api.js');
const tx = read('../pages/DataTransformation/DataTransformation.jsx');

console.log('\n1. the browser no longer fits the model');
t('the hand-rolled solver is gone',
  !/function invertMatrix|function fitRegression|function matMul/.test(page), 'still fitting locally');
t('and the fake queue delay with it',
  !/setTimeout\(r, 300\)|setRunStatus\('queued'\)/.test(page), 'theatre remains');
t('stage 1 calls the engine', /await runRegression\(baseBody\(\)\)/.test(page), 'not wired');
t('ridge calls the engine', /await runRidge\(ridgeBody\(1\)\)/.test(page), 'not wired');

console.log('\n2. both frames are sent, every time');
// `granular_csv` is not optional detail: impactable sales, spend and therefore
// ROI are computed against the raw activity, and the prior-period window the
// long-term factor needs is read from it.
t('the base body carries the transformed frame', /transformed_csv: transformedCsv/.test(page), 'missing');
t('and the raw one', /granular_csv: granularCsv/.test(page), 'ROI would be zero');
t('the raw frame is the ARD csv', /v2GetCsv\(workflowId, activeArd\)/.test(page), 'not fetched');
t('the transformed frame is replayed from the saved set',
  /transformationApply\(payload\)/.test(page), 'no transformed frame');
t('and falls back honestly when there is no set',
  /setUsingTransformedSet\(false\)/.test(page) && /No saved transformation set for this ARD/.test(page),
  'silently models raw data');
t('the source is stated either way', /mc-source-note/.test(page), 'invisible input');

console.log('\n3. one recipe, two screens');
// Two copies of the payload builder would mean two different transformed
// frames from one saved set - a model fitted on something other than what the
// Transformation screen showed.
t('the builders live in a service',
  /export function toTransformation/.test(read('./transformationSet.js')), 'not extracted');
t('Data Transformation uses them',
  /sharedToTransformation\(configs, name\)/.test(tx), 'kept its own copy');
t('Model Configuration uses them', /buildApplyPayload\(rawCsv, savedSet\)/.test(page), 'kept its own copy');

// Run the builder for real.
const saved = {
  ard: 'hcp_ard.csv',
  dateKeys: ['week'], geoKeys: ['npi'], dependentVars: ['trx'], popKeys: [],
  carryover: true,
  selectedVars: ['calls'],
  derivedVars: [{ name: 'promo', operator: '+', parts: ['calls', 'emails'] }],
  configs: { calls: { normalization: 'zscore', decay: 0.3, horizon: 4, saturation: 'power', param: 0.7 } },
};
const body = buildApplyPayload('week,npi,trx,calls\n', saved);
eq('the date column is passed through', body.date_column, 'week');
eq('the geo column too', body.geo_column, 'npi');
eq('carryover is a boolean', body.add_carryover, true);
eq('a channel config reaches the engine keys', body.transformations[0], {
  'Channel Name': 'calls', 'Normalization': 'zscore', 'Adstock': 0.3, 'Lags': 4,
  'Lag': 0, 'Saturation Function': 'Power', 'Power (k)': 0.7, 'Log (k)': 1.0,
});
// The unused constant keeps its default rather than the other curve's value.
eq('a log channel sends Log (k), not Power (k)',
   toTransformation({ x: { saturation: 'log', param: 2, decay: 0.5, horizon: 1 } }, 'x')['Log (k)'], 2);
eq('and leaves Power (k) at its default',
   toTransformation({ x: { saturation: 'log', param: 2, decay: 0.5, horizon: 1 } }, 'x')['Power (k)'], 0.5);
eq('derived variables are passed with an operator',
   body.derived_variables[0], { name: 'promo', operator: '+', variables: ['calls', 'emails'], weights: {} });
t('an incomplete set builds nothing rather than a bad request',
  buildApplyPayload('csv', { dateKeys: [], geoKeys: [], dependentVars: [] }) === null, 'would post');
t('and so does a set with no channels at all',
  buildApplyPayload('csv', { ...saved, selectedVars: [], derivedVars: [] }) === null, 'would post');

console.log('\n4. the two dependent-variable names are kept apart');
// `dependent_variable` is the RAW column the sales totals come from;
// `dependent_variable_user_input` is the TRANSFORMED column that is regressed.
// Sending one for the other produces a model, not an exception.
eq('normalised dependent: the suffixed column is regressed',
   dependentNames({ dependentVars: ['trx'] }, ['trx', 'trx_transformed']),
   { dependent_variable: 'trx', dependent_variable_user_input: 'trx_transformed' });
eq('un-normalised: both are the raw column',
   dependentNames({ dependentVars: ['trx'] }, ['trx']),
   { dependent_variable: 'trx', dependent_variable_user_input: 'trx' });
t('the screen sends both', /\.\.\.depNames/.test(page), 'one name for two fields');
t('and says so when they differ', /Fitting on <code>/.test(page), 'silent substitution');

console.log('\n5. the configuration the engine needs is on screen');
t('the HCP/DMA level picker is back',
  /className=\{`level-card\$\{modelLevel === lvl\.id \? ' selected' : ''\}`\}/.test(page),
  'DMA ARDs unreachable');
t('each level says how many ARDs it has',
  /\{allArds\.filter\(\(a\) => \(a\.grain \|\| ''\)\.toLowerCase\(\) === lvl\.id\)\.length\} ARD/.test(page),
  'no way to tell which level has data');
// Missing entirely before: impactable sales are summed per geography, so the
// fit is wrong without it rather than merely unlabelled.
// Date and geography are no longer pickers here: they come from the
// transformation set, and Step 2 shows which are in force. Offering them again
// invited a model keyed on one column while the frame was built around another.
t('the date and geography pickers are gone',
  !/<label>Geography Column<\/label>/.test(page) && !/<label>Date Column<\/label>/.test(page),
  'still offered twice');
t('but Step 2 still states both', /<span>Date Column<\/span>/.test(page)
  && /<span>Geography Column<\/span>/.test(page), 'invisible inputs');
t('and both still reach the request',
  /date_column: dateColumn/.test(page) && /geo_column: geoColumn/.test(page), 'dropped from the body');
t('geography is still required', /if \(!geoColumn\) return/.test(page), 'optional');
t('channels come from the server', /getAvailableChannels\(\{/.test(page), 'guessed client-side');
t('the training window is bounded by the data',
  /min=\{dateBounds\.start\}/.test(page) && /max=\{dateBounds\.end\}/.test(page), 'unbounded');
t('and the range is stated', /Data covers \{dateBounds\.start\}/.test(page), 'invisible bounds');

console.log('\n6. ridge is configurable, not a single lambda');
for (const [label, re] of [
  ['alpha mode', /alpha_mode: alphaMode/],
  ['manual alpha', /manual_alpha: Number\(manualAlpha\)/],
  ['cv splits', /cv_splits: Number\(cvSplits\)/],
  ['non-negative constraint', /positive_coef: positiveCoef/],
  ['custom penalties', /use_custom_penalties: useCustomPenalties/],
  ['prior weights', /prior_weights: Object\.fromEntries/],
]) {
  t(`ridge sends ${label}`, re.test(page), 'not sent');
}
t('a weight for a deselected channel is not sent',
  /filter\(\(\[k\]\) => selectedChannels\.includes\(k\)\)/.test(page),
  'would name a column that is not in the model');
t('the old single lambda field is gone', !/Ridge Penalty \(λ\)/.test(page), 'stale control');
// Present and disabled, as in the reference app - it is on the roadmap, not
// in the engine - but it can no longer be selected and then fail validation.
t('Bayesian is shown as coming soon, not selectable',
  /Bayesian MMM[\s\S]{0,140}Coming soon/.test(page)
  && /<button className="model-type-btn" disabled>/.test(page),
  'either missing or still selectable');

console.log('\n8. results show what the engine returned');
for (const [label, re] of [
  ['R squared', /stage1\.r_squared/],
  ['adjusted R squared', /stage1\.adj_r_squared/],
  ['RMSE', /stage1\.rmse/],
  // Ridge reports the alpha its cross-validation settled on, and the score at
  // each one; OLS has neither, so that slot shows the training window.
  ['the chosen alpha, when there is one', /stage1\.alpha != null/],
  ['the modelling period otherwise', /\{startDate\} → \{endDate\}/],
  ['the cross-validation scores', /stage1\.cv_results/],
  ['the statsmodels summary', /stage1\.summary/],
]) {
  t(`the results card shows ${label}`, re.test(page), 'dropped');
}
// Stage 1, stage 2 and the combined table return overlapping but different
// shapes; a fixed column list would silently drop the others' columns.
t('the coefficient table renders whatever columns came back',
  /const columns = Object\.keys\(list\[0\]\)\.filter/.test(page), 'hardcoded columns');
t('and hides the raw number behind the formatted percent',
  /new Set\(\['Impactable %'\]\)/.test(page), 'the same column twice');
t('a wide table scrolls inside its own box',
  /\.coef-table-wrap \{[^}]*overflow-x: auto/.test(css), 'pushes the page sideways');

console.log('\n9. DMA residual mode is labelled, not faked');
// The previous version built a residual predictor in the browser - mean
// residual per date, added as a column - which its own comment admitted was a
// date-level proxy rather than an HCP-to-DMA rollup. The engine has no
// residual estimator, and the reference app only records the mode.
t('the mode is recorded on the run', /dmaMode: modelLevel === 'dma' \? dmaMode : null/.test(page), 'lost');
t('it shows in the run label', /const modelLabel = \(\) =>/.test(page), 'no label');
t('no residual column is synthesised',
  !/residualsByDate|hcp_residual\(/.test(page), 'fitting a different model under this label');
t('and the screen says the fit is unchanged',
  /The fit itself is the same standalone regression/.test(page), 'implies a different model');

console.log('\n10. the API bindings');
for (const name of ['getAvailableChannels', 'runRegression', 'runOlsStage2', 'runRidge',
                    'getCombinedDecomposition']) {
  t(`${name} is exported`, new RegExp(`export const ${name} =`).test(api), 'missing');
}
t('they post to /api/modelling', /request\(`\/api\/modelling\/\$\{endpoint\}`/.test(api), 'wrong prefix');

console.log('\n11. the screen is stateful like the others');
t('it records its stage', /recordStage\('modelling'\)/.test(page), 'resume would skip it');
t('the stage is declared with a route',
  /modelling: \{ stage: 'Model Configuration', route: '\/model-configuration' \}/
    .test(read('./workflowStages.js')), 'recordStage would no-op');
t('the configuration is persisted', /useScreenState\('modelling'/.test(page), 'stateless');
t('coefficients are not stored',
  /Coefficients and summaries are not stored/.test(page), 'a stale fit would outlive its ARD');
t('history moved out of localStorage', !/localStorage/.test(page), 'browser-local history');

console.log('\n12. the reference screen, step for step');
for (const step of ['Step 1 - Select Model Level', 'Step 3 - Model Setup',
                    'Step 4 - Variable Selection']) {
  t(`${step} is present`, page.includes(step), 'missing');
}
t('step 2 names the level it is filtering by',
  /Step 2 - \{GRAIN_LABELS\[modelLevel\]\} Transformed Dataset Selection/.test(page), 'missing');
t('the dataset summary states what will be modelled',
  /dataset-summary/.test(page) && /Transformed IVs/.test(page), 'invisible inputs');
t('a duplicate model name is flagged',
  /const isDuplicateName = modelHistory\.some/.test(page), 'two indistinguishable history rows');
t('the run card says what is about to run',
  /Ready to run \{GRAIN_LABELS\[modelLevel\]\}/.test(page), 'no summary');
t('the alpha grid is shown beside the fold slider',
  /const ALPHA_GRID = /.test(page) && /Grid: \{ALPHA_GRID\}/.test(page), 'an alpha out of nowhere');
t('CV folds are a slider, 2 to 10',
  /type="range" min="2" max="10" value=\{cvSplits\}/.test(page), 'not a slider');
t('the channel pills drop the _transformed suffix',
  /c\.replace\('_transformed', ''\)/.test(page), 'every pill ends the same way');
t('downstream steps are inert until there is a frame',
  /mc-disabled/.test(page) && /\.mc-disabled \{[^}]*pointer-events: none/.test(css),
  'clickable before there is anything to model');

console.log('\n12b. the pickers offer the ingestion categories');
t('the declared roles are loaded here too',
  /rolesFromDatasets\(uploads\.items\)/.test(page), 'every column offered everywhere');
// The frame's columns carry a `_transformed` suffix; the categories were
// declared against the raw names.
t('the suffix comes off before the lookup',
  /String\(col\)\.replace\(\/_transformed\$\/, ''\)/.test(page), 'nothing would ever match');
t('the KPI dropdown is the Dependent Variable category',
  /roleOf\(c\) === 'Dependent Variable'/.test(page) && /\{kpiColumns\.map/.test(page),
  'every column offered as a KPI');
t('the channel pills are promotions and baselines',
  /role === 'Independent Promotions' \|\| role === 'Baseline Variables'/.test(page)
  && /\{channelColumns\.map/.test(page), 'a geography could be modelled as a channel');
// A workflow from before column categories has no declarations at all.
t('an empty category falls back to everything offered',
  (page.match(/return matching\.length \? matching : /g) || []).length >= 2,
  'an empty and unusable picker');
t('and Select all follows the same shortlist',
  /setSelectedChannels\(channelColumns\)/.test(page), 'selects hidden columns');

console.log('\n13. the history registry is interactive');
t('rows load their configuration back', /onClick=\{\(\) => loadFromHistory\(m\)\}/.test(page), 'read-only');
t('it restores the channels too', /setSelectedChannels\(m\.selectedChannels\)/.test(page), 'partial');
t('and the KPI', /setDependentChoice\(m\.dependentVariable\)/.test(page), 'partial');
// Loading a configuration must not leave another run's numbers on screen.
t('but clears the previous result',
  /setStage1\(null\);\s*\n\s*setRunStatus\('idle'\);/.test(page),
  'numbers from a different model');
t('the loaded row is highlighted',
  /activeHistoryId === m\.id \? 'is-active' : ''/.test(page), 'no feedback');
for (const col of ['Model Name', 'Target KPI', 'Adj. R²', 'RMSE', 'Training Window', 'Status']) {
  t(`the registry shows ${col}`, page.includes(`<th>${col}</th>`), 'missing column');
}

console.log('\n' + '='.repeat(60));
console.log('PASSED ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
