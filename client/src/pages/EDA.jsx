import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, Legend
} from "recharts";
import {
  edaStats, edaSparsity, edaPoorMansCurve, edaDetectOutliers, edaRemoveOutliers,
  edaTrendRollup, edaHistogram, edaScatter, correlationMatrix, computeVIF,
  getHighCorrPairs, previewRemoval, applyRemoval, findClusters, applyCombination,
  v2ListArds, v2GetCsv, problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, Alert, Spinner, DataTable } from "../components/UI";

const PALETTE = [
  "#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", 
  "#06B6D4", "#EC4899", "#84CC16", "#10B981", "#6366F1",
  "#F97316", "#14B8A6", "#A855F7", "#3B82F6", "#E11D48"
];

function CorrelationHeatmap({ matrix, columns, threshold = 0.7, onCellClick }) {
  if (!matrix || !columns || !columns.length) return null;

  const getStyle = (val) => {
    const v = parseFloat(val) || 0;
    const absV = Math.abs(v);
    const meetsThreshold = absV >= threshold;

    if (!meetsThreshold) {
      return {
        backgroundColor: "#F8FAFC",
        color: "#94A3B8",
        fontWeight: "normal",
        opacity: 0.6,
      };
    }

    if (v > 0) {
      if (v >= 0.8) return { backgroundColor: "#001E96", color: "#FFFFFF", fontWeight: "bold" };
      if (v >= 0.5) return { backgroundColor: "#2563EB", color: "#FFFFFF", fontWeight: "bold" };
      return { backgroundColor: "#60A5FA", color: "#FFFFFF", fontWeight: "bold" };
    } else {
      if (v <= -0.8) return { backgroundColor: "#991B1B", color: "#FFFFFF", fontWeight: "bold" };
      if (v <= -0.5) return { backgroundColor: "#DC2626", color: "#FFFFFF", fontWeight: "bold" };
      return { backgroundColor: "#F87171", color: "#FFFFFF", fontWeight: "bold" };
    }
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
                const style = isDiag
                  ? { backgroundColor: "#E2E8F0", color: "#475569", fontWeight: "bold" }
                  : getStyle(val);

                return (
                  <td
                    key={col}
                    onClick={() => !isDiag && onCellClick && onCellClick(row, col)}
                    style={style}
                    title={`${row} vs ${col}: ${Number(val).toFixed(3)} (Threshold: ${threshold})`}
                    className={`w-14 h-10 text-center font-mono transition-all ${
                      !isDiag ? "cursor-pointer hover:scale-105 hover:ring-2 hover:ring-brand-500" : ""
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
  const workflowId = state.workflowId;

  const [ardList, setArdList] = useState(() => state.savedArds || []);
  const [selectedArdId, setSelectedArdId] = useState(() => state.activeDataset || "active_granular");
  const [loadedCsvMap, setLoadedCsvMap] = useState({});

  useEffect(() => {
    if (!workflowId) return;
    v2ListArds(workflowId)
      .then((res) => {
        const ards = (res.items || []).map((a) => ({
          id: a.filename,
          name: a.filename.replace(/\.csv$/i, ""),
          filename: a.filename,
          grain: a.grain || (a.derived_from && a.derived_from.grain) || "hcp",
          rows: a.row_count,
          cols: (a.columns || []).length,
          columns: a.columns || [],
          version: a.version || 1,
          createdAt: a.derived_at || a.stored_at || new Date().toISOString(),
        }));
        if (ards.length > 0) {
          setArdList(ards);
          setField("savedArds", ards);
          if (selectedArdId === "active_granular" || !ards.some((a) => a.id === selectedArdId)) {
            setSelectedArdId(ards[0].id);
          }
        }
      })
      .catch(() => {});
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId || !selectedArdId || selectedArdId === "active_granular") return;
    if (loadedCsvMap[selectedArdId]) return;

    v2GetCsv(workflowId, selectedArdId)
      .then((csv) => {
        setLoadedCsvMap((prev) => ({ ...prev, [selectedArdId]: csv }));
        setField("granularCsvData", csv);
        setField("filteredCsvData", csv);
        setField("activeDataset", selectedArdId);
      })
      .catch((err) => toast.error(problemMessage(err, "Failed to load ARD data")));
  }, [workflowId, selectedArdId]);

  const activeArdObj = useMemo(() => {
    return ardList.find((a) => a.id === selectedArdId) || null;
  }, [ardList, selectedArdId]);

  const activeCsv = useMemo(() => {
    if (selectedArdId && loadedCsvMap[selectedArdId]) {
      return loadedCsvMap[selectedArdId];
    }
    return state.granularCsvData || state.filteredCsvData || state.mergedCsvData;
  }, [selectedArdId, loadedCsvMap, state]);

  const [backupCsv, setBackupCsv] = useState(null);

  useEffect(() => {
    if (activeCsv && !backupCsv) {
      setBackupCsv(activeCsv);
    }
  }, [activeCsv, selectedArdId]);

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
        const found = cols.find((c) => c.toLowerCase().includes("sale") || c.toLowerCase().includes("trx") || c.toLowerCase().includes("nrx") || c.toLowerCase().includes("kpi"));
        if (found) setKpiCol(found);
      }
    } catch (e) {}
  }, [activeCsv]);

  const handleRunEDA = async (csvOverride = null) => {
    const csv = csvOverride || activeCsv;
    if (!csv) return toast.error("No dataset available.");
    if (!dateCol || !geoCol) return toast.error("Please specify Date and Geo Keys.");

    setLoading(true);
    try {
      const targetDep = kpiCol || columns.find((c) => c.toLowerCase().includes("sale") || c.toLowerCase().includes("trx")) || columns[0];
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
      toast.success("Diagnostics loaded successfully");
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

  // ─── TAB 1: SUMMARY STATS ─────────────────────────────────────────────────
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
        .catch(() => {});
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

  // ─── TAB 2: TIME TRENDS (CRISP LINE GRAPH + SCATTER) ─────────────────────
  const [trendPeriod, setTrendPeriod] = useState("week");
  const [selectedTrendMetrics, setSelectedTrendMetrics] = useState([]);
  const [trendRollupData, setTrendRollupData] = useState([]);
  const [indexedView, setIndexedView] = useState(false);

  const [trendScatterX, setTrendScatterX] = useState("");
  const [trendScatterY, setTrendScatterY] = useState("");
  const [trendScatterData, setTrendScatterData] = useState(null);
  const [trendScatterLoading, setTrendScatterLoading] = useState(false);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length) {
      const activeNumeric = statsResult.numeric_cols;
      const valid = selectedTrendMetrics.filter((m) => activeNumeric.includes(m));
      if (valid.length > 0) {
        setSelectedTrendMetrics(valid);
      } else {
        setSelectedTrendMetrics(activeNumeric.slice(0, 2));
      }

      if (!trendScatterX) setTrendScatterX(activeNumeric.find((c) => c !== kpiCol) || activeNumeric[0] || "");
      if (!trendScatterY) setTrendScatterY(kpiCol || activeNumeric[0] || "");
    }
  }, [statsResult, kpiCol]);

  useEffect(() => {
    if (activeMainTab === "trends" && activeCsv && dateCol && selectedTrendMetrics.length > 0) {
      edaTrendRollup({ csv_data: activeCsv, date_column: dateCol, metric_columns: selectedTrendMetrics, period: trendPeriod })
        .then((res) => setTrendRollupData(res.trend_data || []))
        .catch(() => {});
    }
  }, [activeMainTab, activeCsv, dateCol, selectedTrendMetrics, trendPeriod]);

  useEffect(() => {
    if (activeMainTab === "trends" && activeCsv && trendScatterX && trendScatterY) {
      setTrendScatterLoading(true);
      edaScatter({ csv_data: activeCsv, x_column: trendScatterX, y_column: trendScatterY })
        .then((res) => setTrendScatterData(res))
        .catch(() => {})
        .finally(() => setTrendScatterLoading(false));
    }
  }, [activeMainTab, activeCsv, trendScatterX, trendScatterY]);

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

  // ─── TAB 3: DISTRIBUTIONS & OUTLIERS (CUSTOM BUCKET WIDTH & PERCENTILES) ─
  const [distCol, setDistCol] = useState("");
  const [histData, setHistData] = useState(null);
  const [customBinWidth, setCustomBinWidth] = useState("");
  
  // Outlier detection: Percentiles (default) vs Z-score
  const [outlierMethod, setOutlierMethod] = useState("percentile");
  const [lowerPercentile, setLowerPercentile] = useState("1.0");
  const [upperPercentile, setUpperPercentile] = useState("99.0");
  const [zScoreThreshold, setZScoreThreshold] = useState("3.0");
  const [outlierResult, setOutlierResult] = useState(null);
  const [outlierModalOpen, setOutlierModalOpen] = useState(false);
  const [distLoading, setDistLoading] = useState(false);

  useEffect(() => {
    if (!distCol && statsResult?.numeric_cols?.length) {
      setDistCol(statsResult.numeric_cols[0]);
    }
  }, [statsResult]);

  const loadDistAndOutliers = (binWidthOverride = null) => {
    if (!activeCsv || !distCol) return;
    setDistLoading(true);

    const bw = binWidthOverride !== null ? binWidthOverride : (parseFloat(customBinWidth) || undefined);
    const lp = parseFloat(lowerPercentile) || 1.0;
    const up = parseFloat(upperPercentile) || 99.0;
    const zThresh = parseFloat(zScoreThreshold) || 3.0;

    Promise.all([
      edaHistogram({ csv_data: activeCsv, column: distCol, bin_width: bw }),
      edaDetectOutliers({
        csv_data: activeCsv,
        column: distCol,
        method: outlierMethod,
        lower_percentile: lp,
        upper_percentile: up,
        threshold: zThresh,
      }),
    ])
      .then(([hRes, oRes]) => {
        setHistData(hRes);
        if (hRes && hRes.bin_width && !customBinWidth) {
          setCustomBinWidth(String(hRes.bin_width));
        }
        setOutlierResult(oRes);
      })
      .catch(() => {
        toast.error("Could not load distribution diagnostics");
      })
      .finally(() => setDistLoading(false));
  };

  useEffect(() => {
    if (activeMainTab === "distributions" && activeCsv && distCol) {
      loadDistAndOutliers();
    }
  }, [activeMainTab, activeCsv, distCol, outlierMethod]);

  const handleApplyCustomBucketWidth = () => {
    const parsed = parseFloat(customBinWidth);
    if (!parsed || parsed <= 0) return toast.error("Enter a valid positive bucket width.");
    loadDistAndOutliers(parsed);
    toast.success(`Bucket width updated to ${parsed}`);
  };

  const handleConfirmRemoveOutliers = async () => {
    setOutlierModalOpen(false);
    setDistLoading(true);
    try {
      const lp = parseFloat(lowerPercentile) || 1.0;
      const up = parseFloat(upperPercentile) || 99.0;
      const zThresh = parseFloat(zScoreThreshold) || 3.0;

      const res = await edaRemoveOutliers({
        csv_data: activeCsv,
        column: distCol,
        method: outlierMethod,
        lower_percentile: lp,
        upper_percentile: up,
        threshold: zThresh,
      });

      setLoadedCsvMap((prev) => ({ ...prev, [selectedArdId]: res.clean_csv }));
      setField("granularCsvData", res.clean_csv);
      setField("filteredCsvData", res.clean_csv);
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
    setLoadedCsvMap((prev) => ({ ...prev, [selectedArdId]: backupCsv }));
    setField("granularCsvData", backupCsv);
    setField("filteredCsvData", backupCsv);
    toast.success("Restored original dataset (all exclusions undone)");
    handleRunEDA(backupCsv);
  };

  // ─── TAB 4: RELATIONSHIPS & POOR MAN'S CURVE ──────────────────────────────
  const [relX, setRelX] = useState("");
  const [relY, setRelY] = useState(kpiCol || "");
  const [poorManCurve, setPoorManCurve] = useState(null);
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
      edaPoorMansCurve({ csv_data: activeCsv, x_column: relX, y_column: relY, n_bins: 12 })
        .then((pRes) => setPoorManCurve(pRes))
        .catch(() => {})
        .finally(() => setRelLoading(false));
    }
  }, [activeMainTab, activeCsv, relX, relY]);

  // ─── TAB 5: CORRELATION & MULTICOLLINEARITY ───────────────────────────────
  const [corrSubTab, setCorrSubTab] = useState("analysis");
  const [corrSelectedCols, setCorrSelectedCols] = useState([]);
  const [corrKpiTarget, setCorrKpiTarget] = useState(kpiCol || "");
  const [corrMatrix, setCorrMatrix] = useState(null);
  const [highPairs, setHighPairs] = useState([]);
  const [vifTable, setVifTable] = useState(null);
  const [vifLoading, setVifLoading] = useState(false);
  const [corrThreshold, setCorrThreshold] = useState(0.7);

  const [removalThreshold, setRemovalThreshold] = useState("0.75");
  const [removalPreview, setRemovalPreview] = useState(null);
  const [removalModalOpen, setRemovalModalOpen] = useState(false);
  const [singleDropTarget, setSingleDropTarget] = useState(null);
  const [removalLoading, setRemovalLoading] = useState(false);
  const [removalResultData, setRemovalResultData] = useState(null);

  const [comboThreshold, setComboThreshold] = useState("0.75");
  const [dropOriginalOnCombo, setDropOriginalOnCombo] = useState(true);
  const [foundClusters, setFoundClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [comboModalOpen, setComboModalOpen] = useState(false);
  const [comboLoading, setComboLoading] = useState(false);
  const [comboResultData, setComboResultData] = useState(null);

  useEffect(() => {
    if (statsResult?.numeric_cols?.length) {
      const activeNumeric = statsResult.numeric_cols;
      setCorrSelectedCols(activeNumeric);
      if (!corrKpiTarget) {
        setCorrKpiTarget(kpiCol || activeNumeric[0]);
      }
    }
  }, [statsResult]);

  const toggleCorrCol = (col) => {
    if (corrSelectedCols.includes(col)) {
      if (corrSelectedCols.length <= 2) return toast.error("Select at least 2 variables.");
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
      toast.success("VIF scores computed");
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || "VIF calculation failed");
    } finally {
      setVifLoading(false);
    }
  };

  const handleScanRemovalPairs = async () => {
    if (corrSelectedCols.length < 2) return toast.error("Select at least 2 variables.");
    setRemovalLoading(true);
    try {
      const parsedThresh = parseFloat(removalThreshold) || 0.75;
      const targetDep = corrKpiTarget || kpiCol;
      const res = await previewRemoval({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        threshold: parsedThresh,
        dependent_variable: targetDep,
      });
      setRemovalPreview(res);
      if (res.total_pairs === 0) {
        toast(`No pairs found with |r| ≥ ${parsedThresh}`, { icon: "ℹ️" });
      } else {
        toast.success(`Found ${res.total_pairs} correlated pair(s)`);
      }
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data?.error || e.message || "Removal scan failed";
      toast.error(msg);
    } finally {
      setRemovalLoading(false);
    }
  };

  useEffect(() => {
    if (corrSubTab === "removal" && corrSelectedCols.length >= 2) {
      handleScanRemovalPairs();
    }
  }, [corrSubTab, removalThreshold, corrKpiTarget]);

  const handleApplySingleRemoval = (varToDrop) => {
    setSingleDropTarget(varToDrop);
    setRemovalModalOpen(true);
  };

  const handleConfirmExecuteRemoval = async () => {
    setRemovalModalOpen(false);
    setRemovalLoading(true);
    try {
      const dropList = singleDropTarget ? [singleDropTarget] : (removalPreview?.dropped || []);
      const res = await applyRemoval({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        drop_cols: dropList,
      });

      setRemovalResultData(res);
      setLoadedCsvMap((prev) => ({ ...prev, [selectedArdId]: res.csv_data }));
      setField("granularCsvData", res.csv_data);
      setField("filteredCsvData", res.csv_data);
      toast.success(`Removed ${res.dropped.length} variable(s)!`);
      handleRunEDA(res.csv_data);
      setRemovalPreview(null);
      setSingleDropTarget(null);
    } catch (e) {
      toast.error("Failed to apply removal");
    } finally {
      setRemovalLoading(false);
    }
  };

  const handleFindCorrelatedPairs = async () => {
    if (corrSelectedCols.length < 2) return toast.error("Select at least 2 variables.");
    setComboLoading(true);
    try {
      const parsedThresh = parseFloat(comboThreshold) || 0.75;
      const res = await findClusters({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        threshold: parsedThresh,
      });
      const clusters = res.clusters || [];
      setFoundClusters(clusters);
      setClusterNames(clusters.map((c) => `SUM_${c[0].toUpperCase()}_${c[1].toUpperCase()}`));
      if (clusters.length === 0) {
        toast(`No correlated pairs with |r| ≥ ${parsedThresh}. Try lowering threshold.`, { icon: "ℹ️" });
      } else {
        toast.success(`Found ${clusters.length} correlated 2-variable pair(s)`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Pair search failed");
    } finally {
      setComboLoading(false);
    }
  };

  const handleConfirmApplyCombination = async () => {
    setComboModalOpen(false);
    setComboLoading(true);
    try {
      const res = await applyCombination({
        csv_data: activeCsv,
        columns: corrSelectedCols,
        clusters: foundClusters,
        new_names: clusterNames,
        method: "sum",
        drop_original: dropOriginalOnCombo,
      });

      setComboResultData(res);
      setLoadedCsvMap((prev) => ({ ...prev, [selectedArdId]: res.csv_data }));
      setField("granularCsvData", res.csv_data);
      setField("filteredCsvData", res.csv_data);
      toast.success(`Combined ${foundClusters.length} pair(s) using Sum!`);
      setFoundClusters([]);
      handleRunEDA(res.csv_data);
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || "Combination failed");
    } finally {
      setComboLoading(false);
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
    toast.success("EDA Complete! Proceeding to Data Transformation.");
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
                setBackupCsv(null);
              }}
              className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
            >
              {ardList.length === 0 ? (
                <option value="active_granular">Active Stitched ARD</option>
              ) : (
                ardList.map((ard) => (
                  <option key={ard.id} value={ard.id}>
                    📄 {ard.name} ({ard.grain?.toUpperCase()} Grain • {ard.rows?.toLocaleString()} rows • {ard.cols} cols)
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 flex-1 min-w-[280px]">
            <Select label="Date Key" value={dateCol} onChange={setDateCol} options={columns} placeholder="Select Date Column" />
            <Select label="Geo / Group Key" value={geoCol} onChange={setGeoCol} options={columns} placeholder="Select Geo Column" />
          </div>

          <Btn onClick={() => handleRunEDA()} disabled={loading || !activeCsv} className="self-end py-2.5">
            {loading ? "Calculating…" : "↻ Recalculate EDA"}
          </Btn>
        </div>

        {activeArdObj && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Currently reviewing: <strong className="text-slate-800">{activeArdObj.name}</strong></span>
            <span className="font-mono">Created: {new Date(activeArdObj.createdAt).toLocaleDateString()}</span>
          </div>
        )}
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

      {/* TAB 1: SUMMARY STATS */}
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

      {/* TAB 2: TIME TRENDS (LINEAR LINE GRAPH + BIVARIATE SCATTER) */}
      {activeMainTab === "trends" && (
        <div className="space-y-6">
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
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Select Metrics to Display on Trend Line ({selectedTrendMetrics.length} selected):
              </label>
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

            {displayTrendData.length > 0 && (
              <ResponsiveContainer width="100%" height={340}>
                {/* type="linear" removes curved smoothing and creates exact straight-line connections */}
                <LineChart data={displayTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (indexedView ? `${v.toFixed(0)}` : Number(v).toLocaleString())} />
                  <Tooltip formatter={(v) => (indexedView ? `${Number(v).toFixed(1)} (Index)` : Number(v).toLocaleString())} />
                  <Legend verticalAlign="bottom" wrapperStyle={{ paddingTop: "14px", fontSize: "11px" }} />
                  {selectedTrendMetrics.map((m, i) => (
                    <Line
                      key={m}
                      type="linear"
                      dataKey={m}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: PALETTE[i % PALETTE.length] }}
                      activeDot={{ r: 6 }}
                      name={m}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>

          {/* 2nd Graph: Bivariate Scatter Plot for Relationship Between X and Y */}
          <Card title="Variable Relationship Explorer (Scatter Plot & Linear Correlation)">
            <p className="text-xs text-slate-500 mb-4">
              Inspect the relationship between any marketing variable ($X$) and sales/response ($Y$). Displays observed data points, linear trendline, and Pearson correlation coefficient ($r$).
            </p>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <Select
                label="Select Independent Variable (X Axis):"
                value={trendScatterX}
                onChange={setTrendScatterX}
                options={(statsResult?.numeric_cols || []).filter((c) => c !== trendScatterY)}
              />
              <Select
                label="Select Dependent / Response Variable (Y Axis):"
                value={trendScatterY}
                onChange={setTrendScatterY}
                options={statsResult?.numeric_cols || columns}
              />
            </div>

            {trendScatterLoading && <Spinner label="Loading scatter plot..." />}

            {trendScatterData && !trendScatterLoading && (
              <div className="space-y-3">
                <div className="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-xs">
                  <span className="font-bold text-slate-700">
                    {trendScatterX} vs {trendScatterY}
                  </span>
                  <span className="font-mono font-bold text-brand-700 bg-brand-50 px-2.5 py-1 rounded border border-brand-200">
                    Pearson r = {trendScatterData.r}
                  </span>
                </div>

                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis type="number" dataKey="x" name={trendScatterX} tick={{ fontSize: 10 }} label={{ value: trendScatterX, position: "insideBottom", offset: -10, fontSize: 11 }} />
                    <YAxis type="number" dataKey="y" name={trendScatterY} tick={{ fontSize: 10 }} label={{ value: trendScatterY, angle: -90, position: "insideLeft", fontSize: 11 }} />
                    <Tooltip formatter={(v) => Number(v).toFixed(2)} />
                    <Scatter name="Data Points" data={trendScatterData.x.map((xv, i) => ({ x: xv, y: trendScatterData.y[i] }))} fill="#001E96" opacity={0.65} />
                    {trendScatterData.trendline?.length > 0 && (
                      <Scatter name="Linear Trendline" data={trendScatterData.trendline} line={{ stroke: "#EF4444", strokeWidth: 2 }} shape={() => null} />
                    )}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 3: DISTRIBUTIONS & OUTLIERS (CUSTOM BUCKET WIDTH & PERCENTILES) */}
      {activeMainTab === "distributions" && (
        <div className="space-y-6">
          <Card title="Variable Distribution & Histogram Customization">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <div>
                <Select label="Select Variable:" value={distCol} onChange={setDistCol} options={statsResult?.numeric_cols || columns} />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Bucket Width (Bin Size):
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="any"
                    min="0.001"
                    placeholder="e.g. 5, 10, 50"
                    value={customBinWidth}
                    onChange={(e) => setCustomBinWidth(e.target.value)}
                    className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <Btn onClick={handleApplyCustomBucketWidth} className="text-xs py-2 whitespace-nowrap">
                    Apply Width
                  </Btn>
                </div>
              </div>
            </div>

            {distLoading && <Spinner label="Loading distribution histogram..." />}

            {histData && !distLoading && (
              <div className="space-y-4">
                <div className="flex gap-4 items-center text-xs bg-slate-50 p-3 rounded-xl border border-slate-200 flex-wrap">
                  <span className="font-bold text-slate-700">Mean: {histData.mean?.toFixed(2)}</span>
                  <span className="font-bold text-slate-700">Median: {histData.median?.toFixed(2)}</span>
                  <span className="text-slate-500">Span: {histData.min?.toFixed(1)} to {histData.max?.toFixed(1)}</span>
                  <span className="font-mono text-brand-700 font-semibold bg-brand-50 px-2 py-0.5 rounded">
                    Active Bucket Width: {histData.bin_width} ({histData.counts.length} bins)
                  </span>
                </div>

                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={histData.counts.map((c, i) => ({ bin: histData.bin_labels[i], count: c }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="bin" tick={{ fontSize: 9 }} interval={histData.counts.length > 20 ? 1 : 0} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#001E96" radius={[4, 4, 0, 0]} name="Frequency" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Outlier Diagnostics Section (Percentiles & Z-score) */}
          <Card title={`Outlier Diagnostics for ${distCol}`}>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-4">
              <Select
                label="Detection Strategy:"
                value={outlierMethod}
                onChange={setOutlierMethod}
                options={[
                  { value: "percentile", label: "Percentile Cutoffs (e.g. 1st - 99th %ile)" },
                  { value: "zscore", label: "Z-Score (Standard Deviations)" },
                ]}
              />

              {outlierMethod === "percentile" ? (
                <>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Lower Percentile (%):
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="49"
                      value={lowerPercentile}
                      onChange={(e) => setLowerPercentile(e.target.value)}
                      className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Upper Percentile (%):
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="51"
                      max="100"
                      value={upperPercentile}
                      onChange={(e) => setUpperPercentile(e.target.value)}
                      className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                    />
                  </div>
                </>
              ) : (
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Z-Score Threshold (σ):
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="1.0"
                    max="10.0"
                    value={zScoreThreshold}
                    onChange={(e) => setZScoreThreshold(e.target.value)}
                    className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                  />
                </div>
              )}

              <div className="flex items-end">
                <Btn onClick={() => loadDistAndOutliers()} disabled={distLoading} className="w-full justify-center">
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
                        ↺ Restore Original Dataset
                      </Btn>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 p-3 rounded-xl">
                    <span className="text-xs font-bold text-emerald-800">✅ No extreme outliers detected in {distCol} with {outlierResult.method}.</span>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 4: RELATIONSHIPS & POOR MAN'S CURVE */}
      {activeMainTab === "relationships" && (
        <Card title="Bivariate Relationships & Poor Man's Saturation Curve">
          <p className="text-xs text-slate-500 mb-4">
            Reveals whether a marketing tactic exhibits diminishing returns (logarithmic saturation) or linear growth.
          </p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <Select label="Marketing Tactic (X Axis):" value={relX} onChange={setRelX} options={(statsResult?.numeric_cols || []).filter((c) => c !== relY)} />
            <Select label="Target Sales / KPI (Y Axis):" value={relY} onChange={setRelY} options={statsResult?.numeric_cols || columns} />
          </div>

          {relLoading && <Spinner label="Calculating response curve..." />}

          {poorManCurve && !relLoading && (
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs flex items-center justify-between">
                <div>
                  <span className="font-bold text-blue-950">Detected Response Curve Shape: </span>
                  <span className="font-extrabold text-brand-700">{poorManCurve.shape_indicator}</span>
                </div>
                <span className="text-slate-500">12 Quantile Average Bins</span>
              </div>

              <div>
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">1. Binned Average Response Curve:</h4>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={poorManCurve.binned_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="spend_x" label={{ value: `Tactic Level (${relX})`, position: "insideBottom", offset: -5, fontSize: 11 }} tick={{ fontSize: 10 }} />
                    <YAxis dataKey="response_y" label={{ value: `Average ${relY}`, angle: -90, position: "insideLeft", fontSize: 11 }} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                    <Line type="linear" dataKey="response_y" stroke="#001E96" strokeWidth={3} dot={{ r: 5, fill: "#1ABC9C" }} name={`Binned Mean ${relY}`} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* TAB 5: CORRELATION & MULTICOLLINEARITY */}
      {activeMainTab === "correlation" && (
        <div className="space-y-6">
          <div className="flex gap-2 border-b border-slate-200">
            {[
              { id: "analysis", label: "1. Analysis (Heatmap & VIF)" },
              { id: "removal", label: "2. Treatment — Removal" },
              { id: "combination", label: "3. Treatment — Combination (Sum)" },
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

          {corrSubTab === "analysis" && (
            <div className="space-y-4">
              <Card title="Select Variables for Multicollinearity Analysis">
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
                  <CorrelationHeatmap matrix={corrMatrix.matrix} columns={corrMatrix.columns} threshold={corrThreshold} onCellClick={handleHeatmapJumpToScatter} />
                )}

                {highPairs.length > 0 && (
                  <div className="mt-4">
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
            </div>
          )}

          {corrSubTab === "removal" && (
            <Card title="Multicollinearity Treatment — Variable Removal">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <Select label="Target KPI for Correlation Comparison:" value={corrKpiTarget} onChange={setCorrKpiTarget} options={columns} />
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Removal Threshold (|r| ≥ {removalThreshold}):
                  </label>
                  <input
                    type="text"
                    value={removalThreshold}
                    onChange={(e) => setRemovalThreshold(e.target.value)}
                    className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                  />
                </div>
              </div>

              <Btn onClick={handleScanRemovalPairs} disabled={removalLoading}>
                {removalLoading ? "Scanning…" : "🔍 Scan Correlated Pairs"}
              </Btn>

              {removalPreview && (
                <div className="space-y-3 mt-4">
                  {removalPreview.pairs?.map((p, idx) => (
                    <div key={idx} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <span className="text-xs font-bold text-slate-800">{p.feature1} ↔ {p.feature2} (|r| = {p.correlation})</span>
                        <p className="text-xs text-slate-600">{p.reason}</p>
                      </div>
                      <Btn variant="danger" onClick={() => handleApplySingleRemoval(p.will_drop)} className="text-xs py-1.5">
                        Drop "{p.will_drop}"
                      </Btn>
                    </div>
                  ))}
                </div>
              )}

              {removalResultData && (
                <div className="mt-6 pt-4 border-t border-slate-200 space-y-2">
                  <span className="text-xs font-bold text-emerald-600 block">✅ Dropped: {removalResultData.dropped.join(", ")}</span>
                  <DataTable data={removalResultData.preview} />
                </div>
              )}
            </Card>
          )}

          {corrSubTab === "combination" && (
            <Card title="Multicollinearity Treatment — Variable Combination (Sum Pairs)">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Pairwise Correlation Threshold (|r| ≥ {comboThreshold}):
                  </label>
                  <input
                    type="text"
                    value={comboThreshold}
                    onChange={(e) => setComboThreshold(e.target.value)}
                    className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                  />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={dropOriginalOnCombo} onChange={(e) => setDropOriginalOnCombo(e.target.checked)} className="rounded" />
                    Drop original features after summing
                  </label>
                </div>
              </div>

              <Btn onClick={handleFindCorrelatedPairs} disabled={comboLoading}>
                {comboLoading ? "Scanning…" : "🔍 Find Correlated Pairs"}
              </Btn>

              {foundClusters.length > 0 && (
                <div className="space-y-4 mt-4">
                  {foundClusters.map((cluster, cIdx) => (
                    <div key={cIdx} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-brand-800">Pair #{cIdx + 1}: {cluster[0]} + {cluster[1]}</span>
                      </div>
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
                  ))}

                  <Btn onClick={() => setComboModalOpen(true)} disabled={comboLoading}>
                    Apply Sum Combination
                  </Btn>
                </div>
              )}

              {comboResultData && (
                <div className="mt-6 pt-4 border-t border-slate-200 space-y-2">
                  <span className="text-xs font-bold text-emerald-600 block">✅ Sum Columns Created & Dataset Updated</span>
                  <DataTable data={comboResultData.preview} />
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* Outlier Confirmation Modal */}
      {outlierModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Outlier Exclusion</h3>
            <p className="text-xs text-slate-600">
              Excluding <strong>{outlierResult?.outlier_count} rows</strong> with extreme values in <code>{distCol}</code> using {outlierResult?.method}.
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
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => { setRemovalModalOpen(false); setSingleDropTarget(null); }}>Cancel</Btn>
              <Btn variant="danger" onClick={handleConfirmExecuteRemoval}>Confirm & Drop</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Combination Confirmation Modal */}
      {comboModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Variable Combination</h3>
            <p className="text-xs text-slate-600">
              This will create <strong>{foundClusters.length} new sum column(s)</strong> ({clusterNames.join(", ")}).
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setComboModalOpen(false)}>Cancel</Btn>
              <Btn onClick={handleConfirmApplyCombination}>Confirm & Apply Sum</Btn>
            </div>
          </div>
        </div>
      )}

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
