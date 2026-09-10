import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, Legend,
} from "recharts";
import {
  edaStats, edaHistogram, edaScatter,
  correlationMatrix, computeVIF, getCandidateFeatures,
  getHighCorrPairs, previewRemoval, applyRemoval,
  findClusters, previewCombination, applyCombination, applyWeightedSum,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, MultiSelect, Alert, Spinner } from "../components/UI";

const PALETTE = ["#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4", "#EC4899", "#84CC16"];

// ─── Heatmap component with Jump-to-Scatter on cell click ───────────────────────
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
    <div className="overflow-auto max-h-[500px]">
      <table className="text-xs border-collapse">
        <thead className="sticky top-0 bg-white shadow-sm z-10">
          <tr>
            <th className="p-2 text-slate-400 font-normal">Features</th>
            {columns.map((c) => (
              <th key={c} className="p-2 text-slate-700 font-semibold whitespace-nowrap">{c.slice(0, 14)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((row) => (
            <tr key={row}>
              <td className="p-2 font-semibold text-slate-700 whitespace-nowrap pr-4 bg-slate-50">{row.slice(0, 16)}</td>
              {columns.map((col) => {
                const val = matrix[row]?.[col] ?? 0;
                const isDiag = row === col;
                return (
                  <td
                    key={col}
                    onClick={() => !isDiag && onCellClick && onCellClick(row, col)}
                    style={{ backgroundColor: getColor(val) }}
                    title={`${row} vs ${col}: ${val?.toFixed ? val.toFixed(3) : val} (Click to inspect scatter)`}
                    className={`w-14 h-11 text-center font-mono text-white font-bold transition-transform ${
                      !isDiag ? "cursor-pointer hover:scale-110 hover:ring-2 hover:ring-brand-400" : ""
                    }`}
                  >
                    {val?.toFixed ? val.toFixed(2) : "—"}
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

// ─── Main EDA Component ───────────────────────────────────────────────────────
export default function EDA() {
  const { state, setField } = useAppState();
  const csvData = state.granularCsvData || state.filteredCsvData;

  const [columns, setColumns] = useState([]);
  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [depVar, setDepVar] = useState(state.dependentVariable || "");

  const [activeMainTab, setActiveMainTab] = useState("summary");
  const [loading, setLoading] = useState(false);
  const [statsResult, setStatsResult] = useState(null);

  useEffect(() => {
    if (!csvData) return;
    try {
      const firstLine = csvData.split("\n")[0];
      const cols = firstLine.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setColumns(cols);

      if (!dateCol) {
        const found = cols.find((c) => c.toLowerCase() === "date" || c.toLowerCase().includes("date") || c.toLowerCase().includes("week"));
        if (found) setDateCol(found);
      }
      if (!geoCol) {
        const found = cols.find((c) => c.toLowerCase() === "npi" || c.toLowerCase().includes("npi") || c.toLowerCase().includes("geo") || c.toLowerCase().includes("id"));
        if (found) setGeoCol(found);
      }
      if (!depVar) {
        const found = cols.find((c) => c.toLowerCase() === "sales" || c.toLowerCase().includes("sales") || c.toLowerCase().includes("kpi") || c.toLowerCase().includes("revenue"));
        if (found) setDepVar(found);
      }
    } catch (e) {}
  }, [csvData]);

  const handleRunEDA = async (overrideCsv = null) => {
    const activeCsv = overrideCsv || csvData;
    if (!activeCsv) return toast.error("No data available. Complete Data Ingestion first.");
    if (!dateCol || !geoCol || !depVar) return toast.error("Please select Date, Geo, and Dependent Variable.");

    setLoading(true);
    try {
      const data = await edaStats({
        csv_data: activeCsv,
        date_column: dateCol,
        geo_column: geoCol,
        dependent_variable: depVar,
      });
      setStatsResult(data);
      setField("dateColumn", dateCol);
      setField("geoColumn", geoCol);
      setField("dependentVariable", depVar);
      toast.success("EDA calculations updated");
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || "EDA calculation failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (csvData && dateCol && geoCol && depVar && !statsResult) {
      handleRunEDA();
    }
  }, [csvData, dateCol, geoCol, depVar]);

  // Tab 1 Summary
  const [sortField, setSortField] = useState("variable");
  const [sortAsc, setSortAsc] = useState(true);
  const [searchVar, setSearchVar] = useState("");
  const [filterType, setFilterType] = useState("all");

  const sortedSummaryStats = useMemo(() => {
    if (!statsResult?.summary_stats) return [];
    let list = [...statsResult.summary_stats];

    if (filterType === "metric") {
      list = list.filter((r) => r.type === "Metric");
    } else if (filterType === "dimension_date") {
      list = list.filter((r) => r.type !== "Metric");
    }

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
  }, [statsResult, sortField, sortAsc, searchVar, filterType]);

  const handleSort = (field) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  // Tab 2 Trends
  const [selectedTrendVars, setSelectedTrendVars] = useState([]);
  const [indexedView, setIndexedView] = useState(false);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length && !selectedTrendVars.length) {
      const initial = [depVar, ...statsResult.numeric_cols.filter((c) => c !== depVar).slice(0, 2)];
      setSelectedTrendVars(initial.filter(Boolean));
    }
  }, [statsResult, depVar]);

  const processedTrendData = useMemo(() => {
    if (!statsResult?.trend_data || !statsResult.trend_data.length) return [];
    if (!indexedView) return statsResult.trend_data;

    const baseRow = statsResult.trend_data[0];
    return statsResult.trend_data.map((row) => {
      const newRow = { date: row.date };
      selectedTrendVars.forEach((v) => {
        const baseVal = baseRow[v] || 1;
        newRow[v] = baseVal !== 0 ? ((row[v] || 0) / baseVal) * 100 : 100;
      });
      return newRow;
    });
  }, [statsResult, indexedView, selectedTrendVars]);

  // Tab 3 Distributions
  const [histCol, setHistCol] = useState("");
  const [histData, setHistData] = useState(null);
  const [histLoading, setHistLoading] = useState(false);

  useEffect(() => {
    if (!histCol && statsResult?.numeric_cols?.length) {
      setHistCol(depVar || statsResult.numeric_cols[0]);
    }
  }, [statsResult, depVar]);

  useEffect(() => {
    if (!histCol || !csvData) return;
    setHistLoading(true);
    edaHistogram({ csv_data: csvData, column: histCol, bins: 25 })
      .then((res) => setHistData(res))
      .catch(() => {})
      .finally(() => setHistLoading(false));
  }, [histCol, csvData]);

  const histChartData = useMemo(() => {
    if (!histData?.counts?.length) return [];
    return histData.counts.map((count, i) => ({
      bin: histData.bin_labels ? histData.bin_labels[i] : `${histData.bin_edges[i].toFixed(1)} - ${histData.bin_edges[i + 1].toFixed(1)}`,
      count: count,
    }));
  }, [histData]);

  // Tab 4 Relationships
  const [scatterX, setScatterX] = useState("");
  const [scatterY, setScatterY] = useState("");
  const [scatterData, setScatterData] = useState(null);
  const [scatterLoading, setScatterLoading] = useState(false);
  const [showTrendline, setShowTrendline] = useState(true);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length) {
      if (!scatterY) setScatterY(depVar || statsResult.numeric_cols[0]);
      if (!scatterX) {
        const other = statsResult.numeric_cols.find((c) => c !== depVar) || statsResult.numeric_cols[0];
        setScatterX(other);
      }
    }
  }, [statsResult, depVar]);

  useEffect(() => {
    if (!scatterX || !scatterY || !csvData) return;
    setScatterLoading(true);
    edaScatter({ csv_data: csvData, x_column: scatterX, y_column: scatterY })
      .then((res) => setScatterData(res))
      .catch(() => {})
      .finally(() => setScatterLoading(false));
  }, [scatterX, scatterY, csvData]);

  // Tab 5 Correlation
  const [corrSubTab, setCorrSubTab] = useState("analysis");
  const [corrMethod, setCorrMethod] = useState("pearson");
  const [candidateFeatures, setCandidateFeatures] = useState([]);
  const [corrMatrixResult, setCorrMatrixResult] = useState(null);
  const [vifResult, setVifResult] = useState(null);
  const [corrOverviewThreshold, setCorrOverviewThreshold] = useState(0.15);
  const [highPairs, setHighPairs] = useState([]);

  const fetchCorrelationAnalysis = async () => {
    if (!csvData) return;
    try {
      const featRes = await getCandidateFeatures({
        csv_data: csvData,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
      });
      const feats = featRes.feature_cols || [];
      setCandidateFeatures(feats);

      if (feats.length > 0) {
        const mRes = await correlationMatrix({ csv_data: csvData, columns: feats, method: corrMethod });
        setCorrMatrixResult(mRes);

        const pRes = await getHighCorrPairs({ csv_data: csvData, columns: feats, threshold: corrOverviewThreshold });
        setHighPairs(pRes.pairs || []);
      }
    } catch (e) {}
  };

  useEffect(() => {
    if (activeMainTab === "correlation") {
      fetchCorrelationAnalysis();
    }
  }, [activeMainTab, corrMethod, corrOverviewThreshold, csvData]);

  const handleComputeVIF = async () => {
    if (!candidateFeatures.length) return;
    setLoading(true);
    try {
      const data = await computeVIF({ csv_data: csvData, columns: candidateFeatures });
      setVifResult(data.vif);
      toast.success("VIF scores computed");
    } catch (e) {
      toast.error("Failed to compute VIF");
    } finally {
      setLoading(false);
    }
  };

  // Removal
  const [removalThreshold, setRemovalThreshold] = useState(0.15);
  const [removalPreviewData, setRemovalPreviewData] = useState(null);
  const [showRemovalConfirmModal, setShowRemovalConfirmModal] = useState(false);

  const handlePreviewRemoval = async () => {
    if (!candidateFeatures.length) return;
    setLoading(true);
    try {
      const data = await previewRemoval({
        csv_data: csvData,
        columns: candidateFeatures,
        threshold: removalThreshold,
        dependent_variable: depVar,
      });
      setRemovalPreviewData(data);
    } catch (e) {
      console.error(e);
      toast.error("Removal preview failed. Check network or parameters.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (corrSubTab === "removal" && candidateFeatures.length) {
      handlePreviewRemoval();
    }
  }, [corrSubTab, removalThreshold, candidateFeatures]);

  const handleConfirmApplyRemoval = async () => {
    setShowRemovalConfirmModal(false);
    setLoading(true);
    try {
      const data = await applyRemoval({
        csv_data: csvData,
        columns: candidateFeatures,
        threshold: removalThreshold,
        dependent_variable: depVar,
      });
      setField("granularCsvData", data.csv_data);
      setField("filteredCsvData", data.csv_data);
      toast.success(`Applied removal: dropped ${data.dropped.length} columns`);
      setRemovalPreviewData(null);
      await fetchCorrelationAnalysis();
      handleRunEDA(data.csv_data);
    } catch (e) {
      toast.error("Failed to apply removal");
    } finally {
      setLoading(false);
    }
  };

  // Combination
  const [comboThreshold, setComboThreshold] = useState(0.15);
  const [comboMethod, setComboMethod] = useState("Sum");
  const [dropOriginalOnCombo, setDropOriginalOnCombo] = useState(true);
  const [foundClusters, setFoundClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [wsbWeights, setWsbWeights] = useState({});
  const [comboPreviewResult, setComboPreviewResult] = useState(null);
  const [showComboConfirmModal, setShowComboConfirmModal] = useState(false);

  const handleFindClusters = async () => {
    if (!candidateFeatures.length) return;
    setLoading(true);
    try {
      const data = await findClusters({ csv_data: csvData, columns: candidateFeatures, threshold: comboThreshold });
      const clusters = data.clusters || [];
      setFoundClusters(clusters);
      setClusterNames(clusters.map((_, i) => `COMBO_${i + 1}`));
      const initWeights = {};
      clusters.forEach((c, idx) => {
        initWeights[idx] = {};
        c.forEach((col) => { initWeights[idx][col] = 1.0; });
      });
      setWsbWeights(initWeights);
      toast.success(`Found ${clusters.length} cluster(s) with |r| ≥ ${comboThreshold}`);
    } catch (e) {
      toast.error("Failed to find clusters");
    } finally {
      setLoading(false);
    }
  };

  const handlePreviewCombination = async () => {
    if (!foundClusters.length) return toast.error("Find clusters first");
    setLoading(true);
    try {
      const methodMap = { Sum: "sum", Mean: "mean", "Weighted Sum": "weighted_sum" };
      const weightsList = foundClusters.map((_, idx) => wsbWeights[idx] || {});
      const data = await previewCombination({
        csv_data: csvData,
        clusters: foundClusters,
        new_names: clusterNames,
        method: methodMap[comboMethod] || "sum",
        weights_per_cluster: weightsList,
      });
      setComboPreviewResult(data);
    } catch (e) {
      toast.error("Combination preview failed");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmApplyCombination = async () => {
    setShowComboConfirmModal(false);
    setLoading(true);
    try {
      const methodMap = { Sum: "sum", Mean: "mean", "Weighted Sum": "weighted_sum" };
      const weightsList = foundClusters.map((_, idx) => wsbWeights[idx] || {});
      const data = await applyCombination({
        csv_data: csvData,
        columns: candidateFeatures,
        clusters: foundClusters,
        new_names: clusterNames,
        method: methodMap[comboMethod] || "sum",
        drop_original: dropOriginalOnCombo,
        weights_per_cluster: weightsList,
      });
      setField("granularCsvData", data.csv_data);
      setField("filteredCsvData", data.csv_data);
      toast.success(`Combined ${foundClusters.length} variables into dataset`);
      setFoundClusters([]);
      setComboPreviewResult(null);
      await fetchCorrelationAnalysis();
      handleRunEDA(data.csv_data);
    } catch (e) {
      toast.error("Failed to apply combination");
    } finally {
      setLoading(false);
    }
  };

  const handleHeatmapJumpToScatter = (rowVar, colVar) => {
    setScatterX(colVar);
    setScatterY(rowVar);
    setActiveMainTab("relationships");
    toast(`Inspecting relationship: ${colVar} vs ${rowVar}`, { icon: "🔍" });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exploratory Data Analysis"
        subtitle="Summary statistics, multi-variable trends, distributions, relationships, and multicollinearity treatment"
        icon="🔍"
      />

      {!csvData && (
        <Alert type="warning">No dataset found. Please complete Data Ingestion first.</Alert>
      )}

      {/* ─── Persistent Column Configuration Header ─────────────────────────────── */}
      <Card title="Dataset Configuration">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Select
            label="Date Column"
            value={dateCol}
            onChange={setDateCol}
            options={columns}
            placeholder="Select Date Column"
          />
          <Select
            label="Geo / Grouping Column"
            value={geoCol}
            onChange={setGeoCol}
            options={columns}
            placeholder="Select Geo/ID Column"
          />
          <Select
            label="Dependent Variable (KPI)"
            value={depVar}
            onChange={setDepVar}
            options={columns}
            placeholder="Select Target KPI"
          />
        </div>
        <Btn onClick={() => handleRunEDA()} disabled={loading || !csvData}>
          {loading ? "Computing EDA…" : "▶ Run EDA"}
        </Btn>
      </Card>

      {/* ─── Main 5 EDA Tabs ─────────────────────────────────────────────────── */}
      <div className="flex border-b border-slate-200 gap-2 flex-wrap">
        {[
          { id: "summary", label: "📊 Tab 1 — Summary Stats" },
          { id: "trends", label: "📈 Tab 2 — Trends" },
          { id: "distributions", label: "📉 Tab 3 — Distributions" },
          { id: "relationships", label: "🔗 Tab 4 — Relationships" },
          { id: "correlation", label: "⚖️ Tab 5 — Correlation & Multicollinearity" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveMainTab(t.id)}
            className={`px-5 py-3 text-sm font-semibold border-b-2 -mb-px transition-all ${
              activeMainTab === t.id
                ? "border-brand-600 text-brand-700 bg-brand-50/50 rounded-t-xl"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <Spinner label="Processing EDA calculations…" />}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 1 — SUMMARY STATS                                                   */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "summary" && statsResult && (
        <Card title="Dataset Summary Statistics">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <div className="flex gap-2 items-center">
              <span className="text-xs text-slate-500 font-medium">Filter view:</span>
              {[
                { id: "all", label: "All Variables" },
                { id: "metric", label: "Metrics Only" },
                { id: "dimension_date", label: "Dimensions & Dates" },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilterType(f.id)}
                  className={`text-xs px-3 py-1 rounded-full border transition-all ${
                    filterType === f.id
                      ? "bg-slate-800 text-white border-slate-800"
                      : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder="Search variables…"
              value={searchVar}
              onChange={(e) => setSearchVar(e.target.value)}
              className="text-xs border border-slate-200 rounded-xl px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="overflow-auto rounded-xl border border-slate-100">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 border-b border-slate-100 text-slate-600">
                <tr>
                  {[
                    ["variable", "Variable"],
                    ["type", "Role"],
                    ["unique_count", "Distinct (N)"],
                    ["mean", "Mean"],
                    ["median", "Median"],
                    ["std", "Std Dev"],
                    ["min", "Min / Start"],
                    ["max", "Max / End"],
                    ["p75", "75th %ile"],
                    ["p95", "95th %ile"],
                    ["missing_pct", "% Missing"],
                  ].map(([f, title]) => (
                    <th
                      key={f}
                      onClick={() => handleSort(f)}
                      className="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:bg-slate-100 select-none"
                    >
                      <div className="flex items-center gap-1">
                        <span>{title}</span>
                        {sortField === f && (
                          <span className="text-brand-600">{sortAsc ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 bg-white">
                {sortedSummaryStats.map((row) => (
                  <tr key={row.variable} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2 font-bold text-slate-800 whitespace-nowrap">{row.variable}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                        row.type === "Metric"
                          ? "bg-blue-100 text-blue-800"
                          : row.type === "Date"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-purple-100 text-purple-800"
                      }`}>
                        {row.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-600">{row.unique_count.toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-700">{row.mean != null ? row.mean.toLocaleString() : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.median != null ? row.median.toLocaleString() : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.std != null ? row.std.toLocaleString() : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.min != null ? String(row.min) : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.max != null ? String(row.max) : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.p75 != null ? row.p75.toLocaleString() : "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{row.p95 != null ? row.p95.toLocaleString() : "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        row.missing_pct > 20 ? "bg-red-100 text-red-700" : row.missing_pct > 0 ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"
                      }`}>
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
      {/* TAB 2 — TRENDS                                                          */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "trends" && statsResult && (
        <div className="space-y-6">
          <Card title="Multi-Variable Time Trends">
            <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-2">
                  Select up to 5 metrics to compare (KPI + media/spend variables):
                </label>
                <div className="flex flex-wrap gap-2">
                  {statsResult.numeric_cols.map((col) => {
                    const isSelected = selectedTrendVars.includes(col);
                    return (
                      <button
                        key={col}
                        type="button"
                        onClick={() => {
                          if (isSelected) setSelectedTrendVars(selectedTrendVars.filter((v) => v !== col));
                          else if (selectedTrendVars.length < 5) setSelectedTrendVars([...selectedTrendVars, col]);
                          else toast.error("Maximum 5 variables allowed on trend chart");
                        }}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                          isSelected
                            ? "bg-brand-600 text-white border-brand-600 shadow-sm"
                            : "bg-white text-slate-600 border-slate-200 hover:border-brand-300"
                        }`}
                      >
                        {col}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex items-center gap-3">
                <div>
                  <span className="text-xs font-bold text-slate-700 block">Indexed View</span>
                  <span className="text-[11px] text-slate-400">Rebase series to 100 at start</span>
                </div>
                <input
                  type="checkbox"
                  checked={indexedView}
                  onChange={(e) => setIndexedView(e.target.checked)}
                  className="h-5 w-5 text-brand-600 rounded cursor-pointer"
                />
              </div>
            </div>

            {processedTrendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={processedTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => (indexedView ? `${v.toFixed(0)}` : v.toLocaleString())}
                    label={{
                      value: indexedView ? "Index (Base = 100)" : "Raw Value",
                      angle: -90,
                      position: "insideLeft",
                      fontSize: 11,
                    }}
                  />
                  <Tooltip formatter={(v) => (indexedView ? `${Number(v).toFixed(1)} (Index)` : Number(v).toLocaleString())} />
                  <Legend />
                  {selectedTrendVars.map((v, i) => (
                    <Line
                      key={v}
                      type="monotone"
                      dataKey={v}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2.5}
                      dot={false}
                      name={v}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-slate-400 py-6 text-center">No time trend data available.</p>
            )}
          </Card>

          <Card title={`Top ${geoCol || "Entities"} by ${depVar || "Sales"}`}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={statsResult.by_geo}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="geo" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip formatter={(v) => v.toLocaleString()} />
                <Bar dataKey="value" fill="#1ABC9C" radius={[4, 4, 0, 0]} name={depVar} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 3 — DISTRIBUTIONS                                                   */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "distributions" && statsResult && (
        <Card title="Variable Distribution & Skewness">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-72">
              <Select
                label="Select Variable"
                value={histCol}
                onChange={setHistCol}
                options={statsResult.numeric_cols}
              />
            </div>
            {histData && (
              <div className="flex gap-4 items-center pt-4">
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 bg-red-500 inline-block rounded-full" />
                  <span className="font-semibold text-slate-700">Mean: {histData.mean?.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 bg-green-500 inline-block rounded-full" />
                  <span className="font-semibold text-slate-700">Median: {histData.median?.toFixed(2)}</span>
                </div>
                <div className="text-xs text-slate-500">
                  Min: {histData.min?.toFixed(1)} | Max: {histData.max?.toFixed(1)}
                </div>
              </div>
            )}
          </div>

          {histLoading && <Spinner label="Calculating distribution bins…" />}

          {histChartData.length > 0 && !histLoading && (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={histChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="bin" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#001E96" radius={[4, 4, 0, 0]} name="Record Frequency" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 4 — RELATIONSHIPS                                                   */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "relationships" && statsResult && (
        <Card title="Bivariate Relationships & Scatter Plots">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <Select label="X Axis Variable (Independent/Media)" value={scatterX} onChange={setScatterX} options={statsResult.numeric_cols} />
            <Select label="Y Axis Variable (Dependent/KPI)" value={scatterY} onChange={setScatterY} options={statsResult.numeric_cols} />
          </div>

          {scatterData && (
            <div className="flex justify-between items-center bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl">📈</span>
                <div>
                  <div className="text-sm font-bold text-slate-800">
                    Pearson Correlation Coefficient (r) ={" "}
                    <span className={scatterData.r > 0.5 ? "text-green-600" : scatterData.r < -0.5 ? "text-red-600" : "text-brand-600"}>
                      {scatterData.r.toFixed(4)}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">
                    {Math.abs(scatterData.r) > 0.7
                      ? "Strong correlation"
                      : Math.abs(scatterData.r) > 0.3
                      ? "Moderate correlation"
                      : "Weak / No linear correlation"}
                  </span>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer bg-white px-3 py-2 rounded-lg border border-slate-200 shadow-sm">
                <input
                  type="checkbox"
                  checked={showTrendline}
                  onChange={(e) => setShowTrendline(e.target.checked)}
                  className="rounded text-brand-600 h-4 w-4"
                />
                Show Linear Trendline (OLS)
              </label>
            </div>
          )}

          {scatterLoading && <Spinner label="Plotting scatter points and calculating OLS regression…" />}

          {scatterData?.x?.length > 0 && !scatterLoading && (
            <ResponsiveContainer width="100%" height={360}>
              <ScatterChart margin={{ top: 20, right: 30, bottom: 25, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={scatterX}
                  label={{ value: scatterX, position: "insideBottom", offset: -12, fontSize: 11, fill: "#475569" }}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={scatterY}
                  label={{ value: scatterY, angle: -90, position: "insideLeft", offset: 5, fontSize: 11, fill: "#475569" }}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v) => Number(v).toFixed(2)} />
                <Legend verticalAlign="top" height={36} />

                {/* Observed Data Points */}
                <Scatter
                  name="Observed Data Points"
                  data={scatterData.x.map((xv, idx) => ({ x: xv, y: scatterData.y[idx] }))}
                  fill="#001E96"
                  opacity={0.65}
                />

                {/* Overlaid OLS Regression Trendline */}
                {showTrendline && scatterData.trendline && scatterData.trendline.length > 0 && (
                  <Scatter
                    name={`OLS Regression Line (slope = ${scatterData.slope?.toFixed(3)})`}
                    data={scatterData.trendline}
                    line={{ stroke: "#EF4444", strokeWidth: 3 }}
                    shape={() => null}
                    legendType="line"
                    tooltipType="none"
                  />
                )}
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </Card>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {/* TAB 5 — CORRELATION & MULTICOLLINEARITY (FOLDED IN)                     */}
      {/* ═════════════════════════════════════════════════════════════════════════ */}
      {activeMainTab === "correlation" && (
        <div className="space-y-6">
          <div className="flex gap-2 border-b border-slate-200">
            {[
              { id: "analysis", label: "1. Analysis (Read-Only)" },
              { id: "removal", label: "2. Treatment — Removal" },
              { id: "combination", label: "3. Treatment — Combination" },
            ].map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setCorrSubTab(st.id)}
                className={`px-4 py-2.5 text-xs font-bold border-b-2 -mb-px transition-all ${
                  corrSubTab === st.id
                    ? "border-brand-600 text-brand-700 bg-white"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          {/* Sub-tab A: Analysis */}
          {corrSubTab === "analysis" && (
            <>
              <Card title="Correlation Matrix & Multicollinearity Overview">
                <div className="flex justify-between items-center gap-4 flex-wrap mb-4">
                  <div className="w-56">
                    <Select
                      label="Correlation Method"
                      value={corrMethod}
                      onChange={setCorrMethod}
                      options={["pearson", "spearman", "kendall"]}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Btn variant="outline" onClick={handleComputeVIF}>Compute VIF Scores</Btn>
                  </div>
                </div>

                <div className="mb-4">
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Highlight High Correlation Threshold (|r| ≥ {corrOverviewThreshold}):
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={corrOverviewThreshold}
                      onChange={(e) => setCorrOverviewThreshold(parseFloat(e.target.value) || 0)}
                      className="w-48 sm:w-64"
                    />
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={corrOverviewThreshold}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v)) setCorrOverviewThreshold(Math.max(0, Math.min(1, v)));
                      }}
                      className="w-20 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold bg-white text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                </div>

                {corrMatrixResult && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                        Feature Correlation Heatmap (Click any cell to inspect in Tab 4 Scatter)
                      </h4>
                    </div>
                    <CorrelationHeatmap
                      matrix={corrMatrixResult.matrix}
                      columns={corrMatrixResult.columns}
                      onCellClick={handleHeatmapJumpToScatter}
                    />
                  </div>
                )}
              </Card>

              {highPairs.length > 0 && (
                <Card title={`High Correlation Pairs (|r| ≥ ${corrOverviewThreshold})`}>
                  <div className="overflow-auto max-h-60 rounded-xl border border-slate-100">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-50 border-b border-slate-100">
                        <tr>
                          <th className="px-4 py-2 font-semibold text-slate-600">Feature 1</th>
                          <th className="px-4 py-2 font-semibold text-slate-600">Feature 2</th>
                          <th className="px-4 py-2 font-semibold text-slate-600">Abs Correlation</th>
                          <th className="px-4 py-2 font-semibold text-slate-600">Inspect</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {highPairs.map((p, i) => (
                          <tr key={i} className="hover:bg-slate-50/60">
                            <td className="px-4 py-2 font-medium">{p.feature1}</td>
                            <td className="px-4 py-2 font-medium">{p.feature2}</td>
                            <td className="px-4 py-2 font-bold text-brand-700">{p.corr.toFixed(4)}</td>
                            <td className="px-4 py-2">
                              <button
                                type="button"
                                onClick={() => handleHeatmapJumpToScatter(p.feature1, p.feature2)}
                                className="text-brand-600 hover:underline font-medium text-[11px]"
                              >
                                View Scatter →
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {vifResult && (
                <Card title="Variance Inflation Factor (VIF)">
                  <div className="overflow-auto max-h-72 rounded-xl border border-slate-100">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-50 border-b border-slate-100">
                        <tr>
                          <th className="px-4 py-2 font-semibold text-slate-600">Variable</th>
                          <th className="px-4 py-2 font-semibold text-slate-600">VIF Score</th>
                          <th className="px-4 py-2 font-semibold text-slate-600">Multicollinearity Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {vifResult.map((r) => (
                          <tr key={r.variable}>
                            <td className="px-4 py-2 font-medium">{r.variable}</td>
                            <td className="px-4 py-2 font-bold">{r.VIF != null ? r.VIF.toFixed(3) : "—"}</td>
                            <td className="px-4 py-2">
                              {r.VIF > 10 ? (
                                <span className="text-red-700 font-bold">🔴 High (>10)</span>
                              ) : r.VIF > 5 ? (
                                <span className="text-amber-700 font-bold">⚠️ Moderate (5-10)</span>
                              ) : (
                                <span className="text-green-700 font-bold">✅ Low (&lt;5)</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}

          {/* Sub-tab B: Removal Treatment */}
          {corrSubTab === "removal" && (
            <Card title="Multicollinearity Treatment — Variable Removal">
              <p className="text-xs text-slate-500 mb-4">
                Compares correlated pairs against the KPI (<strong>{depVar}</strong>). The variable with the lower correlation to the KPI is dropped.
              </p>

              <div className="mb-6">
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  Removal Threshold (|r| ≥ {removalThreshold}):
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={removalThreshold}
                    onChange={(e) => setRemovalThreshold(parseFloat(e.target.value) || 0)}
                    className="w-48 sm:w-64"
                  />
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={removalThreshold}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) setRemovalThreshold(Math.max(0, Math.min(1, v)));
                    }}
                    className="w-20 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold bg-white text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>

              {removalPreviewData && (
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900 font-medium">
                    {removalPreviewData.total_pairs} correlated pair(s) found →{" "}
                    <strong>{removalPreviewData.total_dropped} feature(s) will be dropped</strong>,{" "}
                    <strong>{removalPreviewData.total_kept} will be kept</strong>.
                  </div>

                  {removalPreviewData.pairs.length > 0 ? (
                    <div className="overflow-auto max-h-72 rounded-xl border border-slate-200">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                          <tr>
                            <th className="px-4 py-2.5 font-bold">Feature 1</th>
                            <th className="px-4 py-2.5 font-bold">Feature 2</th>
                            <th className="px-4 py-2.5 font-bold">Pair |r|</th>
                            <th className="px-4 py-2.5 font-bold text-red-600">Will Drop</th>
                            <th className="px-4 py-2.5 font-bold text-slate-600">Decision Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {removalPreviewData.pairs.map((p, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="px-4 py-2 font-medium">{p.feature1}</td>
                              <td className="px-4 py-2 font-medium">{p.feature2}</td>
                              <td className="px-4 py-2 font-bold text-slate-800">{p.correlation}</td>
                              <td className="px-4 py-2 font-bold text-red-600 bg-red-50/50">{p.will_drop}</td>
                              <td className="px-4 py-2 text-slate-600 italic">{p.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 py-3">No pairs cross threshold {removalThreshold}.</p>
                  )}

                  {removalPreviewData.total_dropped > 0 && (
                    <Btn
                      variant="danger"
                      onClick={() => setShowRemovalConfirmModal(true)}
                    >
                      Apply Removal (drops {removalPreviewData.total_dropped} feature{removalPreviewData.total_dropped > 1 ? "s" : ""})
                    </Btn>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* Sub-tab C: Combination Treatment */}
          {corrSubTab === "combination" && (
            <Card title="Multicollinearity Treatment — Variable Combination (Composite Clusters)">
              <div className="space-y-4">
                <div className="flex gap-4 items-center flex-wrap">
                  <div>
                    <label className="text-xs font-semibold text-slate-700 block mb-1">
                      Cluster Threshold (|r| ≥ {comboThreshold}):
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={comboThreshold}
                        onChange={(e) => setComboThreshold(parseFloat(e.target.value) || 0)}
                        className="w-48 sm:w-64"
                      />
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={comboThreshold}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v)) setComboThreshold(Math.max(0, Math.min(1, v)));
                        }}
                        className="w-20 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold bg-white text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                  </div>

                  <div className="flex gap-4 items-center text-xs font-medium pt-3">
                    <span className="text-slate-600">Method:</span>
                    {["Sum", "Mean", "Weighted Sum"].map((m) => (
                      <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="comboMethod"
                          checked={comboMethod === m}
                          onChange={() => setComboMethod(m)}
                        />
                        {m}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Btn variant="outline" onClick={handleFindClusters}>Find Correlated Clusters</Btn>
                  <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dropOriginalOnCombo}
                      onChange={(e) => setDropOriginalOnCombo(e.target.checked)}
                      className="rounded"
                    />
                    Drop original features after combination
                  </label>
                </div>

                {foundClusters.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <h4 className="text-xs font-bold text-slate-700 uppercase">Configurable Cluster Cards</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {foundClusters.map((cluster, cIdx) => (
                        <div key={cIdx} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-brand-800">Cluster {cIdx + 1}</span>
                            <span className="text-[11px] text-slate-400">{cluster.length} features</span>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">New Composite Variable Name:</label>
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
                            <strong>Features:</strong> {cluster.join(", ")}
                          </div>

                          {comboMethod === "Weighted Sum" && (
                            <div className="space-y-1.5 pt-2 border-t border-slate-200">
                              <span className="text-[11px] font-bold text-slate-600">Per-column Weights:</span>
                              {cluster.map((col) => (
                                <div key={col} className="flex items-center justify-between text-xs">
                                  <span className="w-36 truncate text-slate-600">{col}</span>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={wsbWeights[cIdx]?.[col] ?? 1.0}
                                    onChange={(e) => {
                                      const next = { ...wsbWeights };
                                      if (!next[cIdx]) next[cIdx] = {};
                                      next[cIdx][col] = parseFloat(e.target.value) || 0;
                                      setWsbWeights(next);
                                    }}
                                    className="w-20 border border-slate-200 rounded px-2 py-1 text-xs bg-white"
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="pt-2 flex gap-3">
                      <Btn onClick={handlePreviewCombination}>Preview Combination Formula & Values</Btn>
                    </div>
                  </div>
                )}

                {comboPreviewResult && (
                  <div className="space-y-4 pt-4 border-t border-slate-200">
                    <h4 className="text-xs font-bold text-slate-700 uppercase">Combination Preview</h4>
                    {comboPreviewResult.clusters.map((c, i) => (
                      <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                        <div className="text-xs font-mono font-bold text-brand-700 bg-brand-50 p-2 rounded-lg">
                          {c.formula}
                        </div>
                        <div className="overflow-auto">
                          <table className="w-full text-xs text-left">
                            <thead className="bg-slate-50 border-b">
                              <tr>
                                {Object.keys(c.sample_rows[0] || {}).map((k) => (
                                  <th key={k} className="px-3 py-1.5 font-semibold text-slate-700">{k}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {c.sample_rows.map((row, rIdx) => (
                                <tr key={rIdx} className="hover:bg-slate-50">
                                  {Object.values(row).map((val, vIdx) => (
                                    <td key={vIdx} className="px-3 py-1 text-slate-600 font-mono">
                                      {typeof val === "number" ? val.toFixed(2) : String(val)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}

                    <Btn
                      onClick={() => setShowComboConfirmModal(true)}
                    >
                      Apply Combination (creates {foundClusters.length} variable{foundClusters.length > 1 ? "s" : ""})
                    </Btn>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Modals */}
      {showRemovalConfirmModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Variable Removal</h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              This will permanently remove <strong>{removalPreviewData?.total_dropped} columns</strong> from your working dataset:
            </p>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              {removalPreviewData?.dropped.map((c) => (
                <span key={c} className="bg-red-100 text-red-800 px-2 py-0.5 rounded-full text-xs font-semibold">
                  {c}
                </span>
              ))}
            </div>
            <p className="text-xs text-slate-400">
              This cannot be undone selectively without re-running ingestion. Are you sure you want to continue?
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Btn variant="secondary" onClick={() => setShowRemovalConfirmModal(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={handleConfirmApplyRemoval}>Yes, Apply Removal</Btn>
            </div>
          </div>
        </div>
      )}

      {showComboConfirmModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Variable Combination</h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              This will create <strong>{foundClusters.length} new composite columns</strong> ({clusterNames.join(", ")}) using <strong>{comboMethod}</strong>.
              {dropOriginalOnCombo && " Original source columns will be dropped from the working dataset."}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Btn variant="secondary" onClick={() => setShowComboConfirmModal(false)}>Cancel</Btn>
              <Btn onClick={handleConfirmApplyCombination}>Yes, Apply Combination</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
