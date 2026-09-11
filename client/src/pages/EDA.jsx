import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, Legend,
} from "recharts";
import {
  edaStats, edaSparsity, edaPoorMansCurve, edaDetectOutliers, edaRemoveOutliers,
  edaTrendRollup, edaHistogram, edaScatter, correlationMatrix, computeVIF, getCandidateFeatures,
  getHighCorrPairs, previewRemoval, applyRemoval, findClusters, previewCombination, applyCombination,
  v2ListArds, v2GetCsv,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, Alert, Spinner, DataTable } from "../components/UI";

const PALETTE = [
  "#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", 
  "#06B6D4", "#EC4899", "#84CC16", "#10B981", "#6366F1",
  "#F97316", "#14B8A6", "#A855F7", "#3B82F6", "#E11D48"
];

function CorrelationHeatmap({ matrix, columns, onCellClick }) {
  if (!matrix || !columns || !columns.length) return null;
  const getColor = (val) => {
    const v = parseFloat(val) || 0;
    if (v > 0.7) return "#001E96";
    if (v > 0.4) return "#4060CC";
    if (v > 0.1) return "#8090EE";
    if (v < -0.7) return "#CC2020";
    if (v < -0.4) return "#EE5555";
    if (v < -0.1) return "#FFB3B3";
    return "#F0F0F5";
  };

  return (
    <div className="overflow-auto max-h-[480px] rounded-xl border border-slate-200">
      <table className="text-xs border-collapse w-full bg-white">
        <thead className="sticky top-0 bg-slate-50 shadow-sm z-10">
          <tr>
            <th className="p-2.5 text-slate-500 font-bold">Variable</th>
            {columns.map((c) => (
              <th key={c} className="p-2.5 text-slate-700 font-bold whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {columns.map((row) => (
            <tr key={row}>
              <td className="p-2.5 font-bold text-slate-700 whitespace-nowrap pr-4 bg-slate-50">{row}</td>
              {columns.map((col) => {
                const val = matrix[row]?.[col] ?? 0;
                const isDiag = row === col;
                return (
                  <td
                    key={col}
                    onClick={() => !isDiag && onCellClick && onCellClick(row, col)}
                    style={{ backgroundColor: getColor(val) }}
                    title={`${row} vs ${col}: ${Number(val).toFixed(3)}`}
                    className={`w-14 h-10 text-center font-mono text-white font-bold ${
                      !isDiag ? "cursor-pointer hover:scale-110 hover:ring-2 hover:ring-brand-400" : ""
                    }`}
                  >
                    {Number(val).toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EDA() {
  const { state, setField, saveWorkflowSnapshot } = useAppState();

  // ─── 1. ARD registry, read from the server ────────────────────────────────
  // ARDs are rows in `workflow_files` (kind='ard') under this workflow, so they
  // are listed from there rather than from app state.
  //
  // This has to be a server read, not an in-memory handoff. CSV payloads are
  // deliberately never persisted - they are megabytes and blow the localStorage
  // quota (see NEVER_PERSIST in AppContext) - so anything handed over in memory
  // is gone after a reload, and the screen showed no dataset. Fetching by
  // filename survives that, and it also stops a DMA-level ARD being shadowed by
  // whatever ingestion happened to leave in `granularCsvData`.
  const workflowId = state.workflowId;
  const [savedArds, setSavedArds] = useState([]);
  const [selectedArdId, setSelectedArdId] = useState("active_granular");
  const [ardCsv, setArdCsv] = useState(null);
  const [ardLoading, setArdLoading] = useState(false);

  // Whatever the stitching screen left in memory, when the user came straight
  // from it. Null after a reload - which is exactly why the list above exists.
  const handoffCsv = state.granularCsvData || state.filteredCsvData || state.mergedCsvData;

  useEffect(() => {
    if (!workflowId) return undefined;
    let cancelled = false;
    v2ListArds(workflowId)
      .then((data) => {
        if (cancelled) return;
        const items = data.items || [];
        setSavedArds(items);
        setSelectedArdId((current) => {
          if (current !== "active_granular") return current;
          // Prefer the one the stitching screen just built; else the newest.
          const active = items.find((a) => a.filename === state.activeDataset);
          return (active || items[0])?.filename || "active_granular";
        });
      })
      .catch(() => { if (!cancelled) setSavedArds([]); });
    return () => { cancelled = true; };
  }, [workflowId, state.activeDataset]);

  useEffect(() => {
    if (!workflowId || selectedArdId === "active_granular") return undefined;
    let cancelled = false;
    setArdLoading(true);
    v2GetCsv(workflowId, selectedArdId)
      .then((csv) => { if (!cancelled) setArdCsv(csv); })
      .catch(() => {
        if (cancelled) return;
        setArdCsv(null);
        toast.error(`Could not load ${selectedArdId}.`);
      })
      .finally(() => { if (!cancelled) setArdLoading(false); });
    return () => { cancelled = true; };
  }, [workflowId, selectedArdId]);

  const activeCsv = selectedArdId === "active_granular" ? handoffCsv : ardCsv;

  // Keep backup for restoring exclusions. Re-taken per ARD, so restoring after
  // switching datasets cannot put the previous ARD's rows back.
  const [backupCsv, setBackupCsv] = useState(null);

  useEffect(() => {
    setBackupCsv(null);
  }, [selectedArdId]);

  useEffect(() => {
    if (activeCsv && !backupCsv) {
      setBackupCsv(activeCsv);
    }
  }, [activeCsv, backupCsv]);

  // Outlier removal edits the working copy in place. When the data came from
  // the server it has to be written back to `ardCsv`, or the edit is discarded
  // on the next render.
  const setWorkingCsv = (csv) => {
    if (selectedArdId === "active_granular") {
      setField("granularCsvData", csv);
      setField("filteredCsvData", csv);
    } else {
      setArdCsv(csv);
    }
  };

  // Key Columns
  const [columns, setColumns] = useState([]);
  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [kpiCol, setKpiCol] = useState(state.dependentVariable || "");

  const [activeMainTab, setActiveMainTab] = useState("summary");
  const [loading, setLoading] = useState(false);
  const [statsResult, setStatsResult] = useState(null);

  useEffect(() => {
    if (!activeCsv) return;
    try {
      const firstLine = activeCsv.split("\n")[0];
      const cols = firstLine.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setColumns(cols);

      if (!dateCol || !cols.includes(dateCol)) {
        const found = cols.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month"));
        if (found) setDateCol(found);
      }
      if (!geoCol || !cols.includes(geoCol)) {
        const found = cols.find((c) => c.toLowerCase().includes("npi") || c.toLowerCase().includes("geo") || c.toLowerCase().includes("id") || c.toLowerCase().includes("dma"));
        if (found) setGeoCol(found);
      }
      if (!kpiCol || !cols.includes(kpiCol)) {
        const found = cols
          .filter((c) => c !== dateCol && c !== geoCol)
          .find((c) => c.toLowerCase().includes("sale") || c.toLowerCase().includes("trx") || c.toLowerCase().includes("nrx") || c.toLowerCase().includes("kpi"));
        if (found) setKpiCol(found);
      }
    } catch (e) {}
  }, [activeCsv]);

  const handleRunEDA = async (csvOverride = null) => {
    const csv = csvOverride || activeCsv;
    if (!csv) return toast.error("No dataset available.");
    if (!dateCol || !geoCol) return toast.error("Please specify Date and Geo / Group Keys.");

    setLoading(true);
    try {
      // Never the date or geo key: grouping a column by itself is
      // meaningless, and the API cannot build its per-geo table from it.
      const usable = columns.filter((c) => c !== dateCol && c !== geoCol);
      const targetDep =
        (kpiCol && kpiCol !== geoCol && kpiCol !== dateCol ? kpiCol : null) ||
        usable.find((c) => c.toLowerCase().includes("sale") || c.toLowerCase().includes("trx")) ||
        usable[0];
      if (!targetDep) {
        setLoading(false);
        return toast.error("Pick a KPI column that is not the Date or Geo key.");
      }
      const data = await edaStats({
        csv_data: csv,
        date_column: dateCol,
        geo_column: geoCol,
        dependent_variable: targetDep,
      });
      setStatsResult(data);
      setField("dateColumn", dateCol);
      setField("geoColumn", geoCol);
      if (kpiCol) setField("dependentVariable", kpiCol);
      toast.success("Dataset diagnostics loaded");
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "EDA stats failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeCsv && dateCol && geoCol && !statsResult) {
      handleRunEDA();
    }
  }, [activeCsv, dateCol, geoCol]);

  // ─── TAB 1: SUMMARY STATS & SPARSITY WITH CONTROL TOTALS ──────────────────
  const [sortField, setSortField] = useState("variable");
  const [sortAsc, setSortAsc] = useState(true);
  const [searchVar, setSearchVar] = useState("");
  const [sparsityMap, setSparsityMap] = useState({});

  useEffect(() => {
    if (activeCsv && statsResult?.numeric_cols?.length) {
      edaSparsity({ csv_data: activeCsv, metric_columns: statsResult.numeric_cols })
        .then((res) => {
          const map = {};
          (res.sparsity_table || []).forEach((row) => {
            map[row.tactic] = row;
          });
          setSparsityMap(map);
        })
        .catch(reportPanelError("Sparsity analysis"));
    }
  }, [activeCsv, statsResult]);

  const sortedSummaryStats = useMemo(() => {
    if (!statsResult?.summary_stats) return [];
    let list = statsResult.summary_stats.map((r) => ({
      ...r,
      sparsity: sparsityMap[r.variable] || null,
    }));
    if (searchVar.trim()) {
      list = list.filter((r) => r.variable.toLowerCase().includes(searchVar.toLowerCase()));
    }
    list.sort((a, b) => {
      let va = a[sortField];
      let vb = b[sortField];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [statsResult, sparsityMap, sortField, sortAsc, searchVar]);

  // ─── TAB 2: TIME TRENDS (WoW / MoM) + CUSTOM BIVARIATE GRAPH ───────────────
  const [trendPeriod, setTrendPeriod] = useState("week");
  const [selectedTrendMetrics, setSelectedTrendMetrics] = useState([]);
  const [trendRollupData, setTrendRollupData] = useState([]);
  const [indexedView, setIndexedView] = useState(false);

  // Custom Bivariate Relationship Explorer in Tab 2
  const [trendBivarX, setTrendBivarX] = useState("");
  const [trendBivarY, setTrendBivarY] = useState("");
  const [trendBivarScatter, setTrendBivarScatter] = useState(null);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length) {
      const activeNumeric = statsResult.numeric_cols;
      const valid = selectedTrendMetrics.filter((m) => activeNumeric.includes(m));
      if (valid.length > 0) {
        setSelectedTrendMetrics(valid);
      } else {
        setSelectedTrendMetrics(activeNumeric.slice(0, 2));
      }

      if (!trendBivarX) setTrendBivarX(activeNumeric[0] || "");
      if (!trendBivarY) setTrendBivarY(activeNumeric[1] || activeNumeric[0] || "");
    }
  }, [statsResult]);

  useEffect(() => {
    if (activeMainTab === "trends" && activeCsv && dateCol && selectedTrendMetrics.length > 0) {
      edaTrendRollup({ csv_data: activeCsv, date_column: dateCol, metric_columns: selectedTrendMetrics, period: trendPeriod })
        .then((res) => setTrendRollupData(res.trend_data || []))
        .catch((err) => {
          setTrendRollupData([]);
          reportPanelError("Trend rollup")(err);
        });
    }
  }, [activeMainTab, activeCsv, dateCol, selectedTrendMetrics, trendPeriod]);

  useEffect(() => {
    if (activeMainTab === "trends" && activeCsv && trendBivarX && trendBivarY) {
      edaScatter({ csv_data: activeCsv, x_column: trendBivarX, y_column: trendBivarY })
        .then((res) => setTrendBivarScatter(res))
        .catch(reportPanelError("Relationship explorer"));
    }
  }, [activeMainTab, activeCsv, trendBivarX, trendBivarY]);

  // Every one of these calls previously discarded its error, so a failing
  // request and an empty result looked identical on screen. They are
  // best-effort panels, so the toast is throttled to whichever fails first.
  const reportPanelError = (what) => (err) => {
    const detail = err?.response?.data?.error || err?.response?.data?.detail;
    const status = err?.response?.status;
    toast.error(
      status === 404
        ? `${what} is not available from this server (404). The API route may not be deployed.`
        : `${what} failed${detail ? `: ${detail}` : ""}.`,
      { id: "eda-panel-error" }
    );
  };

  const displayTrendData = useMemo(() => {
    if (!trendRollupData.length) return [];
    if (!indexedView) return trendRollupData;
    const baseRow = trendRollupData[0];
    return trendRollupData.map((row) => {
      const newRow = { date: row.date };
      selectedTrendMetrics.forEach((m) => {
        const baseVal = baseRow[m] || 1;
        newRow[m] = baseVal !== 0 ? ((row[m] || 0) / baseVal) * 100 : 100;
      });
      return newRow;
    });
  }, [trendRollupData, indexedView, selectedTrendMetrics]);

  // ─── TAB 3: DISTRIBUTIONS & OUTLIERS (DIRECT INPUT + RESTORE) ─────────────
  const [distCol, setDistCol] = useState("");
  const [histData, setHistData] = useState(null);
  const [outlierMethod, setOutlierMethod] = useState("iqr");
  const [outlierThreshold, setOutlierThreshold] = useState("1.5");
  const [outlierResult, setOutlierResult] = useState(null);
  const [outlierModalOpen, setOutlierModalOpen] = useState(false);
  const [distLoading, setDistLoading] = useState(false);

  useEffect(() => {
    if (!distCol && statsResult?.numeric_cols?.length) {
      setDistCol(statsResult.numeric_cols[0]);
    }
  }, [statsResult]);

  const loadDistAndOutliers = () => {
    if (!activeCsv || !distCol) return;
    setDistLoading(true);
    const parsedThresh = parseFloat(outlierThreshold) || 1.5;
    Promise.all([
      edaHistogram({ csv_data: activeCsv, column: distCol }),
      edaDetectOutliers({ csv_data: activeCsv, column: distCol, method: outlierMethod, threshold: parsedThresh }),
    ])
      .then(([hRes, oRes]) => {
        setHistData(hRes);
        setOutlierResult(oRes);
      })
      .catch(() => {
        toast.error("Could not load distribution");
      })
      .finally(() => setDistLoading(false));
  };

  useEffect(() => {
    if (activeMainTab === "distributions" && activeCsv && distCol) {
      loadDistAndOutliers();
    }
  }, [activeMainTab, activeCsv, distCol, outlierMethod, outlierThreshold]);

  const handleConfirmRemoveOutliers = async () => {
    setOutlierModalOpen(false);
    setDistLoading(true);
    try {
      const parsedThresh = parseFloat(outlierThreshold) || 1.5;
      const res = await edaRemoveOutliers({
        csv_data: activeCsv,
        column: distCol,
        method: outlierMethod,
        threshold: parsedThresh,
      });
      setWorkingCsv(res.clean_csv);
      toast.success(`Excluded ${res.dropped_rows} outlier row(s)! ${res.remaining_rows.toLocaleString()} rows remaining.`);
      handleRunEDA(res.clean_csv);
    } catch (err) {
      toast.error("Failed to remove outliers");
    } finally {
      setDistLoading(false);
    }
  };

  const handleRestoreOriginalDataset = () => {
    if (!backupCsv) return toast.error("No original backup found.");
    setWorkingCsv(backupCsv);
    toast.success("Restored original dataset (all exclusions undone)");
    handleRunEDA(backupCsv);
  };

  // ─── TAB 4: RELATIONSHIPS & POOR MAN'S CURVE ──────────────────────────────
  const [relX, setRelX] = useState("");
  const [relY, setRelY] = useState(kpiCol || "");
  const [poorManCurve, setPoorManCurve] = useState(null);
  const [scatterData, setScatterData] = useState(null);
  const [relLoading, setRelLoading] = useState(false);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length) {
      if (!relY) setRelY(kpiCol || statsResult.numeric_cols[0]);
      if (!relX) {
        const other = statsResult.numeric_cols.find((c) => c !== (kpiCol || relY)) || statsResult.numeric_cols[0];
        setRelX(other);
      }
    }
  }, [statsResult, kpiCol]);

  useEffect(() => {
    if (activeMainTab === "relationships" && activeCsv && relX && relY) {
      setRelLoading(true);
      Promise.all([
        edaPoorMansCurve({ csv_data: activeCsv, x_column: relX, y_column: relY, n_bins: 12 }),
        edaScatter({ csv_data: activeCsv, x_column: relX, y_column: relY }),
      ])
        .then(([pRes, sRes]) => {
          setPoorManCurve(pRes);
          setScatterData(sRes);
        })
        .catch(reportPanelError("Response curve"))
        .finally(() => setRelLoading(false));
    }
  }, [activeMainTab, activeCsv, relX, relY]);

  // ─── TAB 5: CORRELATION & MULTICOLLINEARITY (VARIABLE SELECTOR + SUB-TABS) ─
  const [corrSubTab, setCorrSubTab] = useState("analysis"); // analysis | removal | combination
  const [corrSelectedCols, setCorrSelectedCols] = useState([]);
  const [corrKpiTarget, setCorrKpiTarget] = useState(kpiCol || "");
  const [corrMatrix, setCorrMatrix] = useState(null);
  const [highPairs, setHighPairs] = useState([]);
  const [vifTable, setVifTable] = useState(null);
  const [vifLoading, setVifLoading] = useState(false);
  const [corrThreshold, setCorrThreshold] = useState(0.7);

  // Removal state
  const [removalThreshold, setRemovalThreshold] = useState("0.75");
  const [removalPreview, setRemovalPreview] = useState(null);
  const [removalModalOpen, setRemovalModalOpen] = useState(false);

  // Combination state
  const [comboThreshold, setComboThreshold] = useState("0.75");
  const [comboMethod, setComboMethod] = useState("Sum");
  const [dropOriginalOnCombo, setDropOriginalOnCombo] = useState(true);
  const [foundClusters, setFoundClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [comboWeights, setComboWeights] = useState({});
  const [comboPreviewData, setComboPreviewData] = useState(null);
  const [comboModalOpen, setComboModalOpen] = useState(false);

  // Initialize selected correlation columns
  useEffect(() => {
    if (statsResult?.numeric_cols?.length && corrSelectedCols.length === 0) {
      setCorrSelectedCols(statsResult.numeric_cols);
      setCorrKpiTarget(kpiCol || statsResult.numeric_cols[0]);
    }
  }, [statsResult, kpiCol]);

  const toggleCorrCol = (col) => {
    if (corrSelectedCols.includes(col)) {
      if (corrSelectedCols.length <= 2) return toast.error("Select at least 2 columns for correlation.");
      setCorrSelectedCols(corrSelectedCols.filter((c) => c !== col));
    } else {
      setCorrSelectedCols([...corrSelectedCols, col]);
    }
  };

  const fetchCorrelation = async () => {
    if (!activeCsv || corrSelectedCols.length < 2) return;
    try {
      const mRes = await correlationMatrix({ csv_data: activeCsv, columns: corrSelectedCols });
      setCorrMatrix(mRes);
      const pRes = await getHighCorrPairs({ csv_data: activeCsv, columns: corrSelectedCols, threshold: corrThreshold });
      setHighPairs(pRes.pairs || []);
    } catch (e) {}
  };

  useEffect(() => {
    if (activeMainTab === "correlation" && corrSelectedCols.length >= 2) {
      fetchCorrelation();
    }
  }, [activeMainTab, corrThreshold, activeCsv, corrSelectedCols]);

  const handleComputeVIF = async () => {
    if (corrSelectedCols.length < 2) return toast.error("Select at least 2 columns.");
    setVifLoading(true);
    try {
      const data = await computeVIF({ csv_data: activeCsv, columns: corrSelectedCols });
      setVifTable(data.vif || []);
      toast.success("VIF scores computed successfully");
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || "VIF calculation failed");
    } finally {
      setVifLoading(false);
    }
  };

  // Removal Handlers
  const handlePreviewRemoval = async () => {
    if (corrSelectedCols.length < 2) return;
    setLoading(true);
    try {
      const parsedThresh = parseFloat(removalThreshold) || 0.75;
      const res = await previewRemoval({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        threshold: parsedThresh,
        dependent_variable: corrKpiTarget || kpiCol,
      });
      setRemovalPreview(res);
    } catch (e) {
      toast.error("Removal preview failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (corrSubTab === "removal" && corrSelectedCols.length >= 2) {
      handlePreviewRemoval();
    }
  }, [corrSubTab, removalThreshold, corrSelectedCols, corrKpiTarget]);

  const handleConfirmApplyRemoval = async () => {
    setRemovalModalOpen(false);
    setLoading(true);
    try {
      const parsedThresh = parseFloat(removalThreshold) || 0.75;
      const res = await applyRemoval({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        threshold: parsedThresh,
        dependent_variable: corrKpiTarget || kpiCol,
      });
      setField("granularCsvData", res.csv_data);
      setField("filteredCsvData", res.csv_data);
      toast.success(`Removed ${res.dropped.length} collinear variable(s)`);
      handleRunEDA(res.csv_data);
      setRemovalPreview(null);
    } catch (e) {
      toast.error("Failed to apply removal");
    } finally {
      setLoading(false);
    }
  };

  // Combination Handlers
  const handleFindClusters = async () => {
    if (corrSelectedCols.length < 2) return toast.error("Select at least 2 columns.");
    setLoading(true);
    try {
      const parsedThresh = parseFloat(comboThreshold) || 0.75;
      const res = await findClusters({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        threshold: parsedThresh,
      });
      const clusters = res.clusters || [];
      setFoundClusters(clusters);
      setClusterNames(clusters.map((_, i) => `COMBO_${i + 1}`));
      const initW = {};
      clusters.forEach((c, idx) => {
        initW[idx] = {};
        c.forEach((col) => { initW[idx][col] = 1.0; });
      });
      setComboWeights(initW);
      if (clusters.length === 0) {
        toast.error(`No correlated pairs found with |r| ≥ ${parsedThresh}. Try lowering the threshold.`);
      } else {
        toast.success(`Found ${clusters.length} correlated pair(s) with |r| ≥ ${parsedThresh}`);
      }
    } catch (e) {
      toast.error("Cluster identification failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePreviewCombination = async () => {
    if (!foundClusters.length) return toast.error("Find correlated clusters first");
    setLoading(true);
    try {
      const methodMap = { Sum: "sum", Mean: "mean", "Weighted Sum": "weighted_sum" };
      const weightsList = foundClusters.map((_, idx) => comboWeights[idx] || {});
      const res = await previewCombination({
        csv_data: activeCsv,
        clusters: foundClusters,
        new_names: clusterNames,
        method: methodMap[comboMethod] || "sum",
        weights_per_cluster: weightsList,
      });
      setComboPreviewData(res);
    } catch (e) {
      toast.error("Combination preview failed");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmApplyCombination = async () => {
    setComboModalOpen(false);
    setLoading(true);
    try {
      const methodMap = { Sum: "sum", Mean: "mean", "Weighted Sum": "weighted_sum" };
      const weightsList = foundClusters.map((_, idx) => comboWeights[idx] || {});
      const res = await applyCombination({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        clusters: foundClusters,
        new_names: clusterNames,
        method: methodMap[comboMethod] || "sum",
        drop_original: dropOriginalOnCombo,
        weights_per_cluster: weightsList,
      });
      setField("granularCsvData", res.csv_data);
      setField("filteredCsvData", res.csv_data);
      toast.success(`Created ${foundClusters.length} composite variable(s)`);
      setFoundClusters([]);
      setComboPreviewData(null);
      handleRunEDA(res.csv_data);
    } catch (e) {
      toast.error("Failed to apply combination");
    } finally {
      setLoading(false);
    }
  };

  const handleHeatmapJumpToScatter = (rowVar, colVar) => {
    setRelX(colVar);
    setRelY(rowVar);
    setActiveMainTab("relationships");
    toast(`Viewing scatter & response shape: ${colVar} vs ${rowVar}`, { icon: "🔍" });
  };

  const handleProceedToTransformation = async () => {
    await saveWorkflowSnapshot("Data Transformation", "/transformation", {
      eda: "completed",
      transformation: "in_progress",
    });
    toast.success("EDA Diagnostics Complete! Proceeding to Data Transformation.");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 4: Exploratory Data Analysis & Diagnostics"
        subtitle="Sanity-check trends, inspect variable sparsity, preview response shapes, detect outliers, and analyze correlation"
        icon="🔍"
      />

      {!activeCsv && (
        <Alert type="warning">No dataset available. Complete Data Ingestion and Stitching first.</Alert>
      )}

      {/* ─── ARD Registry Selector Bar ────────────────────────────────────────── */}
      <Card title="Active ARD Dataset Under Review">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Select Generated ARD Table:
            </label>
            <select
              value={selectedArdId}
              onChange={(e) => {
                setSelectedArdId(e.target.value);
                setStatsResult(null);
              }}
              className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
            >
              {savedArds.length === 0 ? (
                <option value="active_granular">Active Stitched ARD</option>
              ) : (
                savedArds.map((ard) => (
                  <option key={ard.filename} value={ard.filename}>
                    📄 {ard.filename} ({ard.grain?.toUpperCase()} Grain • {ard.row_count?.toLocaleString()} rows • {(ard.columns || []).length} cols{ard.version > 1 ? ` • v${ard.version}` : ""})
                  </option>
                ))
              )}
            </select>
            {ardLoading && (
              <p className="mt-1.5 text-[11px] font-semibold text-slate-500">
                Loading {selectedArdId}…
              </p>
            )}
            {!ardLoading && !activeCsv && savedArds.length === 0 && (
              <p className="mt-1.5 text-[11px] font-semibold text-amber-700">
                No ARD has been generated for this workflow yet. Build one on the
                Data Stitching &amp; ARDs screen first.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 flex-1 min-w-[280px]">
            <Select label="Date Key" value={dateCol} onChange={setDateCol} options={columns} placeholder="Select Date Column" />
            <Select label="Geo / Group Key" value={geoCol} onChange={setGeoCol} options={columns} placeholder="Select Geo Column" />
          </div>

          <Btn onClick={() => handleRunEDA()} disabled={loading || ardLoading || !activeCsv} className="self-end py-2.5">
            {loading ? "Calculating…" : "↻ Recalculate EDA"}
          </Btn>
        </div>
      </Card>

      {/* ─── 5 Unified Tabs ──────────────────────────────────────────────────── */}
      <div className="bg-slate-200/70 p-1.5 rounded-2xl flex items-center gap-1 shadow-inner border border-slate-200 overflow-x-auto scrollbar-thin">
        {[
          { id: "summary", label: "📊 1. Summary Stats & Sparsity" },
          { id: "trends", label: "📈 2. Time Trends & Relationships" },
          { id: "distributions", label: "📉 3. Distributions & Outliers" },
          { id: "relationships", label: "🔗 4. Poor Man's Response Curve" },
          { id: "correlation", label: "⚖️ 5. Correlation & Multicollinearity" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveMainTab(tab.id)}
            className={`py-2.5 px-4 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 ${
              activeMainTab === tab.id
                ? "bg-white text-slate-800 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:text-slate-800 hover:bg-white/40"
            }`}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {loading && <Spinner label="Running diagnostic calculations on ARD..." />}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: SUMMARY STATS WITH CONTROL TOTALS & SPARSITY                      */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "summary" && statsResult && (
        <Card title="Variable Health, Sparsity & Control Totals">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
            <input
              type="text"
              placeholder="Search variables…"
              value={searchVar}
              onChange={(e) => setSearchVar(e.target.value)}
              className="text-xs border border-slate-200 rounded-xl px-3 py-1.5 w-60"
            />
            <span className="text-xs text-slate-400">Total Rows: <strong>{statsResult.total_rows?.toLocaleString()}</strong></span>
          </div>

          <div className="overflow-auto rounded-xl border border-slate-200 max-h-[500px]">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 z-10">
                <tr>
                  {[
                    ["variable", "Variable"],
                    ["type", "Role"],
                    ["unique_count", "Distinct (N)"],
                    ["control_total", "Control Totals (Sum)"],
                    ["sparsity", "Active / Sparsity Health"],
                    ["mean", "Mean"],
                    ["median", "Median"],
                    ["std", "Std Dev"],
                    ["min", "Min"],
                    ["max", "Max"],
                    ["p75", "75th %ile"],
                    ["p95", "95th %ile"],
                    ["missing_pct", "% Missing"],
                  ].map(([f, title]) => (
                    <th key={f} onClick={() => { setSortField(f); setSortAsc(!sortAsc); }} className="px-3.5 py-2.5 font-bold cursor-pointer hover:bg-slate-100 whitespace-nowrap">
                      {title} {sortField === f && (sortAsc ? "▲" : "▼")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedSummaryStats.map((row) => (
                  <tr key={row.variable} className="hover:bg-slate-50">
                    <td className="px-3.5 py-2 font-bold text-slate-800 whitespace-nowrap">{row.variable}</td>
                    <td className="px-3.5 py-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${row.type === "Metric" ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"}`}>
                        {row.type}
                      </span>
                    </td>
                    <td className="px-3.5 py-2 font-mono text-slate-600">{row.unique_count.toLocaleString()}</td>
                    <td className="px-3.5 py-2 font-bold text-brand-700">
                      {typeof row.control_total === "number" ? row.control_total.toLocaleString() : row.control_total}
                    </td>
                    <td className="px-3.5 py-2">
                      {row.sparsity ? (
                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                          row.sparsity.status === "healthy" ? "bg-emerald-100 text-emerald-800" : row.sparsity.status === "warning" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"
                        }`}>
                          {row.sparsity.non_zero_pct}% active ({row.sparsity.non_zero_count.toLocaleString()})
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3.5 py-2 text-slate-700">{row.mean != null ? row.mean.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.median != null ? row.median.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.std != null ? row.std.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.min != null ? String(row.min) : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.max != null ? String(row.max) : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.p75 != null ? row.p75.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-2 text-slate-700">{row.p95 != null ? row.p95.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${row.missing_pct > 10 ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                        {row.missing_pct}% ({row.missing_count})
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: TIME TRENDS (WoW / MoM) + BIVARIATE RELATIONSHIP GRAPH             */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "trends" && (
        <div className="space-y-6">
          {/* Chart 1: Time Series Multi-Metric Line Rollup */}
          <Card title="Time-Series Trend Rollup (WoW & MoM)">
            <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-700">Aggregation:</span>
                <button
                  type="button"
                  onClick={() => setTrendPeriod("week")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold ${trendPeriod === "week" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
                >
                  Week-on-Week (WoW)
                </button>
                <button
                  type="button"
                  onClick={() => setTrendPeriod("month")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold ${trendPeriod === "month" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
                >
                  Month-on-Month (MoM)
                </button>
              </div>

              <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer bg-slate-50 p-2 rounded-xl border border-slate-200">
                <input type="checkbox" checked={indexedView} onChange={(e) => setIndexedView(e.target.checked)} className="rounded text-brand-600" />
                Indexed View (Rebase to 100)
              </label>
            </div>

            <div className="mb-4">
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Select Metrics to Display on Trend Line ({selectedTrendMetrics.length} selected):
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedTrendMetrics(statsResult?.numeric_cols || [])}
                    className="text-[11px] font-bold text-brand-600 hover:underline"
                  >
                    Select All
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() => setSelectedTrendMetrics((statsResult?.numeric_cols || []).slice(0, 1))}
                    className="text-[11px] font-bold text-slate-400 hover:text-slate-600"
                  >
                    Clear to 1
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {(statsResult?.numeric_cols || []).map((col) => {
                  const isSel = selectedTrendMetrics.includes(col);
                  return (
                    <button
                      key={col}
                      type="button"
                      onClick={() => {
                        if (isSel) {
                          if (selectedTrendMetrics.length === 1) return toast.error("At least one metric must be selected.");
                          setSelectedTrendMetrics(selectedTrendMetrics.filter((m) => m !== col));
                        } else {
                          setSelectedTrendMetrics([...selectedTrendMetrics, col]);
                        }
                      }}
                      className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                        isSel ? "bg-brand-600 text-white shadow-sm ring-2 ring-brand-400/30" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {col}
                    </button>
                  );
                })}
              </div>
            </div>

            {displayTrendData.length === 0 && (
              <div className="py-10 text-center">
                <p className="text-xs font-bold text-slate-500">No trend to plot yet.</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {!statsResult
                    ? "Run the summary stats first — the metric list comes from there."
                    : !(statsResult.numeric_cols || []).length
                    ? "No numeric columns were detected in this dataset, so there is nothing to roll up."
                    : !dateCol
                    ? "Pick a Date Key above."
                    : !selectedTrendMetrics.length
                    ? "Select at least one metric below."
                    : "The date column produced no parseable dates, so no periods could be formed."}
                </p>
              </div>
            )}

            {displayTrendData.length > 0 && (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={displayTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (indexedView ? `${v.toFixed(0)}` : Number(v).toLocaleString())} />
                  <Tooltip formatter={(v) => (indexedView ? `${Number(v).toFixed(1)} (Index)` : Number(v).toLocaleString())} />
                  <Legend verticalAlign="bottom" wrapperStyle={{ paddingTop: "14px", fontSize: "11px" }} />
                  {selectedTrendMetrics.map((m, i) => (
                    <Line key={m} type="monotone" dataKey={m} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2.5} dot={false} name={m} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>

          {/* Chart 2: Custom Bivariate X vs Y Relationship Explorer */}
          <Card title="Custom Relationship Explorer (X vs Y Comparison)">
            <p className="text-xs text-slate-500 mb-4">
              Select any two metrics from your dataset to inspect their direct relationship with linear trendline fitting.
            </p>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <Select label="X Metric:" value={trendBivarX} onChange={setTrendBivarX} options={statsResult?.numeric_cols || columns} />
              <Select label="Y Metric:" value={trendBivarY} onChange={setTrendBivarY} options={statsResult?.numeric_cols || columns} />
            </div>

            {trendBivarScatter && (
              <div className="space-y-3">
                <div className="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl text-xs">
                  <span className="font-bold text-slate-700">Observed Scatter Data ({trendBivarX} vs {trendBivarY})</span>
                  <span className="font-mono font-bold text-brand-700">Pearson r = {trendBivarScatter.r}</span>
                </div>

                <ResponsiveContainer width="100%" height={280}>
                  <ScatterChart margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis type="number" dataKey="x" name={trendBivarX} label={{ value: trendBivarX, position: "insideBottom", offset: -5, fontSize: 10 }} tick={{ fontSize: 10 }} />
                    <YAxis type="number" dataKey="y" name={trendBivarY} label={{ value: trendBivarY, angle: -90, position: "insideLeft", fontSize: 10 }} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => Number(v).toFixed(2)} />
                    <Scatter name="Data Points" data={trendBivarScatter.x.map((xv, i) => ({ x: xv, y: trendBivarScatter.y[i] }))} fill="#001E96" opacity={0.6} />
                    {trendBivarScatter.trendline?.length > 0 && (
                      <Scatter name="Linear Fit" data={trendBivarScatter.trendline} line={{ stroke: "#EF4444", strokeWidth: 2 }} shape={() => null} />
                    )}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 3: DISTRIBUTIONS & OUTLIERS                                          */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "distributions" && (
        <div className="space-y-6">
          <Card title="Variable Distribution & Skewness">
            <div className="w-72 mb-4">
              <Select label="Select Variable:" value={distCol} onChange={setDistCol} options={statsResult?.numeric_cols || columns} />
            </div>

            {distLoading && <Spinner label="Loading distribution and scanning for outliers..." />}

            {histData && !distLoading && (
              <div className="space-y-4">
                <div className="flex gap-4 items-center text-xs bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <span className="font-bold text-slate-700">Mean: {histData.mean?.toFixed(2)}</span>
                  <span className="font-bold text-slate-700">Median: {histData.median?.toFixed(2)}</span>
                  <span className="text-slate-500">Span: {histData.min?.toFixed(1)} to {histData.max?.toFixed(1)}</span>
                </div>

                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={histData.counts.map((c, i) => ({ bin: histData.bin_labels[i], count: c }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="bin" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#001E96" radius={[4, 4, 0, 0]} name="Frequency" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Outlier Diagnostics Section */}
          <Card title={`Outlier Diagnostics for ${distCol}`}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <Select
                label="Detection Strategy:"
                value={outlierMethod}
                onChange={setOutlierMethod}
                options={[
                  { value: "iqr", label: "IQR (Interquartile Range Box-Plot)" },
                  { value: "zscore", label: "Z-Score (Standard Deviations)" },
                ]}
              />
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Threshold Value: ({outlierThreshold} {outlierMethod === "iqr" ? "× IQR" : "σ"})
                </label>
                <input
                  type="text"
                  placeholder="e.g. 1.5, 2.0, 3.0"
                  value={outlierThreshold}
                  onChange={(e) => setOutlierThreshold(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div className="flex items-end">
                <Btn onClick={loadDistAndOutliers} disabled={distLoading} className="w-full justify-center">
                  ↻ Re-Scan Outliers
                </Btn>
              </div>
            </div>

            {outlierResult && !distLoading && (
              <div className="space-y-4 pt-2">
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-lg font-bold text-slate-800">{outlierResult.outlier_count.toLocaleString()}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Outlier Points</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-lg font-bold text-slate-800">{outlierResult.outlier_pct}%</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Dataset Proportion</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-lg font-bold text-slate-800">{outlierResult.lower_bound}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Lower Cutoff</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-lg font-bold text-slate-800">{outlierResult.upper_bound}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Upper Cutoff</div>
                  </div>
                </div>

                {outlierResult.outlier_count > 0 ? (
                  <>
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Flagged Outlier Records:</h4>
                    <DataTable data={outlierResult.preview_flagged_rows} />
                    
                    <div className="flex items-center gap-3 pt-2">
                      <Btn variant="danger" onClick={() => setOutlierModalOpen(true)}>
                        Exclude {outlierResult.outlier_count} Outliers from Dataset
                      </Btn>
                      <Btn variant="outline" onClick={handleRestoreOriginalDataset}>
                        ↺ Restore Original Dataset (Undo Exclusions)
                      </Btn>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 p-3 rounded-xl">
                    <span className="text-xs font-bold text-emerald-800">✅ No extreme outliers detected in {distCol}.</span>
                    <Btn variant="outline" onClick={handleRestoreOriginalDataset} className="text-xs py-1.5">
                      ↺ Restore Original Dataset
                    </Btn>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 4: RELATIONSHIPS & POOR MAN'S CURVE                                  */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "relationships" && (
        <Card title="Bivariate Relationships & Poor Man's Saturation Curve">
          <p className="text-xs text-slate-500 mb-4">
            Combines raw data points with the <strong>binned-average response curve</strong> to reveal whether a marketing tactic exhibits diminishing returns (logarithmic saturation) or linear growth before Module 5 Transformation.
          </p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <Select label="Marketing Tactic (X Axis):" value={relX} onChange={setRelX} options={(statsResult?.numeric_cols || []).filter((c) => c !== relY)} />
            <Select label="Target Sales / KPI (Y Axis):" value={relY} onChange={setRelY} options={statsResult?.numeric_cols || columns} />
          </div>

          {relLoading && <Spinner label="Calculating response curve & scatter points..." />}

          {poorManCurve && !relLoading && (
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs flex items-center justify-between">
                <div>
                  <span className="font-bold text-blue-950">Detected Response Curve Shape: </span>
                  <span className="font-extrabold text-brand-700">{poorManCurve.shape_indicator}</span>
                </div>
                <span className="text-slate-500">12 Quantile Average Bins</span>
              </div>

              {/* Binned Average Curve */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">1. Binned Average Response Curve (Mean {relY} per {relX} Tier):</h4>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={poorManCurve.binned_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="spend_x" label={{ value: `Tactic Level (${relX})`, position: "insideBottom", offset: -5, fontSize: 11 }} tick={{ fontSize: 10 }} />
                    <YAxis dataKey="response_y" label={{ value: `Average ${relY}`, angle: -90, position: "insideLeft", fontSize: 11 }} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                    <Line type="monotone" dataKey="response_y" stroke="#001E96" strokeWidth={3} dot={{ r: 5, fill: "#1ABC9C" }} name={`Binned Mean ${relY}`} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Bivariate Scatter Plot with Linear Fit */}
              {scatterData && (
                <div className="border-t border-slate-100 pt-4">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">2. Raw Observed Data Points with Linear Trendline:</h4>
                    <span className="text-xs font-bold text-brand-700 font-mono">Pearson r = {scatterData.r}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <ScatterChart margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" dataKey="x" name={relX} tick={{ fontSize: 10 }} />
                      <YAxis type="number" dataKey="y" name={relY} tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v) => Number(v).toFixed(2)} />
                      <Scatter name="Observed Points" data={scatterData.x.map((xv, i) => ({ x: xv, y: scatterData.y[i] }))} fill="#001E96" opacity={0.6} />
                      {scatterData.trendline?.length > 0 && (
                        <Scatter name="Linear OLS" data={scatterData.trendline} line={{ stroke: "#EF4444", strokeWidth: 2 }} shape={() => null} />
                      )}
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 5: CORRELATION & MULTICOLLINEARITY (VARIABLE SELECTOR + 3 SUB-TABS)  */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "correlation" && (
        <div className="space-y-6">
          {/* Top Column Selection Box */}
          <Card title="Select Variables to Include in Multicollinearity Analysis">
            <div className="flex justify-between items-center mb-2">
              <p className="text-xs text-slate-500">
                Choose the marketing tactics and variables to analyze ({corrSelectedCols.length} selected):
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCorrSelectedCols(statsResult?.numeric_cols || [])}
                  className="text-[11px] font-bold text-brand-600 hover:underline"
                >
                  Select All
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => setCorrSelectedCols((statsResult?.numeric_cols || []).slice(0, 2))}
                  className="text-[11px] font-bold text-slate-400 hover:text-slate-600"
                >
                  Reset to 2
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(statsResult?.numeric_cols || []).map((col) => {
                const isSelected = corrSelectedCols.includes(col);
                return (
                  <button
                    key={col}
                    type="button"
                    onClick={() => toggleCorrCol(col)}
                    className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                      isSelected
                        ? "bg-brand-600 text-white shadow-sm ring-2 ring-brand-400/30"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 opacity-60"
                    }`}
                  >
                    {col}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Sub-tab Navigation */}
          <div className="flex gap-2 border-b border-slate-200">
            {[
              { id: "analysis", label: "1. Analysis (Heatmap & VIF)" },
              { id: "removal", label: "2. Treatment — Removal" },
              { id: "combination", label: "3. Treatment — Combination" },
            ].map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setCorrSubTab(st.id)}
                className={`px-4 py-2 text-xs font-bold border-b-2 -mb-px transition-all ${
                  corrSubTab === st.id
                    ? "border-brand-600 text-brand-700 bg-white"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          {/* Sub-tab 1: Analysis */}
          {corrSubTab === "analysis" && (
            <Card title="Pairwise Correlation & Multicollinearity Matrix">
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Highlight Threshold (|r| ≥ {corrThreshold}):</label>
                  <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(parseFloat(e.target.value))} className="w-56" />
                </div>
                <Btn variant="outline" onClick={handleComputeVIF} disabled={vifLoading}>
                  {vifLoading ? "Computing VIF…" : "Compute VIF Scores"}
                </Btn>
              </div>

              {corrMatrix && (
                <div className="space-y-2 mb-4">
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
                    Feature Correlation Heatmap (Click any cell to inspect in Tab 4):
                  </span>
                  <CorrelationHeatmap matrix={corrMatrix.matrix} columns={corrMatrix.columns} onCellClick={handleHeatmapJumpToScatter} />
                </div>
              )}

              {highPairs.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">High Collinearity Pairs (|r| ≥ {corrThreshold}):</h4>
                  <DataTable data={highPairs.map((p) => ({ "Tactic 1": p.feature1, "Tactic 2": p.feature2, "Correlation (|r|)": p.corr.toFixed(4) }))} />
                </div>
              )}

              {vifTable && (
                <div className="mt-4">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Variance Inflation Factor (VIF):</h4>
                  <DataTable data={vifTable.map((r) => ({
                    Variable: r.variable,
                    VIF: r.VIF != null ? r.VIF : "—",
                    Status: r.status || (r.VIF > 10 ? "🔴 High (>10)" : r.VIF > 5 ? "⚠️ Moderate (5-10)" : "✅ OK (<5)"),
                  }))} />
                </div>
              )}
            </Card>
          )}

          {/* Sub-tab 2: Removal Treatment */}
          {corrSubTab === "removal" && (
            <Card title="Multicollinearity Treatment — Variable Removal">
              <p className="text-xs text-slate-500 mb-4">
                Compares correlated pairs against the Target KPI. The variable with lower correlation to KPI is automatically dropped.
              </p>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <Select label="Target KPI for Correlation Comparison:" value={corrKpiTarget} onChange={setCorrKpiTarget} options={corrSelectedCols} />
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Removal Threshold (|r| ≥ {removalThreshold}):
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 0.75"
                    value={removalThreshold}
                    onChange={(e) => setRemovalThreshold(e.target.value)}
                    className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                  />
                </div>
              </div>

              {removalPreview && (
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-900 font-medium">
                    {removalPreview.total_pairs} correlated pair(s) found → <strong>{removalPreview.total_dropped} feature(s) will be dropped</strong>.
                  </div>

                  {removalPreview.pairs?.length > 0 ? (
                    <>
                      <DataTable data={removalPreview.pairs.map((p) => ({
                        "Feature 1": p.feature1,
                        "Feature 2": p.feature2,
                        "|r|": p.correlation,
                        "Will Drop": p.will_drop,
                        "Decision Reason": p.reason,
                      }))} />

                      {removalPreview.total_dropped > 0 && (
                        <Btn variant="danger" onClick={() => setRemovalModalOpen(true)}>
                          Apply Removal (Drops {removalPreview.total_dropped} feature{removalPreview.total_dropped > 1 ? "s" : ""})
                        </Btn>
                      )}
                    </>
                  ) : (
                    <Alert type="info">No pairs cross the removal threshold of |r| ≥ {removalThreshold}.</Alert>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* Sub-tab 3: Combination Treatment (Pairwise Correlated Groups) */}
          {corrSubTab === "combination" && (
            <Card title="Multicollinearity Treatment — Variable Combination (Pairwise Clusters)">
              <div className="space-y-4">
                <div className="flex gap-4 items-center flex-wrap">
                  <div className="w-56">
                    <label className="text-xs font-bold text-slate-700 block mb-1">
                      Pairwise Correlation Threshold (|r| ≥ {comboThreshold}):
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 0.75"
                      value={comboThreshold}
                      onChange={(e) => setComboThreshold(e.target.value)}
                      className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                    />
                  </div>

                  <div className="flex gap-3 items-center text-xs font-bold pt-3">
                    <span className="text-slate-600">Method:</span>
                    {["Sum", "Mean", "Weighted Sum"].map((m) => (
                      <label key={m} className="flex items-center gap-1 cursor-pointer">
                        <input type="radio" checked={comboMethod === m} onChange={() => setComboMethod(m)} />
                        {m}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Btn variant="outline" onClick={handleFindClusters}>Find Correlated Pairs</Btn>
                  <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                    <input type="checkbox" checked={dropOriginalOnCombo} onChange={(e) => setDropOriginalOnCombo(e.target.checked)} className="rounded" />
                    Drop original features after combination
                  </label>
                </div>

                {foundClusters.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <h4 className="text-xs font-bold text-slate-700 uppercase">Identified Correlated Pairs:</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {foundClusters.map((cluster, cIdx) => (
                        <div key={cIdx} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                          <span className="text-xs font-bold text-brand-800">Pair #{cIdx + 1} ({cluster.length} features)</span>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">Combined Column Name:</label>
                            <input
                              type="text"
                              value={clusterNames[cIdx] || ""}
                              onChange={(e) => {
                                const next = [...clusterNames];
                                next[cIdx] = e.target.value;
                                setClusterNames(next);
                              }}
                              className="w-full text-xs font-bold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                            />
                          </div>
                          <div className="text-[11px] text-slate-600">
                            <strong>Correlated Tactic Pair:</strong> {cluster.join(" + ")}
                          </div>
                        </div>
                      ))}
                    </div>

                    <Btn onClick={handlePreviewCombination}>Preview Combination Formula & Values</Btn>
                  </div>
                )}

                {comboPreviewData && (
                  <div className="space-y-3 pt-4 border-t border-slate-200">
                    <h4 className="text-xs font-bold text-slate-700 uppercase">Combination Preview:</h4>
                    {comboPreviewData.clusters?.map((c, i) => (
                      <div key={i} className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono font-bold text-brand-700 bg-brand-50">
                        {c.formula}
                      </div>
                    ))}
                    <Btn onClick={() => setComboModalOpen(true)}>
                      Apply Combination (Creates {foundClusters.length} composite variable{foundClusters.length > 1 ? "s" : ""})
                    </Btn>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Outlier Exclusion Confirmation Modal */}
      {outlierModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Outlier Exclusion</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Excluding <strong>{outlierResult?.outlier_count} rows</strong> with extreme values in <code>{distCol}</code>. A clean working dataset layer will be created for downstream modeling without altering your raw source ARDs.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setOutlierModalOpen(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={handleConfirmRemoveOutliers}>Confirm & Exclude Rows</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Removal Confirmation Modal */}
      {removalModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Variable Removal</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Based on correlation against <strong>{corrKpiTarget}</strong>, the following <strong>{removalPreview?.total_dropped} variable(s)</strong> will be dropped:
            </p>
            <div className="flex flex-wrap gap-1 bg-slate-50 p-2 rounded-lg">
              {removalPreview?.dropped?.map((c) => (
                <span key={c} className="bg-red-100 text-red-800 px-2 py-0.5 rounded text-xs font-bold">{c}</span>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setRemovalModalOpen(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={handleConfirmApplyRemoval}>Confirm & Apply Removal</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Combination Confirmation Modal */}
      {comboModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Variable Combination</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will combine <strong>{foundClusters.length} correlated pair(s)</strong> into new columns ({clusterNames.join(", ")}) using <strong>{comboMethod}</strong>.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setComboModalOpen(false)}>Cancel</Btn>
              <Btn onClick={handleConfirmApplyCombination}>Confirm Combination</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Proceed Bar */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
        <div>
          <span className="text-emerald-400 font-bold text-sm block">✅ Dataset Diagnostics Complete</span>
          <p className="text-xs text-slate-400">Ready to proceed to Adstock & Saturation parameter transformations.</p>
        </div>
        <Btn onClick={handleProceedToTransformation}>
          Proceed to Data Transformation →
        </Btn>
      </div>
    </div>
  );
}