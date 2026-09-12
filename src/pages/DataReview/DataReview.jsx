import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip,
  LineChart, Line, BarChart, Bar, ComposedChart, Scatter, ReferenceLine,
} from 'recharts';
import {
  v2ListArds, v2GetCsv, problemMessage, ensureWorkflow,
  edaStats, edaSparsity, edaHistogram, edaScatter, edaPoorMansCurve,
  edaDetectOutliers, edaTrendRollup,
  correlationMatrix as fetchCorrelationMatrix,
  getHighCorrPairs,
  computeVIF as fetchVIF,
  previewRemoval, applyRemoval,
  findClusters, applyCombination,
} from '../../services/api.js';
import './DataReview.css';

const TABS = [
  { id: 'summary', label: 'Summary Stats & Sparsity' },
  { id: 'trends', label: 'Time Trends (WoW / MoM)' },
  { id: 'outliers', label: 'Distributions & Outliers' },
  { id: 'relationships', label: "Relationships & Poor Man's Curve" },
  { id: 'correlation', label: 'Correlation & Multicollinearity' },
];

const CORR_SUBTABS = [
  { id: 'analysis', label: '1. Analysis (Heatmap & VIF)' },
  { id: 'removal', label: '2. Treatment: Removal' },
  { id: 'combination', label: '3. Treatment: Combination (Sum)' },
];

const CHART_COLORS = ['#1d4ed8', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0891b2'];

// The API's own semantic classification, which is what the rest of the
// pipeline uses - so the role shown matches how the column is actually treated
// downstream rather than a second guess made from its name.
const ROLE_OF = { Metric: 'metric', Date: 'date', Dimension: 'dimension' };

/** Which badge colour a VIF row gets, from the server's own status string. */
function vifSeverity(v) {
  const status = String(v.status || '');
  if (status.includes('High')) return 'high';
  if (status.includes('Moderate')) return 'warn';
  if (status) return 'ok';
  return v.vif > 5 ? 'high' : 'ok';        // pre-status fallback
}

// ─── Column heuristics ──────────────────────────────────────────────────
// The statistics that used to live here - mean, median, stdDev, percentile,
// Pearson, OLS - are all server-side now. What remains is naming heuristics
// used to pre-select the date, geo and KPI columns.
// median, stdDev and percentile lived here to compute the summary table in the
// browser. That table now comes from /api/eda/stats, so they are gone; `mean`
// stays because the correlation tab is still client-side.
function isDateLike(colName) { return /date|week|month|period/i.test(colName); }
function isDimensionLike(colName) { return /id$|_id|npi|dma|zip|code|geo/i.test(colName); }
function isNumericColumn(rows, col) {
  return rows.every((r) => r[col] === '' || r[col] === null || typeof r[col] === 'number');
}

// VIF used to be solved here, by hand, via the normal equations. It now comes
// from /api/correlation/vif, which fits a real least-squares model: inverting
// X'X directly goes singular on collinear inputs, which is precisely the case
// VIF exists to measure - so the number shown was least trustworthy exactly
// when it mattered most.

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
  // The dependent variable. The summary endpoint needs one to build its
  // per-geo table, and the screen previously had no way to choose it.
  const [kpiColumn, setKpiColumn] = useState('');
  // Sortable summary table.
  const [sortField, setSortField] = useState('col');
  const [sortAsc, setSortAsc] = useState(true);
  const [activeTab, setActiveTab] = useState('summary');
  const [corrSubTab, setCorrSubTab] = useState('analysis');
  const [searchQuery, setSearchQuery] = useState('');

  const [aggregation, setAggregation] = useState('wow');
  const [indexedView, setIndexedView] = useState(false);
  const [selectedMetrics, setSelectedMetrics] = useState([]);
  // Tab 2's second chart: any X against any Y, independent of the trend lines.
  const [bivarX, setBivarX] = useState('');
  const [bivarY, setBivarY] = useState('');
  const [bivarRaw, setBivarRaw] = useState(null);

  const [distVariable, setDistVariable] = useState('');
  const [outlierVariable, setOutlierVariable] = useState('');
  const [outlierThreshold, setOutlierThreshold] = useState(1.5);
  const [outlierMethod, setOutlierMethod] = useState('iqr');
  const [excludedRowKeys, setExcludedRowKeys] = useState(new Set());

  const [xAxisVar, setXAxisVar] = useState('');
  const [yAxisVar, setYAxisVar] = useState('');

  // Server-computed panels. The engines live in core/processing.py; the
  // browser no longer recomputes them. Each holds the raw API response and is
  // mapped below into the exact shape the render already consumed, so the
  // markup is untouched.
  const [statsResult, setStatsResult] = useState(null);
  const [sparsityMap, setSparsityMap] = useState({});
  const [trendRaw, setTrendRaw] = useState([]);
  const [histRaw, setHistRaw] = useState(null);
  const [outlierRaw, setOutlierRaw] = useState(null);
  const [scatterRaw, setScatterRaw] = useState(null);
  const [curveRaw, setCurveRaw] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);

  const [corrThreshold, setCorrThreshold] = useState(0.7);
  // Which variables the ANALYSIS sub-tab looks at: the heatmap, the high
  // collinearity pairs and VIF. It narrows what you are reading, nothing more.
  //
  // The two treatments deliberately ignore it and work across every tactic.
  // Removal and combination change the dataset, and scoping them to whatever
  // happened to be ticked for a heatmap would silently leave correlated
  // variables in the data because they were not on screen at the time.
  const [corrSelectedCols, setCorrSelectedCols] = useState([]);
  // A pending destructive action, shown for confirmation before it runs.
  // Excluding rows and dropping columns are not undoable from the server -
  // this dataset only exists in the browser - so each is confirmed first.
  const [confirm, setConfirm] = useState(null);
  const [vifResults, setVifResults] = useState(null);

  const [removalTargetKpi, setRemovalTargetKpi] = useState('');
  const [removalThreshold, setRemovalThreshold] = useState(0.75);
  const [removalResults, setRemovalResults] = useState(null);

  const [clusterThreshold, setClusterThreshold] = useState(0.75);
  // Combination is always a SUM of a correlated PAIR. Mean and weighted-sum
  // were offered here but are not part of this treatment: summing two collinear
  // tactics keeps the combined spend on the same scale as its parts, which is
  // what makes the composite interpretable in the model downstream.
  const CLUSTER_METHOD = 'sum';
  // One editable name per pair, defaulted from the pair itself.
  const [clusterNames, setClusterNames] = useState([]);
  // What a treatment produced: { title, columns, preview, rows, cols }. Both
  // apply endpoints return the first rows of the new dataset, so the change can
  // be seen rather than just described.
  const [treatmentResult, setTreatmentResult] = useState(null);
  // In flight. These calls run on the whole dataset server-side, so on a large
  // ARD they take long enough that an unchanged button reads as "nothing
  // happened" and invites a second click.
  const [scanningRemoval, setScanningRemoval] = useState(false);
  const [findingClusters, setFindingClusters] = useState(false);
  const [computingVif, setComputingVif] = useState(false);
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
      // Never the date or geo key: the API cannot group a column by itself.
      const guessedKpi =
        cols.find((c) => c !== guessedDate && c !== guessedGeo && /sale|trx|nrx|kpi|revenue/i.test(c)) ||
        cols.find((c) => c !== guessedDate && c !== guessedGeo && isNumericColumn(parsed.data, c)) ||
        '';
      setKpiColumn(guessedKpi);

      const metricCols = cols.filter((c) => c !== guessedDate && c !== guessedGeo && isNumericColumn(parsed.data, c));
      setSelectedMetrics(metricCols.slice(0, 2));
      setOutlierVariable(metricCols[0] || '');
      setDistVariable(metricCols[0] || '');
      setXAxisVar(metricCols[0] || '');
      setYAxisVar(metricCols[1] || metricCols[0] || '');
      setRemovalTargetKpi(metricCols[metricCols.length - 1] || '');
      setBivarX(metricCols[0] || '');
      setBivarY(metricCols[1] || metricCols[0] || '');
      // Eight is a readable heatmap, not a limit: the picker below can change it.
      setCorrSelectedCols(metricCols.slice(0, 8));
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

  // The CSV as the user currently sees it. Rebuilt when rows are excluded, so
  // every analysis runs on the same row set shown on screen rather than on the
  // stored dataset. Serialising here is what lets outlier exclusion work
  // without writing anything back to the database.
  const activeCsv = useMemo(
    () => (activeRows.length ? Papa.unparse(activeRows) : ''),
    [activeRows]
  );

  // One place to report a failed panel. Without this a 404 or a 422 is
  // indistinguishable from "no data" - the panel just renders empty.
  const failed = (what) => (err) => {
    setAnalysisError(`${what}: ${err instanceof Error ? (err.text || err.message) : String(err)}`);
  };

  // ── Tab 1: summary, then sparsity for whatever it calls numeric ──────────
  useEffect(() => {
    if (!activeCsv || !dateKey || !geoKey) return undefined;
    let cancelled = false;
    if (!kpiColumn) return undefined;
    const dep = kpiColumn;
    edaStats({ csv_data: activeCsv, date_column: dateKey, geo_column: geoKey,
               dependent_variable: dep })
      .then((data) => {
        if (cancelled) return;
        // Cleared on success rather than up front, so the effect sets no state
        // synchronously (which would cascade a render on every dependency tick).
        setAnalysisError(null);
        setStatsResult(data);
        return edaSparsity({ csv_data: activeCsv, metric_columns: data.numeric_cols || [] });
      })
      .then((sp) => {
        if (cancelled || !sp) return;
        setSparsityMap(Object.fromEntries((sp.sparsity_table || []).map((r) => [r.tactic, r])));
      })
      .catch(failed('Summary stats'));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeCsv, dateKey, geoKey, kpiColumn]);

  // ── Tab 2: trend rollup ──────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'trends' || !activeCsv || !dateKey || !selectedMetrics.length) {
      return undefined;
    }
    let cancelled = false;
    edaTrendRollup({ csv_data: activeCsv, date_column: dateKey,
                     metric_columns: selectedMetrics,
                     period: aggregation === 'mom' ? 'month' : 'week' })
      .then((d) => { if (!cancelled) setTrendRaw(d.trend_data || []); })
      .catch((err) => { if (!cancelled) { setTrendRaw([]); failed('Trend rollup')(err); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, dateKey, selectedMetrics, aggregation]);


  // ── Tab 2: the bivariate explorer's own scatter ──────────────────────────
  useEffect(() => {
    if (activeTab !== 'trends' || !activeCsv || !bivarX || !bivarY) return undefined;
    let cancelled = false;
    edaScatter({ csv_data: activeCsv, x_column: bivarX, y_column: bivarY })
      .then((d) => { if (!cancelled) setBivarRaw(d); })
      .catch((err) => { if (!cancelled) { setBivarRaw(null); failed('Relationship explorer')(err); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, bivarX, bivarY]);

  // ── Tab 3: histogram ─────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'outliers' || !activeCsv || !distVariable) return undefined;
    let cancelled = false;
    edaHistogram({ csv_data: activeCsv, column: distVariable })
      .then((d) => { if (!cancelled) setHistRaw(d); })
      .catch((err) => { if (!cancelled) { setHistRaw(null); failed('Histogram')(err); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, distVariable]);

  // ── Tab 3: outliers ──────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'outliers' || !activeCsv || !outlierVariable) return undefined;
    let cancelled = false;
    edaDetectOutliers({ csv_data: activeCsv, column: outlierVariable,
                        method: outlierMethod, threshold: Number(outlierThreshold) || 1.5 })
      .then((d) => { if (!cancelled) setOutlierRaw(d); })
      .catch((err) => { if (!cancelled) { setOutlierRaw(null); failed('Outlier detection')(err); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, outlierVariable, outlierMethod, outlierThreshold]);

  // ── Tab 4: scatter + poor man's curve, fired together ────────────────────
  useEffect(() => {
    if (activeTab !== 'relationships' || !activeCsv || !xAxisVar || !yAxisVar) {
      return undefined;
    }
    let cancelled = false;
    Promise.all([
      edaScatter({ csv_data: activeCsv, x_column: xAxisVar, y_column: yAxisVar }),
      edaPoorMansCurve({ csv_data: activeCsv, x_column: xAxisVar, y_column: yAxisVar, n_bins: 12 }),
    ])
      .then(([s, c]) => { if (!cancelled) { setScatterRaw(s); setCurveRaw(c); } })
      .catch((err) => {
        if (cancelled) return;
        setScatterRaw(null); setCurveRaw(null);
        failed("Relationship / response curve")(err);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, xAxisVar, yAxisVar]);

  const metricColumns = useMemo(
    () => columns.filter((c) => c !== dateKey && c !== geoKey && isNumericColumn(rows, c)),
    [columns, rows, dateKey, geoKey]
  );

  // ---- Tab 1: Summary stats (server) ----
  // `type` comes from the API's own semantic classification, which is what the
  // rest of the pipeline uses - so the role shown here matches how the column
  // will actually be treated downstream, rather than a second guess made from
  // its name.
  const num = (v) => (typeof v === 'number' ? v : 0);

  const columnStats = useMemo(() => {
    const summary = statsResult?.summary_stats || [];
    return summary.map((s) => {
      const role = ROLE_OF[s.type] || 'dimension';
      const base = { col: s.variable, role, distinct: num(s.unique_count) };
      if (role === 'metric') {
        const sp = sparsityMap[s.variable];
        return {
          ...base,
          // Sparsity is a second call; until it lands the health badge reads 0%.
          pctActive: num(sp?.non_zero_pct),
          activeCount: num(sp?.non_zero_count),
          mean: num(s.mean), median: num(s.median), std: num(s.std),
          min: num(s.min), max: num(s.max), p75: num(s.p75), p95: num(s.p95),
          // The figure a reviewer reconciles against the source system.
          controlTotal: typeof s.control_total === 'number' ? s.control_total : null,
          missingPct: num(s.missing_pct),
        };
      }
      // Date min/max arrive as ISO strings and are rendered as-is. Non-metrics
      // have no total, but they do have a missing count worth showing.
      return { ...base, min: s.min, max: s.max, controlTotal: null,
               missingPct: num(s.missing_pct) };
    });
  }, [statsResult, sparsityMap]);
  const filteredStats = useMemo(() => {
    const matched = columnStats.filter((s) =>
      s.col.toLowerCase().includes(searchQuery.toLowerCase()));
    const dir = sortAsc ? 1 : -1;
    return [...matched].sort((a, b) => {
      const av = a[sortField], bv = b[sortField];
      // Blanks last regardless of direction - a column with no total should
      // not win the sort just because it has nothing to compare.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [columnStats, searchQuery, sortField, sortAsc]);

  const sortBy = (field) => {
    if (field === sortField) setSortAsc((asc) => !asc);
    else { setSortField(field); setSortAsc(true); }
  };

  // ---- Tab 2: Time trends (server) ----
  // The rollup is server-side because bucketing by week or month means parsing
  // the date column, and parsing it by inference is how day and month get
  // transposed. The API picks one explicit format for the whole column.
  // Rebasing to 100 stays here: it is presentation, not aggregation.
  const trendData = useMemo(() => {
    if (!trendRaw.length || selectedMetrics.length === 0) return { labels: [], series: {} };
    const labels = trendRaw.map((r) => r.date);
    const series = {};
    selectedMetrics.forEach((m) => {
      let values = trendRaw.map((r) => Number(r[m]) || 0);
      if (indexedView && values[0]) { const base = values[0]; values = values.map((v) => (v / base) * 100); }
      series[m] = values;
    });
    return { labels, series };
  }, [trendRaw, selectedMetrics, indexedView]);

  // ---- Tab 3: Distribution histogram (server) ----
  // The API gives one bin per value for small integer ranges, so a column of
  // 1..8 call counts reads as eight bars rather than "1.0 - 1.9".
  const histogramData = useMemo(() => {
    if (!histRaw || !(histRaw.counts || []).length) return null;
    return {
      bins: histRaw.counts,
      labels: histRaw.bin_labels,
      mean: num(histRaw.mean), median: num(histRaw.median),
      min: num(histRaw.min), max: num(histRaw.max),
    };
  }, [histRaw]);

  // ---- Tab 3: Outlier detection (server) ----
  // `outlier_indices` are positions in the CSV that was sent, and that CSV is
  // built from activeRows in order - so they index activeRows directly, which
  // is what `excludeOutliers` below relies on.
  const outlierResult = useMemo(() => {
    if (!outlierRaw) return null;
    return {
      lower: num(outlierRaw.lower_bound),
      upper: num(outlierRaw.upper_bound),
      flaggedIndices: outlierRaw.outlier_indices || [],
      pct: num(outlierRaw.outlier_pct),
    };
  }, [outlierRaw]);

  // The Poor Man's Curve is drawn straight from `curveRaw.binned_curve` now,
  // so the scatter/curve merge that used to live here is gone. The trends
  // tab's own explorer still uses ScatterChart, from `bivarRaw`.


  // ---- Tab 5a: Correlation matrix (for heatmap) ----
  // The matrix now comes from /api/correlation/matrix. Kept in the same
  // [{ col, values }] shape the heatmap already renders, so only the source
  // changed - Pearson on strings coerced with `Number(x) || 0` silently scored
  // every unparseable value as a real zero.
  const [corrRaw, setCorrRaw] = useState(null);
  // Which pairs clear the highlight threshold. Listed under the heatmap so the
  // cells a reader has to hunt for are also spelled out.
  const [highPairs, setHighPairs] = useState([]);
  const correlationMatrix = useMemo(() => {
    if (!corrRaw) return [];
    const { matrix, columns } = corrRaw;
    return (columns || []).map((c1) => ({
      col: c1,
      values: (columns || []).map((c2) => Number(matrix?.[c1]?.[c2] ?? 0)),
    }));
  }, [corrRaw]);

  useEffect(() => {
    if (activeTab !== 'correlation' || !activeCsv || corrSelectedCols.length < 2) {
      return undefined;
    }
    let cancelled = false;
    fetchCorrelationMatrix({ csv_data: activeCsv, columns: corrSelectedCols })
      .then((d) => { if (!cancelled) setCorrRaw(d); })
      .catch((err) => { if (!cancelled) { setCorrRaw(null); failed('Correlation matrix')(err); } });
    getHighCorrPairs({ csv_data: activeCsv, columns: corrSelectedCols, threshold: corrThreshold })
      .then((d) => { if (!cancelled) setHighPairs(d.pairs || []); })
      .catch(() => { if (!cancelled) setHighPairs([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [activeTab, activeCsv, corrSelectedCols, corrThreshold]);

  // VIF from the server. The browser version solved the normal equations by
  // hand, which goes singular on exactly the collinear inputs VIF exists to
  // measure - the number it produced there was noise.
  const computeVIF = () => {
    if (corrSelectedCols.length < 2) return;
    setVifResults(null);
    setComputingVif(true);
    fetchVIF({ csv_data: activeCsv, columns: corrSelectedCols })
      .then((d) => setVifResults(
        // Mapped to the keys the table already renders.
        (d.vif || []).map((v) => ({
          col: v.variable,
          vif: v.VIF,
          // Emoji prefix stripped: the badge colour already says the severity.
          status: String(v.status || '').replace(/[^\x20-\x7E]/g, '').trim(),
        }))
      ))
      .catch(failed('VIF'))
      .finally(() => setComputingVif(false));
  };

  const findRemovalCandidates = () => {
    if (!removalTargetKpi || metricColumns.length < 2) return;
    setScanningRemoval(true);
    previewRemoval({
      csv_data: activeCsv,
      // Every tactic, not the analysis selection.
      columns: metricColumns,
      threshold: Number(removalThreshold) || 0.75,
      dependent_variable: removalTargetKpi,
    })
      .then((d) => setRemovalResults({
        // Same keys the results list already renders, plus the server's own
        // explanation of why each side was chosen.
        pairs: (d.pairs || []).map((p) => ({
          a: p.feature1, b: p.feature2, r: Number(p.correlation),
          drop: p.will_drop, keep: p.will_keep, reason: p.reason,
        })),
        dropped: d.dropped || [],
        kept: d.kept || [],
      }))
      .catch(failed('Removal scan'))
      .finally(() => setScanningRemoval(false));
  };


  // The removal scan runs only when asked. It reads the whole dataset, so
  // firing it on every sub-tab visit spends real time on a result the user
  // may not have wanted yet.


  const findCorrelatedClusters = () => {
    if (metricColumns.length < 2) return;
    setFindingClusters(true);
    findClusters({
      csv_data: activeCsv,
      // Every tactic, for the same reason as the removal scan.
      columns: metricColumns,
      threshold: Number(clusterThreshold) || 0.75,
    })
      .then((d) => {
        const clusters = d.clusters || [];
        setClusterResults({
          clusters,
          method: CLUSTER_METHOD,
          dropOriginals: dropOriginalAfterCombination,
        });
        setClusterNames(clusters.map((c) => `SUM_${String(c[0]).toUpperCase()}_${String(c[1] ?? '').toUpperCase()}`));
      })
      .catch(failed('Cluster scan'))
      .finally(() => setFindingClusters(false));
  };


  const selectedArd = ards.find((a) => a.filename === selectedArdFilename);

  /**
   * Adopt a dataset the server returned.
   *
   * Both treatments now come back as CSV rather than a list of edits to make
   * locally: the removal and the combination happen in pandas, so the screen
   * re-parses the result and every tab recomputes from it. Row exclusions are
   * cleared because their indices referred to the previous row set.
   */
  const adoptCsv = (csvText, note) => {
    setTreatmentResult(null);
    const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
    const cols = parsed.meta?.fields || [];
    setRows(parsed.data);
    setColumns(cols);
    setExcludedRowKeys(new Set());
    setSelectedMetrics((prev) => prev.filter((c) => cols.includes(c)));
    setCorrSelectedCols((prev) => {
      const kept = prev.filter((c) => cols.includes(c));
      return kept.length >= 2 ? kept : cols.filter((c) => c !== dateKey && c !== geoKey).slice(0, 8);
    });
    // `activeCsv` is derived from `rows`, so replacing the rows is enough -
    // every panel refetches against the new dataset on its own.
    setStatsResult(null);
    setCorrRaw(null);
    setVifResults(null);
    setAnalysisError(note || null);
  };

  /**
   * Apply a removal. With no argument this drops everything the scan suggested;
   * with a list it drops only those, which is what the per-pair buttons use.
   */
  const applyRemovalTreatment = (only) => {
    const drop = only && only.length
      ? only
      : [...new Set((removalResults?.pairs || []).map((p) => p.drop))];
    if (!drop.length) return;
    applyRemoval({ csv_data: activeCsv, columns: metricColumns, drop_cols: drop })
      .then((res) => {
        adoptCsv(res.csv_data, null);
        setTreatmentResult({
          title: `Removed ${(res.dropped || drop).length} variable(s): ${(res.dropped || drop).join(', ')}`,
          columns: res.columns || [],
          preview: res.preview || [],
          rows: res.rows,
          cols: res.cols,
        });
        setRemovalResults(null);
      })
      .catch(failed('Apply removal'));
  };

  const applyCombinationTreatment = () => {
    const clusters = clusterResults?.clusters || [];
    if (!clusters.length) return;
    const names = clusters.map((c, i) =>
      (clusterNames[i] || '').trim() ||
      `SUM_${String(c[0]).toUpperCase()}_${String(c[1] ?? '').toUpperCase()}`);
    applyCombination({
      csv_data: activeCsv,
      columns: metricColumns,
      clusters,
      new_names: names,
      method: CLUSTER_METHOD,
      drop_original: clusterResults.dropOriginals,
    })
      .then((res) => {
        adoptCsv(res.csv_data, null);
        setTreatmentResult({
          title: `Sum columns created: ${names.join(', ')}`,
          columns: res.columns || [],
          preview: res.preview || [],
          rows: res.rows,
          cols: res.cols,
        });
        setClusterResults(null);
        setClusterNames([]);
      })
      .catch(failed('Apply combination'));
  };



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
              <div className="ard-select-field">
                <label>Dependent Variable (KPI)</label>
                <select value={kpiColumn} onChange={(e) => setKpiColumn(e.target.value)}>
                  {columns
                    .filter((c) => c !== dateKey && c !== geoKey)
                    .map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button className="recalc-btn" onClick={() => loadArdData(selectedArdFilename)}> Recalculate EDA</button>
            </div>
          </div>

          {isLoadingData && <p className="review-empty">Loading dataset...</p>}
          {dataError && <div className="review-error-banner">{dataError}</div>}
          {/* A failed panel used to look identical to an empty one. */}
          {analysisError && <div className="review-error-banner">{analysisError}</div>}

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
                        <tr>
                          {[
                            ['col', 'Variable'],
                            ['role', 'Role'],
                            ['distinct', 'Distinct (N)'],
                            ['controlTotal', 'Control Totals (Sum)'],
                            ['pctActive', 'Active / Sparsity Health'],
                            ['mean', 'Mean'],
                            ['median', 'Median'],
                            ['std', 'Std Dev'],
                            ['min', 'Min'],
                            ['max', 'Max'],
                            ['p75', '75th %ile'],
                            ['p95', '95th %ile'],
                            ['missingPct', '% Missing'],
                          ].map(([field, title]) => (
                            <th
                              key={field}
                              className="sortable-th"
                              onClick={() => sortBy(field)}
                              role="button"
                              tabIndex={0}
                            >
                              {title}{sortField === field ? (sortAsc ? ' \u25B2' : ' \u25BC') : ''}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredStats.map((s) => (
                          <tr key={s.col}>
                            <td><strong>{s.col}</strong></td>
                            <td><span className={`role-badge ${s.role}`}>{s.role.charAt(0).toUpperCase() + s.role.slice(1)}</span></td>
                            <td>{s.distinct.toLocaleString()}</td>
                            <td>{s.controlTotal != null ? s.controlTotal.toLocaleString() : '—'}</td>
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
                            <td>{s.role === 'metric' ? s.p95.toFixed(2) : '—'}</td>
                            <td>
                              <span className={`health-badge ${s.missingPct === 0 ? 'good' : s.missingPct <= 5 ? 'warn' : 'bad'}`}>
                                {s.missingPct.toFixed(2)}%
                              </span>
                            </td>
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
                    <TrendChart labels={trendData.labels} series={trendData.series} indexed={indexedView} />
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

              {/* ---- Custom Relationship Explorer (lives on the Trends tab) ---- */}
              {activeTab === 'trends' && (
                <div className="review-card">
                  <p className="review-card-heading">Custom Relationship Explorer (X vs Y Comparison)</p>
                  <p className="treatment-desc">
                    Compare any two metrics directly, with a least-squares fit. Independent of
                    the trend lines above.
                  </p>
                  <div className="trend-controls-row">
                    <div className="ard-select-field">
                      <label>X Metric</label>
                      <select value={bivarX} onChange={(e) => setBivarX(e.target.value)}>
                        {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="ard-select-field">
                      <label>Y Metric</label>
                      <select value={bivarY} onChange={(e) => setBivarY(e.target.value)}>
                        {metricColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>

                  {bivarRaw && typeof bivarRaw.r === 'number' && (
                    <div className="curve-verdict-row">
                      <span className={`shape-badge${Math.abs(bivarRaw.r) >= 0.7 ? ' saturating'
                        : Math.abs(bivarRaw.r) >= 0.4 ? ' convex' : ''}`}>
                        {Math.abs(bivarRaw.r) >= 0.7 ? 'Strong' : Math.abs(bivarRaw.r) >= 0.4 ? 'Moderate' : 'Weak'} relationship
                      </span>
                      <span className="curve-stat">
                        r = <strong>{bivarRaw.r.toFixed(4)}</strong>
                        {' · '}slope <strong>{Number(bivarRaw.slope || 0).toFixed(4)}</strong>
                        {' · '}intercept <strong>{Number(bivarRaw.intercept || 0).toFixed(2)}</strong>
                      </span>
                    </div>
                  )}

                  {bivarRaw && (bivarRaw.x || []).length > 0 ? (
                    <ScatterChart
                      points={(bivarRaw.x || []).map((x, i) => ({ x, y: bivarRaw.y[i] }))}
                      binnedLine={[]}
                      trendline={bivarRaw.trendline || []}
                      xLabel={bivarX}
                      yLabel={bivarY}
                    />
                  ) : (
                    <p className="review-empty">Select two metrics to compare.</p>
                  )}
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
                          <label>Detection Strategy</label>
                          <select value={outlierMethod} onChange={(e) => setOutlierMethod(e.target.value)}>
                            <option value="iqr">IQR (Interquartile Range)</option>
                            <option value="zscore">Z-Score (Standard Deviations)</option>
                          </select>
                        </div>
                        <div className="ard-select-field">
                          <label>
                            Threshold Value: (N &times; {outlierMethod === 'zscore' ? 'σ' : 'IQR'})
                          </label>
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
                        <button
                          className="exclude-btn"
                          onClick={() => setConfirm({
                            title: 'Exclude flagged rows?',
                            body: `${outlierResult.flaggedIndices.length.toLocaleString()} row(s) will be removed from every chart and table on this screen. The stored dataset is not changed, and "Restore Original Dataset" puts them back.`,
                            label: 'Confirm & Exclude Rows',
                            danger: true,
                            run: excludeOutliers,
                          })}
                        >Exclude {outlierResult.flaggedIndices.length} Outliers from Dataset</button>
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
                  {(curveRaw || scatterRaw) && (
                    <div className="curve-verdict-row">
                      {curveRaw?.shape_indicator && (
                        <span className={`shape-badge${/Diminishing/i.test(curveRaw.shape_indicator) ? ' saturating'
                          : /Accelerating/i.test(curveRaw.shape_indicator) ? ' convex' : ''}`}>
                          {curveRaw.shape_indicator}
                        </span>
                      )}
                      {scatterRaw && typeof scatterRaw.r === 'number' && (
                        <span className="curve-stat">
                          r = <strong>{scatterRaw.r.toFixed(4)}</strong>
                          {' · '}slope <strong>{Number(scatterRaw.slope || 0).toFixed(4)}</strong>
                        </span>
                      )}
                      {curveRaw?.binned_curve?.length > 0 && (
                        <span className="curve-stat">
                          {curveRaw.binned_curve.length} quantile bins
                        </span>
                      )}
                    </div>
                  )}
                  <p className="treatment-desc">Binned average response curve:</p>
                  {curveRaw?.binned_curve?.length > 0 ? (
                    <BinnedCurveChart
                      data={curveRaw.binned_curve}
                      xLabel={xAxisVar}
                      yLabel={yAxisVar}
                    />
                  ) : (
                    <p className="review-empty">
                      Select two metrics to build the response curve.
                    </p>
                  )}
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
                  <p className="review-card-heading">Select Variables to Include in Multicollinearity Analysis</p>
                  <div className="metric-select-row">
                    <p className="treatment-desc" style={{ marginBottom: 0 }}>
                      Choose the tactics to analyse ({corrSelectedCols.length} selected).
                      This narrows the heatmap, the pair list and the VIF table on this
                      tab only. Both treatments always consider every tactic.
                    </p>
                    <p className="metric-select-links">
                      <span onClick={() => setCorrSelectedCols(metricColumns)}>Select All</span>{' | '}
                      <span onClick={() => setCorrSelectedCols(metricColumns.slice(0, 2))}>Reset to 2</span>
                    </p>
                  </div>
                  <div className="metric-pills">
                    {metricColumns.map((m) => (
                      <span
                        key={m}
                        className={`metric-pill${corrSelectedCols.includes(m) ? ' selected' : ''}`}
                        onClick={() => setCorrSelectedCols((prev) => {
                          // Correlation needs a pair. Deselecting past that
                          // would empty the heatmap with no explanation.
                          if (prev.includes(m)) {
                            return prev.length <= 2 ? prev : prev.filter((x) => x !== m);
                          }
                          return [...prev, m];
                        })}
                      >{m}</span>
                    ))}
                  </div>
                  {corrSelectedCols.length < 2 && (
                    <p className="review-empty">Select at least two variables to compare.</p>
                  )}

                      <p className="review-card-heading">Pairwise Correlation &amp; Multicollinearity Matrix</p>
                      <div className="threshold-slider-row">
                        <label>Highlight Threshold (|r| &ge; {corrThreshold.toFixed(2)}):</label>
                        <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} />
                        <button
                          className="outline-btn"
                          onClick={computeVIF}
                          disabled={computingVif || corrSelectedCols.length < 2}
                        >{computingVif ? 'Computing VIF…' : 'Compute VIF Scores'}</button>
                      </div>
                      <p className="treatment-desc">
                        Feature correlation heatmap, highlighted for |r| &ge; {corrThreshold.toFixed(2)}.
                      </p>
                      <div className="corr-table-wrapper">
                        <table className="corr-table">
                          <thead><tr><th>Variable</th>{correlationMatrix.map((row) => <th key={row.col}>{row.col}</th>)}</tr></thead>
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
                      {highPairs.length > 0 && (
                        <>
                          <p className="treatment-desc">
                            High collinearity pairs (|r| &ge; {corrThreshold.toFixed(2)}):
                          </p>
                          <div className="vif-table-wrapper">
                            <table className="vif-table">
                              <thead><tr><th>Tactic 1</th><th>Tactic 2</th><th>Correlation (|r|)</th></tr></thead>
                              <tbody>
                                {highPairs.map((p) => (
                                  <tr key={`${p.feature1}|${p.feature2}`}>
                                    <td>{p.feature1}</td>
                                    <td>{p.feature2}</td>
                                    <td>{Math.abs(Number(p.corr)).toFixed(4)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}

                      {corrSelectedCols.length >= 2 && highPairs.length === 0 && corrRaw && (
                        <p className="review-empty">
                          No pair reaches |r| &ge; {corrThreshold.toFixed(2)}.
                        </p>
                      )}

                      {vifResults && (
                        <div className="vif-table-wrapper">
                          <table className="vif-table">
                            <thead><tr><th>Variable</th><th>VIF</th><th>Status</th></tr></thead>
                            <tbody>
                              {vifResults.map((v) => (
                                <tr key={v.col}>
                                  <td>{v.col}</td>
                                  <td>{Number.isFinite(v.vif) ? v.vif.toFixed(2) : '∞'}</td>
                                  <td>
                                    {/* The server's own verdict, not a second
                                        threshold applied here - it already
                                        distinguishes Moderate from High. */}
                                    <span className={`vif-flag ${vifSeverity(v)}`}>
                                      {v.status || (v.vif > 5 ? 'High (>10)' : 'OK (<5)')}
                                    </span>
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
                      <button
                        className="primary-btn"
                        onClick={findRemovalCandidates}
                        disabled={scanningRemoval || !removalTargetKpi}
                      >{scanningRemoval ? 'Scanning…' : 'Scan Correlated Pairs'}</button>

                      {scanningRemoval && (
                        <p className="review-empty">Scanning for correlated pairs…</p>
                      )}

                      {!scanningRemoval && removalResults && (
                        <div className="treatment-results">
                          {removalResults.pairs.length === 0 ? (
                            <p className="treatment-result-row">
                              No pair reaches |r| &ge; {Number(removalThreshold).toFixed(2)} against{' '}
                              <strong>{removalTargetKpi}</strong>. Try lowering the threshold.
                            </p>
                          ) : (
                            removalResults.pairs.map((p, i) => (
                              <div key={i} className="removal-pair-row">
                                <div>
                                  <p className="removal-pair-title">
                                    {p.a} &harr; {p.b} (|r| = {Math.abs(p.r).toFixed(4)})
                                  </p>
                                  {/* The server explains which side it keeps and
                                      why, against the chosen KPI. */}
                                  <p className="removal-pair-reason">
                                    {p.reason || `${p.keep} kept, ${p.drop} dropped`}
                                  </p>
                                </div>
                                {/* Dropping one pair at a time, rather than only
                                    all of them: the automatic choice is a
                                    suggestion, and a modeller may disagree about
                                    a single pair without rejecting the rest. */}
                                <button
                                  className="drop-one-btn"
                                  onClick={() => setConfirm({
                                    title: `Drop "${p.drop}"?`,
                                    body: `"${p.drop}" will be removed from this dataset. "${p.keep}" is kept because it correlates more strongly with ${removalTargetKpi}. Re-select the ARD above to get it back.`,
                                    label: `Confirm & Drop "${p.drop}"`,
                                    danger: true,
                                    run: () => applyRemovalTreatment([p.drop]),
                                  })}
                                >Drop &quot;{p.drop}&quot;</button>
                              </div>
                            ))
                          )}
                          {removalResults.pairs.length > 0 && (
                            <button
                              className="exclude-btn"
                              onClick={() => setConfirm({
                                title: 'Apply this removal?',
                                body: `${removalResults.pairs.length} column(s) will be dropped from this dataset: ${[...new Set(removalResults.pairs.map((p) => p.drop))].join(', ')}. Re-select the ARD above to get them back.`,
                                label: 'Confirm & Apply Removal',
                                danger: true,
                                run: applyRemovalTreatment,
                              })}
                            >Apply All ({new Set(removalResults.pairs.map((p) => p.drop)).size} columns)</button>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {corrSubTab === 'combination' && (
                    <>
                      <p className="review-card-heading">Multicollinearity Treatment: Variable Combination (Sum Pairs)</p>
                      <div className="combination-row">
                        <div className="treatment-field" style={{ maxWidth: 260 }}>
                          <label>Pairwise Correlation Threshold (|r| &ge; {Number(clusterThreshold).toFixed(2)}):</label>
                          <input
                            type="number" step="0.05" min="0" max="1"
                            value={clusterThreshold}
                            onChange={(e) => setClusterThreshold(Number(e.target.value) || 0.75)}
                          />
                        </div>
                        {/* No method choice: this treatment sums a correlated
                            pair. Mean and weighted-sum were offered here but are
                            not part of it. */}
                        <label className="drop-original-check">
                          <input
                            type="checkbox"
                            checked={dropOriginalAfterCombination}
                            onChange={(e) => setDropOriginalAfterCombination(e.target.checked)}
                          />
                          Drop original features after summing
                        </label>
                      </div>

                      <button
                        className="primary-btn"
                        onClick={findCorrelatedClusters}
                        disabled={findingClusters || metricColumns.length < 2}
                      >
                        {findingClusters ? 'Finding…' : 'Find Correlated Pairs'}
                      </button>

                      {clusterResults && clusterResults.clusters.length > 0 && (
                        <>
                          {/* One card per pair, each with its own name. The
                              default encodes what the column is, so a composite
                              is still readable in the model output. */}
                          {clusterResults.clusters.map((cluster, i) => (
                            <div key={i} className="combo-pair-card">
                              <p className="combo-pair-title">
                                Pair #{i + 1}: {cluster[0]} + {cluster[1]}
                              </p>
                              <input
                                type="text"
                                className="combo-pair-name"
                                value={clusterNames[i] || ''}
                                onChange={(e) => setClusterNames((prev) => {
                                  const next = [...prev];
                                  next[i] = e.target.value;
                                  return next;
                                })}
                              />
                            </div>
                          ))}

                          <button
                            className="primary-btn"
                            onClick={() => setConfirm({
                              title: 'Apply this combination?',
                              body: `${clusterResults.clusters.length} pair(s) will be summed into new column(s)${clusterResults.dropOriginals ? ', and the original columns dropped' : ', keeping the originals'}. Re-select the ARD above to start over.`,
                              label: 'Confirm Combination',
                              danger: false,
                              run: applyCombinationTreatment,
                            })}
                          >Preview &amp; Apply Combination</button>
                        </>
                      )}

                      {clusterResults && clusterResults.clusters.length === 0 && (
                        <div className="treatment-results">
                          <p className="treatment-result-row">
                            No correlated pair reaches |r| &ge; {Number(clusterThreshold).toFixed(2)}. Try lowering the threshold.
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {treatmentResult && (
                    <div className="treatment-preview">
                      <p className="treatment-preview-title">
                        &#10003; {treatmentResult.title}
                      </p>
                      <p className="treatment-preview-meta">
                        Dataset is now {Number(treatmentResult.rows || 0).toLocaleString()} rows
                        &times; {treatmentResult.cols} columns. Showing the first
                        {' '}{Math.min(10, (treatmentResult.preview || []).length)} rows.
                      </p>
                      <div className="stats-table-wrapper">
                        <table className="stats-table">
                          <thead>
                            <tr>{treatmentResult.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                          </thead>
                          <tbody>
                            {treatmentResult.preview.slice(0, 10).map((row, i) => (
                              <tr key={i}>
                                {treatmentResult.columns.map((c) => (
                                  <td key={c}>
                                    {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                </div>
              )}

              {confirm && (
                <div className="modal-overlay" role="dialog" aria-modal="true">
                  <div className="confirm-modal">
                    <p className="confirm-modal-title">{confirm.title}</p>
                    <p className="confirm-modal-body">{confirm.body}</p>
                    <div className="modal-footer">
                      <button className="modal-btn" onClick={() => setConfirm(null)}>Cancel</button>
                      <button
                        className={`modal-btn primary${confirm.danger ? ' danger' : ''}`}
                        onClick={() => { confirm.run(); setConfirm(null); }}
                      >{confirm.label}</button>
                    </div>
                  </div>
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

// ─── Chart components ──────────────────────────────────────────────────────
// Rendered with recharts so every chart in the app is drawn by the same
// library. The tooltip is ours: recharts' default is replaced with
// `ChartTooltip` below via the `content` prop, so the box keeps the design it
// had when the charts were hand-drawn SVG.

/** Shared axis/grid treatment, so the three charts stay visually identical. */
const GRID = '#eef1f6';
const AXIS_TICK = { fontSize: 10, fill: '#8a94a3' };

const fmt = (v) => (Number.isFinite(v)
  ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(Number(v).toFixed(2)).toLocaleString())
  : '—');

/**
 * Our tooltip, in recharts' contract.
 *
 * recharts calls this with { active, payload, label }; `payload` is one entry
 * per series under the cursor, each carrying its colour. `rows` lets a caller
 * override the lines entirely - the histogram uses it to add a share-of-total
 * that is not a series.
 */
function ChartTooltip({ active, payload, label, title, rows, indexed = false }) {
  if (!active || !payload || !payload.length) return null;

  const heading = title ? title(label, payload) : label;
  const lines = rows
    ? rows(label, payload)
    : payload.map((p) => ({
        label: p.name ?? p.dataKey,
        // Same formatting as the screen this was ported from: an indexed view
        // reads as a rebased index, not as a count.
        value: indexed ? `${Number(p.value).toFixed(1)} (Index)` : fmt(p.value),
        color: p.color || p.stroke || p.fill,
      }));

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-title">{heading}</p>
      {lines.map((r) => (
        <p key={r.label} className="chart-tooltip-row">
          {r.color && <span className="chart-tooltip-swatch" style={{ backgroundColor: r.color }} />}
          <span className="chart-tooltip-label">{r.label}</span>
          <span className="chart-tooltip-value">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

function TrendChart({ labels, series, indexed = false }) {
  const seriesKeys = Object.keys(series);
  if (labels.length === 0 || seriesKeys.length === 0) {
    return <p className="review-empty">No data to plot for the selected metrics.</p>;
  }
  // recharts takes one object per x value; the hand-drawn version took parallel
  // arrays, so they are zipped here rather than changing the caller.
  const data = labels.map((date, i) => {
    const row = { date };
    seriesKeys.forEach((k) => { row[k] = series[k][i]; });
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
               minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
               tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
        <Tooltip
          content={<ChartTooltip indexed={indexed} />}
          cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }}
        />
        {seriesKeys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function HistogramChart({ bins, labels }) {
  if (!bins.length) return <p className="review-empty">No distribution to plot.</p>;
  const total = bins.reduce((a, b) => a + b, 0);
  const data = bins.map((count, i) => ({ bin: labels[i], count }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="bin" tick={{ fontSize: 8, fill: '#8a94a3' }} tickLine={false}
               axisLine={{ stroke: GRID }} minTickGap={16} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
        <Tooltip
          cursor={{ fill: 'rgba(29, 42, 107, 0.08)' }}
          content={
            <ChartTooltip
              rows={(label, payload) => {
                const count = payload[0]?.value ?? 0;
                return [
                  { label: 'Records', value: count.toLocaleString(), color: '#1d2a6b' },
                  { label: 'Share', value: total ? `${((count / total) * 100).toFixed(1)}%` : '—' },
                ];
              }}
            />
          }
        />
        <Bar dataKey="count" fill="#1d2a6b" />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Poor Man's Response Curve: a line through the quantile-binned averages.
 *
 * Each point is the mean response for a bin holding a comparable number of
 * records, so the line shows the SHAPE of the response - saturating, linear or
 * convex - without a model. Plotting the raw observations underneath would
 * reintroduce exactly the spread the binning removed.
 */
function BinnedCurveChart({ data, xLabel, yLabel }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 10, right: 24, bottom: 18, left: 4 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        <XAxis
          dataKey="spend_x" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
          tickFormatter={(v) => fmt(v)}
          label={{ value: `Tactic Level (${xLabel})`, position: 'insideBottom', offset: -10,
                   fontSize: 10, fill: '#8a94a3' }}
        />
        <YAxis
          tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
          tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)}
          label={{ value: `Average ${yLabel}`, angle: -90, position: 'insideLeft',
                   fontSize: 10, fill: '#8a94a3' }}
        />
        <Tooltip
          cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }}
          content={
            <ChartTooltip
              title={(label, payload) => payload[0]?.payload?.bin_label || 'Bin'}
              rows={(label, payload) => {
                const p = payload[0]?.payload || {};
                return [
                  { label: `Mean ${yLabel}`, value: fmt(p.response_y), color: CHART_COLORS[0] },
                  { label: `Median ${yLabel}`, value: fmt(p.median_y) },
                  { label: 'Records', value: Number(p.record_count || 0).toLocaleString() },
                ];
              }}
            />
          }
        />
        <Line
          type="monotone" dataKey="response_y"
          stroke={CHART_COLORS[0]} strokeWidth={3}
          dot={{ r: 5, fill: CHART_COLORS[1], strokeWidth: 0 }}
          activeDot={{ r: 7, stroke: '#fff', strokeWidth: 2, fill: CHART_COLORS[0] }}
          name={`Binned Mean ${yLabel}`}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ScatterChart({ points, binnedLine, trendline = [], xLabel, yLabel }) {
  if (!points.length && !binnedLine.length) {
    return <p className="review-empty">No points to plot.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart margin={{ top: 10, right: 24, bottom: 18, left: 4 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis
          type="number" dataKey="x" name={xLabel} tick={AXIS_TICK} tickLine={false}
          axisLine={{ stroke: GRID }} domain={['dataMin', 'dataMax']}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fontSize: 10, fill: '#8a94a3' }}
        />
        <YAxis
          type="number" dataKey="y" name={yLabel} tick={AXIS_TICK} tickLine={false}
          axisLine={{ stroke: GRID }}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 10, fill: '#8a94a3' }}
        />
        <Tooltip
          cursor={{ strokeDasharray: '3 3', stroke: '#c7d2e5' }}
          content={
            <ChartTooltip
              title={() => (binnedLine.length ? 'Binned average' : 'Observation')}
              rows={(label, payload) => {
                const p = payload[0]?.payload || {};
                return [
                  { label: xLabel, value: fmt(p.x), color: '#94a3b8' },
                  { label: yLabel, value: fmt(p.y), color: binnedLine.length ? '#1d4ed8' : '#94a3b8' },
                ];
              }}
            />
          }
        />
        {/* Least-squares fit from the API, computed on ALL points before the
            scatter was sampled - so it describes the real data, not the markers
            drawn here. Dashed to distinguish it from the binned curve. */}
        {trendline.length === 2 && (
          <ReferenceLine
            segment={trendline}
            stroke="#ef4444" strokeWidth={2} strokeDasharray="6 4"
            ifOverflow="extendDomain"
          />
        )}
        <Scatter data={points} fill="#94a3b8" fillOpacity={0.5} isAnimationActive={false} />
        {binnedLine.length > 0 && (
          <Line
            data={binnedLine} dataKey="y" type="monotone"
            stroke="#1d4ed8" strokeWidth={2.5}
            dot={{ r: 3.5, fill: '#1d4ed8', strokeWidth: 0 }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: '#1d4ed8', fill: '#fff' }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}


export default DataReview;