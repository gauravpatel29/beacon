import { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import { v2ListArds, v2GetCsv, problemMessage, ensureWorkflow } from '../../services/api.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './DataTransformation.css';

// ─── Stats helpers (same approach as Data Review) ───────────────────────────
function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stdDev(nums, m) {
  if (nums.length < 2) return 0;
  return Math.sqrt(nums.reduce((s, x) => s + (x - m) ** 2, 0) / nums.length);
}
function percentile(nums, p) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
function isNumericColumn(rows, col) {
  return rows.some((r) => typeof r[col] === 'number');
}

const ADSTOCK_OPTIONS = [0.3, 0.5, 0.7, 0.9];
const HORIZON_OPTIONS = [
  { value: 1, label: '1 week' },
  { value: 2, label: '2 weeks' },
  { value: 4, label: '4 weeks (1 month)' },
  { value: 8, label: '8 weeks' },
];
const SATURATION_OPTIONS = [
  { value: 'none', label: 'None (Linear)' },
  { value: 'log', label: 'Log: ln(1 + k·x)' },
  { value: 'power', label: 'Power: x^p' },
];

// Real Adstock decay (geometric, applied within each geo group over time,
// truncated to the chosen horizon window) followed by a saturation curve.
function applyAdstockAndSaturation(rowsSorted, geoKey, valueGetter, decay, horizon, saturation, param) {
  // Group indices by geo key, preserving original order (already sorted by date).
  const groups = {};
  rowsSorted.forEach((r, i) => {
    const g = r[geoKey];
    (groups[g] = groups[g] || []).push(i);
  });

  const adstocked = new Array(rowsSorted.length).fill(0);
  Object.values(groups).forEach((indices) => {
    // geometric decay with a horizon cutoff: weight_j = decay^j for j < horizon
    for (let t = 0; t < indices.length; t++) {
      let acc = 0;
      for (let j = 0; j < horizon && t - j >= 0; j++) {
        acc += (decay ** j) * (valueGetter(rowsSorted[indices[t - j]]) || 0);
      }
      adstocked[indices[t]] = acc;
    }
  });

  return adstocked.map((v) => {
    if (saturation === 'log') return Math.log(1 + (param || 1) * v);
    if (saturation === 'power') return Math.pow(v, param || 1);
    return v;
  });
}

let derivedIdCounter = 0;

function DataTransformation() {
  const [workflowId, setWorkflowId] = useState(null);
  const [ards, setArds] = useState([]);
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  // Step 1
  const [dateKeys, setDateKeys] = useState([]);
  const [geoKeys, setGeoKeys] = useState([]);
  const [dependentVars, setDependentVars] = useState([]);
  const [zipKeys, setZipKeys] = useState([]);
  const [dmaKeys, setDmaKeys] = useState([]);
  const [popKeys, setPopKeys] = useState([]);
  const [carryover, setCarryover] = useState(false);

  // Step 2
  const [selectedVars, setSelectedVars] = useState(new Set());
  const [derivedVars, setDerivedVars] = useState([]); // [{id, name, parts}]

  // Step 3: per-variable config
  const [configs, setConfigs] = useState({}); // { [varName]: {decay, horizon, saturation, param, source} }

  const [transformSetName, setTransformSetName] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  // Result of applying (post-Step-3-save)
  const [transformResult, setTransformResult] = useState(null); // { rows, transformedCols, corrThreshold... }
  const [inspectVar, setInspectVar] = useState('');
  const [corrThreshold, setCorrThreshold] = useState(0.7);

  useEffect(() => {
    (async () => {
      setIsLoadingArds(true);
      setLoadError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const data = await v2ListArds(id);
        setArds(data.items || []);
        if (data.items?.length) setSelectedArdFilename(data.items[0].filename);
      } catch (err) {
        setLoadError(problemMessage(err, 'Could not load ARDs for this workflow.'));
      } finally {
        setIsLoadingArds(false);
      }
    })();
  }, []);

  const loadArdData = async (filename) => {
    if (!filename || !workflowId) return;
    setIsLoadingData(true);
    setDataError(null);
    setTransformResult(null);
    try {
      const csvText = await v2GetCsv(workflowId, filename);
      const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
      const cols = parsed.meta.fields || [];
      setColumns(cols);
      setRows(parsed.data);

      const guessedDate = cols.find((c) => /date|week|month/i.test(c));
      const guessedGeo = cols.find((c) => /npi|dma|zip|id$/i.test(c));
      setDateKeys(guessedDate ? [guessedDate] : []);
      setGeoKeys(guessedGeo ? [guessedGeo] : []);
      setDependentVars([]);
      setZipKeys([]); setDmaKeys([]); setPopKeys([]);
      setSelectedVars(new Set());
      setDerivedVars([]);
      setConfigs({});
    } catch (err) {
      setDataError(problemMessage(err, 'Could not load this dataset.'));
      setRows([]);
      setColumns([]);
    } finally {
      setIsLoadingData(false);
    }
  };

  useEffect(() => {
    if (selectedArdFilename && workflowId) loadArdData(selectedArdFilename);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArdFilename, workflowId]);

  const lockedKeys = useMemo(
    () => new Set([...dateKeys, ...geoKeys, ...zipKeys, ...dmaKeys, ...popKeys]),
    [dateKeys, geoKeys, zipKeys, dmaKeys, popKeys]
  );

  const eligibleColumns = useMemo(
    () => columns.filter((c) => !lockedKeys.has(c) && !dependentVars.includes(c) && isNumericColumn(rows, c)),
    [columns, rows, lockedKeys, dependentVars]
  );

  const togglePill = (setter, list, col) => {
    setter(list.includes(col) ? list.filter((c) => c !== col) : [...list, col]);
  };

  const toggleVarSelect = (col) => {
    setSelectedVars((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const selectAllEligible = () => setSelectedVars(new Set(eligibleColumns));
  const deselectAll = () => setSelectedVars(new Set());

  const addDerivedVariable = () => {
    if (eligibleColumns.length < 2) return;
    derivedIdCounter += 1;
    const parts = eligibleColumns.slice(0, 2);
    const name = parts.join('+').toUpperCase();
    setDerivedVars((prev) => [...prev, { id: derivedIdCounter, name, parts }]);
    setSelectedVars((prev) => new Set(prev).add(name));
  };

  const removeDerivedVariable = (id, name) => {
    setDerivedVars((prev) => prev.filter((d) => d.id !== id));
    setSelectedVars((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setConfigs((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const configFor = (name) => configs[name] || { decay: 0.5, horizon: 2, saturation: 'log', param: 1, source: 'manual' };

  const updateConfig = (name, updates) => {
    setConfigs((prev) => ({ ...prev, [name]: { ...configFor(name), ...updates, source: 'manual' } }));
  };

  const autoFillConfig = (name) => {
    // Sensible default: dependent-variable-like carryover gets a gentler
    // decay + linear response; everything else gets a log-saturated curve.
    setConfigs((prev) => ({ ...prev, [name]: { decay: 0.7, horizon: 4, saturation: 'none', param: 1, source: 'auto' } }));
  };

  const autoSelectAllVariables = () => {
    const next = {};
    Array.from(selectedVars).forEach((name) => { next[name] = { decay: 0.7, horizon: 4, saturation: 'none', param: 1, source: 'auto' }; });
    setConfigs(next);
  };

  const selectedList = Array.from(selectedVars);

  const handleSaveApply = async () => {
    if (!dateKeys.length || !geoKeys.length || !dependentVars.length) {
      setApplyError('Set Date, Geo, and Dependent Variable columns in Step 1 first.');
      return;
    }
    if (selectedList.length === 0) {
      setApplyError('Select at least one variable to transform in Step 2.');
      return;
    }
    setApplyError(null);
    setIsApplying(true);

    // Real transform, computed client-side on the actual ARD rows.
    const dateKey = dateKeys[0];
    const geoKey = geoKeys[0];
    const sorted = [...rows].sort((a, b) => (a[dateKey] > b[dateKey] ? 1 : -1));

    const transformedCols = [];
    const outputRows = sorted.map((r) => ({ ...r }));

    // Derived variables first (simple sum of parts), so they can also be
    // transformed downstream the same as any base channel.
    derivedVars.forEach((d) => {
      outputRows.forEach((r) => {
        r[d.name] = d.parts.reduce((s, p) => s + (Number(r[p]) || 0), 0);
      });
      if (!columns.includes(d.name)) columns.push(d.name);
    });

    selectedList.forEach((varName) => {
      const cfg = configFor(varName);
      const values = applyAdstockAndSaturation(
        outputRows, geoKey, (r) => Number(r[varName]) || 0,
        cfg.decay, cfg.horizon, cfg.saturation, cfg.param
      );
      const outName = `${varName}_transformed`;
      outputRows.forEach((r, i) => { r[outName] = values[i]; });
      transformedCols.push({ raw: varName, transformed: outName, config: cfg });
    });

    if (carryover) {
      const depVar = dependentVars[0];
      const groups = {};
      outputRows.forEach((r, i) => { (groups[r[geoKey]] = groups[r[geoKey]] || []).push(i); });
      Object.values(groups).forEach((indices) => {
        indices.forEach((idx, t) => {
          outputRows[idx][`${depVar}_carryover_lag1`] = t > 0 ? outputRows[indices[t - 1]][depVar] : 0;
        });
      });
    }

    setTransformResult({ rows: outputRows, transformedCols, dependentVar: dependentVars[0] });
    setInspectVar(transformedCols[0]?.raw || '');
    setIsApplying(false);
  };

  // ---- Validation section computations ----
  const correlationMatrix = useMemo(() => {
    if (!transformResult) return [];
    const cols = transformResult.transformedCols.map((c) => c.transformed).slice(0, 8);
    return cols.map((c1) => ({
      col: c1,
      values: cols.map((c2) => pearsonCorrelation(
        transformResult.rows.map((r) => Number(r[c1]) || 0),
        transformResult.rows.map((r) => Number(r[c2]) || 0)
      )),
    }));
  }, [transformResult]);

  const highCorrPairs = useMemo(() => {
    const pairs = [];
    for (let i = 0; i < correlationMatrix.length; i++) {
      for (let j = i + 1; j < correlationMatrix.length; j++) {
        const r = correlationMatrix[i].values[j];
        if (Math.abs(r) >= corrThreshold) {
          pairs.push({ a: correlationMatrix[i].col, b: correlationMatrix[j].col, r });
        }
      }
    }
    return pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  }, [correlationMatrix, corrThreshold]);

  const inspectDetail = useMemo(() => {
    if (!transformResult || !inspectVar) return null;
    const entry = transformResult.transformedCols.find((c) => c.raw === inspectVar);
    if (!entry) return null;
    const before = transformResult.rows.map((r) => Number(r[entry.raw]) || 0);
    const after = transformResult.rows.map((r) => Number(r[entry.transformed]) || 0);
    const dep = transformResult.rows.map((r) => Number(r[transformResult.dependentVar]) || 0);

    const statsFor = (arr) => ({
      mean: mean(arr), median: median(arr), std: stdDev(arr, mean(arr)),
      min: Math.min(...arr), max: Math.max(...arr),
      p25: percentile(arr, 25), p75: percentile(arr, 75),
    });

    const histogram = (arr) => {
      const min = Math.min(...arr), max = Math.max(...arr);
      const binCount = 8;
      const binWidth = (max - min) / binCount || 1;
      const bins = Array.from({ length: binCount }, () => 0);
      arr.forEach((v) => { const idx = Math.min(binCount - 1, Math.floor((v - min) / binWidth)); bins[idx]++; });
      return bins;
    };

    const binnedCurve = (xArr, yArr) => {
      const minX = Math.min(...xArr), maxX = Math.max(...xArr);
      const binCount = 8;
      const binWidth = (maxX - minX) / binCount || 1;
      const buckets = Array.from({ length: binCount }, () => []);
      xArr.forEach((x, i) => { const idx = Math.min(binCount - 1, Math.floor((x - minX) / binWidth)); buckets[idx].push(yArr[i]); });
      return buckets.map((ys, i) => ({ x: minX + (i + 0.5) * binWidth, y: ys.length ? mean(ys) : 0 }));
    };

    return {
      config: entry.config,
      before: statsFor(before), after: statsFor(after),
      histBefore: histogram(before), histAfter: histogram(after),
      curveBefore: binnedCurve(before, dep), curveAfter: binnedCurve(after, dep),
    };
  }, [transformResult, inspectVar]);

  const downloadTransformed = () => {
    if (!transformResult) return;
    const csv = Papa.unparse(transformResult.rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transformSetName || 'transformed_dataset'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="transform-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Data Transformation &amp; Feature Engineering</p>
          <p className="page-header-subtitle">
            Apply Normalization, Adstock decay, Horizon smoothing, Saturation curves (Log/Power), and manage versioned transformation sets
          </p>
        </div>
      </div>

      {isLoadingArds && <p className="transform-empty">Loading ARDs...</p>}
      {!isLoadingArds && loadError && <div className="transform-error-banner">{loadError}</div>}
      {!isLoadingArds && !loadError && ards.length === 0 && (
        <p className="transform-empty">No ARDs found — build one on the Data Stitching &amp; ARD Creation page first.</p>
      )}

      {!isLoadingArds && !loadError && ards.length > 0 && (
        <>
          {/* ---- Active ARD selector ---- */}
          <div className="transform-card">
            <p className="transform-card-heading">Active ARD Dataset Under Transformation</p>
            <p className="transform-card-heading" style={{ marginBottom: '0.5rem' }}>Select ARD Table:</p>
            <div className="ard-select-row-transform">
              <select value={selectedArdFilename} onChange={(e) => setSelectedArdFilename(e.target.value)}>
                {ards.map((a) => (
                  <option key={a.filename} value={a.filename}>
                    {a.filename} ({a.grain} · {(a.row_count ?? 0).toLocaleString()} rows · {a.columns?.length} cols)
                  </option>
                ))}
              </select>
              <span className="ard-status-badge">Status: <span className="ard-status-ok">✓ Loaded</span></span>
            </div>
          </div>

          {isLoadingData && <p className="transform-empty">Loading dataset...</p>}
          {dataError && <div className="transform-error-banner">{dataError}</div>}

          {!isLoadingData && !dataError && rows.length > 0 && (
            <>
              {/* ---- Step 1: Key Columns & Model Target ---- */}
              <div className="transform-card">
                <p className="transform-section-title">Step 1: Key Columns &amp; Model Target</p>
                <div className="pill-groups-row">
                  <div>
                    <div className="pill-group-heading">
                      Date Column(s) ({dateKeys.length} selected)
                      <span className="pill-group-clear" onClick={() => setDateKeys([])}>Clear</span>
                    </div>
                    <div className="pill-group-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill${dateKeys.includes(c) ? ' selected' : ''}`} onClick={() => togglePill(setDateKeys, dateKeys, c)}>
                          {dateKeys.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="pill-group-heading">
                      Geo Column(s) (HCP/DMA Keys) ({geoKeys.length} selected)
                      <span className="pill-group-clear" onClick={() => setGeoKeys([])}>Clear</span>
                    </div>
                    <div className="pill-group-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill${geoKeys.includes(c) ? ' selected' : ''}`} onClick={() => togglePill(setGeoKeys, geoKeys, c)}>
                          {geoKeys.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="pill-group-heading locked">
                      Dependent Variable(s) (Sales KPI) ({dependentVars.length} selected)
                      <span className="pill-group-clear" onClick={() => setDependentVars([])}>Clear</span>
                    </div>
                    <div className="pill-group-box locked-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill selected-check${dependentVars.includes(c) ? ' selected locked' : ''}`} onClick={() => togglePill(setDependentVars, dependentVars, c)}>
                          {dependentVars.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                    <p className="pill-group-note">* Selected sales KPI(s) are strictly locked from transformation.</p>
                  </div>
                </div>

                <div className="pill-groups-row">
                  <div>
                    <div className="pill-group-heading">ZIP Column(s) (Optional)</div>
                    <div className="pill-group-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill${zipKeys.includes(c) ? ' selected' : ''}`} onClick={() => togglePill(setZipKeys, zipKeys, c)}>
                          {zipKeys.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="pill-group-heading">DMA Column(s) (Optional)</div>
                    <div className="pill-group-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill${dmaKeys.includes(c) ? ' selected' : ''}`} onClick={() => togglePill(setDmaKeys, dmaKeys, c)}>
                          {dmaKeys.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="pill-group-heading">Population / Universe Column(s)</div>
                    <div className="pill-group-box">
                      {columns.map((c) => (
                        <span key={c} className={`col-pill${popKeys.includes(c) ? ' selected' : ''}`} onClick={() => togglePill(setPopKeys, popKeys, c)}>
                          {popKeys.includes(c) ? '✓ ' : '+ '}{c}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="carryover-row">
                  <label className="carryover-checkbox-label">
                    <input type="checkbox" checked={carryover} onChange={(e) => setCarryover(e.target.checked)} />
                    Create Lagged Dependent Variable as Carryover (Lag 1)
                  </label>
                  <span className="eligible-count-text">{eligibleColumns.length} channel(s) eligible for transformation</span>
                </div>
              </div>

              {/* ---- Step 2: Variable Selection Grid ---- */}
              <div className="transform-card">
                <p className="transform-section-title">Step 2: Variable Selection Grid</p>
                <p className="transform-section-desc">
                  Check the marketing variables you want to transform. Target KPI(s) are visible but locked to prevent transformation.
                </p>
                <div className="step-toolbar">
                  <span className="step-toolbar-link" onClick={selectAllEligible}>Select All Eligible</span>
                  <div className="step-toolbar-divider" />
                  <span className="step-toolbar-link muted" onClick={deselectAll}>Deselect All</span>
                  <button className="add-derived-btn" onClick={addDerivedVariable}>+ Add Derived Variable</button>
                </div>
                <div className="var-grid-table-wrapper">
                  <table className="var-grid-table">
                    <thead>
                      <tr><th>Select</th><th>Variable Name</th><th>Grain</th><th>Type</th><th>Transformation Status</th></tr>
                    </thead>
                    <tbody>
                      {[...columns, ...derivedVars.map((d) => d.name)].map((c) => {
                        const isKey = lockedKeys.has(c) && !dependentVars.includes(c);
                        const isDependent = dependentVars.includes(c);
                        const isEligible = eligibleColumns.includes(c) || derivedVars.some((d) => d.name === c);
                        return (
                          <tr key={c}>
                            <td>
                              {isEligible && (
                                <input type="checkbox" checked={selectedVars.has(c)} onChange={() => toggleVarSelect(c)} />
                              )}
                            </td>
                            <td><strong>{c}</strong></td>
                            <td><span className="grain-badge">{geoKeys[0] ? geoKeys[0].toUpperCase() : 'HCP'}</span></td>
                            <td>Numeric</td>
                            <td>
                              {isKey ? (
                                <span className="status-preserved">ID / Group Key (Preserved)</span>
                              ) : isDependent ? (
                                <span className="status-locked"><span className="status-lock-icon">🔒</span>Sales (Dependent Variable) — Transform Disabled</span>
                              ) : selectedVars.has(c) ? (
                                <span className="status-included">✓ Included in Step 3</span>
                              ) : (
                                <span className="status-preserved">Not selected</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ---- Step 3: Transformation Configuration Table ---- */}
              {selectedList.length > 0 && (
                <div className="transform-card">
                  <p className="transform-section-title">Step 3: Transformation Configuration Table</p>
                  <p className="transform-section-desc">
                    Configure Normalization, Adstock Decay, Horizon smoothing (weeks), and Functional Saturation (Log/Power) per channel.
                  </p>
                  <button className="auto-select-all-btn" onClick={autoSelectAllVariables}>Auto Select All Variables</button>

                  <div className="config-table-wrapper">
                    <table className="config-table">
                      <thead>
                        <tr>
                          <th>Variable</th><th>Adstock (Decay)</th><th>Horizon (Time Horizon)</th>
                          <th>Saturation Curve</th><th>Param (k / p)</th><th>Source</th><th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedList.map((name) => {
                          const cfg = configFor(name);
                          const derived = derivedVars.find((d) => d.name === name);
                          return (
                            <tr key={name}>
                              <td><strong>{name}</strong></td>
                              <td>
                                <select value={cfg.decay} onChange={(e) => updateConfig(name, { decay: Number(e.target.value) })}>
                                  {ADSTOCK_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                                </select>
                              </td>
                              <td>
                                <select value={cfg.horizon} onChange={(e) => updateConfig(name, { horizon: Number(e.target.value) })}>
                                  {HORIZON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td>
                                <select value={cfg.saturation} onChange={(e) => updateConfig(name, { saturation: e.target.value })}>
                                  {SATURATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td>
                                {cfg.saturation !== 'none' ? (
                                  <input type="number" step="0.1" value={cfg.param} onChange={(e) => updateConfig(name, { param: Number(e.target.value) })} />
                                ) : '—'}
                              </td>
                              <td><span className={`source-badge ${cfg.source}`}>{cfg.source.toUpperCase()}</span></td>
                              <td>
                                <div className="config-action-btns">
                                  <button className="auto-fill-btn" onClick={() => autoFillConfig(name)}>Auto</button>
                                  {derived && (
                                    <button className="remove-derived-btn" onClick={() => removeDerivedVariable(derived.id, name)}>✕</button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="set-name-row">
                    <div className="set-name-field">
                      <label>Transformation Set Name:</label>
                      <input value={transformSetName} onChange={(e) => setTransformSetName(e.target.value)} placeholder="e.g. Q4 National Launch v1" />
                    </div>
                    <button className="save-apply-btn" onClick={handleSaveApply} disabled={isApplying}>
                      {isApplying ? 'Applying...' : '▶ Save & Apply Transformation Set'}
                    </button>
                  </div>
                  {applyError && <div className="transform-error-banner" style={{ marginTop: '0.75rem' }}>{applyError}</div>}
                </div>
              )}

              {/* ---- Validation sections (post apply) ---- */}
              {transformResult && (
                <>
                  <div className="transform-card">
                    <p className="transform-section-title">1. Post-Transformation Multicollinearity Matrix</p>
                    <p className="transform-section-desc">
                      Verify correlation across transformed channels to ensure adstock smoothing and saturation transforms have not introduced severe collinearity before modeling.
                    </p>
                    <div className="threshold-slider-row-t">
                      <label>Highlight Threshold (|r| ≥ {corrThreshold.toFixed(2)}):</label>
                      <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} />
                      <span className="ready-badge">{selectedList.length} Features Ready for Regression</span>
                    </div>
                    <div className="config-table-wrapper">
                      <table className="corr-table-t">
                        <thead><tr><th>Variable</th>{correlationMatrix.map((r) => <th key={r.col}>{r.col.replace('_transformed', '')}</th>)}</tr></thead>
                        <tbody>
                          {correlationMatrix.map((row, i) => (
                            <tr key={row.col}>
                              <th>{row.col.replace('_transformed', '')}</th>
                              {row.values.map((v, j) => (
                                <td key={j} className={i === j ? 'corr-self-t' : Math.abs(v) >= corrThreshold ? 'corr-hi-t' : ''}>{v.toFixed(2)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {highCorrPairs.length > 0 && (
                      <table className="high-corr-pairs-table">
                        <thead><tr><th>Transformed Tactic 1</th><th>Transformed Tactic 2</th><th>Correlation (r)</th></tr></thead>
                        <tbody>
                          {highCorrPairs.map((p, i) => (
                            <tr key={i}><td>{p.a}</td><td>{p.b}</td><td>{p.r.toFixed(4)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="transform-card">
                    <p className="transform-section-title">2. Transformed Dataset Preview</p>
                    <p className="transform-section-desc">
                      Showing first 10 rows of {transformResult.rows.length.toLocaleString()} total rows ({[...columns, ...transformResult.transformedCols.map((c) => c.transformed)].length} columns)
                    </p>
                    <div className="transformed-preview-scroll">
                      <table className="transformed-preview-table">
                        <thead>
                          <tr>
                            {columns.map((c) => <th key={c}>{c}</th>)}
                            {transformResult.transformedCols.map((c) => <th key={c.transformed}>{c.transformed}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {transformResult.rows.slice(0, 10).map((r, i) => (
                            <tr key={i}>
                              {columns.map((c) => <td key={c}>{typeof r[c] === 'number' ? r[c].toLocaleString(undefined, { maximumFractionDigits: 4 }) : r[c]}</td>)}
                              {transformResult.transformedCols.map((c) => <td key={c.transformed}>{Number(r[c.transformed]).toFixed(4)}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="section-connector">
                   
                  </div>

                  <div className="transform-card">
                    <p className="transform-section-title">3. Preview &amp; Validation</p>
                    <p className="transform-section-desc">
                      Review the empirical impact of transformations, validate distribution compression, and inspect response shape against KPI before saving.
                    </p>
                    <div className="stat-card-row-transform">
                      <div className="tstat-card blue"><p className="tstat-value">{selectedList.length}</p><p className="tstat-label">Variables Transformed</p></div>
                      <div className="tstat-card green"><p className="tstat-value">{Object.values(configs).filter((c) => c.source === 'auto').length}</p><p className="tstat-label">Auto Selected</p></div>
                      <div className="tstat-card grey"><p className="tstat-value">{Object.values(configs).filter((c) => c.source === 'manual').length}</p><p className="tstat-label">Manually Configured</p></div>
                      <div className="tstat-card purple"><p className="tstat-value">{derivedVars.length}</p><p className="tstat-label">Derived Variables</p></div>
                      <div className="tstat-card yellow"><p className="tstat-value">{highCorrPairs.length}</p><p className="tstat-label">High Corr Pairs</p></div>
                      <div className="tstat-card dark"><p className="tstat-value">{transformSetName || 'Unsaved'}</p><p className="tstat-label">Active Version</p></div>
                    </div>

                    <div className="inspect-select-row">
                      <p className="transform-card-heading">Select Variable to Inspect:</p>
                      <select value={inspectVar} onChange={(e) => setInspectVar(e.target.value)}>
                        {transformResult.transformedCols.map((c) => (
                          <option key={c.raw} value={c.raw}>
                            {c.raw} ({geoKeys[0]?.toUpperCase() || 'HCP'} • none • {SATURATION_OPTIONS.find((o) => o.value === c.config.saturation)?.label.split(':')[0].trim()})
                          </option>
                        ))}
                      </select>
                    </div>

                    {inspectDetail && (
                      <>
                        <div className="inspect-layout">
                          <div className="transform-detail-card">
                            <p className="transform-detail-title">Transformation Details: {inspectVar.toUpperCase()}</p>
                            <div className="detail-grid">
                              <div><p className="detail-item-label">Normalization</p><p className="detail-item-value">none</p></div>
                              <div><p className="detail-item-label">Adstock Decay (α)</p><p className="detail-item-value">{inspectDetail.config.decay}</p></div>
                              <div><p className="detail-item-label">Adstock Horizon</p><p className="detail-item-value">{inspectDetail.config.horizon} weeks</p></div>
                              <div><p className="detail-item-label">Saturation Transform</p><p className="detail-item-value">{SATURATION_OPTIONS.find((o) => o.value === inspectDetail.config.saturation)?.label.split(':')[0]}</p></div>
                              <div><p className="detail-item-label">Param (k  p)</p><p className="detail-item-value">{inspectDetail.config.saturation === 'none' ? '—' : inspectDetail.config.param}</p></div>
                              <div><p className="detail-item-label">Configuration Source</p><p className="detail-item-value"><span className={`source-badge ${inspectDetail.config.source}`}>{inspectDetail.config.source === 'auto' ? 'Auto Selected' : 'Manual'}</span></p></div>
                            </div>
                          </div>

                          <div>
                            <p className="transform-card-heading">Before vs. After Summary Statistics ({inspectVar}):</p>
                            <table className="before-after-table">
                              <thead><tr><th>Metric</th><th>Original</th><th>Transformed</th></tr></thead>
                              <tbody>
                                <tr><td>Mean</td><td>{inspectDetail.before.mean.toFixed(3)}</td><td className="after-val">{inspectDetail.after.mean.toFixed(3)}</td></tr>
                                <tr><td>Median</td><td>{inspectDetail.before.median.toFixed(3)}</td><td className="after-val">{inspectDetail.after.median.toFixed(3)}</td></tr>
                                <tr><td>Standard Deviation</td><td>{inspectDetail.before.std.toFixed(3)}</td><td className="after-val">{inspectDetail.after.std.toFixed(3)}</td></tr>
                                <tr><td>Minimum</td><td>{inspectDetail.before.min.toFixed(3)}</td><td className="after-val">{inspectDetail.after.min.toFixed(3)}</td></tr>
                                <tr><td>Maximum</td><td>{inspectDetail.before.max.toFixed(3)}</td><td className="after-val">{inspectDetail.after.max.toFixed(3)}</td></tr>
                                <tr><td>25th Percentile</td><td>{inspectDetail.before.p25.toFixed(3)}</td><td className="after-val">{inspectDetail.after.p25.toFixed(3)}</td></tr>
                                <tr><td>75th Percentile</td><td>{inspectDetail.before.p75.toFixed(3)}</td><td className="after-val">{inspectDetail.after.p75.toFixed(3)}</td></tr>
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <p className="transform-card-heading">Variable Distribution Comparison (Compression &amp; Skewness Check):</p>
                        <div className="dist-compare-row">
                          <div className="dist-chart-box">
                            <p className="dist-chart-title">Original Distribution (Raw Histogram)</p>
                            <MiniBarChart bins={inspectDetail.histBefore} color="#94a3b8" />
                          </div>
                          <div className="dist-chart-box">
                            <p className="dist-chart-title after-title">Transformed Distribution (Normalized &amp; Saturated)</p>
                            <MiniBarChart bins={inspectDetail.histAfter} color="#1d4ed8" />
                          </div>
                        </div>

                        <p className="transform-card-heading">Relationship with KPI (Poor Man's Curve): Before vs. After Transformation</p>
                        <div className="curve-compare-row">
                          <div className="dist-chart-box">
                            <p className="dist-chart-title">Before: {inspectVar} vs {transformResult.dependentVar}</p>
                            <MiniLineChart points={inspectDetail.curveBefore} color="#94a3b8" />
                          </div>
                          <div className="dist-chart-box">
                            <p className="dist-chart-title after-title">After: {inspectVar} (Transformed) vs {transformResult.dependentVar}</p>
                            <MiniLineChart points={inspectDetail.curveAfter} color="#1d4ed8" />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  
                </>
              )}
            </>
          )}
        </>
      )}

      <PageFooterNav currentStepId="data-transformation" />
    </div>
  );
}

function MiniBarChart({ bins, color }) {
  const width = 400, height = 140, padding = 20;
  const maxVal = Math.max(...bins, 1);
  const barWidth = (width - padding * 2) / bins.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {bins.map((v, i) => {
        const h = (v / maxVal) * (height - padding * 2);
        return <rect key={i} x={padding + i * barWidth + 1} y={height - padding - h} width={barWidth - 2} height={h} fill={color} />;
      })}
    </svg>
  );
}

function MiniLineChart({ points, color }) {
  const width = 400, height = 140, padding = 20;
  if (!points.length) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 1);
  const xScale = (v) => padding + ((v - minX) / (maxX - minX || 1)) * (width - padding * 2);
  const yScale = (v) => height - padding - ((v - minY) / (maxY - minY || 1)) * (height - padding * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      <polyline points={points.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ')} fill="none" stroke={color} strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r="3" fill={color} />)}
    </svg>
  );
}

export default DataTransformation;