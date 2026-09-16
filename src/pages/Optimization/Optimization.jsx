import { useState, useEffect, useMemo } from 'react';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './Optimization.css';

const HISTORY_KEY = 'mmm_model_history';
const FINALIZED_KEY = 'mmm_finalized_model';
const spendKeyFor = (modelId) => `mmm_spend_${modelId}`;
const constraintsKeyFor = (modelId) => `mmm_constraints_${modelId}`;

function Optimization() {
  const [modelHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const finalizedId = localStorage.getItem(FINALIZED_KEY) || '';
  const finalizedModel = modelHistory.find((m) => m.id === finalizedId) || null;

  const [currentSpend, setCurrentSpend] = useState({});
  useEffect(() => {
    if (!finalizedModel) return;
    try { setCurrentSpend(JSON.parse(localStorage.getItem(spendKeyFor(finalizedModel.id)) || '{}')); }
    catch { setCurrentSpend({}); }
  }, [finalizedModel?.id]);

  // ── Per-channel unit cost, derived from real current spend ÷ real exposure ──
  // If a channel has no current spend entered on Model Output, there's no
  // real $-per-unit conversion available — flagged per-channel rather than
  // silently assuming a cost.
  const channelMath = useMemo(() => {
    if (!finalizedModel) return [];
    return finalizedModel.coefficients.map((c) => {
      const stats = finalizedModel.predictorStats?.[c.name] || {};
      const spend = Number(currentSpend[c.name]) || 0;
      const exposure = stats.sum ?? 0;
      const unitCost = spend > 0 && exposure > 0 ? spend / exposure : null;
      // Marginal ROI per dollar — constant here because the underlying
      // response is linear (coefficient × exposure); see Model Output's
      // note on why raw-spend saturation isn't wired in yet.
      const marginalRoi = unitCost ? c.value / unitCost : null;
      return { name: c.name, coefficient: c.value, currentSpend: spend, unitCost, marginalRoi };
    });
  }, [finalizedModel, currentSpend]);

  const usableChannels = channelMath.filter((c) => c.unitCost !== null);
  const unusableChannels = channelMath.filter((c) => c.unitCost === null);

  const [scenario, setScenario] = useState('budget'); // 'budget' | 'goal'
  const [totalBudget, setTotalBudget] = useState('');
  const [targetOutcome, setTargetOutcome] = useState('');

  const [constraints, setConstraints] = useState({});
  useEffect(() => {
    if (!finalizedModel) return;
    try {
      const stored = JSON.parse(localStorage.getItem(constraintsKeyFor(finalizedModel.id)) || '{}');
      setConstraints(stored);
    } catch { setConstraints({}); }
  }, [finalizedModel?.id]);

  const updateConstraint = (channel, key, value) => {
    setConstraints((prev) => {
      const next = { ...prev, [channel]: { ...prev[channel], [key]: value } };
      try { localStorage.setItem(constraintsKeyFor(finalizedModel.id), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const constraintFor = (channel) => {
    const c = constraints[channel] || {};
    return {
      min: c.min !== undefined && c.min !== '' ? Number(c.min) : 0,
      max: c.max !== undefined && c.max !== '' ? Number(c.max) : Infinity,
    };
  };

  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);

  // ── The optimizer itself: greedy fill by marginal ROI ──────────────────
  // This is the mathematically correct global optimum for a LINEAR
  // objective under box (min/max) constraints — not a heuristic
  // approximation. It would need to become an iterative/marginal-utility
  // solver instead once real diminishing-returns curves are wired in.
  const runOptimizer = () => {
    setRunError(null);
    if (usableChannels.length === 0) {
      setRunError('No channel has a usable $-per-unit cost yet — enter current spend for at least one channel on Model Output first.');
      return;
    }

    const allocation = {};
    usableChannels.forEach((c) => { allocation[c.name] = constraintFor(c.name).min; });

    const sumMin = usableChannels.reduce((s, c) => s + constraintFor(c.name).min, 0);

    if (scenario === 'budget') {
      const budget = Number(totalBudget);
      if (!budget || budget <= 0) { setRunError('Enter a total budget greater than 0.'); return; }
      if (sumMin > budget) { setRunError(`Minimum constraints alone total ${sumMin.toLocaleString()}, which exceeds your budget of ${budget.toLocaleString()}.`); return; }

      let remaining = budget - sumMin;
      const ranked = [...usableChannels].sort((a, b) => b.marginalRoi - a.marginalRoi);
      ranked.forEach((c) => {
        if (remaining <= 0) return;
        const { max, min } = constraintFor(c.name);
        const room = max - min;
        const add = Math.min(room, remaining);
        allocation[c.name] += add;
        remaining -= add;
      });

      const leftover = remaining;
      finish(allocation, budget, null, leftover);
    } else {
      const target = Number(targetOutcome);
      if (!target || target <= 0) { setRunError('Enter a target outcome greater than 0.'); return; }

      let cumulative = usableChannels.reduce((s, c) => s + allocation[c.name] * c.marginalRoi, 0);
      const ranked = [...usableChannels].sort((a, b) => b.marginalRoi - a.marginalRoi);
      let reached = cumulative >= target;

      ranked.forEach((c) => {
        if (reached) return;
        const { max, min } = constraintFor(c.name);
        const room = max - min;
        const remainingGap = (target - cumulative) / c.marginalRoi;
        const add = Math.min(room, Math.max(0, remainingGap));
        allocation[c.name] += add;
        cumulative += add * c.marginalRoi;
        if (cumulative >= target) reached = true;
      });

      if (!reached) {
        setRunError(`Target not reachable within the given max constraints — best achievable is ${cumulative.toLocaleString(undefined, { maximumFractionDigits: 0 })} of your ${target.toLocaleString()} target.`);
      }
      const totalSpend = Object.values(allocation).reduce((a, b) => a + b, 0);
      finish(allocation, totalSpend, target, 0, !reached);
    }
  };

  const finish = (allocation, totalSpend, target, leftover, targetMissed = false) => {
    const rows = usableChannels.map((c) => {
      const optimizedSpend = allocation[c.name];
      const projectedImpact = optimizedSpend * c.marginalRoi;
      const currentImpact = c.currentSpend * c.marginalRoi;
      return {
        name: c.name,
        currentSpend: c.currentSpend,
        optimizedSpend,
        delta: optimizedSpend - c.currentSpend,
        projectedImpact,
        currentImpact,
        roi: optimizedSpend > 0 ? projectedImpact / optimizedSpend : 0,
      };
    });
    const totalProjectedImpact = rows.reduce((s, r) => s + r.projectedImpact, 0);
    const totalCurrentImpact = rows.reduce((s, r) => s + r.currentImpact, 0);
    setResult({ rows, totalSpend, totalProjectedImpact, totalCurrentImpact, target, leftover, targetMissed });
  };

  return (
    <div className="optimization-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Optimization</p>
          <p className="page-header-subtitle">
            Run constrained budget optimization on top of your finalized model's response curves.
          </p>
        </div>
      </div>

      {!finalizedModel ? (
        <p className="opt-empty">No finalized model found — finalize one on the Model Output page first.</p>
      ) : (
        <>
          <div className="opt-card">
            <p className="opt-section-title">Scenario: {finalizedModel.name}</p>
            <p className="opt-section-desc">
              Choose whether to allocate a fixed budget for maximum outcome, or find the minimum spend to hit a target outcome.
            </p>

            {unusableChannels.length > 0 && (
              <div className="opt-note">
                {unusableChannels.length} channel(s) have no $-per-unit cost yet (no current spend entered on Model
                Output) and are excluded from optimization: {unusableChannels.map((c) => c.name).join(', ')}.
              </div>
            )}

            <div className="scenario-toggle">
              <button className={scenario === 'budget' ? 'active' : ''} onClick={() => setScenario('budget')}>Fixed Budget</button>
              <button className={scenario === 'goal' ? 'active' : ''} onClick={() => setScenario('goal')}>Fixed Goal</button>
            </div>

            {scenario === 'budget' ? (
              <div className="opt-field">
                <label>Total Budget ($)</label>
                <input type="number" min="0" value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} placeholder="e.g. 500000" />
              </div>
            ) : (
              <div className="opt-field">
                <label>Target Outcome (incremental impact)</label>
                <input type="number" min="0" value={targetOutcome} onChange={(e) => setTargetOutcome(e.target.value)} placeholder="e.g. 20000" />
              </div>
            )}

            <p className="opt-section-title" style={{ fontSize: '0.85rem', marginTop: 'var(--spacing-md)' }}>Per-Channel Constraints</p>
            <div className="constraints-table-wrapper">
              <table className="constraints-table">
                <thead><tr><th>Channel</th><th>$ / Unit</th><th>Min Spend</th><th>Max Spend</th></tr></thead>
                <tbody>
                  {channelMath.map((c) => {
                    const con = constraintFor(c.name);
                    return (
                      <tr key={c.name}>
                        <td><strong>{c.name}</strong></td>
                        <td>{c.unitCost !== null ? `$${c.unitCost.toFixed(3)}` : <span className="no-unit-cost-tag">No spend entered</span>}</td>
                        <td>
                          <input type="number" min="0" disabled={c.unitCost === null}
                            value={constraints[c.name]?.min ?? ''} placeholder="0"
                            onChange={(e) => updateConstraint(c.name, 'min', e.target.value)} />
                        </td>
                        <td>
                          <input type="number" min="0" disabled={c.unitCost === null}
                            value={constraints[c.name]?.max ?? ''} placeholder="No max"
                            onChange={(e) => updateConstraint(c.name, 'max', e.target.value)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {runError && <div className="opt-error">{runError}</div>}
            <button className="run-optimizer-btn" onClick={runOptimizer} disabled={usableChannels.length === 0}>
              ▶ Run Optimizer
            </button>
          </div>

          {result && (
            <>
              <div className="opt-card">
                <p className="opt-section-title">Optimized Allocation</p>
                <div className="opt-stat-row">
                  <div className="opt-stat-card"><p className="opt-stat-value">${result.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p><p className="opt-stat-label">Total Spend</p></div>
                  <div className="opt-stat-card"><p className="opt-stat-value">{result.totalProjectedImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p><p className="opt-stat-label">Projected Impact</p></div>
                  <div className="opt-stat-card"><p className="opt-stat-value">{(result.totalProjectedImpact / result.totalSpend).toFixed(2)}x</p><p className="opt-stat-label">Blended ROI</p></div>
                  <div className="opt-stat-card">
                    <p className="opt-stat-value">
                      {result.totalCurrentImpact > 0 ? `${(((result.totalProjectedImpact - result.totalCurrentImpact) / result.totalCurrentImpact) * 100).toFixed(1)}%` : '—'}
                    </p>
                    <p className="opt-stat-label">Impact Lift vs. Current</p>
                  </div>
                </div>

                {scenario === 'budget' && result.leftover > 0.01 && (
                  <div className="opt-note">
                    ${result.leftover.toLocaleString(undefined, { maximumFractionDigits: 0 })} of budget couldn't be
                    allocated — every channel hit its max constraint.
                  </div>
                )}

                <div className="alloc-table-wrapper">
                  <table className="alloc-table">
                    <thead><tr><th>Channel</th><th>Current Spend</th><th>Optimized Spend</th><th>Δ Spend</th><th>Projected Impact</th><th>ROI</th></tr></thead>
                    <tbody>
                      {result.rows.map((r) => (
                        <tr key={r.name}>
                          <td><strong>{r.name}</strong></td>
                          <td>${r.currentSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td>${r.optimizedSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className={r.delta >= 0 ? 'delta-positive' : 'delta-negative'}>
                            {r.delta >= 0 ? '+' : ''}{r.delta.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td>{r.projectedImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td>{r.roi.toFixed(2)}x</td>
                        </tr>
                      ))}
                      <tr className="total-row">
                        <td>Total</td>
                        <td>${result.rows.reduce((s, r) => s + r.currentSpend, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td>${result.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td></td>
                        <td>{result.totalProjectedImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td>{(result.totalProjectedImpact / result.totalSpend).toFixed(2)}x</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="opt-card">
                <p className="opt-section-title">Optimized vs. Current Allocation by Channel</p>
                <div className="compare-chart-wrapper">
                  <CompareBarChart rows={result.rows} />
                  <div className="compare-legend">
                    <div className="compare-legend-item"><span className="compare-legend-swatch" style={{ backgroundColor: '#94a3b8' }} />Current</div>
                    <div className="compare-legend-item"><span className="compare-legend-swatch" style={{ backgroundColor: '#1d4ed8' }} />Optimized</div>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function CompareBarChart({ rows }) {
  const width = 900, height = 300, padding = 50;
  const maxVal = Math.max(...rows.flatMap((r) => [r.currentSpend, r.optimizedSpend]), 1);
  const groupWidth = (width - padding * 2) / rows.length;
  const barWidth = groupWidth * 0.32;
  const yScale = (v) => height - padding - (v / maxVal) * (height - padding * 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padding + t * (height - padding * 2);
        return <line key={t} x1={padding} x2={width - padding} y1={y} y2={y} stroke="#eef1f6" strokeWidth="1" />;
      })}
      {rows.map((r, i) => {
        const groupX = padding + i * groupWidth + groupWidth / 2;
        return (
          <g key={r.name}>
            <rect x={groupX - barWidth - 2} y={yScale(r.currentSpend)} width={barWidth} height={height - padding - yScale(r.currentSpend)} fill="#94a3b8" />
            <rect x={groupX + 2} y={yScale(r.optimizedSpend)} width={barWidth} height={height - padding - yScale(r.optimizedSpend)} fill="#1d4ed8" />
            <text x={groupX} y={height - padding + 16} fontSize="9" fill="#8a94a3" textAnchor="middle">{r.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default Optimization;