import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { v2ListArds, v2GetCsv, problemMessage, ensureWorkflow } from '../../services/api.js';
import './DataReview.css';

const TABS = [
  { id: 'summary', label: 'Summary Stats & Sparsity' },
  { id: 'trends', label: 'Time Trends (WoW / MoM)' },
  { id: 'outliers', label: 'Distributions & Outliers' },
  { id: 'relationships', label: "Relationships & Poor Man's Curve" },
  { id: 'correlation', label: 'Correlation & Multicollinearity' },
];

const CORR_SUBTABS = [
  { id: 'analysis', label: 'Analysis (Heatmap & VIF)' },
  { id: 'removal', label: 'Treatment Removal' },
  { id: 'combination', label: 'Treatment Combination' },
];

const CHART_COLORS = ['#1d4ed8', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0891b2'];

// ─── Stats helpers ──────────────────────────────────────────────────────
function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stdDev(nums, m) {
  if (nums.length < 2) return 0;
  return Math.sqrt(nums.reduce((sum, x) => sum + (x - m) ** 2, 0) / nums.length);
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
function isDateLike(colName) { return /date|week|month|period/i.test(colName); }
function isDimensionLike(colName) { return /id$|_id|npi|dma|zip|code|geo/i.test(colName); }
function isNumericColumn(rows, col) {
  return rows.every((r) => r[col] === '' || r[col] === null || typeof r[col] === 'number');
}

// ─── Small linear algebra for VIF (OLS via normal equations) ───────────────
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
// R² of regressing `y` on `xs` (array of predictor arrays), with intercept.
function rSquaredOLS(y, xs) {
  const n = y.length;
  const X = y.map((_, i) => [1, ...xs.map((col) => col[i])]);
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  let XtXinv;
  try { XtXinv = invertMatrix(XtX); } catch { return 0; }
  const Xty = Xt.map((row) => [row.reduce((s, v, i) => s + v * y[i], 0)]);
  const beta = matMul(XtXinv, Xty).map((r) => r[0]);
  const yHat = X.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
  const yMean = mean(y);
  const ssRes = y.reduce((s, v, i) => s + (v - yHat[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  return ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

function DataReview() {
  const navigate = useNavigate();

  const [workflowId, setWorkflowId] = useState(null);
  const [ards, setArds] = useState([]);
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  const [dateKey, setDateKey] = useState('');
  const [geoKey, setGeoKey] = useState('');
  const [activeTab, setActiveTab] = useState('summary');
  const [corrSubTab, setCorrSubTab] = useState('analysis');
  const [searchQuery, setSearchQuery] = useState('');

  const [aggregation, setAggregation] = useState('wow');
  const [indexedView, setIndexedView] = useState(false);
  const [selectedMetrics, setSelectedMetrics] = useState([]);

  const [distVariable, setDistVariable] = useState('');
  const [outlierVariable, setOutlierVariable] = useState('');
  const [outlierThreshold, setOutlierThreshold] = useState(1.5);
  const [excludedRowKeys, setExcludedRowKeys] = useState(new Set());

  const [xAxisVar, setXAxisVar] = useState('');
  const [yAxisVar, setYAxisVar] = useState('');

  const [corrThreshold, setCorrThreshold] = useState(0.7);
  const [vifResults, setVifResults] = useState(null);

  const [removalTargetKpi, setRemovalTargetKpi] = useState('');
  const [removalThreshold, setRemovalThreshold] = useState(0.75);
  const [removalResults, setRemovalResults] = useState(null);

  const [clusterThreshold, setClusterThreshold] = useState(0.75);
  const [clusterMethod, setClusterMethod] = useState('sum');
  const [dropOriginalAfterCombination, setDropOriginalAfterCombination] = useState(true);
  const [clusterResults, setClusterResults] = useState(null);

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
    setExcludedRowKeys(new Set());
    setVifResults(null);
    setRemovalResults(null);
    setClusterResults(null);
    try {
      const csvText = await v2GetCsv(workflowId, filename);
      const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
      const cols = parsed.meta.fields || [];
      setColumns(cols);
      setRows(parsed.data);

      const guessedDate = cols.find(isDateLike) || '';
      const guessedGeo = cols.find(isDimensionLike) || '';
      setDateKey(guessedDate);
      setGeoKey(guessedGeo);

      const metricCols = cols.filter((c) => c !== guessedDate && c !== guessedGeo && isNumericColumn(parsed.data, c));
      setSelectedMetrics(metricCols.slice(0, 2));
      setOutlierVariable(metricCols[0] || '');
      setDistVariable(metricCols[0] || '');
      setXAxisVar(metricCols[0] || '');
      setYAxisVar(metricCols[1] || metricCols[0] || '');
      setRemovalTargetKpi(metricCols[metricCols.length - 1] || '');
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

  const activeRows = useMemo(() => rows.filter((_, i) => !excludedRowKeys.has(i)), [rows, excludedRowKeys]);

  const metricColumns = useMemo(
    () => columns.filter((c) => c !== dateKey && c !== geoKey && isNumericColumn(rows, c)),
    [columns, rows, dateKey, geoKey]
  );

  // ---- Tab 1: Summary stats ----
  const columnStats = useMemo(() => columns.map((col) => {
    if (col === dateKey) {
      const values = activeRows.map((r) => r[col]).filter(Boolean).sort();
      return { col, role: 'date', distinct: new Set(values).size, min: values[0], max: values[values.length - 1] };
    }
    if (col === geoKey || isDimensionLike(col)) {
      const values = activeRows.map((r) => r[col]).filter((v) => v !== null && v !== '');
      return { col, role: 'dimension', distinct: new Set(values).size };
    }
    const numericValues = activeRows.map((r) => r[col]).filter((v) => typeof v === 'number');
    const activeCount = numericValues.filter((v) => v !== 0).length;
    const pctActive = activeRows.length ? (activeCount / activeRows.length) * 100 : 0;
    const m = mean(numericValues);
    return {
      col, role: 'metric', distinct: new Set(numericValues).size, pctActive, activeCount,
      mean: m, median: median(numericValues), std: stdDev(numericValues, m),
      min: numericValues.length ? Math.min(...numericValues) : 0,
      max: numericValues.length ? Math.max(...numericValues) : 0,
      p75: percentile(numericValues, 75),
    };
  }), [columns, activeRows, dateKey, geoKey]);
  const filteredStats = columnStats.filter((s) => s.col.toLowerCase().includes(searchQuery.toLowerCase()));

  // ---- Tab 2: Time trends ----
  const trendData = useMemo(() => {
    if (!dateKey || selectedMetrics.length === 0) return { labels: [], series: {} };
    const grouped = {};
    activeRows.forEach((r) => {
      const rawDate = r[dateKey];
      if (!rawDate) return;
      const key = aggregation === 'mom' ? String(rawDate).slice(0, 7) : String(rawDate);
      if (!grouped[key]) grouped[key] = {};
      selectedMetrics.forEach((m) => { grouped[key][m] = (grouped[key][m] || 0) + (Number(r[m]) || 0); });
    });
    const labels = Object.keys(grouped).sort();
    const series = {};
    selectedMetrics.forEach((m) => {
      let values = labels.map((l) => grouped[l][m] || 0);
      if (indexedView && values[0]) { const base = values[0]; values = values.map((v) => (v / base) * 100); }
      series[m] = values;
    });
    return { labels, series };
  }, [activeRows, dateKey, selectedMetrics, aggregation, indexedView]);

  // ---- Tab 3: Distribution histogram ----
  const histogramData = useMemo(() => {
    if (!distVariable) return null;
    const values = activeRows.map((r) => Number(r[distVariable])).filter((v) => !Number.isNaN(v));
    if (!values.length) return null;
    const min = Math.min(...values), max = Math.max(...values);
    const binCount = 20;
    const binWidth = (max - min) / binCount || 1;
    const bins = Array.from({ length: binCount }, () => 0);
    values.forEach((v) => {
      const idx = Math.min(binCount - 1, Math.floor((v - min) / binWidth));
      bins[idx]++;
    });
    const labels = bins.map((_, i) => `${(min + i * binWidth).toFixed(1)} - ${(min + (i + 1) * binWidth).toFixed(1)}`);
    return { bins, labels, mean: mean(values), median: median(values), min, max };
  }, [activeRows, distVariable]);

  // ---- Tab 3: Outlier detection ----
  const outlierResult = useMemo(() => {
    if (!outlierVariable) return null;
    const values = activeRows.map((r) => Number(r[outlierVariable])).filter((v) => !Number.isNaN(v));
    const q1 = percentile(values, 25), q3 = percentile(values, 75), iqr = q3 - q1;
    const lower = q1 - outlierThreshold * iqr, upper = q3 + outlierThreshold * iqr;
    const flaggedIndices = [];
    activeRows.forEach((r, i) => {
      const v = Number(r[outlierVariable]);
      if (!Number.isNaN(v) && (v < lower || v > upper)) flaggedIndices.push(i);
    });
    return { lower, upper, flaggedIndices, pct: activeRows.length ? (flaggedIndices.length / activeRows.length) * 100 : 0 };
  }, [activeRows, outlierVariable, outlierThreshold]);

  // ---- Tab 4: Bivariate scatter + binned average (Poor Man's Curve) ----
  const bivariateData = useMemo(() => {
    if (!xAxisVar || !yAxisVar) return null;
    const points = activeRows
      .map((r) => ({ x: Number(r[xAxisVar]), y: Number(r[yAxisVar]) }))
      .filter((p) => !Number.isNaN(p.x) && !Number.isNaN(p.y));
    if (!points.length) return null;
    const xs = points.map((p) => p.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const binCount = 15;
    const binWidth = (maxX - minX) / binCount || 1;
    const buckets = Array.from({ length: binCount }, () => []);
    points.forEach((p) => {
      const idx = Math.min(binCount - 1, Math.floor((p.x - minX) / binWidth));
      buckets[idx].push(p.y);
    });
    const binnedLine = buckets.map((ys, i) => ({
      x: minX + (i + 0.5) * binWidth,
      y: ys.length ? mean(ys) : null,
    })).filter((p) => p.y !== null);
    return { points, binnedLine };
  }, [activeRows, xAxisVar, yAxisVar]);

  // ---- Tab 5a: Correlation matrix (for heatmap) ----
  const correlationMatrix = useMemo(() => {
    const cols = metricColumns.slice(0, 8);
    return cols.map((c1) => ({
      col: c1,
      values: cols.map((c2) => pearsonCorrelation(
        activeRows.map((r) => Number(r[c1]) || 0),
        activeRows.map((r) => Number(r[c2]) || 0)
      )),
    }));
  }, [metricColumns, activeRows]);

  const computeVIF = () => {
    const cols = metricColumns.slice(0, 8);
    const colData = Object.fromEntries(cols.map((c) => [c, activeRows.map((r) => Number(r[c]) || 0)]));
    const results = cols.map((target) => {
      const predictors = cols.filter((c) => c !== target).map((c) => colData[c]);
      const r2 = rSquaredOLS(colData[target], predictors);
      const vif = r2 >= 0.999 ? Infinity : 1 / (1 - r2);
      return { col: target, vif };
    });
    setVifResults(results);
  };

  const findRemovalCandidates = () => {
    if (!removalTargetKpi) return;
    const cols = metricColumns.filter((c) => c !== removalTargetKpi);
    const colData = Object.fromEntries([...cols, removalTargetKpi].map((c) => [c, activeRows.map((r) => Number(r[c]) || 0)]));
    const removed = new Set();
    const results = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const a = cols[i], b = cols[j];
        if (removed.has(a) || removed.has(b)) continue;
        const r = pearsonCorrelation(colData[a], colData[b]);
        if (Math.abs(r) >= removalThreshold) {
          const corrAKpi = Math.abs(pearsonCorrelation(colData[a], colData[removalTargetKpi]));
          const corrBKpi = Math.abs(pearsonCorrelation(colData[b], colData[removalTargetKpi]));
          const drop = corrAKpi < corrBKpi ? a : b;
          const keep = drop === a ? b : a;
          removed.add(drop);
          results.push({ a, b, r, drop, keep, corrAKpi, corrBKpi });
        }
      }
    }
    setRemovalResults({ pairs: results, removed: Array.from(removed) });
  };

  const findCorrelatedClusters = () => {
    const cols = metricColumns;
    const colData = Object.fromEntries(cols.map((c) => [c, activeRows.map((r) => Number(r[c]) || 0)]));
    // Union-find over columns whose pairwise |r| >= clusterThreshold.
    const parent = Object.fromEntries(cols.map((c) => [c, c]));
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const r = pearsonCorrelation(colData[cols[i]], colData[cols[j]]);
        if (Math.abs(r) >= clusterThreshold) union(cols[i], cols[j]);
      }
    }
    const groups = {};
    cols.forEach((c) => { const root = find(c); (groups[root] = groups[root] || []).push(c); });
    const clusters = Object.values(groups).filter((g) => g.length > 1);
    setClusterResults({ clusters, method: clusterMethod, dropOriginals: dropOriginalAfterCombination });
  };

  const selectedArd = ards.find((a) => a.filename === selectedArdFilename);

  const toggleMetric = (m) => setSelectedMetrics((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const excludeOutliers = () => {
    if (!outlierResult) return;
    const activeToOriginal = [];
    rows.forEach((_, i) => { if (!excludedRowKeys.has(i)) activeToOriginal.push(i); });
    const newExcluded = new Set(excludedRowKeys);
    outlierResult.flaggedIndices.forEach((idx) => newExcluded.add(activeToOriginal[idx]));
    setExcludedRowKeys(newExcluded);
  };
  const restoreOriginal = () => setExcludedRowKeys(new Set());

  return (
    <div className="review-page">
      <div className="page-header">
        <p className="page-header-title">Data Review</p>
        <p className="page-header-subtitle">
          Sanity-check trends, inspect variable sparsity, detect outliers, and analyze correlation
        </p>
      </div>

      {isLoadingArds && <p className="review-empty">Loading ARDs...</p>}
      {!isLoadingArds && loadError && <div className="review-error-banner">{loadError}</div>}
      {!isLoadingArds && !loadError && ards.length === 0 && (
        <p className="review-empty">No ARDs found build one on the Data Stitching &amp; ARD Creation page first.</p>
      )}

      {!isLoadingArds && !loadError && ards.length > 0 && (
        <>
          <div className="review-card">
            <p className="review-card-heading">Active ARD Dataset Under Review</p>
            <div className="ard-select-row">
              <div className="ard-select-field primary">
                <label>Select Generated ARD Table:</label>
                <select value={selectedArdFilename} onChange={(e) => setSelectedArdFilename(e.target.value)}>
                  {ards.map((a) => (
                    <option key={a.filename} value={a.filename}>
                      {a.filename} ({a.grain} · {(a.row_count ?? 0).toLocaleString()} rows)
                    </option>
                  ))}
                </select>
              </div>
              <div className="ard-select-field">
                <label>Date Key</label>
                <select value={dateKey} onChange={(e) => setDateKey(e.target.value)}>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="ard-select-field">
                <label>Geo / Group Key</label>
                <select value={geoKey} onChange={(e) => setGeoKey(e.target.value)}>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button className="recalc-btn" onClick={() => loadArdData(selectedArdFilename)}> Recalculate EDA</button>
            </div>
          </div>

          {isLoadingData && <p className="review-empty">Loading dataset...</p>}
          {dataError && <div className="review-error-banner">{dataError}</div>}

          {!isLoadingData && !dataError && rows.length > 0 && (
            <>
              <div className="review-tabs">
                {TABS.map((t) => (
                  <div key={t.id} className={`review-tab${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)} role="button" tabIndex={0}>
                    {t.label}
                  </div>
                ))}
              </div>

              {/* ---- Summary Stats & Sparsity ---- */}
              {activeTab === 'summary' && (
                <div className="review-card">
                  <p className="review-card-heading">Variable Health, Sparsity &amp; Distributions</p>
                  <div className="review-search-row">
                    <input className="review-search-input" placeholder="Search variables..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                    <p className="review-total-rows">Total Rows: <strong>{activeRows.length.toLocaleString()}</strong></p>
                  </div>
                  <div className="stats-table-wrapper">
                    <table className="stats-table">
                      <thead>
                        <tr><th>Variable</th><th>Role</th><th>Distinct (N)</th><th>Active / Sparsity Health</th><th>Mean</th><th>Median</th><th>Std Dev</th><th>Min</th><th>Max</th><th>75th %ile</th></tr>
                      </thead>
                      <tbody>
                        {filteredStats.map((s) => (
                          <tr key={s.col}>
                            <td><strong>{s.col}</strong></td>
                            <td><span className={`role-badge ${s.role}`}>{s.role.charAt(0).toUpperCase() + s.role.slice(1)}</span></td>
                            <td>{s.distinct.toLocaleString()}</td>
                            <td>{s.role === 'metric' ? (
                              <span className={`health-badge ${s.pctActive >= 40 ? 'good' : s.pctActive >= 15 ? 'warn' : 'bad'}`}>
                                {s.pctActive.toFixed(2)}% active ({s.activeCount.toLocaleString()})
                              </span>
                            ) : '—'}</td>
                            <td>{s.role === 'metric' ? s.mean.toFixed(2) : '—'}</td>
                            <td>{s.role === 'metric' ? s.median.toFixed(2) : '—'}</td>
                            <td>{s.role === 'metric' ? s.std.toFixed(2) : '—'}</td>
                            <td>{s.role === 'metric' ? s.min : s.role === 'date' ? s.min : '—'}</td>
                            <td>{s.role === 'metric' ? s.max : s.role === 'date' ? s.max : '—'}</td>
                            <td>{s.role === 'metric' ? s.p75.toFixed(2) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ---- Time Trends ---- */}
              {activeTab === 'trends' && (
                <div className="review-card">
                  <p className="review-card-heading">Time-Series Trend Rollup (WoW &amp; MoM)</p>
                  <div className="trend-controls-row">
                    <div className="agg-toggle">
                      <button className={aggregation === 'wow' ? 'active' : ''} onClick={() => setAggregation('wow')}>Week-on-Week (WoW)</button>
                      <button className={aggregation === 'mom' ? 'active' : ''} onClick={() => setAggregation('mom')}>Month-on-Month (MoM)</button>
                    </div>
                    <label className="indexed-view-check">
                      <input type="checkbox" checked={indexedView} onChange={(e) => setIndexedView(e.target.checked)} />
                      Indexed View (Rebase to 100)
                    </label>
                  </div>
                  <div className="metric-select-row">
                    <p className="review-card-heading" style={{ marginBottom: 0 }}>Select Metrics to Display on Trend Line ({selectedMetrics.length} selected):</p>
                    <p className="metric-select-links">
                      <span onClick={() => setSelectedMetrics(metricColumns)}>Select All</span>{' | '}
                      <span onClick={() => setSelectedMetrics(metricColumns.slice(0, 1))}>Clear to 1</span>
                    </p>
                  </div>
                  <div className="metric-pills">
                    {metricColumns.map((m) => (
                      <span key={m} className={`metric-pill${selectedMetrics.includes(m) ? ' selected' : ''}`} onClick={() => toggleMetric(m)}>{m}</span>
                    ))}
                  </div>
                  <div className="trend-chart-wrapper">
                    <TrendChart labels={trendData.labels} series={trendData.series} />
                    <div className="trend-legend">
                      {selectedMetrics.map((m, i) => (
                        <div key={m} className="trend-legend-item">
                          <span className="trend-legend-swatch" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />{m}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ---- Distributions & Outliers ---- */}
              {activeTab === 'outliers' && (
                <>
                  <div className="review-card">
                    <p className="review-card-heading">Variable Distribution &amp; Skewness</p>
                    <div className="ard-select-field" style={{ maxWidth: 300, marginBottom: '1rem' }}>
                      <label>Select Variable:</label>
                      <select value={distVariable} onChange={(e) => setDistVariable(e.target.value)}>
                        {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {histogramData && (
                      <>
                        <div className="dist-stats-row">
                          <strong>Mean:</strong> {histogramData.mean.toFixed(2)} &nbsp;&nbsp;
                          <strong>Median:</strong> {histogramData.median.toFixed(2)} &nbsp;&nbsp;
                          Span: {histogramData.min.toFixed(1)} to {histogramData.max.toFixed(1)}
                        </div>
                        <HistogramChart bins={histogramData.bins} labels={histogramData.labels} />
                      </>
                    )}
                  </div>

                  {outlierResult && (
                    <div className="review-card">
                      <p className="review-card-heading">Outlier Diagnostics for {outlierVariable.toUpperCase()}</p>
                      <div className="outlier-controls-row">
                        <div className="ard-select-field">
                          <label>Variable</label>
                          <select value={outlierVariable} onChange={(e) => setOutlierVariable(e.target.value)}>
                            {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="ard-select-field">
                          <label>Threshold Value: (N &times; IQR)</label>
                          <input type="number" step="0.1" value={outlierThreshold} onChange={(e) => setOutlierThreshold(Number(e.target.value) || 1.5)}
                            style={{ width: '100%', padding: '0.65rem 0.8rem', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }} />
                        </div>
                        <button className="recalc-btn">&#8635; Re-Scan Outliers</button>
                      </div>
                      <div className="outlier-stat-row">
                        <div className="outlier-stat-card"><p className="outlier-stat-value">{outlierResult.flaggedIndices.length.toLocaleString()}</p><p className="outlier-stat-label">Outlier Points</p></div>
                        <div className="outlier-stat-card"><p className="outlier-stat-value">{outlierResult.pct.toFixed(1)}%</p><p className="outlier-stat-label">Dataset Proportion</p></div>
                        <div className="outlier-stat-card"><p className="outlier-stat-value">{outlierResult.lower.toFixed(1)}</p><p className="outlier-stat-label">Lower Cutoff</p></div>
                        <div className="outlier-stat-card"><p className="outlier-stat-value">{outlierResult.upper.toFixed(1)}</p><p className="outlier-stat-label">Upper Cutoff</p></div>
                      </div>
                      <p className="review-card-heading">Flagged Outlier Records:</p>
                      <div className="outlier-table-wrapper">
                        <table className="stats-table">
                          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                          <tbody>
                            {outlierResult.flaggedIndices.slice(0, 100).map((idx) => (
                              <tr key={idx}>{columns.map((c) => <td key={c}>{activeRows[idx][c]}</td>)}</tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="outlier-actions">
                        <button className="exclude-btn" onClick={excludeOutliers}>Exclude {outlierResult.flaggedIndices.length} Outliers from Dataset</button>
                        <button className="restore-btn" onClick={restoreOriginal}>&#8635; Restore Original Dataset (Undo Exclusions)</button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ---- Relationships & Poor Man's Curve ---- */}
              {activeTab === 'relationships' && (
                <div className="review-card">
                  <p className="review-card-heading">Bivariate Relationships &amp; Poor Man's Saturation Curve</p>
                  <p className="treatment-desc">
                    Combines raw data points with the <strong>binned-average response curve</strong> to test whether a
                    marketing channel exhibits diminishing returns (logarithmic saturation) or linear growth.
                  </p>
                  <div className="bivariate-controls-row">
                    <div className="treatment-field">
                      <label>Marketing Tactic (X Axis):</label>
                      <select value={xAxisVar} onChange={(e) => setXAxisVar(e.target.value)}>
                        {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="treatment-field">
                      <label>Target Sales / KPI (Y Axis):</label>
                      <select value={yAxisVar} onChange={(e) => setYAxisVar(e.target.value)}>
                        {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>
                  {bivariateData && <ScatterChart points={bivariateData.points} binnedLine={bivariateData.binnedLine} xLabel={xAxisVar} yLabel={yAxisVar} />}
                </div>
              )}

              {/* ---- Correlation & Multicollinearity ---- */}
              {activeTab === 'correlation' && (
                <div className="review-card">
                  <div className="review-subtabs">
                    {CORR_SUBTABS.map((t) => (
                      <div key={t.id} className={`review-subtab${corrSubTab === t.id ? ' active' : ''}`} onClick={() => setCorrSubTab(t.id)} role="button" tabIndex={0}>
                        {t.label}
                      </div>
                    ))}
                  </div>

                  {corrSubTab === 'analysis' && (
                    <>
                      <p className="review-card-heading">Pairwise Correlation &amp; Multicollinearity Matrix</p>
                      <div className="threshold-slider-row">
                        <label>Highlight Threshold (|r| &ge; {corrThreshold.toFixed(2)}):</label>
                        <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} />
                        <button className="outline-btn" onClick={computeVIF}>Compute VIF Scores</button>
                      </div>
                      <div className="corr-table-wrapper">
                        <table className="corr-table">
                          <thead><tr><th></th>{correlationMatrix.map((row) => <th key={row.col}>{row.col}</th>)}</tr></thead>
                          <tbody>
                            {correlationMatrix.map((row, i) => (
                              <tr key={row.col}>
                                <th>{row.col}</th>
                                {row.values.map((v, j) => (
                                  <td key={j} className={i === j ? 'corr-self' : Math.abs(v) >= corrThreshold ? 'corr-highlight' : ''}>{v.toFixed(2)}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {vifResults && (
                        <div className="vif-table-wrapper">
                          <table className="vif-table">
                            <thead><tr><th>Variable</th><th>VIF Score</th></tr></thead>
                            <tbody>
                              {vifResults.map((v) => (
                                <tr key={v.col}>
                                  <td>{v.col}</td>
                                  <td>
                                    {v.vif === Infinity ? '∞' : v.vif.toFixed(2)}
                                    <span className={`vif-flag ${v.vif > 5 ? 'high' : 'ok'}`}>{v.vif > 5 ? 'High' : 'OK'}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}

                  {corrSubTab === 'removal' && (
                    <>
                      <p className="review-card-heading">Multicollinearity Treatment Variable Removal</p>
                      <p className="treatment-desc">
                        Compares correlated pairs against the Target KPI. The variable with lower correlation to KPI is automatically dropped.
                      </p>
                      <div className="treatment-controls-row">
                        <div className="treatment-field">
                          <label>Target KPI for Correlation Comparison:</label>
                          <select value={removalTargetKpi} onChange={(e) => setRemovalTargetKpi(e.target.value)}>
                            <option value="">Select...</option>
                            {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="treatment-field">
                          <label>Removal Threshold (|r| &ge; 0.75):</label>
                          <input type="number" step="0.05" value={removalThreshold} onChange={(e) => setRemovalThreshold(Number(e.target.value) || 0.75)} />
                        </div>
                      </div>
                      <button className="outline-btn" onClick={findRemovalCandidates} disabled={!removalTargetKpi}>Find &amp; Remove Correlated Variables</button>

                      {removalResults && (
                        <div className="treatment-results">
                          {removalResults.pairs.length === 0 ? (
                            <p className="treatment-result-row">No pairs exceeded the threshold nothing to remove.</p>
                          ) : (
                            removalResults.pairs.map((p, i) => (
                              <p key={i} className="treatment-result-row">
                                <strong>{p.a}</strong> vs <strong>{p.b}</strong> (r = {p.r.toFixed(2)}) dropping{' '}
                                <strong>{p.drop}</strong> (corr to KPI {Math.abs(p.drop === p.a ? p.corrAKpi : p.corrBKpi).toFixed(2)}),
                                keeping <strong>{p.keep}</strong>.
                              </p>
                            ))
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {corrSubTab === 'combination' && (
                    <>
                      <p className="review-card-heading">Multicollinearity Treatment Variable Combination (Composite Clusters)</p>
                      <div className="combination-row">
                        <div className="treatment-field" style={{ maxWidth: 220 }}>
                          <label>Cluster Threshold (|r| &ge; 0.75):</label>
                          <input type="number" step="0.05" value={clusterThreshold} onChange={(e) => setClusterThreshold(Number(e.target.value) || 0.75)} />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.4rem' }}>Method:</label>
                          <div className="method-radio-row">
                            {['sum', 'mean', 'weighted'].map((m) => (
                              <label key={m}>
                                <input type="radio" checked={clusterMethod === m} onChange={() => setClusterMethod(m)} />
                                {m === 'sum' ? 'Sum' : m === 'mean' ? 'Mean' : 'Weighted Sum'}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                      <button className="outline-btn" onClick={findCorrelatedClusters}>Find Correlated Clusters</button>
                      <label className="drop-original-check" style={{ marginLeft: '1rem' }}>
                        <input type="checkbox" checked={dropOriginalAfterCombination} onChange={(e) => setDropOriginalAfterCombination(e.target.checked)} />
                        Drop original features after combination
                      </label>

                      {clusterResults && (
                        <div className="treatment-results">
                          {clusterResults.clusters.length === 0 ? (
                            <p className="treatment-result-row">No clusters found above this threshold.</p>
                          ) : (
                            clusterResults.clusters.map((cluster, i) => (
                              <p key={i} className="treatment-result-row">
                                Cluster {i + 1}: <strong>{cluster.join(', ')}</strong> → combined via <strong>{clusterResults.method}</strong>
                                {clusterResults.dropOriginals ? ' (originals will be dropped)' : ' (originals kept)'}.
                              </p>
                            ))
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="review-status-bar">
                <div>
                  <p className="review-status-title">Dataset Diagnostics Complete</p>
                  <p className="review-status-subtext">Ready to proceed to Adstock &amp; Saturation parameter transformations.</p>
                </div>
                <button className="proceed-btn" onClick={() => navigate('/data-transformation')}>Proceed to Data Transformation &rarr;</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Chart components (dependency-free inline SVG) ─────────────────────────
function TrendChart({ labels, series }) {
  const width = 900, height = 280, padding = 40;
  const seriesKeys = Object.keys(series);
  if (labels.length === 0 || seriesKeys.length === 0) return <p className="review-empty">No data to plot for the selected metrics.</p>;
  const allValues = seriesKeys.flatMap((k) => series[k]);
  const maxVal = Math.max(...allValues, 1), minVal = Math.min(...allValues, 0);
  const xStep = (width - padding * 2) / Math.max(labels.length - 1, 1);
  const yScale = (v) => height - padding - ((v - minVal) / (maxVal - minVal || 1)) * (height - padding * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padding + t * (height - padding * 2);
        const val = maxVal - t * (maxVal - minVal);
        return (
          <g key={t}>
            <line x1={padding} x2={width - padding} y1={y} y2={y} stroke="#eef1f6" strokeWidth="1" />
            <text x={4} y={y + 4} fontSize="10" fill="#8a94a3">{val.toFixed(0)}</text>
          </g>
        );
      })}
      {seriesKeys.map((key, i) => {
        const points = series[key].map((v, idx) => `${padding + idx * xStep},${yScale(v)}`).join(' ');
        return <polyline key={key} points={points} fill="none" stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth="2" />;
      })}
      {labels.map((l, idx) => {
        if (idx % Math.ceil(labels.length / 8) !== 0) return null;
        return <text key={l} x={padding + idx * xStep} y={height - 8} fontSize="9" fill="#8a94a3" textAnchor="middle">{l}</text>;
      })}
    </svg>
  );
}

function HistogramChart({ bins, labels }) {
  const width = 900, height = 260, padding = 40;
  const maxCount = Math.max(...bins, 1);
  const barWidth = (width - padding * 2) / bins.length;
  const yScale = (v) => height - padding - (v / maxCount) * (height - padding * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.5, 1].map((t) => {
        const y = padding + t * (height - padding * 2);
        return <line key={t} x1={padding} x2={width - padding} y1={y} y2={y} stroke="#eef1f6" strokeWidth="1" />;
      })}
      {bins.map((count, i) => (
        <rect key={i} x={padding + i * barWidth + 1} y={yScale(count)} width={barWidth - 2} height={height - padding - yScale(count)} fill="#1d2a6b" />
      ))}
      {labels.map((l, i) => {
        if (i % Math.ceil(labels.length / 8) !== 0) return null;
        return <text key={l} x={padding + i * barWidth + barWidth / 2} y={height - 8} fontSize="8" fill="#8a94a3" textAnchor="middle">{l}</text>;
      })}
    </svg>
  );
}

function ScatterChart({ points, binnedLine, xLabel, yLabel }) {
  const width = 900, height = 320, padding = 45;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys);
  const xScale = (v) => padding + ((v - minX) / (maxX - minX || 1)) * (width - padding * 2);
  const yScale = (v) => height - padding - ((v - minY) / (maxY - minY || 1)) * (height - padding * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {points.map((p, i) => <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r="2.5" fill="#94a3b8" opacity="0.5" />)}
      <polyline points={binnedLine.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ')} fill="none" stroke="#1d4ed8" strokeWidth="2.5" />
      {binnedLine.map((p, i) => <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r="3.5" fill="#1d4ed8" />)}
      <text x={width / 2} y={height - 4} fontSize="10" fill="#8a94a3" textAnchor="middle">{xLabel}</text>
      <text x={12} y={height / 2} fontSize="10" fill="#8a94a3" textAnchor="middle" transform={`rotate(-90, 12, ${height / 2})`}>{yLabel}</text>
    </svg>
  );
}

export default DataReview;