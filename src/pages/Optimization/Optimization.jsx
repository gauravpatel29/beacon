import { useState, useEffect, useMemo } from 'react';
import {
  ensureWorkflow,
  getWorkflow,
  updateWorkflow,
  problemMessage,
  generateResponseCurves,
} from '../../services/api.js';
import { runOptimization } from '../../services/optimization.js';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import { AXIS_TICK, CHART_COLORS, GRID } from '../../components/charts/chartTheme.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './Optimization.css';

// Same defensive multi-key coefficient lookup as ModelOutput.jsx — the
// stored model run may or may not have coefficients under this exact name,
// depending on whether Model Configuration's save step has been fixed to
// keep them. Kept in sync with ModelOutput's version rather than assuming.
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

function Optimization() {
  // ── Load the real workflow: finalized model, current spend, saved scenarios ──
  const [workflowId, setWorkflowId] = useState(null);
  const [modelHistory, setModelHistory] = useState([]);
  const [finalizedId, setFinalizedId] = useState('');
  const [spendByChannel, setSpendByChannel] = useState({});
  const [savedScenarios, setSavedScenarios] = useState([]);
  const [isLoadingWorkflow, setIsLoadingWorkflow] = useState(true);
  const [workflowError, setWorkflowError] = useState(null);

  useEffect(() => {
    (async () => {
      setIsLoadingWorkflow(true);
      setWorkflowError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const workflow = await getWorkflow(id);
        setModelHistory(workflow?.state_data?.modelling?.modelHistory || []);
        setFinalizedId(workflow?.state_data?.finalizedModelId || '');
        setSpendByChannel(workflow?.state_data?.channelSpendMap || {});
        setSavedScenarios(workflow?.state_data?.optimization?.savedScenarios || []);
      } catch (err) {
        setWorkflowError(problemMessage(err, 'Could not load the finalized model for optimization.'));
      } finally {
        setIsLoadingWorkflow(false);
      }
    })();
  }, []);

  const finalizedModel = useMemo(
    () => modelHistory.find((m) => m.id === finalizedId) || null,
    [modelHistory, finalizedId]
  );

  // ── Channel rows from the finalized model's coefficients, deduped ────────
  // Same collision as Model Output's Section 6: a channel selected as BOTH
  // its raw and _transformed variant collapses to the same display name once
  // the suffix is stripped. Keep the _transformed row, drop the raw
  // duplicate — otherwise every downstream total double-counts that channel.
  const coefficientLookup = useMemo(() => findCoefficientArray(finalizedModel), [finalizedModel]);
  const channelRows = useMemo(() => {
    if (!coefficientLookup.rows) return [];
    const mapped = coefficientLookup.rows
      .filter((r) => r.Note !== 'Intercept' && r.Note !== 'Carryover' && r.Variable !== 'const')
      .map((r) => ({
        variable: (r.Variable || '').replace(/_transformed$/, ''),
        isTransformedVariant: /_transformed$/.test(r.Variable || ''),
        coefficient: Number(r.Coefficient) || 0,
        impactableSales: Number(r['Impactable Sales']) || 0,
        storedSpend: Number(r.Spend) || 0,
      }));
    const byVariable = new Map();
    for (const row of mapped) {
      const existing = byVariable.get(row.variable);
      if (!existing || row.isTransformedVariant) byVariable.set(row.variable, row);
    }
    return [...byVariable.values()];
  }, [coefficientLookup]);

  const coefficientDiagnostic = useMemo(() => {
    if (!finalizedModel || channelRows.length) return null;
    return `No usable coefficient data found on "${finalizedModel.name}". Checked: ${COEFFICIENT_KEY_CANDIDATES.join(', ')}. ` +
      `Fields actually present on this run: ${Object.keys(finalizedModel).join(', ')}.`;
  }, [finalizedModel, channelRows]);

  // ── Response curves: Model Output never persists these to the workflow,
  // so — same as the reference implementation — generate them here directly
  // if they aren't already in memory, using the same defensive floors
  // (beta_coeff, stop, step) Model Output's Section 6 uses.
  const [apiCurves, setApiCurves] = useState({});
  const [isGeneratingCurves, setIsGeneratingCurves] = useState(false);
  const [curvesError, setCurvesError] = useState(null);

  useEffect(() => {
    if (!channelRows.length || Object.keys(apiCurves).length) return;
    (async () => {
      setIsGeneratingCurves(true);
      setCurvesError(null);
      try {
        const channels = channelRows.map((r) => {
          const spend = Number(spendByChannel[r.variable]) || r.storedSpend || 50000;
          const stop = spend * 3.0 || 300000;
          const step = Math.max(1000, Math.round(stop / 50));
          return {
            name: r.variable,
            impactable_sales_nation: r.impactableSales || 90000,
            beta_coeff: r.coefficient || 0.005,
            spend_nation: spend,
            start: 0,
            stop,
            step,
            price: 1,
            saturation_function: 'log',
            power_value: 0.5,
          };
        });
        const data = await generateResponseCurves({ channels, num_time: 12, num_geo: 100 });
        setApiCurves(data.curves || {});
      } catch (err) {
        setCurvesError(problemMessage(err, 'Could not generate response curves for optimization.'));
      } finally {
        setIsGeneratingCurves(false);
      }
    })();
  }, [channelRows, spendByChannel, apiCurves]);

  const hasCurves = Object.keys(apiCurves).length > 0;

  // merged_rc: the exact flattened shape runOptimization expects — parallel
  // arrays per channel, not the {curves: {channel: [points]}} shape
  // generateResponseCurves itself returns.
  const effectiveMergedRc = useMemo(() => {
    const built = {};
    Object.entries(apiCurves).forEach(([ch, rows]) => {
      built[`${ch}_spend`] = rows.map((r) => r.spend);
      built[`${ch}_impactable_nation`] = rows.map((r) => r.impactable_nation);
      built[`${ch}_roi`] = rows.map((r) => r.roi);
      built[`${ch}_mroi`] = rows.map((r) => r.mroi);
    });
    return built;
  }, [apiCurves]);

  // ── Scenario definition ───────────────────────────────────────────────────
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioType, setScenarioType] = useState('fixed_budget'); // 'fixed_budget' | 'fixed_goal'
  const [targetValue, setTargetValue] = useState('');

  // ── Per-channel constraints, fully user-editable ─────────────────────────
  const [channelBounds, setChannelBounds] = useState([]);
  useEffect(() => {
    if (!channelRows.length) return;
    setChannelBounds((prev) => {
      if (prev.length === channelRows.length) return prev; // preserve user edits
      return channelRows.map((r) => {
        const curSpend = Number(spendByChannel[r.variable]) || r.storedSpend || 50000;
        return { channel: r.variable, min: 0, max: Math.round(curSpend * 2) || 150000, currentSpend: curSpend };
      });
    });
  }, [channelRows, spendByChannel]);

  const updateBound = (idx, field, value) => {
    const num = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
    setChannelBounds((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: num };
      return next;
    });
  };
  const setAllMinToZero = () => setChannelBounds((prev) => prev.map((b) => ({ ...b, min: 0 })));
  const applyConstraintPreset = (multiplierMin, multiplierMax) => {
    setChannelBounds((prev) => prev.map((b) => ({
      ...b,
      min: Math.round(b.currentSpend * multiplierMin),
      max: Math.round(b.currentSpend * multiplierMax),
    })));
  };

  // ── Current-plan baseline, for the sales-lift comparison ─────────────────
  const currentBaselineSummary = useMemo(() => {
    if (!channelBounds.length) return { totalSpend: 0, estimatedSales: 0 };
    let totalSpend = 0;
    let estimatedSales = 0;
    channelBounds.forEach((b) => {
      const spend = b.currentSpend || 0;
      totalSpend += spend;
      const chCurve = apiCurves[b.channel] || [];
      if (chCurve.length > 0) {
        let closest = chCurve[0];
        let minDiff = Infinity;
        chCurve.forEach((pt) => {
          const diff = Math.abs(pt.spend - spend);
          if (diff < minDiff) { minDiff = diff; closest = pt; }
        });
        estimatedSales += closest?.impactable_nation || spend * 1.8;
      } else {
        estimatedSales += spend * 1.8;
      }
    });
    return { totalSpend, estimatedSales: Math.round(estimatedSales) };
  }, [channelBounds, apiCurves]);

  // ── Run the real optimizer ────────────────────────────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [optResult, setOptResult] = useState(null);
  const [runError, setRunError] = useState(null);

  const handleRunOptimizer = async () => {
    setRunError(null);
    if (!channelRows.length) { setRunError('No channels available — finalize a model with coefficients first.'); return; }
    if (!targetValue || Number(targetValue) <= 0) { setRunError('Enter a valid target value.'); return; }
    for (const b of channelBounds) {
      const minV = Number(b.min) || 0;
      const maxV = Number(b.max) || 0;
      if (minV > maxV) {
        setRunError(`Constraint error for ${b.channel}: Min ($${minV.toLocaleString()}) exceeds Max ($${maxV.toLocaleString()}).`);
        return;
      }
    }
    setIsRunning(true);
    setOptResult(null);
    const optimizerDict = {};
    channelBounds.forEach((b) => {
      optimizerDict[b.channel] = { min: Number(b.min) || 0, max: Number(b.max) || 500000, currentSpend: b.currentSpend };
    });
    try {
      const data = await runOptimization({
        mergedRc: effectiveMergedRc,
        optimizerDict,
        target: parseFloat(targetValue),
        optType: scenarioType === 'fixed_budget' ? 'Budget Goal' : 'Sales Goal',
        scenarioName: scenarioName.trim() || 'Optimization Scenario',
      });
      setOptResult(data);
    } catch (err) {
      setRunError(problemMessage(err, 'Optimization calculation failed.'));
    } finally {
      setIsRunning(false);
    }
  };

  // ── Comparison data (current vs. optimized) ──────────────────────────────
  const comparisonData = useMemo(() => {
    if (!optResult || !optResult.allocation) return [];
    return Object.entries(optResult.allocation).map(([ch, vals]) => {
      const curSpend = Number(spendByChannel[ch]) || 50000;
      const optSpend = Math.round(Number(vals.spend) || 0);
      const optImpact = Math.round(Number(vals.impactable_nation) || 0);
      const deltaSpend = optSpend - curSpend;
      const deltaPct = curSpend > 0 ? Math.round((deltaSpend / curSpend) * 100) : 0;
      // optimization.py already returns roi per channel (impactable_nation ÷
      // spend, rounded) — use it directly rather than recomputing, so
      // rounding is consistent with whatever the server actually solved.
      const optRoi = vals.roi !== undefined ? Number(vals.roi) : (optSpend > 0 ? Number((optImpact / optSpend).toFixed(2)) : 0);
      return { channel: ch.replace('_transformed', ''), currentSpend: curSpend, optimizedSpend: optSpend, deltaSpend, deltaPct, optimizedImpact: optImpact, optimizedRoi: optRoi };
    });
  }, [optResult, spendByChannel]);

  const totalOptimizedSpend = comparisonData.reduce((s, r) => s + r.optimizedSpend, 0);
  const totalOptimizedSales = comparisonData.reduce((s, r) => s + r.optimizedImpact, 0);
  const totalCurrentSpend = comparisonData.reduce((s, r) => s + r.currentSpend, 0);
  const salesUplift = totalOptimizedSales - currentBaselineSummary.estimatedSales;
  const salesUpliftPct = currentBaselineSummary.estimatedSales > 0
    ? Number(((salesUplift / currentBaselineSummary.estimatedSales) * 100).toFixed(1))
    : 0;

  // ── Save / load scenarios, persisted to the workflow (not localStorage) ──
  const [isSavingScenario, setIsSavingScenario] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const handleSaveScenario = async () => {
    if (!optResult) return;
    const newScenario = {
      id: `scen_${Date.now()}`,
      scenarioName: scenarioName.trim() || `Scenario v${savedScenarios.length + 1}`,
      scenarioType: scenarioType === 'fixed_budget' ? 'Fixed Budget' : 'Fixed Goal',
      targetValue,
      modelUsed: finalizedModel?.name || 'Finalized Model',
      createdAt: new Date().toISOString(),
      optimizedPlan: {
        totalSpend: totalOptimizedSpend,
        totalSales: totalOptimizedSales,
        roi: totalOptimizedSpend > 0 ? totalOptimizedSales / totalOptimizedSpend : 0,
      },
      allocation: optResult.allocation || {},
      status: optResult.feasible === false ? 'Infeasible Target' : optResult.converged === false ? 'At Boundary' : 'Optimal',
    };
    const updated = [newScenario, ...savedScenarios.filter((s) => s.scenarioName !== newScenario.scenarioName)];
    setSavedScenarios(updated);
    setIsSavingScenario(true);
    setSaveError(null);
    try {
      await updateWorkflow(workflowId, { state_data: { optimization: { savedScenarios: updated } } });
    } catch (err) {
      setSaveError(problemMessage(err, 'Could not save this scenario.'));
    } finally {
      setIsSavingScenario(false);
    }
  };

  const handleLoadScenario = (scen) => {
    setScenarioName(scen.scenarioName);
    setScenarioType(scen.scenarioType === 'Fixed Budget' ? 'fixed_budget' : 'fixed_goal');
    setTargetValue(scen.targetValue);
    if (scen.allocation) {
      setOptResult({ allocation: scen.allocation, feasible: scen.status === 'Optimal', converged: true });
    }
  };

  const handleExportCsv = () => {
    const csvRows = [
      'Channel,Current Spend,Optimized Spend,Delta Spend,Projected Impact,Optimized ROI',
      ...comparisonData.map((r) => `${r.channel},${r.currentSpend},${r.optimizedSpend},${r.deltaSpend},${r.optimizedImpact},${r.optimizedRoi}`),
    ].join('\n');
    const blob = new Blob([csvRows], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(scenarioName || 'optimization').replace(/\s+/g, '_')}_plan.csv`;
    a.click();
  };

  return (
    <div className="optimization-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Module 8: Scenario Planning &amp; Budget Optimization</p>
          <p className="page-header-subtitle">
            Allocate marketing budgets to maximize commercial impact, determine required spending for sales targets, customize channel constraints freely, and simulate scenarios.
          </p>
        </div>
      </div>

      {isLoadingWorkflow ? (
        <p className="opt-empty">Loading finalized model...</p>
      ) : workflowError ? (
        <div className="opt-error">{workflowError}</div>
      ) : !finalizedModel ? (
        <p className="opt-empty">No finalized model found — finalize one on the Model Output page first.</p>
      ) : (
        <>
          {/* ---- 1. Finalized Model Linkage ---- */}
          <div className="opt-card">
            <p className="opt-section-title">1. Finalized Model Linkage</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <p className="opt-section-desc" style={{ marginBottom: '0.2rem' }}>Active Source Model for Optimization:</p>
                <p style={{ fontSize: '1.05rem', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-primary)' }}>{finalizedModel.name}</p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span className="model-badge level">Level: {finalizedModel.level?.toUpperCase()}</span>
                <span className="model-badge type">Type: {finalizedModel.type?.toUpperCase()}</span>
                <span className="model-badge finalized">✓ Model Finalized</span>
              </div>
            </div>
            {coefficientDiagnostic && <div className="opt-error" style={{ marginTop: '0.8rem' }}>{coefficientDiagnostic}</div>}
            {isGeneratingCurves && <div className="opt-note" style={{ marginTop: '0.8rem' }}>⚡ Calibrating response curves from finalized model coefficients...</div>}
            {curvesError && <div className="opt-error" style={{ marginTop: '0.8rem' }}>{curvesError}</div>}
            {!hasCurves && !isGeneratingCurves && channelRows.length > 0 && (
              <div className="opt-note" style={{ marginTop: '0.8rem' }}>No response curve saturation schedules found yet for this model.</div>
            )}
          </div>

          {/* ---- 2. Create Optimization Scenario ---- */}
          <div className="opt-card">
            <p className="opt-section-title">2. Create Optimization Scenario</p>
            <p className="opt-section-desc">Choose whether to allocate a fixed budget for maximum outcome, or find the minimum spend to hit a target outcome.</p>

            <div className="opt-field">
              <label>Scenario Name</label>
              <input type="text" value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} placeholder="e.g. Q1 Budget Optimization" />
            </div>

            <div className="scenario-toggle">
              <button className={scenarioType === 'fixed_budget' ? 'active' : ''} onClick={() => setScenarioType('fixed_budget')}>Fixed Budget</button>
              <button className={scenarioType === 'fixed_goal' ? 'active' : ''} onClick={() => setScenarioType('fixed_goal')}>Fixed Goal</button>
            </div>

            <div className="opt-field">
              <label>{scenarioType === 'fixed_budget' ? 'Total Available Budget ($)' : 'Target Sales / Outcome (Units)'}</label>
              <input type="number" min="1" value={targetValue} onChange={(e) => setTargetValue(e.target.value)}
                placeholder={scenarioType === 'fixed_budget' ? 'e.g. 500000' : 'e.g. 100000'} />
            </div>
          </div>

          {/* ---- 3. Channel Constraints & Bounds ---- */}
          <div className="opt-card">
            <p className="opt-section-title">3. Channel Constraints &amp; Bounds</p>
            <p className="opt-section-desc">
              Edit the Min ($) and Max ($) constraints freely for any channel. Setting Min to $0 allows the optimizer to cut underperforming channels completely.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
              <button className="constraint-preset-btn" onClick={setAllMinToZero}>Set All Min to $0</button>
              <button className="constraint-preset-btn" onClick={() => applyConstraintPreset(0.8, 1.2)}>±20% Bounds</button>
              <button className="constraint-preset-btn" onClick={() => applyConstraintPreset(0.5, 2.0)}>±50% Bounds</button>
            </div>

            <div className="constraints-table-wrapper">
              <table className="constraints-table">
                <thead><tr><th>Channel</th><th>Current Spend</th><th>Min ($)</th><th>Max ($)</th><th>Allowed Range</th></tr></thead>
                <tbody>
                  {channelBounds.map((b, idx) => (
                    <tr key={b.channel}>
                      <td><strong>{b.channel}</strong></td>
                      <td>${Number(b.currentSpend || 0).toLocaleString()}</td>
                      <td><input type="number" step="1000" min="0" value={b.min} onChange={(e) => updateBound(idx, 'min', e.target.value)} placeholder="0" /></td>
                      <td><input type="number" step="1000" min="0" value={b.max} onChange={(e) => updateBound(idx, 'max', e.target.value)} placeholder="500000" /></td>
                      <td>${Number(b.min || 0).toLocaleString()} → ${Number(b.max || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {runError && <div className="opt-error">{runError}</div>}
            <button className="run-optimizer-btn" onClick={handleRunOptimizer} disabled={isRunning || !channelRows.length}>
              {isRunning ? 'Running Optimizer Engine...' : '▶ Run Optimizer'}
            </button>
          </div>

          {/* ---- 4. Projected Scenario Performance & Lift ---- */}
          {optResult && (
            <>
              <div className="opt-card">
                <p className="opt-section-title">4. Projected Scenario Performance &amp; Lift</p>

                {optResult.feasible === false && (
                  <div className="opt-error">
                    Target Unreachable Within Current Bounds — {optResult.message || `the highest achievable sales volume is ${optResult.max_possible_sales?.toLocaleString() || 'lower than your target'}. Increase Max Spend constraints on high-ROI channels to reach this target.`}
                  </div>
                )}
                {optResult.feasible !== false && optResult.converged === false && (
                  <div className="opt-note">
                    Every channel hit its Max constraint before the full {scenarioType === 'fixed_budget' ? 'budget could be allocated' : 'target could be reached'} —
                    {' '}${totalOptimizedSpend.toLocaleString()} was allocated instead of the requested {scenarioType === 'fixed_budget' ? `$${Number(targetValue).toLocaleString()}` : `${Number(targetValue).toLocaleString()} units`}.
                    Raise Max constraints on high-ROI channels to use the rest.
                  </div>
                )}

                <div className="opt-stat-row">
                  <div className="opt-stat-card"><p className="opt-stat-value">{optResult.feasible === false ? '⚠️ Infeasible' : optResult.converged === false ? 'At Boundary' : 'Optimal'}</p><p className="opt-stat-label">Scenario Status</p></div>
                  <div className="opt-stat-card"><p className="opt-stat-value">${totalOptimizedSpend.toLocaleString()}</p><p className="opt-stat-label">{scenarioType === 'fixed_budget' ? 'Total Allocated Budget' : 'Required Investment'}</p></div>
                  <div className="opt-stat-card"><p className="opt-stat-value">{Math.round(totalOptimizedSales).toLocaleString()}</p><p className="opt-stat-label">Projected Sales (Units)</p></div>
                  <div className="opt-stat-card">
                    <p className="opt-stat-value">{salesUplift >= 0 ? `+${salesUplift.toLocaleString()}` : salesUplift.toLocaleString()}</p>
                    <p className="opt-stat-label">Sales Lift ({salesUpliftPct >= 0 ? `+${salesUpliftPct}` : salesUpliftPct}%)</p>
                  </div>
                </div>

                <div className="compare-chart-wrapper">
                  <ResponsiveContainer width="100%" height={340}>
                    <BarChart data={comparisonData} margin={{ top: 10, right: 20, bottom: 70, left: 8 }}>
                      <CartesianGrid stroke={GRID} vertical={false} />
                      <XAxis dataKey="channel" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                             angle={-40} textAnchor="end" interval={0} height={70} />
                      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                             tickFormatter={(v) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                      <Bar dataKey="currentSpend" name="Current Plan Spend ($)" fill="#001E96" />
                      <Bar dataKey="optimizedSpend" name="Optimized Spend ($)" fill="#1ABC9C" />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="compare-legend">
                    <div className="compare-legend-item"><span className="compare-legend-swatch" style={{ backgroundColor: '#001E96' }} />Current Plan Spend</div>
                    <div className="compare-legend-item"><span className="compare-legend-swatch" style={{ backgroundColor: '#1ABC9C' }} />Optimized Spend</div>
                  </div>
                </div>

                <p className="opt-section-title" style={{ fontSize: '0.85rem', marginTop: 'var(--spacing-md)' }}>Channel Recommendations &amp; Spend Shift</p>
                <div className="alloc-table-wrapper">
                  <table className="alloc-table">
                    <thead><tr><th>Channel</th><th>Current Spend</th><th>Optimized Spend</th><th>Δ Spend</th><th>Projected Impact</th><th>ROI</th><th>Budget Share</th></tr></thead>
                    <tbody>
                      {comparisonData.map((r) => (
                        <tr key={r.channel}>
                          <td><strong>{r.channel}</strong></td>
                          <td>${r.currentSpend.toLocaleString()}</td>
                          <td>${r.optimizedSpend.toLocaleString()}</td>
                          <td className={r.deltaSpend >= 0 ? 'delta-positive' : 'delta-negative'}>
                            {r.deltaSpend >= 0 ? '+' : ''}${r.deltaSpend.toLocaleString()} ({r.deltaSpend >= 0 ? '+' : ''}{r.deltaPct}%)
                          </td>
                          <td>{r.optimizedImpact.toLocaleString()} Units</td>
                          <td>{r.optimizedRoi.toFixed(2)}x</td>
                          <td>{totalOptimizedSpend > 0 ? `${((r.optimizedSpend / totalOptimizedSpend) * 100).toFixed(1)}%` : '0%'}</td>
                        </tr>
                      ))}
                      <tr className="total-row">
                        <td>Total</td>
                        <td>${totalCurrentSpend.toLocaleString()}</td>
                        <td>${totalOptimizedSpend.toLocaleString()}</td>
                        <td></td>
                        <td>{Math.round(totalOptimizedSales).toLocaleString()} Units</td>
                        <td>{totalOptimizedSpend > 0 ? (totalOptimizedSales / totalOptimizedSpend).toFixed(2) : '0.00'}x</td>
                        <td>100%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {saveError && <div className="opt-error">{saveError}</div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginTop: 'var(--spacing-md)' }}>
                  <span className="opt-section-desc" style={{ marginBottom: 0 }}>Save this plan to your workflow's Scenario History for executive presentations and budget sign-off.</span>
                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <button className="constraint-preset-btn" onClick={handleExportCsv}>Export Plan CSV</button>
                    <button className="run-optimizer-btn" onClick={handleSaveScenario} disabled={isSavingScenario}>
                      {isSavingScenario ? 'Saving...' : 'Save Scenario'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ---- 5. Scenario History ---- */}
          <div className="opt-card">
            <p className="opt-section-title">5. Scenario History &amp; Saved Planning Runs</p>
            <p className="opt-section-desc">Compare saved planning scenarios against each other. Click any scenario to load its parameters back onto the screen.</p>
            {savedScenarios.length === 0 ? (
              <p className="opt-empty">No scenarios saved yet. Run an optimization and click Save Scenario.</p>
            ) : (
              <div className="alloc-table-wrapper">
                <table className="alloc-table">
                  <thead><tr><th>Scenario Name</th><th>Type</th><th>Target / Budget</th><th>Projected Sales</th><th>Projected Spend</th><th>Model Used</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {savedScenarios.map((s) => (
                      <tr key={s.id} onClick={() => handleLoadScenario(s)} style={{ cursor: 'pointer' }}>
                        <td><strong>{s.scenarioName}</strong></td>
                        <td>{s.scenarioType}</td>
                        <td>{s.scenarioType === 'Fixed Budget' ? `$${Number(s.targetValue).toLocaleString()}` : `${Number(s.targetValue).toLocaleString()} Units`}</td>
                        <td>{Math.round(s.optimizedPlan?.totalSales || 0).toLocaleString()} Units</td>
                        <td>${Math.round(s.optimizedPlan?.totalSpend || 0).toLocaleString()}</td>
                        <td>{s.modelUsed}</td>
                        <td><span className={`model-badge ${s.status === 'Optimal' ? 'finalized' : 'warn'}`}>{s.status}</span></td>
                        <td>
                          <button
                            type="button"
                            className="registry-action-btn"
                            onClick={(e) => { e.stopPropagation(); handleLoadScenario(s); }}
                          >
                            Load
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <PageFooterNav currentStepId="optimization" />
    </div>
  );
}

export default Optimization;