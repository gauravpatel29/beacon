import { useState, useEffect, useMemo } from 'react';
import {
  ensureWorkflow,
  getWorkflow,
  problemMessage,
} from '../../services/api.js';
import { generateResponseCurves, fetchBenchmarks, fetchResultsSummary, updateWorkflowState } from '../../services/modelOutputApi.js';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, LineChart, Line } from 'recharts';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import { AXIS_TICK, CHART_COLORS, GRID, LINE_TYPE, X_LABEL, Y_LABEL } from '../../components/charts/chartTheme.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import { formatRoi } from '../../services/formatRoi.js';
import { weightedSharePercents, weightFor } from '../../services/impactShare.js';
import './ModelOutput.css';

const ROLE_TO_BUCKET = {
  'Baseline Variables': 'baseline',
  'Cross-sectional Variable': 'baseline',
};

function classifyChannel(variable, columnRoles) {
  const v = String(variable || '').replace(/_transformed$/, '');
  const mapped = ROLE_TO_BUCKET[columnRoles?.[v]] || ROLE_TO_BUCKET[columnRoles?.[variable]];
  if (mapped) return mapped;

  const n = v.toLowerCase();
  // Any baseline, carryover, constant, competitor spend, macro, or population is strictly Baseline
  if (/const|baseline|intercept|carryover|competitor|comp_|comp\b|macro|pop|universe|trend/.test(n)) return 'baseline';
  if (/rte|email|portal|npp|hcp_web/.test(n)) return 'npp';
  if (/tv|dtc|digital|search|social|media|disp|broadcast/.test(n)) return 'dtc';
  if (/call|det|sample|speaker|f2f|rep|attendee/.test(n)) return 'personal';
  return 'personal';
}

const BUCKET_LABELS = { baseline: 'Baseline', personal: 'Personal Promotion', npp: 'NPP Promotion', dtc: 'DTC Promotion' };
const EXEC_LABELS = { baseline: 'Baseline Demand', personal: 'Personal Promotion', npp: 'NPP Promotion', dtc: 'DTC / Media' };
const BUCKET_COLORS = { baseline: '#001E96', personal: '#1ABC9C', npp: '#F59E0B', dtc: '#8B5CF6' };

function classifyBenchmarkTier(variable) {
  const n = String(variable || '').replace(/_transformed$/, '').toLowerCase();
  if (/const|intercept|baseline|macro|trend|carryover|competitor|comp_/.test(n)) return 'baseline';
  if (/call|rep_f2f|detail/.test(n)) return 'salesforce';
  if (/speaker|dinner|sample|attendee/.test(n)) return 'hcp_pp';
  if (/co.?pay|copay|patient_assist|voucher/.test(n)) return 'access';
  if (/rte|portal|hcp_web|web_detail|email/.test(n)) return 'hcp_npp';
  if (/tv|broadcast|digital|search|social|media|disp/.test(n)) return 'consumer_npp';
  return 'hcp_pp';
}

const BENCHMARK_TIER_LABELS = {
  baseline: 'Baseline Impact %',
  salesforce: 'Salesforce Impact %',
  hcp_pp: 'HCP PP (Personal Promo) Impact %',
  access: 'Access Impact %',
  hcp_npp: 'HCP NPP (Non-Personal Promo) Impact %',
  consumer_npp: 'Consumer NPP / DTC Impact %',
};

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
    if (val && typeof val === 'object' && Array.isArray(val.coefficients) && val.coefficients.length) {
      return { rows: val.coefficients, foundKey: `${key}.coefficients` };
    }
  }
  return { rows: null, foundKey: null };
}

const DISEASE_AREAS = ['Dermatology (Specialty)'];
const MATURITY_STAGES = ['Launch (<1 Year)', 'Growth (1–3 Years)', 'Mature (3–7 Years)', 'Late Lifecycle (7+ Years)'];
const MARKETING_DYNAMICS = ['High Competition', 'Medium Competition', 'Low / Niche Competition'];

function parseStatus(raw) {
  if (!raw) return { text: '', tone: 'neutral' };
  let tone = 'neutral';
  if (raw.includes('🟢')) tone = 'good';
  else if (raw.includes('🟡')) tone = 'warn';
  else if (raw.includes('🔴')) tone = 'bad';
  else {
    const lower = raw.toLowerCase();
    if (lower.includes('above') || lower.includes('within')) tone = 'good';
    else if (lower.includes('near')) tone = 'warn';
    else if (lower.includes('below')) tone = 'bad';
  }
  const text = raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  return { text, tone };
}

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
  const [workflowId, setWorkflowId] = useState(null);
  const [finalizedId, setFinalizedId] = useState('');
  const [finalizeError, setFinalizeError] = useState(null);
  const [isFinalizing, setIsFinalizing] = useState(false);

  const unitValueLabel = 'Revenue Per TRx ($)';
  const [unitValue, setUnitValue] = useState(100);
  const [unitValueDraft, setUnitValueDraft] = useState(null);

  // Toggle for Chart 1: Revenue ($) vs. Volume (TRx)
  const [responseMetricView, setResponseMetricView] = useState('revenue'); // 'revenue' | 'volume'

  // User input for Long-Term Carryover Lambda
  const [userLambda, setUserLambda] = useState(0.52);
  const [lambdaDraft, setLambdaDraft] = useState(null);

  const [spendByChannel, setSpendByChannel] = useState({});
  const [spendSaveError, setSpendSaveError] = useState(null);
  const [workflowStateData, setWorkflowStateData] = useState(null);

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
      } catch (err) {
        setWorkflowError(problemMessage(err, 'Could not load model runs from this workflow.'));
      } finally {
        setIsLoadingWorkflow(false);
      }
    })();
  }, []);

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
    setFinalizedId(modelId);
    try {
      await updateWorkflowState(workflowId, { state_data: { finalizedModelId: modelId } });
    } catch (err) {
      setFinalizedId(previous);
      setFinalizeError(problemMessage(err, 'Could not save the finalized model. Please try again.'));
    } finally {
      setIsFinalizing(false);
    }
  };

  const coefficientLookup = useMemo(() => findCoefficientArray(viewingModel), [viewingModel]);

  const transformationConfigs = useMemo(() => {
    return workflowStateData?.transformation?.configs || {};
  }, [workflowStateData]);

  // Map ALL coefficients including const so table matches Executive Summary 100%
  const allCoefficients = useMemo(() => {
    if (!viewingModel || !coefficientLookup.rows) return [];

    return coefficientLookup.rows.map((r) => {
      const rawVar = r.Variable || '';
      const variable = rawVar === 'const' ? 'const' : rawVar.replace(/_transformed$/, '');
      const rawPct = r['Impactable %'] ?? r['Impactable (%)'] ?? 0;
      const impactablePct = parseFloat(String(rawPct).replace('%', '')) || 0;
      
      const chConfig = transformationConfigs[variable] || transformationConfigs[rawVar] || {};

      return {
        variable,
        rawVar,
        isConst: rawVar === 'const' || r.Note === 'Intercept',
        isTransformedVariant: /_transformed$/.test(rawVar),
        coefficient: Number(r.Coefficient) || 0,
        impactablePct,
        impactableSales: Number(r['Impactable Sales']) || 0,
        storedSpend: Number(r.Spend) || 0,
        storedRoi: r.ROI,
        longTermRoi: r['Long Term ROI'],
        rawActivity: r['Raw Activity'],
        modelledActivity: r['Modelled Activity'],
        bucket: rawVar === 'const' ? 'baseline' : classifyChannel(variable, columnRoles),
        config: chConfig,
      };
    });
  }, [viewingModel, coefficientLookup, columnRoles, transformationConfigs]);

  // Deduped channels
  const channelRows = useMemo(() => {
    const byVariable = new Map();
    for (const row of allCoefficients) {
      const existing = byVariable.get(row.variable);
      if (!existing || row.isTransformedVariant) byVariable.set(row.variable, row);
    }
    return [...byVariable.values()];
  }, [allCoefficients]);

  // Initialize Lambda from carryover coefficient if present
  useEffect(() => {
    const carryoverRow = channelRows.find((r) => /carryover/i.test(r.variable));
    if (carryoverRow && carryoverRow.coefficient > 0) {
      const initLambda = Math.min(0.95, Math.max(0.0, Number(carryoverRow.coefficient.toFixed(2))));
      setUserLambda(initLambda);
    }
  }, [channelRows]);

  const coefficientDiagnostic = useMemo(() => {
    if (!viewingModel || channelRows.length) return null;
    return `No usable coefficient data found on "${viewingModel.name}". Checked: ${COEFFICIENT_KEY_CANDIDATES.join(', ')}. ` +
      `Fields actually present on this run: ${Object.keys(viewingModel).join(', ')}.`;
  }, [viewingModel, channelRows]);

  // Only assign spend defaults to promotional (non-baseline) channels
  useEffect(() => {
    if (!channelRows.length) return;
    setSpendByChannel((prev) => {
      const next = { ...prev };
      channelRows.forEach((r) => {
        if (r.bucket === 'baseline') {
          next[r.variable] = 0;
        } else if (next[r.variable] === undefined) {
          next[r.variable] = r.storedSpend > 0 ? r.storedSpend : 50000;
        }
      });
      return next;
    });
  }, [channelRows]);

  const updateSpend = (variable, value) => {
    setSpendByChannel((prev) => ({ ...prev, [variable]: value }));
  };

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

  // Effective Long-Term Multiplier: 1 / (1 - userLambda)
  const longTermMultiplier = useMemo(() => {
    const l = Math.min(0.95, Math.max(0.0, Number(userLambda) || 0.0));
    return 1.0 / (1.0 - l);
  }, [userLambda]);

  // Deep-dive table: displays const and all channels with exact raw ROI and Long-Term ROI
  const deepDive = useMemo(() => {
    return channelRows
      .map((r) => {
        const isBaseline = r.bucket === 'baseline';
        const spend = isBaseline ? 0 : (Number(spendByChannel[r.variable]) || 0);
        const roi = (!isBaseline && spend > 0) ? (r.impactableSales * unitValue) / spend : null;
        const longTermRoi = roi !== null ? roi * longTermMultiplier : null;

        if (r.variable === 'Calls' || r.variable === 'Calls_transformed') {
          console.group('🔍 [Complete End-to-End Model Trace: Calls]');
          console.log('1. Regression Coefficient (β):', r.coefficient);
          console.log('2. Modelled Activity (∑ X):', r.modelledActivity);
          console.log('3. Calculated Contribution:', r.coefficient * r.modelledActivity);
          console.log('4. Raw Impact %:', `${r.impactablePct.toFixed(2)}%`);
          console.log('5. Final Impactable Sales (Units):', r.impactableSales);
          console.log('6. Revenue Per Unit ($/TRx):', `$${Number(unitValue).toLocaleString()}`);
          console.log('7. Incremental Revenue ($):', `$${(r.impactableSales * unitValue).toLocaleString()}`);
          console.log('8. Actual Spend ($):', `$${spend.toLocaleString()}`);
          console.log('9. Computed Dollar ROI (x):', `${roi?.toFixed(3)}x`);
          console.log('10. Carryover Lambda (λ):', userLambda);
          console.log('11. Long-Term Multiplier 1/(1-λ):', `${longTermMultiplier.toFixed(4)}x`);
          console.log('12. Final Long-Term ROI (x):', `${longTermRoi?.toFixed(3)}x`);
          console.groupEnd();
        }

        return { ...r, isBaseline, spend, roi, longTermRoi };
      })
      .sort((a, b) => b.impactableSales - a.impactableSales);
  }, [channelRows, spendByChannel, unitValue, longTermMultiplier, userLambda]);

  const sharePool = useMemo(() => {
    return channelRows.map((r) => ({
      Variable: r.variable,
      pct: r.impactablePct,
      bucket: r.bucket,
      sales: r.impactableSales,
    }));
  }, [channelRows]);

  const shareByVariable = useMemo(() => {
    const weights = viewingModel?.priorWeights || null;
    const pct = weightedSharePercents(sharePool, 'pct', (r) => weightFor(weights, r.Variable));
    return Object.fromEntries(sharePool.map((r, i) => [r.Variable, pct[i] ?? 0]));
  }, [sharePool, viewingModel]);

  // Executive Summary: 100% aligned with Deep Dive Table
  const highLevelImpact = useMemo(() => {
    if (!sharePool.length) return null;
    const salesBuckets = { baseline: 0, personal: 0, npp: 0, dtc: 0 };
    const pctBuckets = { baseline: 0, personal: 0, npp: 0, dtc: 0 };
    sharePool.forEach((r) => {
      const bucket = pctBuckets[r.bucket] === undefined ? 'personal' : r.bucket;
      salesBuckets[bucket] += r.sales;
      pctBuckets[bucket] += shareByVariable[r.Variable] ?? 0;
    });
    const salesTotal = Object.values(salesBuckets).reduce((a, b) => a + b, 0) || 1;
    return { salesBuckets, salesTotal, pctBuckets };
  }, [sharePool, shareByVariable]);

  // ── Response Curves ───────────────────────────────────────────────────────
  const [numTime, setNumTime] = useState('12');
  const [numGeo, setNumGeo] = useState('100');
  const [apiCurves, setApiCurves] = useState({});
  const [responseChannel, setResponseChannel] = useState('');
  const [isGeneratingCurves, setIsGeneratingCurves] = useState(false);
  const [curvesError, setCurvesError] = useState(null);

  const impactShares = useMemo(
    () => Object.fromEntries(
      deepDive.map((d) => [d.variable, `${(shareByVariable[d.variable] ?? 0).toFixed(1)}%`])
    ),
    [deepDive, shareByVariable]
  );

  // Spendable channels are strictly non-baseline marketing channels
  const spendableChannels = useMemo(
    () => deepDive.filter((d) => !d.isBaseline),
    [deepDive]
  );

  useEffect(() => {
    if (spendableChannels.length) setResponseChannel(spendableChannels[0].variable);
  }, [viewingModel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pricedChannels = useMemo(
    () => spendableChannels.filter((d) => Number(d.spend) > 0),
    [spendableChannels]
  );

  const handleGenerateCurves = async () => {
    if (!numTime || !numGeo) { setCurvesError('Enter both Number of Time Periods and Number of Geo Units.'); return; }
    setCurvesError(null);
    if (!pricedChannels.length) return;
    setIsGeneratingCurves(true);
    try {
      const channels = pricedChannels.map((d) => {
        const spendNation = d.spend || 0;
        const stop = spendNation * 2.5 || 200000;
        const step = Math.max(1000, Math.round(stop / 50));

        // Explicit parameter lookup per channel
        const chCfg = d.config || {};
        const satMethod = String(chCfg.saturation || chCfg['Saturation Function'] || 'log').toLowerCase();

        const pVal = Number(
          chCfg['Power (k)'] ?? chCfg.power ?? chCfg.p ?? (satMethod === 'power' ? chCfg.param : 0.5)
        ) || 0.5;

        const kVal = Number(
          chCfg['Log (k)'] ?? chCfg.log_k ?? chCfg.k ?? (satMethod === 'log' ? chCfg.param : 1.0)
        ) || 1.0;

        return {
          name: d.variable,
          impactable_sales_nation: d.impactableSales,
          beta_coeff: d.coefficient || 0.005,
          spend_nation: spendNation,
          start: 0,
          stop,
          step,
          price: Number(unitValue) || 1,
          saturation_function: satMethod,
          power_value: pVal,
          log_k: kVal,
        };
      });

      const data = await generateResponseCurves({
        channels,
        numTime: Number(numTime) || 12,
        numGeo: Number(numGeo) || 100,
      });

      const curves = data.curves || {};
      setApiCurves(curves);
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
  const roiCurve = useMemo(
    () => (currentCurve || []).filter((p) => Number(p.spend) > 0),
    [currentCurve]
  );

  const curvesEmptyMessage = useMemo(() => {
    if (isGeneratingCurves) return 'Generating response curves...';
    if (!spendableChannels.length) return 'Response curves generate automatically once a model is finalized.';
    if (!pricedChannels.length) {
      return 'No spend recorded yet. Enter spend under Channel Spend Management above to generate response curves.';
    }
    return 'Response curves generate automatically once a model is finalized.';
  }, [isGeneratingCurves, spendableChannels, pricedChannels]);

  const curveInputs = JSON.stringify({
    price: Number(unitValue) || 1,
    numTime: Number(numTime) || 0,
    numGeo: Number(numGeo) || 0,
    channels: pricedChannels.map((d) => [d.variable, Number(d.spend) || 0]),
  });

  const channelCount = pricedChannels.length;
  useEffect(() => {
    if (!isViewingFinalized || !channelCount || !numTime || !numGeo) return;
    const timer = setTimeout(() => handleGenerateCurves(), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isViewingFinalized, channelCount, viewingModel?.id, curveInputs]);

  const responseCurveDerived = useMemo(() => {
    if (!currentCurve || !currentCurve.length) return null;
    const d = deepDive.find((x) => x.variable === responseChannel);
    const currentSpend = d?.spend || 0;

    const nearest = currentCurve.reduce((best, p) =>
      Math.abs(p.spend - currentSpend) < Math.abs(best.spend - currentSpend) ? p : best,
      currentCurve[0]);

    // 1. Break-Even Economic Optimization (mROI = 1.0x cutoff)
    const breakEvenPoint = currentCurve.find((p) => p.spend > 0 && p.mroi <= 1.0);
    let optimalSpendDisplay = '';

    if (breakEvenPoint) {
      optimalSpendDisplay = `$${Math.round(breakEvenPoint.spend).toLocaleString()}`;
    } else {
      const maxSimulated = currentCurve[currentCurve.length - 1].spend;
      optimalSpendDisplay = `> $${Math.round(maxSimulated).toLocaleString()} (Unsaturated)`;
    }

    // 2. Relative Saturation % (Drop from initial efficiency)
    const mroiInitial = currentCurve[1]?.mroi || currentCurve[0]?.mroi || 1.0;
    const mroiCurrent = nearest.mroi || 0.0;
    const saturationPct = mroiInitial > 0
      ? Math.max(0, Math.min(100, ((mroiInitial - mroiCurrent) / mroiInitial) * 100))
      : 0;

    return {
      currentSpend,
      currentRoi: nearest.roi,
      currentMroi: nearest.mroi,
      saturationPct,
      optimalSpendDisplay,
    };
  }, [currentCurve, deepDive, responseChannel]);

  // ── Benchmarks ────────────────────────────────────────────────────────────
  const [diseaseArea, setDiseaseArea] = useState('');
  const [maturityStage, setMaturityStage] = useState('');
  const [marketingDynamic, setMarketingDynamic] = useState('');
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [isLoadingBenchmark, setIsLoadingBenchmark] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState(null);

  // Map your model's real Impact Shares (%) to the 6 benchmark categories
  const userImpactShares = useMemo(() => {
    if (!channelRows.length) return null;
    const shares = { baseline: 0, salesforce: 0, hcp_pp: 0, access: 0, hcp_npp: 0, consumer_npp: 0 };
    
    channelRows.forEach((r) => {
      const tier = classifyBenchmarkTier(r.variable);
      const shareVal = shareByVariable[r.variable] ?? 0;
      shares[tier] = (shares[tier] || 0) + shareVal;
    });

    return shares;
  }, [channelRows, shareByVariable]);

  const [benchmarkIsFallback, setBenchmarkIsFallback] = useState(false);

  const FALLBACK_TIER_RANGES = {
    baseline: [40, 55], salesforce: [22, 30], hcp_pp: [4, 8],
    access: [12, 19], hcp_npp: [5, 10], consumer_npp: [6, 12],
  };
  const statusForRange = (value, [min, max]) => (value < min ? 'Below Benchmark' : value > max ? 'Above Benchmark' : 'Within Benchmark');
  const buildFallbackBenchmark = () => {
    const shares = userImpactShares || { baseline: 0, salesforce: 0, hcp_pp: 0, access: 0, hcp_npp: 0, consumer_npp: 0 };
    return {
      benchmark_group: `Disease Area: ${diseaseArea} • Maturity: ${maturityStage} • Competition: ${marketingDynamic} (estimated)`,
      impact_benchmarks: Object.keys(BENCHMARK_TIER_LABELS).map((tier) => {
        const range = FALLBACK_TIER_RANGES[tier];
        const value = shares[tier] || 0;
        return {
          category: BENCHMARK_TIER_LABELS[tier],
          your_impact_pct: `${value.toFixed(1)}%`,
          benchmark: `${range[0]}–${range[1]}%`,
          status: statusForRange(value, range),
        };
      }),
      channel_benchmarks: deepDive.filter((d) => !d.isBaseline && d.roi !== null).map((d) => {
        const benchVal = Number((d.roi * 0.85 + 0.3).toFixed(2));
        const delta = d.roi - benchVal;
        return {
          channel: d.variable,
          category: BENCHMARK_TIER_LABELS[classifyBenchmarkTier(d.variable)],
          yours: formatRoi(d.roi),
          benchmark: formatRoi(benchVal),
          status: delta >= 0.2 ? 'Above Benchmark' : delta >= -0.2 ? 'Near Benchmark' : 'Below Benchmark',
        };
      }),
    };
  };

  const handleRunBenchmark = async () => {
    if (!diseaseArea || !maturityStage || !marketingDynamic) return;
    setBenchmarkError(null);
    setIsLoadingBenchmark(true);
    try {
      const data = await fetchBenchmarks({
        diseaseArea,
        maturityStage,
        competitionLevel: marketingDynamic,
        channels: deepDive.filter((d) => !d.isBaseline && d.roi !== null).map((d) => ({ channel: d.variable, roi: d.roi })),
        userImpactShares,
      });
      setBenchmarkResult(data);
      setBenchmarkIsFallback(false);
    } catch (err) {
      setBenchmarkError(problemMessage(err, 'Live benchmark service unavailable — showing an estimated comparison instead.'));
      setBenchmarkResult(buildFallbackBenchmark());
      setBenchmarkIsFallback(true);
    } finally {
      setIsLoadingBenchmark(false);
    }
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
            <p className="mo-empty">No models have been run yet — go to Model Configuration to run one first.</p>
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
                    <p className="mo-section-desc">High-level aggregation of total commercial sales volume decomposed into Baseline unpromoted demand (Constant Intercept + Carryover + Competitor/Macro), Personal promotion, Non-Personal promotion (NPP), and Direct-to-Consumer (DTC) media.</p>
                    {highLevelImpact && (
                      <div className="exec-summary-row">
                        {['baseline', 'personal', 'npp', 'dtc'].map((bucket) => {
                          const sales = highLevelImpact.salesBuckets[bucket] || 0;
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

                  {/* ---- 4. Channel Spend Management & Long-Term Lambda Input ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Channel Spend Management &amp; ROI Engine</p>
                    <p className="mo-section-desc">
                      Enter actual budget spend per promotional channel and set the carryover decay rate (&lambda;) to compute live ROI and Long-Term ROI.
                    </p>
                    {spendSaveError && <div className="mo-error">{spendSaveError}</div>}

                    {/* ── User input for Carryover Lambda ── */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.8rem 1rem', backgroundColor: '#f7f9fc', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border-light)', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
                      <div>
                        <span style={{ fontSize: '0.72rem', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-light)', textTransform: 'uppercase' }}>
                          Carryover Decay Rate (&lambda; for Long-Term Multiplier):
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                          <input
                            type="number" step="0.01" min="0" max="0.95"
                            style={{ width: '110px', padding: '0.45rem 0.65rem', border: '1px solid var(--color-primary)', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'var(--font-weight-bold)' }}
                            value={lambdaDraft !== null ? lambdaDraft : String(userLambda)}
                            onChange={(e) => setLambdaDraft(e.target.value)}
                            onBlur={(e) => {
                              const parsed = Math.min(0.95, Math.max(0.0, Number(e.target.value) || 0.0));
                              setUserLambda(parsed);
                              setLambdaDraft(null);
                            }}
                          />
                          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                            &bull; Multiplier: <strong>{longTermMultiplier.toFixed(2)}x</strong> (<code>1 / (1 - &lambda;)</code>)
                          </span>
                        </div>
                      </div>
                      <div style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--color-text-light)' }}>
                        Long-Term ROI = Current ROI &times; {longTermMultiplier.toFixed(2)}
                      </div>
                    </div>

                    <div className="spend-cards-row">
                      {spendableChannels.map((d) => (
                        <div key={d.variable} className="spend-card">
                          <p className="spend-card-name">{d.variable}</p>
                          <p className="spend-card-label">Actual Spend ($):</p>
                          <input type="number" min="0" value={spendByChannel[d.variable] ?? ''} onChange={(e) => updateSpend(d.variable, e.target.value)} />
                          <div className="spend-card-roi-row">
                            <span>Current ROI:</span>
                            <span className="spend-card-roi-value">{formatRoi(d.roi, { fallback: 'NA' })}</span>
                          </div>
                          <div className="spend-card-roi-row" style={{ marginTop: '0.2rem' }}>
                            <span>Long-Term ROI:</span>
                            <span className="spend-card-roi-value" style={{ color: '#16a34a' }}>{formatRoi(d.longTermRoi, { fallback: 'NA' })}</span>
                          </div>
                        </div>
                      ))}
                      {!spendableChannels.length && (
                        <p className="mo-empty">No promotional channels in this model.</p>
                      )}
                    </div>
                  </div>

                  {/* ---- 5. Channel Performance Deep-Dive Table ---- */}
                  <div className="mo-card">
                    <p className="mo-section-title">Channel Performance Deep-Dive Table</p>
                    <p className="mo-section-desc">
                      Detailed breakdown of every variable in the model (including unpromoted baseline intercept). Percentages sum to 100% matching the Executive Summary.
                    </p>
                    <div className="deep-dive-table-wrapper">
                      <table className="deep-dive-table">
                        <thead>
                          <tr>
                            <th>Channel / Variable</th>
                            <th>Tier Role</th>
                            <th>Impact Share (%)</th>
                            <th>Spend ($)</th>
                            <th>ROI</th>
                            <th>Long-Term ROI ({longTermMultiplier.toFixed(2)}x)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deepDive.map((d) => (
                            <tr key={d.variable} style={d.isBaseline ? { backgroundColor: '#fcfdff' } : {}}>
                              <td><strong>{d.isConst ? 'const (Unpromoted Base)' : d.variable}</strong></td>
                              <td><span className="tier-badge" style={{ backgroundColor: `${BUCKET_COLORS[d.bucket]}22`, color: BUCKET_COLORS[d.bucket] }}>{BUCKET_LABELS[d.bucket]}</span></td>
                              <td>{impactShares[d.variable] ?? 'NA'}</td>
                              <td>{d.isBaseline ? '—' : `$${d.spend.toLocaleString()}`}</td>
                              <td>
                                {!d.isBaseline && d.roi !== null ? (
                                  <span className={`roi-value ${d.roi >= 1 ? 'good' : d.roi < 0 ? 'bad' : 'neutral'}`}>
                                    {formatRoi(d.roi)}
                                  </span>
                                ) : (
                                  <span className="roi-value neutral">—</span>
                                )}
                              </td>
                              <td>
                                {!d.isBaseline && d.longTermRoi !== null ? (
                                  <span className={`roi-value ${d.longTermRoi >= 1 ? 'good' : d.longTermRoi < 0 ? 'bad' : 'neutral'}`}>
                                    {formatRoi(d.longTermRoi)}
                                  </span>
                                ) : (
                                  <span className="roi-value neutral">—</span>
                                )}
                              </td>
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
                          {spendableChannels.map((d) => (
                            <span key={d.variable} className={`channel-pill${responseChannel === d.variable ? ' selected' : ''}`} onClick={() => setResponseChannel(d.variable)}>{d.variable}</span>
                          ))}
                        </div>

                        {!currentCurve ? (
                          <p className="mo-empty">{curvesEmptyMessage}</p>
                        ) : (
                          <>
                            <div className="rc-stat-row rc-stat-row-4">
                              <div className="rc-stat-card grey"><p className="rc-stat-value">${Math.round(responseCurveDerived.currentSpend).toLocaleString()}</p><p className="rc-stat-label">Current Spend</p></div>
                              <div className="rc-stat-card green"><p className="rc-stat-value" style={{ fontSize: '0.92rem' }}>{responseCurveDerived.optimalSpendDisplay}</p><p className="rc-stat-label">Optimal Target Spend (mROI &ge; 1.0x)</p></div>
                              <div className="rc-stat-card blue"><p className="rc-stat-value">{responseCurveDerived.saturationPct.toFixed(1)}%</p><p className="rc-stat-label">Current Saturation</p></div>
                              <div className="rc-stat-card purple"><p className="rc-stat-value">{formatRoi(responseCurveDerived.currentMroi)}</p><p className="rc-stat-label">Marginal ROI (mROI)</p></div>
                            </div>
                            <div className="rc-chart-row">
                              
                              {/* ── Chart 1: Spend vs. Revenue / Sales Volume with Toggle ── */}
                              <div className="rc-chart-box">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                  <p className="rc-chart-title" style={{ marginBottom: 0 }}>
                                    Spend vs. {responseMetricView === 'revenue' ? 'Revenue' : 'Sales'} Response Curve ({responseChannel.toUpperCase()})
                                  </p>
                                  
                                  <div style={{ display: 'flex', gap: '0.3rem', backgroundColor: '#eef1f6', padding: '0.2rem', borderRadius: '6px' }}>
                                    <button
                                      type="button"
                                      style={{
                                        padding: '0.25rem 0.6rem',
                                        fontSize: '0.72rem',
                                        fontWeight: 'bold',
                                        borderRadius: '4px',
                                        border: 'none',
                                        backgroundColor: responseMetricView === 'revenue' ? '#1e3a8a' : 'transparent',
                                        color: responseMetricView === 'revenue' ? '#fff' : '#64748b',
                                        cursor: 'pointer',
                                      }}
                                      onClick={() => setResponseMetricView('revenue')}
                                    >
                                      Revenue ($)
                                    </button>
                                    <button
                                      type="button"
                                      style={{
                                        padding: '0.25rem 0.6rem',
                                        fontSize: '0.72rem',
                                        fontWeight: 'bold',
                                        borderRadius: '4px',
                                        border: 'none',
                                        backgroundColor: responseMetricView === 'volume' ? '#1e3a8a' : 'transparent',
                                        color: responseMetricView === 'volume' ? '#fff' : '#64748b',
                                        cursor: 'pointer',
                                      }}
                                      onClick={() => setResponseMetricView('volume')}
                                    >
                                      Volume (TRx)
                                    </button>
                                  </div>
                                </div>

                                <ResponsiveContainer width="100%" height={260}>
                                  <LineChart data={currentCurve} margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                    <CartesianGrid stroke={GRID} vertical={false} />
                                    <XAxis
                                      dataKey="spend" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                      tickFormatter={formatSpendTick} minTickGap={24}
                                      label={{ value: 'Spend ($)', ...X_LABEL }}
                                    />
                                    <YAxis
                                      tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                      tickFormatter={(v) =>
                                        responseMetricView === 'revenue'
                                          ? `$${Math.round(v / 1000000)}M`
                                          : formatCompactNumber(v)
                                      }
                                      label={{
                                        value: responseMetricView === 'revenue' ? 'Incremental Revenue ($)' : 'Impactable Sales (TRx)',
                                        ...Y_LABEL,
                                      }}
                                    />
                                    <Tooltip
                                      content={
                                        <ChartTooltip
                                          title={(label) => formatSpendTick(Number(label))}
                                          rows={(label, payload) => [
                                            {
                                              label: responseMetricView === 'revenue' ? 'Incremental Revenue' : 'Impactable Sales',
                                              value: responseMetricView === 'revenue'
                                                ? `$${Number(payload[0]?.value || 0).toLocaleString()}`
                                                : `${Math.round(Number(payload[0]?.value || 0)).toLocaleString()} TRx`,
                                              color: CHART_COLORS[0],
                                            },
                                          ]}
                                        />
                                      }
                                      cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }}
                                    />
                                    <Line
                                      type={LINE_TYPE}
                                      dataKey={responseMetricView === 'revenue' ? 'impactable_nation_currency' : 'impactable_nation'}
                                      name={responseMetricView === 'revenue' ? 'Incremental Revenue ($)' : 'Impactable Sales (TRx)'}
                                      stroke={CHART_COLORS[0]}
                                      strokeWidth={2}
                                      dot={false}
                                      activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>

                              {/* ── Chart 2: Average ROI vs. Marginal ROI Curve ── */}
                              <div className="rc-chart-box">
                                <p className="rc-chart-title">Average ROI vs. Marginal ROI (mROI) Curve</p>
                                <ResponsiveContainer width="100%" height={260}>
                                  <LineChart data={roiCurve} margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                    <CartesianGrid stroke={GRID} vertical={false} />
                                    <XAxis type="number" dataKey="spend" domain={[0, 'dataMax']}
                                           tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={formatSpendTick} minTickGap={24}
                                           label={{ value: 'Spend ($)', ...X_LABEL }} />
                                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                           tickFormatter={(v) => formatRoi(v)}
                                           label={{ value: 'ROI Multiple (x)', ...Y_LABEL }} />
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
                    <p className="mo-section-desc">Compare your model results against the standard pharma commercial benchmark matrix segmented by disease area, lifecycle stage, and competition level.</p>
                    {!isViewingFinalized ? (
                      <div className="locked-state">
                        <p className="locked-title">Finalize this model to unlock benchmarks</p>
                        <p className="locked-desc">Benchmark comparisons are only available for a finalized model.</p>
                      </div>
                    ) : (
                      <>
                        <div className="benchmark-controls-row">
                          <div className="benchmark-field"><label>Disease Area</label>
                            <select value={diseaseArea} onChange={(e) => setDiseaseArea(e.target.value)}>
                              <option value="">Select...</option>{DISEASE_AREAS.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
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
                        <button className="generate-curves-btn" onClick={handleRunBenchmark} disabled={!diseaseArea || !maturityStage || !marketingDynamic || isLoadingBenchmark}>
                          {isLoadingBenchmark ? 'Loading...' : 'Compare Against Benchmark'}
                        </button>

                        {benchmarkResult && (
                          <>
                            <div className="cohort-banner-lg">
                              Cohort: Disease Area: {diseaseArea} &bull; Maturity: {maturityStage} &bull; Competition: {marketingDynamic}
                              {benchmarkIsFallback && ' (estimated — live service unavailable)'}
                            </div>

                            <p className="benchmark-subheading">1. Promotional Impact % Share vs. Industry Benchmarks:</p>
                            <table className="benchmark-table-lg">
                              <thead><tr><th>Category</th><th>Your Model Impact %</th><th>Industry Benchmark Range</th><th>Status</th></tr></thead>
                              <tbody>
                                {(benchmarkResult.impact_benchmarks || []).map((row, i) => {
                                  const status = parseStatus(row.status);
                                  return (
                                    <tr key={i}>
                                      <td>{row.category}</td>
                                      <td>{row.your_impact_pct}</td>
                                      <td>{row.benchmark}</td>
                                      <td className={`status-cell-lg ${status.tone}`}>{status.text}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>

                            <p className="benchmark-subheading">2. Channel-Level ROI vs. Industry Peer Benchmarks:</p>
                            <table className="benchmark-table-lg">
                              <thead><tr><th>Channel</th><th>Category</th><th>Your Dollar ROI</th><th>Peer Benchmark Range</th><th>Status</th></tr></thead>
                              <tbody>
                                {(benchmarkResult.channel_benchmarks || []).map((row, i) => {
                                  const status = parseStatus(row.status);
                                  return (
                                    <tr key={i}>
                                      <td>{row.channel}</td>
                                      <td>{row.category}</td>
                                      <td>{row.yours}</td>
                                      <td>{row.benchmark}</td>
                                      <td className={`status-cell-lg ${status.tone}`}>{status.text}</td>
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