import { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import { v2ListArds, v2GetCsv, problemMessage, ensureWorkflow } from '../../services/api.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './ModelConfiguration.css';

// ─── Linear algebra for real OLS / Ridge regression ─────────────────────────
function transpose(m) { return m[0].map((_, c) => m.map((r) => r[c])); }
function matMul(a, b) {
  const bt = transpose(b);
  return a.map((row) => bt.map((col) => row.reduce((s, v, i) => s + v * col[i], 0)));
}
function invertMatrix(m) {
  const n = m.length;
  const aug = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
    const pivot = aug[col][col] || 1e-9;
    for (let c = 0; c < 2 * n; c++) aug[col][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let c = 0; c < 2 * n; c++) aug[r][c] -= factor * aug[col][c];
    }
  }
  return aug.map((row) => row.slice(n));
}
function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }

// Fits y ~ X (predictor columns) + intercept, with optional ridge penalty
// (lambda). Intercept is never regularized, per standard practice.
function fitRegression(y, predictorMatrix, lambda = 0) {
  const n = y.length;
  const p = predictorMatrix.length; // number of predictors
  const X = y.map((_, i) => [1, ...predictorMatrix.map((col) => col[i])]);
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);

  if (lambda > 0) {
    for (let i = 1; i <= p; i++) XtX[i][i] += lambda; // skip intercept (index 0)
  }

  const XtXinv = invertMatrix(XtX);
  const Xty = Xt.map((row) => [row.reduce((s, v, i) => s + v * y[i], 0)]);
  const beta = matMul(XtXinv, Xty).map((r) => r[0]);

  const yHat = X.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
  const residuals = y.map((v, i) => v - yHat[i]);
  const yMean = mean(y);
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { intercept: beta[0], coefficients: beta.slice(1), yHat, residuals, r2, n };
}

function isDateLike(col) { return /date|week|month|period/i.test(col); }
function isDimensionLike(col) { return /id$|_id|npi|dma|zip|code|geo/i.test(col); }
function isNumericColumn(rows, col) { return rows.some((r) => typeof r[col] === 'number'); }

const HISTORY_KEY = 'mmm_model_history';

function ModelConfiguration() {
  const [workflowId, setWorkflowId] = useState(null);
  const [allArds, setAllArds] = useState([]);
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [modelLevel, setModelLevel] = useState('hcp'); // 'hcp' | 'dma'
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [dateKey, setDateKey] = useState('');
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  const [modelName, setModelName] = useState('');
  const [modelType, setModelType] = useState('ols'); // 'ols' | 'ridge' | 'bayesian'
  const [independentVars, setIndependentVars] = useState(new Set());
  const [dependentVar, setDependentVar] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [ridgeLambda, setRidgeLambda] = useState(1.0);

  const [dmaMode, setDmaMode] = useState('standalone'); // 'standalone' | 'residual'
  const [residualSourceId, setResidualSourceId] = useState('');

  const [runStatus, setRunStatus] = useState('idle'); // idle | queued | running | complete | failed
  const [runError, setRunError] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const [modelHistory, setModelHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });

  useEffect(() => {
    (async () => {
      setIsLoadingArds(true);
      setLoadError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const data = await v2ListArds(id);
        setAllArds(data.items || []);
      } catch (err) {
        setLoadError(problemMessage(err, 'Could not load ARDs for this workflow.'));
      } finally {
        setIsLoadingArds(false);
      }
    })();
  }, []);

  const ardsForLevel = useMemo(
    () => allArds.filter((a) => (a.grain || '').toLowerCase() === modelLevel),
    [allArds, modelLevel]
  );

  useEffect(() => {
    if (ardsForLevel.length && !ardsForLevel.some((a) => a.filename === selectedArdFilename)) {
      setSelectedArdFilename(ardsForLevel[0].filename);
    }
    if (!ardsForLevel.length) setSelectedArdFilename('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ardsForLevel]);

  const loadArdData = async (filename) => {
    if (!filename || !workflowId) return;
    setIsLoadingData(true);
    setDataError(null);
    setRunResult(null);
    setRunStatus('idle');
    try {
      const csvText = await v2GetCsv(workflowId, filename);
      const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
      const cols = parsed.meta.fields || [];
      setColumns(cols);
      setRows(parsed.data);

      const guessedDate = cols.find(isDateLike) || '';
      setDateKey(guessedDate);
      const dates = parsed.data.map((r) => r[guessedDate]).filter(Boolean).sort();
      setStartDate(dates[0] || '');
      setEndDate(dates[dates.length - 1] || '');

      setIndependentVars(new Set());
      setDependentVar('');
    } catch (err) {
      setDataError(problemMessage(err, 'Could not load this dataset.'));
      setRows([]); setColumns([]);
    } finally {
      setIsLoadingData(false);
    }
  };

  useEffect(() => {
    if (selectedArdFilename && workflowId) loadArdData(selectedArdFilename);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArdFilename, workflowId]);

  const candidateVars = useMemo(
    () => columns.filter((c) => c !== dateKey && !isDimensionLike(c) && isNumericColumn(rows, c)),
    [columns, rows, dateKey]
  );

  const toggleIndependentVar = (col) => {
    setIndependentVars((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const priorHcpModels = useMemo(() => modelHistory.filter((m) => m.level === 'hcp'), [modelHistory]);

  const validate = () => {
    if (!modelName.trim()) return 'Model name is required.';
    if (!selectedArdFilename) return 'Select an ARD table for this level.';
    if (independentVars.size === 0) return 'Select at least one independent variable.';
    if (!dependentVar) return 'Select a dependent variable.';
    if (!startDate || !endDate) return 'Set a training time period.';
    if (modelType === 'ridge' && (!ridgeLambda || ridgeLambda <= 0)) return 'Ridge penalty (lambda) must be a positive number.';
    if (modelType === 'bayesian') return 'Bayesian regression is not available in this release.';
    if (modelLevel === 'dma' && dmaMode === 'residual' && !residualSourceId) {
      return 'Pick an HCP-level model to pull the residual from.';
    }
    return null;
  };

  const handleRunModel = async () => {
    const err = validate();
    if (err) { setRunError(err); return; }
    setRunError(null);
    setRunStatus('queued');

    // Brief queued -> running transition so the status is genuinely visible,
    // not just a flash, per the "clear run action" requirement.
    await new Promise((r) => setTimeout(r, 300));
    setRunStatus('running');
    await new Promise((r) => setTimeout(r, 500));

    try {
      const windowRows = rows.filter((r) => r[dateKey] >= startDate && r[dateKey] <= endDate);
      let indepList = Array.from(independentVars);
      let predictorMatrix = indepList.map((col) => windowRows.map((r) => Number(r[col]) || 0));

      // Residual mode: merge the source HCP model's residual series in by
      // date (mean residual per date), as an additional predictor. This is
      // a date-level proxy, not a true per-HCP-to-DMA geographic rollup —
      // flagged since that would need a mapping-file join we don't have here.
      if (modelLevel === 'dma' && dmaMode === 'residual') {
        const source = modelHistory.find((m) => m.id === residualSourceId);
        if (!source) throw new Error('Selected residual source model not found.');
        const residualByDate = source.residualsByDate || {};
        const residualCol = windowRows.map((r) => residualByDate[r[dateKey]] ?? 0);
        predictorMatrix = [...predictorMatrix, residualCol];
        indepList = [...indepList, `hcp_residual(${source.name})`];
      }

      const y = windowRows.map((r) => Number(r[dependentVar]) || 0);
      const lambda = modelType === 'ridge' ? ridgeLambda : 0;
      const fit = fitRegression(y, predictorMatrix, lambda);

      // For HCP-level models, precompute a residual-by-date series so this
      // run can later serve as a residual source for a DMA-level model.
      let residualsByDate = null;
      if (modelLevel === 'hcp') {
        const grouped = {};
        windowRows.forEach((r, i) => {
          const d = r[dateKey];
          (grouped[d] = grouped[d] || []).push(fit.residuals[i]);
        });
        residualsByDate = Object.fromEntries(Object.entries(grouped).map(([d, vals]) => [d, mean(vals)]));
      }

      const result = {
        id: `model-${Date.now()}`,
        name: modelName.trim(),
        level: modelLevel,
        type: modelType,
        ardFilename: selectedArdFilename,
        independentVars: indepList,
        dependentVar,
        startDate, endDate,
        ridgeLambda: modelType === 'ridge' ? ridgeLambda : null,
        dmaMode: modelLevel === 'dma' ? dmaMode : null,
        residualSourceId: dmaMode === 'residual' ? residualSourceId : null,
        intercept: fit.intercept,
        coefficients: indepList.map((name, i) => ({ name, value: fit.coefficients[i] })),
        r2: fit.r2,
        n: fit.n,
        residualsByDate,
        createdAt: new Date().toISOString(),
      };

      setRunResult(result);
      setRunStatus('complete');

      setModelHistory((prev) => {
        const next = [result, ...prev].slice(0, 30);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota errors */ }
        return next;
      });
    } catch (err) {
      setRunStatus('failed');
      setRunError(err.message || 'Model run failed — check your variable selection and try again.');
    }
  };

  return (
    <div className="model-config-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Model Configuration</p>
          <p className="page-header-subtitle">
            Configure and run a regression model against your transformed variables, at the HCP or DMA level.
          </p>
        </div>
      </div>

      {isLoadingArds && <p className="mc-empty">Loading ARDs...</p>}
      {!isLoadingArds && loadError && <div className="mc-error-banner">{loadError}</div>}

      {!isLoadingArds && !loadError && (
        <>
          {/* ---- Model level + ARD ---- */}
          <div className="mc-card">
            {/* <p className="mc-card-heading">Model Level</p>
            <div className="level-toggle">
              <button className={modelLevel === 'hcp' ? 'active' : ''} onClick={() => setModelLevel('hcp')}>HCP-Level</button>
              <button className={modelLevel === 'dma' ? 'active' : ''} onClick={() => setModelLevel('dma')}>DMA-Level</button>
            </div> */}

            {ardsForLevel.length === 0 ? (
              <p className="mc-empty">
                No {modelLevel.toUpperCase()}-level ARDs found — build one on the Data Stitching &amp; ARD Creation page first.
              </p>
            ) : (
              <div className="mc-field-row">
                <div className="mc-field required">
                  <label>Model Name</label>
                  <input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="e.g. Q4 HCP Base Model v1" maxLength={200} />
                </div>
                <div className="mc-field">
                  <label>ARD Table</label>
                  <select value={selectedArdFilename} onChange={(e) => setSelectedArdFilename(e.target.value)}>
                    {ardsForLevel.map((a) => (
                      <option key={a.filename} value={a.filename}>{a.filename} ({(a.row_count ?? 0).toLocaleString()} rows)</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {isLoadingData && <p className="mc-empty">Loading dataset...</p>}
          {dataError && <div className="mc-error-banner">{dataError}</div>}

          {!isLoadingData && !dataError && rows.length > 0 && ardsForLevel.length > 0 && (
            <>
              {/* ---- Variables & model type ---- */}
              <div className="mc-card">
                <p className="mc-section-title">Variables &amp; Model Type</p>

                <div className="mc-field required" style={{ marginBottom: 'var(--spacing-md)' }}>
                  <label>Independent Variables (multi-select)</label>
                  <div className="var-pill-box">
                    {candidateVars.map((c) => (
                      <span key={c} className={`var-pill${independentVars.has(c) ? ' selected' : ''}`} onClick={() => toggleIndependentVar(c)}>
                        {independentVars.has(c) ? '✓ ' : '+ '}{c}
                      </span>
                    ))}
                  </div>
                  <p className="selected-count-note">{independentVars.size} selected</p>
                </div>

                <div className="mc-field-row">
                  <div className="mc-field required">
                    <label>Dependent Variable</label>
                    <select value={dependentVar} onChange={(e) => setDependentVar(e.target.value)}>
                      <option value="">Select...</option>
                      {candidateVars.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="mc-field required">
                    <label>Time Period</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                      <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                    </div>
                  </div>
                </div>

                <div className="mc-field" style={{ marginBottom: 'var(--spacing-md)' }}>
                  <label>Model Type</label>
                  <div className="model-type-row">
                    <button className={`model-type-btn${modelType === 'ols' ? ' selected' : ''}`} onClick={() => setModelType('ols')}>OLS</button>
                    <button className={`model-type-btn${modelType === 'ridge' ? ' selected' : ''}`} onClick={() => setModelType('ridge')}>Ridge</button>
                    <button className="model-type-btn" disabled title="Not available in this release">
                      Bayesian
                      <span className="disabled-tag"></span>
                    </button>
                  </div>
                </div>

                {modelType === 'ridge' && (
                  <div className="mc-field required" style={{ maxWidth: 260 }}>
                    <label>Ridge Penalty (λ)</label>
                    <input type="number" step="0.1" min="0.01" value={ridgeLambda} onChange={(e) => setRidgeLambda(Number(e.target.value))} />
                  </div>
                )}
              </div>

              {/* ---- DMA mode (DMA level only) ---- */}
              {modelLevel === 'dma' && (
                <div className="mc-card">
                  <p className="mc-section-title">DMA Model Mode</p>
                  <div className="dma-mode-toggle">
                    <button className={dmaMode === 'standalone' ? 'active' : ''} onClick={() => setDmaMode('standalone')}>Standalone</button>
                    <button className={dmaMode === 'residual' ? 'active' : ''} onClick={() => setDmaMode('residual')}>Residual</button>
                  </div>

                  {dmaMode === 'residual' && (
                    <>
                      <div className="mc-field required" style={{ maxWidth: 420 }}>
                        <label>HCP-Level Model (residual source)</label>
                        <select value={residualSourceId} onChange={(e) => setResidualSourceId(e.target.value)}>
                          <option value="">Select a prior HCP-level model...</option>
                          {priorHcpModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.name} (R²={m.r2.toFixed(3)})</option>
                          ))}
                        </select>
                      </div>
                      {priorHcpModels.length === 0 && (
                        <p className="mc-empty">No HCP-level models run yet — run one first to use as a residual source.</p>
                      )}
                      <p className="residual-note">
                        The selected HCP-level model's residual sales impact is aggregated by date and added as an
                        extra predictor here, so this DMA model explains variation left over from that HCP model.
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* ---- Run action ---- */}
              <div className="mc-card">
                {runError && <div className="mc-error-banner">{runError}</div>}
                <div className="run-row">
                  <button className="run-model-btn" onClick={handleRunModel} disabled={runStatus === 'queued' || runStatus === 'running'}>
                    ▶ Run Model
                  </button>
                  {runStatus !== 'idle' && (
                    <span className={`run-status-badge ${runStatus}`}>
                      {runStatus === 'queued' && 'Queued'}
                      {runStatus === 'running' && 'Running...'}
                      {runStatus === 'complete' && '✓ Complete'}
                      {runStatus === 'failed' && '✕ Failed'}
                    </span>
                  )}
                </div>
              </div>

              {/* ---- Results ---- */}
              {runResult && (
                <div className="mc-card">
                  <p className="mc-section-title">Model Results: {runResult.name}</p>
                  <div className="result-stat-row">
                    <div className="result-stat-card"><p className="result-stat-value">{runResult.r2.toFixed(3)}</p><p className="result-stat-label">R²</p></div>
                    <div className="result-stat-card"><p className="result-stat-value">{runResult.n}</p><p className="result-stat-label">Observations</p></div>
                    <div className="result-stat-card"><p className="result-stat-value">{runResult.intercept.toFixed(3)}</p><p className="result-stat-label">Intercept</p></div>
                    <div className="result-stat-card"><p className="result-stat-value">{runResult.type.toUpperCase()}</p><p className="result-stat-label">Model Type</p></div>
                  </div>
                  <table className="coef-table">
                    <thead><tr><th>Variable</th><th>Coefficient</th></tr></thead>
                    <tbody>
                      {runResult.coefficients.map((c) => (
                        <tr key={c.name}>
                          <td>{c.name}</td>
                          <td className={c.value >= 0 ? 'coef-positive' : 'coef-negative'}>{c.value.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {runResult.level === 'hcp' && (
                    <p className="residual-note" style={{ marginTop: 'var(--spacing-md)' }}>
                      This model's residuals are now available as a source for a DMA-level residual model.
                    </p>
                  )}
                </div>
              )}

              {/* ---- Model history ---- */}
              {modelHistory.length > 0 && (
                <div className="mc-card">
                  <p className="mc-card-heading">Model History (this browser)</p>
                  <div className="history-list">
                    {modelHistory.map((m) => (
                      <div key={m.id} className="history-item">
                        <div>
                          <p className="history-item-title">{m.name} <span className="grain-badge" style={{ marginLeft: '0.4rem' }}>{m.level.toUpperCase()}</span></p>
                          <p className="history-item-meta">{m.type.toUpperCase()} · {m.independentVars.length} vars · {new Date(m.createdAt).toLocaleString()}</p>
                        </div>
                        <span className="history-item-r2">R² {m.r2.toFixed(3)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <PageFooterNav currentStepId="model-configuration" />
    </div>
  );
}

export default ModelConfiguration;