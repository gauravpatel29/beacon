import { useState, useEffect, useMemo } from 'react';
import {
  ensureWorkflow,
  getWorkflow,
  getCsv,
  problemMessage,
  runRegression,
  runRidge,
} from '../../services/api.js';
import { generateResponseCurves, fetchBenchmarks, fetchResultsSummary, updateWorkflowState } from '../../services/modelOutputApi.js';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, Legend, LineChart, Line, BarChart, Bar } from 'recharts';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import { AXIS_TICK, CHART_COLORS, GRID, LINE_TYPE, X_LABEL, Y_LABEL } from '../../components/charts/chartTheme.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './ModelOutput.css';

// ─── Tier / bucket classification (exact rules from the integration spec) ───
// Prefer the per-column category recorded during ingestion
// (spec.config_metadata.column_roles) where it answers the question; the
// name-pattern rules below are the fallback, not the primary source.
// column_roles records one of the five INGESTION roles - 'Baseline
// Variables', 'Independent Promotions', and so on. Those are not these four
// output buckets, and returning one straight through filed rows under keys
// like 'Baseline Variables' that nothing on this screen reads. The damage
// showed up in Baseline Demand: the real baseline variables vanished into an
// unrendered bucket, leaving the tier to be the intercept alone, which is
// routinely negative even in a model whose baseline contribution is
// positive. Only 'Baseline Variables' maps cleanly onto a bucket;
// 'Independent Promotions' still has to be split into personal/npp/dtc,
// which only the name rules can do.
const ROLE_TO_BUCKET = { 'Baseline Variables': 'baseline' };

function classifyChannel(variable, columnRoles) {
  const mapped = ROLE_TO_BUCKET[columnRoles?.[variable]];
  if (mapped) return mapped;

  const n = variable.toLowerCase();
  if (/const|baseline|intercept|carryover/.test(n)) return 'baseline';
  if (/rte|email|portal|npp|hcp_web/.test(n)) return 'npp';
  if (/tv|dtc|digital|search|social|media|disp/.test(n)) return 'dtc';
  if (/call|det|sample|speaker|f2f|rep/.test(n)) return 'personal';
  return 'personal'; // unmatched falls into Personal Promotion, per spec
}
const BUCKET_LABELS = { baseline: 'Baseline', personal: 'Personal Promotion', npp: 'NPP Promotion', dtc: 'DTC Promotion' };
// Section 3 (Executive Summary) stat-card labels use slightly different
// wording than the Tier Role badges in Section 5's deep-dive table.
const EXEC_LABELS = { baseline: 'Baseline Demand', personal: 'Personal Promotion', npp: 'NPP Promotion', dtc: 'DTC / Media' };
const BUCKET_COLORS = { baseline: '#001E96', personal: '#1ABC9C', npp: '#F59E0B', dtc: '#8B5CF6' };

// The coefficient array is documented (MODEL_OUTPUT_API.md) to live at
// `coefficients` on each stored model run. Sections 3/4/5 read it entirely
// client-side — there's no endpoint for them by design. But real runs have
// come through with that array empty/missing while still having valid
// r2/rmse, so this checks a handful of plausible alternate key names before
// giving up, and reports back which one (if any) actually worked so the UI
// can show a useful diagnostic instead of just silently rendering nothing.
const COEFFICIENT_KEY_CANDIDATES = [
  'coefficients', 'coefficient_table', 'coeffs', 'coefficientTable',
  'regression_output', 'regressionOutput', 'model_output', 'modelOutput',
  'results', 'output',
];
function findCoefficientArray(model) {
  if (!model) return { rows: null, foundKey: null };
  for (const key of COEFFICIENT_KEY_CANDIDATES) {
    const val = model[key];
    if (Array.isArray(val) && val.length) return { rows: val, foundKey: key };
    // A couple of these candidates are objects that might themselves nest a
    // `coefficients` array one level down (e.g. model.results.coefficients).
    if (val && typeof val === 'object' && Array.isArray(val.coefficients) && val.coefficients.length) {
      return { rows: val.coefficients, foundKey: `${key}.coefficients` };
    }
  }
  return { rows: null, foundKey: null };
}

// Must match results.py's BENCHMARK_DATABASE keys EXACTLY — the backend does
// a silent dict .get(value, default) fallback on mismatch, not an error, so a
// wrong string here doesn't fail, it just quietly benchmarks against the
// wrong (or default) cohort with no visible sign anything's off. Note the en
// dash (–, U+2013) in the maturity stages, not a plain hyphen.
const MATURITY_STAGES = ['Launch (<1 Year)', 'Growth (1–3 Years)', 'Mature (3–7 Years)', 'Late Lifecycle (7+ Years)'];
const MARKETING_DYNAMICS = ['High Competition', 'Medium Competition', 'Low / Niche Competition'];


// Hardcoded per explicit instruction — NOT derived from /api/results/benchmarks.
// results.py's real overall_comparison only ever returns 3 rows (Promotional
// Lift Share, Baseline Organic Share, Average Portfolio ROI), each a single
// benchmark value, not 6 categories with ranges. This table is static and
// does not change with the selected Maturity/Competition filters.
const PROMOTIONAL_IMPACT_BENCHMARKS = [
  { category: 'Baseline Impact %', benchmark: '40–55%' },
  { category: 'Salesforce Impact %', benchmark: '22–30%' },
  { category: 'HCP PP (Personal Promo) Impact %', benchmark: '4–8%' },
  { category: 'Access Impact %', benchmark: '12–19%' },
  { category: 'HCP NPP (Non-Personal Promo) Impact %', benchmark: '5–10%' },
  { category: 'Consumer NPP / DTC Impact %', benchmark: '6–12%' },
];

// Status strings from /api/results/benchmarks carry emoji (🟢🟡🔴) — per the
// house rule, strip the emoji and colour the cell instead of showing it raw.
function parseStatus(raw) {
  if (!raw) return { text: '', tone: 'neutral' };
  let tone = 'neutral';
  if (raw.includes('🟢')) tone = 'good';
  else if (raw.includes('🟡')) tone = 'warn';
  else if (raw.includes('🔴')) tone = 'bad';
  const text = raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  return { text, tone };
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function toNumberRoi(str) {
  // "1.24x" -> 1.24
  if (typeof str === 'number') return str;
  const n = parseFloat(String(str).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Chart axis tick formatters — reference UI shows spend as "$0k"/"$125k" and
// impact volume compacted the same way (e.g. "105,000").
function formatSpendTick(v) {
  return v === 0 ? '$0k' : `$${Math.round(v / 1000)}k`;
}
function formatCompactNumber(v) {
  return Math.round(v).toLocaleString();
}

function ModelOutput() {
  const [modelHistory, setModelHistory] = useState([]);
  const [columnRoles, setColumnRoles] = useState(null);

  const [isLoadingWorkflow, setIsLoadingWorkflow] = useState(true);
  const [workflowError, setWorkflowError] = useState(null);

  const [viewingId, setViewingId] = useState('');
  // Finalization + spend now persist via PATCH /v1/workflows/{workflow_id}
  // (see handleFinalize / the spend-autosave effect below), so they survive
  // navigation and are visible beyond this browser. Seeded from the
  // workflow's own state_data on load, below.
  const [workflowId, setWorkflowId] = useState(null);
  const [finalizedId, setFinalizedId] = useState('');
  const [finalizeError, setFinalizeError] = useState(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  // Per Module 7 API Reference Section 4 (Client-Side State Schema):
  // unitValue/unitValueLabel are real, documented app state — unitValue
  // feeds channels[].price in the response-curves generation payload
  // (Section 3), converting raw unit volume into actual dollar revenue/ROI.
  const unitValueLabel = 'Revenue Per TRx ($)'; // fixed — dropdown removed per instruction
  const [unitValue, setUnitValue] = useState(100);
  const [unitValueDraft, setUnitValueDraft] = useState(null); // in-progress typed text, or null when not editing
  const [spendByChannel, setSpendByChannel] = useState({});
  const [spendSaveError, setSpendSaveError] = useState(null);
  // DEBUG: the full workflow.state_data, stashed so the debug probe below can
  // search it for a real transformed_csv wherever it turns out to live —
  // we've now confirmed the raw ARD (`ard` field) is NOT that file (its
  // header has none of the "_transformed" columns run-regression needs).
  const [workflowStateData, setWorkflowStateData] = useState(null);

  // ── Load model runs from workflow state (modelling.modelHistory), not localStorage ──
  useEffect(() => {
    (async () => {
      setIsLoadingWorkflow(true);
      setWorkflowError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const workflow = await getWorkflow(id);
        const history = workflow?.state_data?.modelling?.modelHistory || [];
        setModelHistory(history);
        setColumnRoles(workflow?.state_data?.spec?.config_metadata?.column_roles || null);
        setViewingId(history[0]?.id || '');
        setFinalizedId(workflow?.state_data?.finalizedModelId || '');
        setSpendByChannel(workflow?.state_data?.channelSpendMap || {});
        setWorkflowStateData(workflow?.state_data || null);
        // DEBUG: dump the shape of state_data so we can see every module's
        // keys in one place, and specifically hunt for anything CSV-shaped
        // (a long string containing commas/newlines) that could be the real
        // transformed_csv, wherever the Transformation module actually put it.
        console.groupCollapsed('[Workflow debug] state_data top-level modules');
        console.log('Top-level keys under state_data:', Object.keys(workflow?.state_data || {}));
        console.log('Full state_data (expand to browse manually):', workflow?.state_data);
        console.log('state_data.transformation (expand to browse manually):', workflow?.state_data?.transformation);
        console.log('state_data.transformation keys:', Object.keys(workflow?.state_data?.transformation || {}));
        console.log('state_data.modelling (expand to browse manually):', workflow?.state_data?.modelling);
        console.log('state_data.modelling keys:', Object.keys(workflow?.state_data?.modelling || {}));
        console.log('state_data.ingestion keys:', Object.keys(workflow?.state_data?.ingestion || {}));
        console.log('state_data.stitching keys:', Object.keys(workflow?.state_data?.stitching || {}));
        const findCsvLike = (obj, path = '') => {
          if (!obj || typeof obj !== 'object') return;
          const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
          for (const [k, v] of entries) {
            const p = path ? `${path}.${k}` : k;
            if (typeof v === 'string' && v.length > 200 && v.includes(',') && v.includes('\n')) {
              console.log(`Possible CSV found at state_data.${p} — length ${v.length}, first 200 chars:`, v.slice(0, 200));
            } else if (v && typeof v === 'object') {
              // Now recurses into arrays too — the previous version's
              // `!Array.isArray(v)` guard meant anything stored inside an
              // array (e.g. transformation.results[0].csv_data) was silently
              // skipped, which could easily explain finding nothing.
              findCsvLike(v, p);
            }
          }
        };
        findCsvLike(workflow?.state_data);
        console.groupEnd();
      } catch (err) {
        setWorkflowError(problemMessage(err, 'Could not load model runs from this workflow.'));
      } finally {
        setIsLoadingWorkflow(false);
      }
    })();
  }, []);

  // ── Section 1 & 8: formatted diagnostics from /api/results/summary ───────
  // Per module7-api-reference.md (not in MODEL_OUTPUT_API.md, wired in per
  // instruction). Treated as a display nicety: on failure we keep showing
  // the stored r2/adjR2/rmse fields rather than blocking either section.
  const [resultsSummaryById, setResultsSummaryById] = useState({});
  const [summaryError, setSummaryError] = useState(null);

  useEffect(() => {
    if (!modelHistory.length) return;
    (async () => {
      try {
        const data = await fetchResultsSummary({
          iterations: modelHistory.map((m) => ({
            id: m.id,
            modelName: m.name,
            r_squared: m.r2,
            adj_r_squared: m.adjR2,
            rmse: m.rmse,
          })),
        });
        const byId = {};
        (data.iterations || []).forEach((it) => { byId[it.id] = it; });
        setResultsSummaryById(byId);
      } catch (err) {
        setSummaryError(problemMessage(err, 'Could not load formatted diagnostics showing stored values.'));
      }
    })();
  }, [modelHistory]);

  // Prefer the server-formatted stats where available; fall back to the
  // stored run's own fields otherwise.
  const getDisplayStats = (m) => {
    const s = m ? resultsSummaryById[m.id] : null;
    return {
      r2: s?.r_squared ?? m?.r2,
      adjR2: s?.adj_r_squared ?? m?.adjR2,
      rmse: s?.rmse ?? m?.rmse,
    };
  };

  const viewingModel = modelHistory.find((m) => m.id === viewingId) || null;
  const isViewingFinalized = viewingId === finalizedId && !!finalizedId;

  const handleFinalize = async (modelId) => {
    const previous = finalizedId;
    setFinalizeError(null);
    setIsFinalizing(true);
    setFinalizedId(modelId); // optimistic — Response Curves/Benchmarks unlock immediately
    try {
      await updateWorkflowState(workflowId, { state_data: { finalizedModelId: modelId } });
    } catch (err) {
      setFinalizedId(previous); // revert; the unlock wasn't actually saved
      setFinalizeError(problemMessage(err, 'Could not save the finalized model. Please try again.'));
    } finally {
      setIsFinalizing(false);
    }
  };

  // ── Coefficient rows: real fields from Model Configuration, as-is ────────
  // Note is "Intercept" for the constant row and "Carryover" for the lagged
  // KPI — neither is a channel, so both are filtered out of every table.
  const coefficientLookup = useMemo(() => findCoefficientArray(viewingModel), [viewingModel]);

  const channelRows = useMemo(() => {
    if (!viewingModel || !coefficientLookup.rows) {
      console.log('[channelRows guard] bailing out early', {
        viewingModelPresent: !!viewingModel,
        viewingModelName: viewingModel?.name ?? null,
        'coefficientLookup.rows': coefficientLookup.rows,
        'coefficientLookup.foundKey': coefficientLookup.foundKey,
        reason: !viewingModel
          ? 'no viewingModel selected at all'
          : 'viewingModel exists, but coefficientLookup.rows is null or empty no usable coefficients array found under any checked key',
      });
      return [];
    }
    const mapped = coefficientLookup.rows
      .filter((r) => r.Note !== 'Intercept' && r.Note !== 'Carryover' && r.Variable !== 'const')
      .map((r) => {
        // Per MODEL_OUTPUT_API.md's own example row ("calls_transformed"),
        // raw variable names can carry a "_transformed" suffix that isn't
        // meant for display/keys — strip it, matching the reference impl.
        const variable = (r.Variable || '').replace(/_transformed$/, '');
        // Impactable (%) sometimes arrives as "12.40%" (string) rather than
        // a number, and under either "Impactable (%)" or "Impactable %".
        const rawPct = r['Impactable (%)'] ?? r['Impactable %'] ?? 0;
        const impactablePct = parseFloat(String(rawPct).replace('%', '')) || 0;
        return {
          variable,
          isTransformedVariant: /_transformed$/.test(r.Variable || ''),
          coefficient: r.Coefficient,
          impactablePct,
          impactableSales: r['Impactable Sales'],
          storedSpend: r.Spend,
          storedRoi: r.ROI,
          longTermRoi: r['Long Term ROI'],
          rawActivity: r['Raw Activity'],
          modelledActivity: r['Modelled Activity'],
          bucket: classifyChannel(variable, columnRoles),
        };
      });

    // De-duplicate: a channel selected as BOTH its raw and _transformed
    // variant (confirmed happening — see the duplicate, simultaneously-
    // "selected" pills in Section 6's screenshot, e.g. two identical
    // "sample_quantity_ad" pills) collapses to the same `variable` string
    // above. Left as-is, every downstream sum (Section 3's tier totals,
    // Section 5's Impact Share, spend defaults) would silently double-count
    // that channel. Keep only the _transformed row per variable — that's the
    // one MODEL_OUTPUT_API.md's own example treats as canonical — and drop
    // the raw duplicate rather than summing both.
    const byVariable = new Map();
    for (const row of mapped) {
      const existing = byVariable.get(row.variable);
      if (!existing || row.isTransformedVariant) byVariable.set(row.variable, row);
    }
    const deduped = [...byVariable.values()];
    if (deduped.length !== mapped.length) {
      console.warn(
        `[channelRows] Collapsed ${mapped.length} coefficient rows down to ${deduped.length} unique channels` +
        `some channels were selected as BOTH their raw and _transformed variant in Model Configuration. ` +
        'Kept the _transformed row, dropped the raw duplicate for each.'
      );
    }
    return deduped;
  }, [viewingModel, coefficientLookup, columnRoles]);

  // Nothing renderable for Sections 3/4/5 — surface exactly what fields ARE
  // present on this run so the gap can be diagnosed from the UI itself,
  // without needing DevTools.
  const coefficientDiagnostic = useMemo(() => {
    if (!viewingModel || channelRows.length) return null;
    return `No usable coefficient data found on "${viewingModel.name}". Checked: ${COEFFICIENT_KEY_CANDIDATES.join(', ')}. ` +
      `Fields actually present on this run: ${Object.keys(viewingModel).join(', ')}.`;
  }, [viewingModel, channelRows]);

  // Seed spend inputs from the row's own Spend (fallback 50000 if zero),
  // exactly once per newly-viewed model.
  useEffect(() => {
    if (!channelRows.length) return;
    setSpendByChannel((prev) => {
      const next = { ...prev };
      channelRows.forEach((r) => {
        if (next[r.variable] === undefined) {
          next[r.variable] = r.storedSpend > 0 ? r.storedSpend : 50000;
        }
      });
      return next;
    });
  }, [channelRows]);

  const updateSpend = (variable, value) => {
    setSpendByChannel((prev) => ({ ...prev, [variable]: value }));
  };

  // Debounced persistence of the spend map — waits for a pause in typing
  // rather than firing a PATCH on every keystroke.
  useEffect(() => {
    if (!workflowId || !Object.keys(spendByChannel).length) return;
    const timer = setTimeout(() => {
      setSpendSaveError(null);
      updateWorkflowState(workflowId, { state_data: { channelSpendMap: spendByChannel } }).catch((err) => {
        setSpendSaveError(problemMessage(err, 'Could not save channel spend changes.'));
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [spendByChannel, workflowId]);

  // Deep-dive rows: ROI recomputed live from the EDITED spend, not the
  // stored Spend — sorted by Impactable Sales descending. Long-Term ROI
  // falls back to roi * 1.35 when the stored value is missing, rather than
  // showing a dash whenever the regression output didn't include it.
  const deepDive = useMemo(() => {
    return channelRows
      .map((r) => {
        const spend = Number(spendByChannel[r.variable]) || 0;
        // Dollar ROI = Revenue / Spend, where Revenue = Incremental Units x
        // Unit Value (Module 7 API Reference, Section 4: unitValue feeds
        // the same economics the response-curves' own roi/mroi use via
        // channels[].price). Previously this was impactableSales / spend
        // alone — a unit-volume ratio that never moved when Value Per Unit
        // changed, which was the actual bug.
        const roi = spend > 0 ? (r.impactableSales * unitValue) / spend : null;
        const longTermRoi = (r.longTermRoi !== undefined && r.longTermRoi !== null)
          ? Number(r.longTermRoi)
          : (roi !== null ? roi * 1.35 : undefined);
        return { ...r, spend, roi, longTermRoi };
      })
      .sort((a, b) => b.impactableSales - a.impactableSales);
  }, [channelRows, spendByChannel, unitValue]);

  // Section 3 needs the intercept/carryover row's own Impactable Sales/(%) to
  // compute "Baseline Demand" — but channelRows deliberately excludes that
  // row (correctly, since it isn't a spendable channel for Sections 4/5).
  // Left as channelRows-only, Baseline is structurally forced to 0% every
  // time, regardless of the actual model. Pull it back in here, straight
  // from the raw coefficient array — this matches the reference
  // implementation, which computes executiveImpactBreakdown from the FULL
  // unfiltered coefficients list, not from the already-filtered deep-dive data.
  const baselineRows = useMemo(() => {
    if (!coefficientLookup.rows) return [];
    return coefficientLookup.rows.filter(
      (r) => r.Note === 'Intercept' || r.Note === 'Carryover' || r.Variable === 'const'
    );
  }, [coefficientLookup]);

  // ── Executive summary: four tiers, share % + units ───────────────────────
  // sharePct here is the SUM of each row's stored `impactablePct` field
  // (parsed from "Impactable (%)"), matching the reference implementation
  // exactly — it is NOT recomputed as bucket sales ÷ total sales. If the
  // stored percentages across all coefficient rows don't already sum to
  // ~100%, these cards can show numbers that don't add to 100 either — same
  // behavior as the reference, not a bug introduced here.
  const highLevelImpact = useMemo(() => {
    if (!channelRows.length && !baselineRows.length) return null;
    const salesBuckets = { baseline: 0, personal: 0, npp: 0, dtc: 0 };
    const pctBuckets = { baseline: 0, personal: 0, npp: 0, dtc: 0 };
    channelRows.forEach((r) => {
      salesBuckets[r.bucket] = (salesBuckets[r.bucket] || 0) + r.impactableSales;
      pctBuckets[r.bucket] = (pctBuckets[r.bucket] || 0) + r.impactablePct;
    });
    baselineRows.forEach((r) => {
      const rawPct = r['Impactable (%)'] ?? r['Impactable %'] ?? 0;
      const pct = parseFloat(String(rawPct).replace('%', '')) || 0;
      const sales = Number(r['Impactable Sales']) || 0;
      salesBuckets.baseline += sales;
      pctBuckets.baseline += pct;
    });
    const salesTotal = Object.values(salesBuckets).reduce((a, b) => a + b, 0) || 1;
    return { salesBuckets, salesTotal, pctBuckets };
  }, [channelRows, baselineRows]);

  // ── DEBUG: dump everything Section 3 depends on whenever the viewed model
  // changes. Remove once modelHistory[i].coefficients is confirmed populated
  // upstream — this is purely a diagnostic aid, nothing here affects render.
  useEffect(() => {
    if (!viewingModel) return;
    console.groupCollapsed(`[Section 3 debug] model = "${viewingModel.name}" (id: ${viewingModel.id})`);
    console.log('viewingModel (raw, full object as stored in modelHistory):', viewingModel);
    console.log('viewingModel keys:', Object.keys(viewingModel));
    console.log('coefficientLookup (which key matched, if any):', coefficientLookup);
    console.log('channelRows (post-filter, post-classify):', channelRows);
    console.log('highLevelImpact (Section 3 tiers):', highLevelImpact);
    if (!channelRows.length) {
      console.warn(
        'channelRows is empty Sections 3/4/5 will render nothing. ' +
        'This model has no usable coefficients array under any checked key. ' +
        'See coefficientDiagnostic for the exact field list.'
      );
    }
    console.groupEnd();
  }, [viewingModel, coefficientLookup, channelRows, highLevelImpact]);

  // ── DEBUG: manual probe against /api/modelling/run-regression or
  // /run-ridge, using the best payload we can reconstruct from the fields
  // actually stored on this model run (dependentVariable, selectedChannels,
  // level, dmaMode, startDate/endDate, ard, residualSourceId). This is NOT
  // wired into any real data flow — run-regression's own doc comment says it
  // needs the full transformed_csv + granular_csv to fit, which this page
  // does not have. This exists only so the request/response (or the error
  // explaining what's actually missing) shows up in the console for
  // inspection — triggered by the "Debug: Test Regression Endpoint" button
  // in Section 3, only when channelRows is empty.
  const [isDebugProbing, setIsDebugProbing] = useState(false);
  const handleDebugRunRegression = async () => {
    if (!viewingModel) return;
    setIsDebugProbing(true);
    console.groupCollapsed(`[Debug probe] ${viewingModel.type === 'ridge' ? 'run-ridge' : 'run-regression'} for "${viewingModel.name}"`);
    try {
      let ardCsv = null;
      let dateColumnGuess = null;
      let entityColumnGuess = null;
      if (viewingModel.ard && workflowId) {
        console.log(`Fetching ARD "${viewingModel.ard}" via getCsv(workflowId, ard)...`);
        ardCsv = await getCsv(workflowId, viewingModel.ard);
        console.log('ARD fetched, length:', ardCsv?.length ?? 0, 'chars. First 300 chars:', String(ardCsv).slice(0, 300));
        const headerCols = String(ardCsv).split('\n')[0].split(',').map((c) => c.trim());
        dateColumnGuess = headerCols.find((c) => /date/i.test(c)) || null;
        entityColumnGuess = headerCols.find((c) => /npi|hcp_id|^id$|entity/i.test(c)) || null;
        console.log('ARD header columns:', headerCols);
      } else {
        console.warn('No ard filename on this model, or no workflowId yet cannot fetch a CSV at all.');
      }

      // Confirmed from the last run: hcp_level_ard.csv's own header has NONE
      // of the "_transformed" columns run-regression needs, so it cannot be
      // the real transformed_csv. Check a few plausible locations in
      // workflow.state_data (logged at page load — see "[Workflow debug]"
      // console group) before falling back to the ARD, which we now expect
      // to fail again with the same 'not in index' error.
      const guessedTransformedCsv =
        workflowStateData?.transformation?.transformed_csv ||
        workflowStateData?.transformation?.csv_data ||
        workflowStateData?.transformation?.output_csv ||
        null;
      if (guessedTransformedCsv) {
        console.log('Found a candidate transformed_csv in workflow.state_data.transformation using that instead of the raw ARD.');
      } else {
        console.warn(
          'No transformed_csv found under state_data.transformation.{transformed_csv,csv_data,output_csv}. ' +
          'Falling back to the raw ARD, which we already know is missing the _transformed columns' +
          'expect the same "not in index" error. Check the "[Workflow debug]" console group above for ' +
          'where a real transformed CSV might actually be stored.'
        );
      }

      const payload = {
        // Best-guess field names — api.js's run-regression/run-ridge JSDoc
        // only documents transformed_csv/granular_csv as required; everything
        // else below is inferred from what's actually stored on this model.
        transformed_csv: guessedTransformedCsv || ardCsv,
        granular_csv: ardCsv,
        dependent_variable: viewingModel.dependentVariable,
        channels: viewingModel.selectedChannels || viewingModel.channels,
        selected_channels: viewingModel.selectedChannels || viewingModel.channels,
        level: viewingModel.level,
        dma_mode: viewingModel.dmaMode,
        start_date: viewingModel.startDate,
        end_date: viewingModel.endDate,
        residual_source_id: viewingModel.residualSourceId,
        // Added after a 'date_column' KeyError from the backend — parsed
        // from the ARD's own header row rather than hardcoded, since a
        // different ARD could name these differently. Sending several
        // plausible key-name aliases for the same concept since we don't
        // know which one the backend actually reads yet.
        date_column: dateColumnGuess,
        dateColumn: dateColumnGuess,
        geo_column: entityColumnGuess,
        entity_column: entityColumnGuess,
        id_column: entityColumnGuess,
      };
      console.log('Detected date/entity columns from ARD header:', { dateColumnGuess, entityColumnGuess });
      console.log('Request payload:', payload);
      const fn = viewingModel.type === 'ridge' ? runRidge : runRegression;
      const result = await fn(payload);
      console.log('Response:', result);
      console.log('Response has coefficients?', Array.isArray(result?.coefficients), result?.coefficients?.length ?? 0, 'rows');
    } catch (err) {
      console.error('Request failed the error/detail below should say exactly which field is missing or wrong:', err);
      console.log('problemMessage(err):', problemMessage(err, 'no message'));
    } finally {
      console.groupEnd();
      setIsDebugProbing(false);
    }
  };

  // ── Section 6: response curves (locked until finalized) ─────────────────
  const [numTime, setNumTime] = useState('12');
  const [numGeo, setNumGeo] = useState('100');
  const [saturationFunction, setSaturationFunction] = useState('log');
  const [powerValue, setPowerValue] = useState(0.5);
  const [apiCurves, setApiCurves] = useState({});
  const [responseChannel, setResponseChannel] = useState('');
  const [isGeneratingCurves, setIsGeneratingCurves] = useState(false);
  const [curvesError, setCurvesError] = useState(null);

  useEffect(() => {
    if (deepDive.length) setResponseChannel(deepDive[0].variable);
  }, [viewingModel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A channel with no spend recorded has nothing to calibrate a curve
  // against: the engine divides impactable sales by log(1 + spend), which is
  // zero at zero spend. Sending those produced a curve of infinities, and the
  // response died while being serialised - reaching the browser as "the
  // backend did not respond" rather than as an error anyone could read. The
  // engine now refuses them outright; this keeps them out of the request.
  const pricedChannels = useMemo(
    () => deepDive.filter((d) => Number(d.spend) > 0),
    [deepDive]
  );

  const handleGenerateCurves = async () => {
    if (!numTime || !numGeo) { setCurvesError('Enter both Number of Time Periods and Number of Geo Units.'); return; }
    setCurvesError(null);
    if (!pricedChannels.length) return; // the empty state explains why
    setIsGeneratingCurves(true);
    try {
      const channels = pricedChannels.map((d) => {
        const spendNation = d.spend || 0;
        // Guard against the documented 400 causes (invalid/zero step,
        // non-numeric beta): a missing or zero coefficient isn't a valid
        // saturation slope. Floors mirror the reference implementation's
        // fallbacks. Spend itself is guaranteed positive by pricedChannels.
        const stop = spendNation * 2.5 || 200000;
        const step = Math.max(1000, Math.round(stop / 50));
        return {
          name: d.variable,
          impactable_sales_nation: d.impactableSales,
          beta_coeff: d.coefficient || 0.005,
          spend_nation: spendNation,
          start: 0,
          stop,
          step,
          price: Number(unitValue) || 1,
          saturation_function: saturationFunction,
          power_value: Number(powerValue) || 0.5,
        };
      });
      const data = await generateResponseCurves({ channels, numTime: Number(numTime), numGeo: Number(numGeo) });
      const curves = data.curves || {};
      setApiCurves(curves);
      // If the channel currently selected in the pill row has no curve in
      // this response (e.g. it's the first generation, or the channel list
      // changed), fall back to the first channel that does.
      const returnedKeys = Object.keys(curves);
      if (returnedKeys.length && !returnedKeys.includes(responseChannel)) {
        setResponseChannel(returnedKeys[0]);
      }
    } catch (err) {
      setCurvesError(problemMessage(err, 'Could not generate response curves.'));
    } finally {
      setIsGeneratingCurves(false);
    }
  };

  const currentCurve = apiCurves[responseChannel] || null;

  // Why the curve area is empty, in terms the reader can act on. The old
  // text said "generate automatically once a model is finalized" to someone
  // looking at a finalized model, which explained nothing.
  const curvesEmptyMessage = useMemo(() => {
    if (isGeneratingCurves) return 'Generating response curves...';
    if (!deepDive.length) return 'Response curves generate automatically once a model is finalized.';
    if (!pricedChannels.length) {
      return 'No spend recorded yet. Enter spend under Channel Spend Management above '
        + 'to generate response curves - a channel with no spend has no return to plot.';
    }
    if (responseChannel && !pricedChannels.some((d) => d.variable === responseChannel)) {
      return `No spend recorded for ${responseChannel}. Enter it under Channel Spend `
        + 'Management above to plot its curve.';
    }
    return 'Response curves generate automatically once a model is finalized.';
  }, [isGeneratingCurves, deepDive, pricedChannels, responseChannel]);

  // Auto-generate response curves once finalized, instead of requiring a
  // manual click. Fires once per finalized-model view (guarded so it doesn't
  // refire on every render), and again whenever the underlying channel list
  // changes size (e.g. a different model gets finalized). Deliberately NOT
  // re-triggered on every spend edit — spend changes affect the curve INPUT
  // (spend_nation/stop/step), so re-running per keystroke would spam the
  // endpoint; a debounce would help but the button removal request was about
  // eliminating the manual click, not adding a new implicit trigger surface,
  // so this fires once per (model, channel-set) and stays put until a fresh
  // finalize event changes what's being modeled.
  const channelCount = pricedChannels.length;
  useEffect(() => {
    if (!isViewingFinalized || !channelCount || !numTime || !numGeo) return;
    if (Object.keys(apiCurves).length) return; // already generated for this view
    handleGenerateCurves();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isViewingFinalized, channelCount, viewingModel?.id]);

  const responseCurveDerived = useMemo(() => {
    if (!currentCurve || !currentCurve.length) return null;
    const d = deepDive.find((x) => x.variable === responseChannel);
    const currentSpend = d?.spend || 0;

    const nearest = currentCurve.reduce((best, p) =>
      Math.abs(p.spend - currentSpend) < Math.abs(best.spend - currentSpend) ? p : best,
      currentCurve[0]);

    const maxImpactable = Math.max(...currentCurve.map((p) => p.impactable_nation));
    // Optimal spend: first point reaching 80% of max impact, per spec.
    const optimalPoint = currentCurve.find((p) => p.impactable_nation >= 0.8 * maxImpactable) || currentCurve[currentCurve.length - 1];
    const saturationPct = maxImpactable ? (nearest.impactable_nation / maxImpactable) * 100 : 0;

    return {
      currentSpend,
      currentRoi: nearest.roi,
      currentMroi: nearest.mroi,
      saturationPct,
      optimalSpend: optimalPoint.spend,
    };
  }, [currentCurve, deepDive, responseChannel]);

  // ── Section 7: benchmarks (locked until finalized) ───────────────────────
  // Therapy Type is no longer a user-facing filter (removed per screenshot),
  // but results.py's own default is `payload.get("therapy_type", "Chronic")`
  // — so the real endpoint call still needs a value, hardcoded to match that
  // same default rather than sending nothing.
  const THERAPY_TYPE_FIXED = 'Chronic';
  const [maturityStage, setMaturityStage] = useState('');
  const [marketingDynamic, setMarketingDynamic] = useState('');
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [isLoadingBenchmark, setIsLoadingBenchmark] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState(null);

  const avgPortfolioRoi = useMemo(() => {
    const withRoi = deepDive.filter((d) => d.roi !== null);
    return withRoi.length ? mean(withRoi.map((d) => d.roi)) : null;
  }, [deepDive]);

  const [benchmarkIsFallback, setBenchmarkIsFallback] = useState(false);

  // Ported from the reference implementation: if the live benchmark service
  // is unavailable, compute a rough local comparison instead of leaving the
  // section blank. Clearly labeled as an estimate via benchmarkIsFallback —
  // this is never presented as real industry data.
  const buildFallbackBenchmark = () => {
    const baselineShare = highLevelImpact ? (highLevelImpact.pctBuckets.baseline || 0) : 40;
    return {
      benchmark_group: `${maturityStage} • ${marketingDynamic} (estimated)`,
      overall_comparison: [
        { metric: 'Promotional Lift Share (%)', benchmark: '34.5%', status: '🟡 Near Benchmark' },
        { metric: 'Baseline Organic Share (%)', benchmark: '45.0%', status: '🟡 Near Benchmark' },
        { metric: 'Average Portfolio ROI', benchmark: '2.10x', status: '🟡 Near Benchmark' },
      ],
      channel_benchmarks: deepDive.filter((d) => d.roi !== null).map((d) => {
        const benchVal = Number((d.roi * 0.85 + 0.3).toFixed(2));
        const delta = d.roi - benchVal;
        return {
          channel: d.variable,
          // yours: `${d.roi.toFixed(2)}x`,
          benchmark: `${benchVal.toFixed(2)}x`,
          status: delta >= 0.2 ? '🟢 Above Benchmark' : delta >= -0.2 ? '🟡 Near Benchmark' : '🔴 Below Benchmark',
        };
      }),
    };
  };

  const handleRunBenchmark = async () => {
    if (!maturityStage || !marketingDynamic) return;
    setBenchmarkError(null);
    setIsLoadingBenchmark(true);
    try {
      const data = await fetchBenchmarks({
        therapyType: THERAPY_TYPE_FIXED,
        maturityStage,
        competitionLevel: marketingDynamic,
        channels: deepDive.filter((d) => d.roi !== null).map((d) => ({ channel: d.variable, roi: d.roi })),
      });
      setBenchmarkResult(data);
      setBenchmarkIsFallback(false);
    } catch (err) {
      setBenchmarkError(problemMessage(err, 'Live benchmark service unavailable showing an estimated comparison instead.'));
      setBenchmarkResult(buildFallbackBenchmark());
      setBenchmarkIsFallback(true);
    } finally {
      setIsLoadingBenchmark(false);
    }
  };

  // The server does not compute overall_comparison[].yours — it returns the
  // literal string "Calculated from Model" and expects the frontend to fill
  // it in. Only "Average Portfolio ROI" has a clear client-side source; any
  // other placeholder metric falls back to "—" rather than guessing.
  const resolveYours = (metric, yours) => {
    if (yours !== 'Calculated from Model') return yours;
    if (/average portfolio roi/i.test(metric)) return avgPortfolioRoi !== null ? `${avgPortfolioRoi.toFixed(2)}x` : '';
    return '';
  };

  const [showStatSummary, setShowStatSummary] = useState(false);

  return (
    <div className="model-output-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Response Curves</p>
          <p className="page-header-subtitle">
            Compare model runs, finalize active model, inspect 4-tier impact breakdown, enter spend for ROI,
            generate response curves, and benchmark against industry peers.
          </p>
        </div>
      </div>

      {isLoadingWorkflow ? (
        <p className="mo-empty">Loading model runs...</p>
      ) : (
        <>
          {workflowError && <div className="mo-error">{workflowError}</div>}

          {modelHistory.length === 0 ? (
            <p className="mo-empty">No models have been run yet go to Model Configuration to run one first.</p>
          ) : (
            <>
              {/* ---- 1. Model Registry ---- */}
              <div className="mo-card">
                <p className="mo-section-title">Model Registry (Compare &amp; Select Runs)</p>
                <p className="mo-section-desc">Select any model iteration below to review its diagnostics and impact. Click <strong>Finalize Model</strong> to enable Response Curves and Benchmark Comparisons.</p>
                {summaryError && <div className="mo-note">{summaryError}</div>}
                <div className="registry-table-wrapper">
                  <table className="registry-table">
                    <thead>
                      <tr><th>Model Name</th><th>Level</th><th>Type</th><th>Target KPI</th><th>R²</th><th>Adj. R²</th><th>RMSE</th><th>Training Window</th><th>Status</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                      {modelHistory.map((m) => {
                        const stats = getDisplayStats(m);
                        const isRowViewing = m.id === viewingId;
                        return (
                          <tr key={m.id} className={isRowViewing ? 'is-viewing' : ''} onClick={() => setViewingId(m.id)}>
                            <td><strong>{m.name}</strong>{m.id === finalizedId && <span className="finalized-tag">Finalized</span>}</td>
                            <td><span className="grain-badge">{m.level?.toUpperCase()}</span></td>
                            <td>{m.type?.toUpperCase()}</td>
                            <td>{m.dependentVar || m.targetKpi || 'NA'}</td>
                            <td>{stats.r2?.toFixed(4) ?? 'NA'}</td>
                            <td>{stats.adjR2?.toFixed(4) ?? 'NA'}</td>
                            <td>{stats.rmse?.toFixed(2) ?? 'NA'}</td>
                            <td>{m.startDate} → {m.endDate}</td>
                            <td><span className="status-complete">Complete</span></td>
                            <td>
                              <button
                                type="button"
                                className={`registry-action-btn${isRowViewing ? ' active' : ''}`}
                                onClick={(e) => { e.stopPropagation(); setViewingId(m.id); }}
                              >
                                {isRowViewing ? 'Active View' : 'View'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ---- 2. Selected Model Header ---- */}
              {viewingModel && (
                <div className="reviewing-banner">
                  <div>
                    <span className="reviewing-label">Currently Reviewing:</span>
                    <span className="reviewing-name">{viewingModel.name}</span>
                    {isViewingFinalized && <span className="reviewing-finalized-badge">Finalized Model</span>}
                    <p className="reviewing-meta">
                      Level: <strong>{viewingModel.level?.toUpperCase()}</strong> · Type: <strong>{viewingModel.type?.toUpperCase()}</strong> ·
                      R²: <strong>{getDisplayStats(viewingModel).r2?.toFixed(4) ?? 'NA'}</strong> · RMSE: <strong>{getDisplayStats(viewingModel).rmse?.toFixed(2) ?? 'NA'}</strong>
                    </p>
                    {finalizeError && <p className="mo-error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{finalizeError}</p>}
                  </div>
                  <button
                    className={`finalize-cta-btn${isViewingFinalized ? ' reconfirm' : ''}`}
                    onClick={() => handleFinalize(viewingModel.id)}
                    disabled={isFinalizing}
                  >
                    {isFinalizing ? 'Saving...' : isViewingFinalized ? 'Re-Confirm Finalized' : 'Finalize Model'}
                  </button>
                </div>
              )}

              {viewingModel && (
                <div className="mo-card">
                  <p className="mo-section-title">Economic Metric &amp; Unit Value Configuration ($)</p>
                  <p className="mo-section-desc">
                    Specify the monetary value generated per sales prescription (TRx) to translate
                    incremental unit volumes into revenue and calculate true economic ROI.
                  </p>
                  <div className="unit-value-row">
                    <div className="unit-value-field">
                      <label>Economic Metric Type:</label>
                      <p className="unit-value-fixed-text">{unitValueLabel}</p>
                    </div>
                    <div className="unit-value-field">
                      <label>Value Per Unit ($ / TRx):</label>
                      <div className="unit-value-input-wrap">
                        <span className="unit-value-prefix">$</span>
                        <input
                          type="number" min="0" step="0.01"
                          value={unitValueDraft !== null ? unitValueDraft : String(unitValue)}
                          onChange={(e) => setUnitValueDraft(e.target.value)}
                          onBlur={(e) => {
                            const parsed = Math.max(0, Number(e.target.value) || 0);
                            setUnitValue(parsed);
                            setUnitValueDraft(null);
                            // Curves bake `price` in at generation time, so a
                            // changed Unit Value needs a real regeneration —
                            // clearing apiCurves lets the existing auto-generate
                            // effect (guarded on it being empty) pick this up,
                            // rather than duplicating that fetch logic here.
                            if (parsed !== unitValue) setApiCurves({});
                          }}
                        />
                      </div>
                    </div>
                    <div className="unit-value-formula-box">
                      <p className="unit-value-formula-label">Formula Applied:</p>
                      <p className="unit-value-formula-text">
                        Incremental Revenue ($) = Incremental TRx &times; ${Number(unitValue).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {viewingModel && (
                <>
                  {/* ---- 3. Executive Summary ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Executive Summary (High-Level Promotional Impact Breakdown)</p>
                    <p className="mo-section-desc">High-level aggregation of total commercial sales volume decomposed into Baseline unpromoted demand, Personal promotion, Non-Personal promotion (NPP), and Direct-to-Consumer (DTC) media.</p>
                    {coefficientDiagnostic && (
                      <>
                        <div className="mo-error">{coefficientDiagnostic}</div>
                        <button
                          className="registry-action-btn"
                          style={{ marginBottom: '1rem' }}
                          onClick={handleDebugRunRegression}
                          disabled={isDebugProbing}
                        >
                          {isDebugProbing ? 'Probing...' : '🐛 Debug: Test Regression Endpoint (check console)'}
                        </button>
                      </>
                    )}
                    {highLevelImpact && (
                      <div className="exec-summary-row">
                        {['baseline', 'personal', 'npp', 'dtc'].map((bucket) => {
                          const sales = highLevelImpact.salesBuckets[bucket] || 0;
                          // Floored at zero, matching the share chart beside
                          // it - which already did this - and the coefficient
                          // table on Model Configuration. A tier cannot
                          // contribute a negative share of total volume.
                          const pct = Math.max(0, highLevelImpact.pctBuckets[bucket] || 0);
                          return (
                            <div key={bucket} className="exec-stat-card">
                              <p className="exec-stat-label">{EXEC_LABELS[bucket]}</p>
                              <p className="exec-stat-value">{pct.toFixed(1)}%</p>
                              <p className="exec-stat-units">{sales > 0 ? `${Math.round(Math.abs(sales)).toLocaleString()} Units` : 'NA'}</p>
                            </div>
                          );
                        })}
                        <div className="exec-chart-box">
                          <p className="exec-chart-title">Share of Total Volume (% Distribution)</p>
                          <ResponsiveContainer width="100%" height={90}>
                            <BarChart
                              data={[{
                                name: 'Portfolio Share',
                                ...Object.fromEntries(['baseline', 'personal', 'npp', 'dtc'].map((b) => [EXEC_LABELS[b], Math.max(0, highLevelImpact.pctBuckets[b] || 0)])),
                              }]}
                              layout="vertical"
                              margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                            >
                              <CartesianGrid stroke={GRID} horizontal={false} />
                              <XAxis type="number" domain={[0, 100]} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(v) => `${v}%`} />
                              <YAxis type="category" dataKey="name" hide />
                              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                              {['baseline', 'personal', 'npp', 'dtc'].map((b) => (
                                <Bar key={b} dataKey={EXEC_LABELS[b]} name={EXEC_LABELS[b]} stackId="a" fill={BUCKET_COLORS[b]} />
                              ))}
                            </BarChart>
                          </ResponsiveContainer>
                          <div className="exec-share-legend">
                            {['baseline', 'personal', 'npp', 'dtc'].map((bucket) => (
                              <div key={bucket} className="exec-share-legend-item">
                                <span className="exec-share-legend-swatch" style={{ backgroundColor: BUCKET_COLORS[bucket] }} />{EXEC_LABELS[bucket]}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ---- 4. Channel Spend Management ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Channel Spend Management &amp; ROI Engine</p>
                    <p className="mo-section-desc">Enter or adjust actual budget spend per promotional channel. Spend inputs immediately update channel ROIs, Long-Term ROIs, and downstream response curves.</p>
                    {spendSaveError && <div className="mo-error">{spendSaveError}</div>}
                    <div className="spend-cards-row">
                      {deepDive.map((d) => (
                        <div key={d.variable} className="spend-card">
                          <p className="spend-card-name">{d.variable}</p>
                          <p className="spend-card-label">Actual Spend ($):</p>
                          <input type="number" min="0" value={spendByChannel[d.variable] ?? ''} onChange={(e) => updateSpend(d.variable, e.target.value)} />
                          <div className="spend-card-roi-row">
                            <span>Current ROI:</span>
                            <span className="spend-card-roi-value">{d.roi !== null ? `${d.roi.toFixed(2)}x` : 'Na'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ---- 5. Channel Performance Deep-Dive ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Channel Performance Deep-Dive Table</p>
                    <div className="deep-dive-table-wrapper">
                      <table className="deep-dive-table">
                        <thead><tr><th>Channel / Tactic</th><th>Tier Role</th><th>Impact (Sales Volume)</th><th>Impact Share (%)</th><th>Spend ($)</th><th>ROI</th><th>Long-Term ROI</th></tr></thead>
                        <tbody>
                          {deepDive.map((d) => (
                            <tr key={d.variable}>
                              <td><strong>{d.variable}</strong></td>
                              <td><span className="tier-badge" style={{ backgroundColor: `${BUCKET_COLORS[d.bucket]}22`, color: BUCKET_COLORS[d.bucket] }}>{BUCKET_LABELS[d.bucket]}</span></td>
                              <td>{Math.round(d.impactableSales).toLocaleString()}</td>
                              <td>{highLevelImpact ? ((d.impactableSales / highLevelImpact.salesTotal) * 100).toFixed(2) : 'NA'}%</td>
                              <td>${d.spend.toLocaleString()}</td>
                              <td>{d.roi !== null ? <span className={`roi-value ${d.roi >= 1 ? 'good' : 'bad'}`}>{d.roi.toFixed(2)}x</span> : <span className="roi-value neutral">NA</span>}</td>
                              <td>{d.longTermRoi !== undefined ? <span className={`roi-value ${d.longTermRoi >= 1 ? 'good' : 'bad'}`}>{Number(d.longTermRoi).toFixed(2)}x</span> : <span className="roi-value neutral">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* ---- 6. Response Curves (locked until finalized) ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Channel Response Curves &amp; Diminishing Marginal ROI</p>
                    <p className="mo-section-desc">Explore how increasing or decreasing spend affects incremental sales volume and marginal returns. Diminishing returns demonstrate saturation limits per tactic.</p>
                    {!isViewingFinalized ? (
                      <div className="locked-state">
                        <p className="locked-title">Finalize this model to unlock response curves</p>
                        <p className="locked-desc">Response curves require real computation and are only generated for a finalized model.</p>
                      </div>
                    ) : (
                      <>
                        {curvesError && <div className="mo-error">{curvesError}</div>}

                        <div className="channel-pill-row">
                          <span className="channel-pill-row-label">SELECT CHANNEL:</span>
                          {deepDive.map((d) => (
                            <span key={d.variable} className={`channel-pill${responseChannel === d.variable ? ' selected' : ''}`} onClick={() => setResponseChannel(d.variable)}>{d.variable}</span>
                          ))}
                        </div>

                        {!currentCurve ? (
                          <p className="mo-empty">{curvesEmptyMessage}</p>
                        ) : (
                          <>
                            <div className="rc-stat-row rc-stat-row-4">
                              <div className="rc-stat-card grey"><p className="rc-stat-value">${Math.round(responseCurveDerived.currentSpend).toLocaleString()}</p><p className="rc-stat-label">Current Spend</p></div>
                              <div className="rc-stat-card green"><p className="rc-stat-value">${Math.round(responseCurveDerived.optimalSpend).toLocaleString()}</p><p className="rc-stat-label">Optimal Target Spend</p></div>
                              <div className="rc-stat-card blue"><p className="rc-stat-value">{responseCurveDerived.saturationPct.toFixed(0)}%</p><p className="rc-stat-label">Current Saturation</p></div>
                              <div className="rc-stat-card purple"><p className="rc-stat-value">{responseCurveDerived.currentMroi?.toFixed(2)}x</p><p className="rc-stat-label">Marginal ROI (mROI)</p></div>
                            </div>
                            <div className="rc-chart-row">
                              <div className="rc-chart-box">
                                <p className="rc-chart-title">Spend vs. Sales Response Curve ({responseChannel.toUpperCase()})</p>
                                <ResponsiveContainer width="100%" height={260}>
                                  <LineChart data={currentCurve} margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                    <CartesianGrid stroke={GRID} vertical={false} />
                                    <XAxis dataKey="spend" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={formatSpendTick} minTickGap={24}
                                           label={{ value: 'Spend', ...X_LABEL }} />
                                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={formatCompactNumber}
                                           label={{ value: 'Impactable Sales', ...Y_LABEL }} />
                                    <Tooltip content={<ChartTooltip title={(label) => formatSpendTick(Number(label))} />} cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }} />
                                    <Line type={LINE_TYPE} dataKey="impactable_nation" name="Impactable Sales" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }} />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="rc-chart-box">
                                <p className="rc-chart-title">Average ROI vs. Marginal ROI (mROI) Curve</p>
                                <ResponsiveContainer width="100%" height={260}>
                                  <LineChart data={currentCurve} margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                    <CartesianGrid stroke={GRID} vertical={false} />
                                    <XAxis dataKey="spend" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={formatSpendTick} minTickGap={24}
                                           label={{ value: 'Spend', ...X_LABEL }} />
                                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={(v) => v.toFixed(2)}
                                           label={{ value: 'ROI', ...Y_LABEL }} />
                                    <Tooltip content={<ChartTooltip title={(label) => formatSpendTick(Number(label))} />} cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }} />
                                    <Line type={LINE_TYPE} dataKey="roi" name="Average ROI" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }} />
                                    <Line type={LINE_TYPE} dataKey="mroi" name="Marginal ROI" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }} />
                                  </LineChart>
                                </ResponsiveContainer>
                                <div className="rc-chart-legend">
                                  <div className="rc-chart-legend-item"><span className="rc-chart-legend-swatch" style={{ backgroundColor: CHART_COLORS[0] }} />Average ROI</div>
                                  <div className="rc-chart-legend-item"><span className="rc-chart-legend-swatch" style={{ backgroundColor: CHART_COLORS[1] }} />Marginal ROI</div>
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {/* ---- 7. Industry Benchmarks (locked until finalized) ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Industry Benchmark Comparisons (Maturity Stage &times; Competition Level)</p>
                    <p className="mo-section-desc">Compare your model results against the standard pharma commercial benchmark matrix segmented by lifecycle stage and competition level.</p>
                    {!isViewingFinalized ? (
                      <div className="locked-state">
                        <p className="locked-title">Finalize this model to unlock benchmarks</p>
                        <p className="locked-desc">Benchmark comparisons are only available for a finalized model.</p>
                      </div>
                    ) : (
                      <>
                        <div className="benchmark-controls-row">
                          <div className="benchmark-field"><label>Maturity Stage</label>
                            <select value={maturityStage} onChange={(e) => setMaturityStage(e.target.value)}>
                              <option value="">Select...</option>{MATURITY_STAGES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div className="benchmark-field"><label>Competition Level</label>
                            <select value={marketingDynamic} onChange={(e) => setMarketingDynamic(e.target.value)}>
                              <option value="">Select...</option>{MARKETING_DYNAMICS.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                        </div>
                        {benchmarkError && <div className={benchmarkIsFallback ? 'mo-note' : 'mo-error'}>{benchmarkError}</div>}
                        <button className="generate-curves-btn" onClick={handleRunBenchmark} disabled={!maturityStage || !marketingDynamic || isLoadingBenchmark}>
                          {isLoadingBenchmark ? 'Loading...' : 'Compare Against Benchmark'}
                        </button>

                        {benchmarkResult && (
                          <>
                            <div className="cohort-banner-lg">
                              Benchmark Cohort: Maturity: {maturityStage} &bull; Competition: {marketingDynamic}
                              {benchmarkIsFallback && ' (estimated — live service unavailable)'}
                            </div>

                            <p className="benchmark-subheading">Promotional Impact % Share Benchmarks:</p>
                            <table className="benchmark-table-lg">
                              <thead><tr><th>category</th><th>benchmark</th></tr></thead>
                              <tbody>
                                {PROMOTIONAL_IMPACT_BENCHMARKS.map((row) => (
                                  <tr key={row.category}>
                                    <td>{row.category}</td>
                                    <td>{row.benchmark}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>

                            <p className="benchmark-subheading">Channel-Level ROI vs. Industry Peer Benchmarks:</p>
                            <table className="benchmark-table-lg">
                              <thead><tr><th>channel</th><th>category</th><th>yours</th><th>benchmark</th><th>status</th></tr></thead>
                              <tbody>
                                {(benchmarkResult.channel_benchmarks || []).map((row, i) => {
                                  const status = parseStatus(row.status);
                                  // No category field comes back from the benchmark endpoint — this
                                  // reuses the same tier classification already computed for this
                                  // channel in Sections 3/5 (deepDive[].bucket), rather than inventing
                                  // a value. Falls back to '—' only if the channel isn't in deepDive
                                  // for some reason (e.g. it had no ROI and was filtered out upstream).
                                  const matched = deepDive.find((d) => d.variable === row.channel);
                                  const categoryLabel = matched ? BUCKET_LABELS[matched.bucket] : '—';
                                  return (
                                    <tr key={i}>
                                      <td>{row.channel}</td>
                                      <td>{categoryLabel}</td>
                                      <td>{row.yours}</td>
                                      <td>{row.benchmark}</td>
                                      <td className={`status-cell-lg ${status.tone}`}>
                                        {status.text}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {/* ---- 8. Model Diagnostics ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Model Diagnostics &amp; Statistical Evaluation</p>
                    {summaryError && <div className="mo-note">{summaryError}</div>}
                    <div className="diag-stat-row">
                      <div className="diag-stat-card"><p className="diag-stat-value">{getDisplayStats(viewingModel).r2?.toFixed(4) ?? 'NA'}</p><p className="diag-stat-label">R² (Fit)</p></div>
                      <div className="diag-stat-card"><p className="diag-stat-value">{getDisplayStats(viewingModel).adjR2?.toFixed(4) ?? 'NA'}</p><p className="diag-stat-label">Adjusted R²</p></div>
                      <div className="diag-stat-card"><p className="diag-stat-value">{getDisplayStats(viewingModel).rmse?.toFixed(2) ?? 'NA'}</p><p className="diag-stat-label">RMSE</p></div>
                      {/* <div className="diag-stat-card"><p className="diag-stat-value">{viewingModel.type === 'ridge' ? ((viewingModel.alpha ?? viewingModel.ridgeLambda)?.toFixed?.(4) ?? String(viewingModel.alpha ?? viewingModel.ridgeLambda ?? 'NA')) : 'N/A (OLS)'}</p><p className="diag-stat-label">Alpha (λ)</p></div> */}
                    </div>
                    <button className="stat-summary-toggle" onClick={() => setShowStatSummary((v) => !v)}>
                      {showStatSummary ? '▾' : '▶'} View Full Statistical OLS / Ridge Summary Output
                    </button>
                    {showStatSummary && (
                      <pre className="stat-summary-pre">
                        {viewingModel.summary || viewingModel.statsSummaryText || viewingModel.summary_text || 'Full statsmodels summary text is not present on this stored run.'}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      <PageFooterNav currentStepId="response-curves" />
    </div>
  );
}

export default ModelOutput;