import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter
} from "recharts";
import {
  applyTransformations,
  transformationPreviewSingle,
  transformationCorrelation,
  correlationMatrix,
  edaHistogram,
  edaDetectOutliers,
  edaRemoveOutliers,
  v2ListArds,
  v2GetCsv
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Select } from "../components/UI";

const NORMALIZATION_OPTIONS = [
  { value: "none", label: "None (Raw Volume)" },
  { value: "population", label: "Population Based (÷ Universe)" },
  { value: "minmax", label: "Min-Max Scaling [0, 1]" },
  { value: "zscore", label: "Z-Score (Standardized σ)" },
  { value: "iqr", label: "Robust / IQR Scaling" },
];

const format1Dec = (val) => {
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (Math.abs(num) >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return num.toFixed(1);
};

function detectGrainUnit(dates = []) {
  if (!dates || dates.length < 2) return { grain: "Weekly", unit: "Weeks", singular: "Week" };
  const d0 = new Date(dates[0]);
  const d1 = new Date(dates[1]);
  if (isNaN(d0.getTime()) || isNaN(d1.getTime())) {
    return { grain: "Weekly", unit: "Weeks", singular: "Week" };
  }
  const gapDays = Math.abs((d1 - d0) / (1000 * 60 * 60 * 24));

  if (gapDays <= 2) return { grain: "Daily", unit: "Days", singular: "Day" };
  if (gapDays <= 12) return { grain: "Weekly", unit: "Weeks", singular: "Week" };
  if (gapDays <= 45) return { grain: "Monthly", unit: "Months", singular: "Month" };
  return { grain: "Monthly", unit: "Months", singular: "Month" };
}

function IngestionCategoryBox({ title, subtitle, columns, selected = [], onToggle, colorBadge }) {
  return (
    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">{title}</span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colorBadge}`}>
            {selected.length} / {columns.length}
          </span>
        </div>
        <p className="text-[11px] text-slate-500 mb-3">{subtitle}</p>

        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-2 bg-white rounded-xl border border-slate-200">
          {columns.length === 0 ? (
            <span className="text-[11px] text-slate-400 italic">No columns mapped to this category</span>
          ) : (
            columns.map((c) => {
              const isChecked = selected.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onToggle(c)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 border ${
                    isChecked
                      ? "bg-[#001E96] text-white border-[#001E96] shadow-sm"
                      : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                  }`}
                >
                  <span>{isChecked ? "✓" : "+"}</span>
                  <span>{c}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function HeatmapGrid({ matrix, columns, threshold = 0.7, title = "Correlation Matrix" }) {
  if (!matrix || !columns || !columns.length) return null;

  const getStyle = (val) => {
    const v = parseFloat(val) || 0;
    const absV = Math.abs(v);
    if (absV < threshold) {
      return { backgroundColor: "#F8FAFC", color: "#94A3B8", opacity: 0.55 };
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
    <div className="space-y-2">
      <span className="text-xs font-bold text-slate-700 block uppercase tracking-wider">{title}</span>
      <div className="overflow-auto max-h-[380px] rounded-xl border border-slate-200">
        <table className="text-xs border-collapse w-full bg-white">
          <thead className="sticky top-0 bg-slate-50 shadow-sm z-10">
            <tr>
              <th className="p-2.5 text-slate-500 font-bold">Variable</th>
              {columns.map((c) => (
                <th key={c} className="p-2.5 text-slate-700 font-bold whitespace-nowrap">{c.replace("_transformed", "")}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {columns.map((row) => (
              <tr key={row}>
                <td className="p-2.5 font-bold text-slate-700 whitespace-nowrap pr-4 bg-slate-50">{row.replace("_transformed", "")}</td>
                {columns.map((col) => {
                  const val = matrix[row]?.[col] ?? 0;
                  const isDiag = row === col;
                  const style = isDiag
                    ? { backgroundColor: "#E2E8F0", color: "#475569", fontWeight: "bold" }
                    : getStyle(val);

                  return (
                    <td
                      key={col}
                      style={style}
                      title={`${row} vs ${col}: ${Number(val).toFixed(2)}`}
                      className="w-14 h-9 text-center font-mono transition-all"
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
    </div>
  );
}

export default function DataTransformation() {
  const navigate = useNavigate();
  const { state, setField, saveWorkflowSnapshot } = useAppState();
  const workflowId = state.workflowId;

  const [ardList, setArdList] = useState(() => state.savedArds || []);
  const [selectedArdId, setSelectedArdId] = useState(() => state.activeDataset || "active");
  const [activeCsv, setActiveCsv] = useState(() => state.granularCsvData || state.filteredCsvData || "");
  const [savedSets, setSavedSets] = useState(() => state.savedTransformationSets || []);
  const [activeSetIndex, setActiveSetIndex] = useState(0);

  const [detectedGrain, setDetectedGrain] = useState("Weekly");
  const [grainUnit, setGrainUnit] = useState("Weeks");

  useEffect(() => {
    if (!workflowId) return;
    v2ListArds(workflowId)
      .then((res) => {
        const ards = (res.items || []).map((a) => ({
          id: a.filename,
          name: a.filename.replace(/\.csv$/i, ""),
          filename: a.filename,
          grain: a.grain || (a.filename.toLowerCase().includes("dma") ? "dma" : "hcp"),
          rows: a.row_count,
          cols: (a.columns || []).length,
          columns: a.columns || [],
          version: a.version || 1,
        }));
        if (ards.length > 0) {
          setArdList(ards);
          setField("savedArds", ards);
          if (selectedArdId === "active" || !ards.some((a) => a.id === selectedArdId)) {
            setSelectedArdId(ards[0].id);
          }
        }
      })
      .catch(() => {});
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId || !selectedArdId || selectedArdId === "active") return;
    v2GetCsv(workflowId, selectedArdId)
      .then((csv) => {
        setActiveCsv(csv);
        setField("granularCsvData", csv);
        setField("filteredCsvData", csv);
      })
      .catch(() => {});
  }, [workflowId, selectedArdId]);

  const [distCol, setDistCol] = useState("");
  const [histData, setHistData] = useState(null);
  const [customBinWidth, setCustomBinWidth] = useState("");
  const [outlierMethod, setOutlierMethod] = useState("percentile");
  const [lowerPercentile, setLowerPercentile] = useState("0.5");
  const [upperPercentile, setUpperPercentile] = useState("99.5");
  const [zScoreThreshold, setZScoreThreshold] = useState("3.0");
  const [outlierResult, setOutlierResult] = useState(null);
  const [outlierModalOpen, setOutlierModalOpen] = useState(false);
  const [distLoading, setDistLoading] = useState(false);
  const [backupCsv, setBackupCsv] = useState(null);

  useEffect(() => {
    if (activeCsv && !backupCsv) {
      setBackupCsv(activeCsv);
    }
  }, [activeCsv, selectedArdId]);

  useEffect(() => {
    if (!activeCsv) return;
    try {
      const lines = activeCsv.trim().split("\n").slice(1, 15);
      const dates = lines.map((l) => l.split(",")[0]?.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      const res = detectGrainUnit(dates);
      setDetectedGrain(res.grain);
      setGrainUnit(res.unit);
    } catch (e) {}
  }, [activeCsv]);

  const [allCols, setAllCols] = useState([]);
  const [columnRolesMap, setColumnRolesMap] = useState(() => state.columnRoles || {});

  const [selCrossSectional, setSelCrossSectional] = useState([]);
  const [selDependent, setSelDependent] = useState([]);
  const [selTime, setSelTime] = useState([]);
  const [selPromotions, setSelPromotions] = useState([]);
  const [selBaseline, setSelBaseline] = useState([]);
  const [lockDepVar, setLockDepVar] = useState(true);

  useEffect(() => {
    if (!activeCsv) return;
    try {
      const firstLine = activeCsv.split("\n")[0];
      const cols = firstLine.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setAllCols(cols);

      const roles = { ...(state.columnRoles || {}) };
      cols.forEach((c) => {
        if (!roles[c]) {
          const l = c.toLowerCase();
          if (l.includes("sale") || l.includes("trx") || l.includes("nrx") || l.includes("kpi")) {
            roles[c] = "Dependent Variable";
          } else if (l.includes("date") || l.includes("week") || l.includes("month") || l.includes("period")) {
            roles[c] = "Time Variable";
          } else if (l.includes("npi") || l.includes("geo") || l.includes("id") || l.includes("dma")) {
            roles[c] = "Cross-sectional Variable";
          } else if (l.includes("pop") || l.includes("universe") || l.includes("base") || l.includes("weight")) {
            roles[c] = "Baseline Variables";
          } else {
            roles[c] = "Independent Promotions";
          }
        }
      });
      setColumnRolesMap(roles);

      setSelCrossSectional(cols.filter((c) => roles[c] === "Cross-sectional Variable"));
      setSelDependent(cols.filter((c) => roles[c] === "Dependent Variable"));
      setSelTime(cols.filter((c) => roles[c] === "Time Variable"));
      setSelPromotions(cols.filter((c) => roles[c] === "Independent Promotions"));
      setSelBaseline(cols.filter((c) => roles[c] === "Baseline Variables"));

      if (!distCol && cols.length > 0) {
        const d = cols.find((c) => roles[c] === "Dependent Variable") || cols[0];
        setDistCol(d);
      }
    } catch (e) {}
  }, [activeCsv]);

  const loadDistAndOutliers = (binWidthOverride = null) => {
    if (!activeCsv || !distCol) return;
    setDistLoading(true);

    const bw = binWidthOverride !== null ? binWidthOverride : (parseFloat(customBinWidth) || undefined);
    const lp = parseFloat(lowerPercentile) || 0.5;
    const up = parseFloat(upperPercentile) || 99.5;
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
      .catch(() => toast.error("Could not load distribution diagnostics"))
      .finally(() => setDistLoading(false));
  };

  useEffect(() => {
    if (activeCsv && distCol) {
      loadDistAndOutliers();
    }
  }, [activeCsv, distCol, outlierMethod]);

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
      const lp = parseFloat(lowerPercentile) || 0.5;
      const up = parseFloat(upperPercentile) || 99.5;
      const zThresh = parseFloat(zScoreThreshold) || 3.0;

      const res = await edaRemoveOutliers({
        csv_data: activeCsv,
        column: distCol,
        method: outlierMethod,
        lower_percentile: lp,
        upper_percentile: up,
        threshold: zThresh,
      });

      setActiveCsv(res.clean_csv);
      setField("granularCsvData", res.clean_csv);
      setField("filteredCsvData", res.clean_csv);
      toast.success(`Excluded ${res.dropped_rows} outlier row(s)!`);
    } catch (err) {
      toast.error("Failed to remove outliers");
    } finally {
      setDistLoading(false);
    }
  };

  const handleRestoreOriginalDataset = () => {
    if (!backupCsv) return toast.error("No original backup found.");
    setActiveCsv(backupCsv);
    setField("granularCsvData", backupCsv);
    setField("filteredCsvData", backupCsv);
    toast.success("Restored original dataset");
  };

  const crossCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Cross-sectional Variable"), [allCols, columnRolesMap]);
  const depCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Dependent Variable"), [allCols, columnRolesMap]);
  const timeCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Time Variable"), [allCols, columnRolesMap]);
  const promoCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Independent Promotions"), [allCols, columnRolesMap]);
  const baseCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Baseline Variables"), [allCols, columnRolesMap]);

  const toggleCategorySelection = (col, list, setter) => {
    setter(list.includes(col) ? list.filter((x) => x !== col) : [...list, col]);
  };

  const activeTransformableList = useMemo(() => {
    const list = [...selPromotions, ...selBaseline];
    if (!lockDepVar) {
      selDependent.forEach((d) => {
        if (!list.includes(d)) list.push(d);
      });
    }
    return list;
  }, [selPromotions, selBaseline, selDependent, lockDepVar]);

  const [derivedVars, setDerivedVars] = useState([]);
  const [derivedModalOpen, setDerivedModalOpen] = useState(false);
  const [newDerivedName, setNewDerivedName] = useState("");
  const [derivedOperator, setDerivedOperator] = useState("+");
  const [selectedDerivedVars, setSelectedDerivedVars] = useState([]);
  const [derivedWeights, setDerivedWeights] = useState({});

  const [transformConfig, setTransformConfig] = useState(() => state.transformationConfig || []);

  useEffect(() => {
    setTransformConfig((prev) => {
      const existingMap = new Map(prev.map((r) => [r["Channel Name"], r]));
      const defaultPopCol = baseCols[0] || allCols.find((c) => /pop|weight|universe/i.test(c)) || "";

      const standardRows = activeTransformableList.map((v) => {
        if (existingMap.has(v)) return existingMap.get(v);
        const isDep = selDependent.includes(v);
        return {
          "Channel Name": v,
          "Grain": isDep ? "KPI" : "Promo",
          "Normalization": "none",
          "Population Column": defaultPopCol,
          "Adstock": 0.5,
          "Adstock Horizon": 2,
          "Lag": 0,
          "Saturation Function": "Log",
          "Power (k)": 0.5,
          "Log (k)": 1.0,
          "is_derived": false,
          "is_dependent": isDep,
        };
      });

      const derivedRows = derivedVars.map((dv) => {
        if (existingMap.has(dv.name)) return existingMap.get(dv.name);
        return {
          "Channel Name": dv.name,
          "Grain": "Derived",
          "Normalization": "none",
          "Population Column": defaultPopCol,
          "Adstock": 0.5,
          "Adstock Horizon": 2,
          "Lag": 0,
          "Saturation Function": "Log",
          "Power (k)": 0.5,
          "Log (k)": 1.0,
          "is_derived": true,
          "formula": dv.variables.join(` ${dv.operator} `),
        };
      });

      return [...standardRows, ...derivedRows];
    });
  }, [activeTransformableList, derivedVars, selDependent, baseCols, allCols]);

  const updateConfigRow = (channelName, field, value) => {
    setTransformConfig((prev) =>
      prev.map((row) => (row["Channel Name"] === channelName ? { ...row, [field]: value } : row))
    );
  };

  const handleAddDerivedVariable = () => {
    if (!newDerivedName.trim()) return toast.error("Provide a name for the derived variable.");
    if (selectedDerivedVars.length < 2) return toast.error("Select at least 2 source variables.");

    const derivedName = newDerivedName.trim().toUpperCase();
    const entry = {
      name: derivedName,
      operator: derivedOperator,
      variables: selectedDerivedVars,
      weights: derivedWeights,
    };

    setDerivedVars((prev) => [...prev, entry]);
    setNewDerivedName("");
    setSelectedDerivedVars([]);
    setDerivedWeights({});
    setDerivedModalOpen(false);
    toast.success(`Derived channel "${derivedName}" added!`);
  };

  const removeDerivedVariable = (channelName) => {
    setDerivedVars((prev) => prev.filter((d) => d.name !== channelName));
    setTransformConfig((prev) => prev.filter((r) => r["Channel Name"] !== channelName));
    toast.success(`Removed derived channel "${channelName}"`);
  };

  const [preCorrMatrix, setPreCorrMatrix] = useState(null);
  const [preCorrColumns, setPreCorrColumns] = useState([]);

  useEffect(() => {
    if (!activeCsv || (activeTransformableList.length + derivedVars.length) < 2) return;
    
    const rawColsToCorrelate = Array.from(new Set([
      ...activeTransformableList,
      ...derivedVars.map((d) => d.name)
    ]));
    
    correlationMatrix({
      csv_data: activeCsv,
      columns: rawColsToCorrelate,
      derived_variables: derivedVars,
    })
      .then((cRes) => {
        setPreCorrMatrix(cRes.matrix);
        setPreCorrColumns(cRes.columns);
      })
      .catch(() => {});
  }, [activeCsv, activeTransformableList, derivedVars]);

  // Scatter plot X and Y explorer
  const [scatterX, setScatterX] = useState("");
  const [scatterY, setScatterY] = useState("");

  useEffect(() => {
    if (activeTransformableList.length > 0 && !scatterX) {
      setScatterX(activeTransformableList[0]);
    }
    if (selDependent.length > 0 && !scatterY) {
      setScatterY(selDependent[0]);
    } else if (allCols.length > 0 && !scatterY) {
      setScatterY(allCols[0]);
    }
  }, [activeTransformableList, selDependent, allCols]);

  // Generate Sampled Scatter Data for Pre vs Post Plotting
  const rawScatterPoints = useMemo(() => {
    if (!activeCsv || !scatterX || !scatterY) return [];
    try {
      const lines = activeCsv.trim().split("\n");
      const headers = lines[0].split(",").map((h) => h.trim().replace(/^["']|["']$/g, ""));
      const xIdx = headers.indexOf(scatterX);
      const yIdx = headers.indexOf(scatterY);
      if (xIdx === -1 || yIdx === -1) return [];

      const points = [];
      const sampleLimit = Math.min(lines.length - 1, 400);
      const step = Math.max(1, Math.floor((lines.length - 1) / sampleLimit));

      for (let i = 1; i < lines.length; i += step) {
        const parts = lines[i].split(",");
        const xv = parseFloat(parts[xIdx]);
        const yv = parseFloat(parts[yIdx]);
        if (!isNaN(xv) && !isNaN(yv)) {
          points.push({ x: xv, y: yv });
        }
      }
      return points;
    } catch (e) {
      return [];
    }
  }, [activeCsv, scatterX, scatterY]);

  const [setNameInput, setSetNameInput] = useState("HCP FINAL ARD");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [transCorrMatrix, setTransCorrMatrix] = useState(null);
  const [transCorrThreshold, setTransCorrThreshold] = useState(0.7);

  const transScatterPoints = useMemo(() => {
    const csvSource = result?.csv_data || state.transformedCsvData;
    if (!csvSource || !scatterX || !scatterY) return [];
    try {
      const transName = `${scatterX}_transformed`;
      const lines = csvSource.trim().split("\n");
      const headers = lines[0].split(",").map((h) => h.trim().replace(/^["']|["']$/g, ""));
      let xIdx = headers.indexOf(transName);
      if (xIdx === -1) xIdx = headers.indexOf(scatterX);
      const yIdx = headers.indexOf(scatterY);
      if (xIdx === -1 || yIdx === -1) return [];

      const points = [];
      const sampleLimit = Math.min(lines.length - 1, 400);
      const step = Math.max(1, Math.floor((lines.length - 1) / sampleLimit));

      for (let i = 1; i < lines.length; i += step) {
        const parts = lines[i].split(",");
        const xv = parseFloat(parts[xIdx]);
        const yv = parseFloat(parts[yIdx]);
        if (!isNaN(xv) && !isNaN(yv)) {
          points.push({ x: xv, y: yv });
        }
      }
      return points;
    } catch (e) {
      return [];
    }
  }, [result, state.transformedCsvData, scatterX, scatterY]);

  const handleApplyTransformations = async () => {
    if (!activeCsv) return toast.error("No dataset available");
    const primaryDate = selTime[0] || "";
    const primaryGeo = selCrossSectional[0] || "";
    const primaryDep = selDependent[0] || "";
    const primaryPop = selBaseline[0] || "";

    if (!primaryDate || !primaryGeo || !primaryDep) {
      return toast.error("Select Time Variable, Cross-sectional Geo Variable, and Dependent Variable.");
    }
    if (!transformConfig.length) return toast.error("Configure at least one channel.");

    setLoading(true);
    try {
      const mappedTransformations = transformConfig.map((c) => ({
        ...c,
        Lags: c["Adstock Horizon"] ?? 2,
        Lag: c["Lag"] ?? 0,
        pop_column: c["Population Column"] || primaryPop || undefined,
      }));

      const data = await applyTransformations({
        csv_data: activeCsv,
        geo_column: primaryGeo,
        date_column: primaryDate,
        dependent_variable: primaryDep,
        add_carryover: false,
        transformations: mappedTransformations,
        derived_variables: derivedVars,
        pop_column: primaryPop || undefined,
      });

      setResult(data);
      setField("transformedCsvData", data.csv_data);
      setField("geoColumn", primaryGeo);
      setField("dateColumn", primaryDate);
      setField("dependentVariable", primaryDep);
      setField("transformationConfig", transformConfig);

      const activeArd = ardList.find((a) => a.id === selectedArdId);
      const isDma = (activeArd?.grain || "").toLowerCase().includes("dma") || setNameInput.toLowerCase().includes("dma");
      const detectedModelGrain = isDma ? "DMA" : "HCP";

      const newVersion = {
        id: `trans_${Date.now()}`,
        name: setNameInput.trim() || `Transform Set v${savedSets.length + 1}`,
        grain: detectedModelGrain,
        createdAt: new Date().toISOString(),
        configs: [...transformConfig],
        derivedVars: [...derivedVars],
        columnsCount: data.cols,
        columns: data.columns || [],
        transformed_channels: data.transformed_channels || [],
        resultData: data,
        csv_data: data.csv_data,
        depVars: selDependent,
        timeVars: selTime,
        crossVars: selCrossSectional,
        promotions: selPromotions,
        baselineVars: selBaseline,
        dateColumn: primaryDate,
        geoColumn: primaryGeo,
        dependentVariable: primaryDep,
      };

      const updatedSets = [newVersion, ...savedSets.filter((s) => s.name !== newVersion.name)];
      setSavedSets(updatedSets);
      setActiveSetIndex(0);
      setField("savedTransformationSets", updatedSets);

      if (data.transformed_channels && data.transformed_channels.length >= 2) {
        transformationCorrelation({
          csv_data: data.csv_data,
          columns: data.transformed_channels,
          threshold: transCorrThreshold,
        })
          .then((cRes) => setTransCorrMatrix(cRes))
          .catch(() => {});
      }

      toast.success(`Transformation Dataset "${newVersion.name}" saved!`);
    } catch (err) {
      toast.error(err.response?.data?.error || "Transformation failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectVersion = (idx) => {
    const targetSet = savedSets[idx];
    if (!targetSet) return;
    setActiveSetIndex(idx);
    setTransformConfig(targetSet.configs || []);
    setDerivedVars(targetSet.derivedVars || []);
    setSetNameInput(targetSet.name);
    if (targetSet.resultData) setResult(targetSet.resultData);
    toast.success(`Switched to "${targetSet.name}"`);
  };

  const [selectedValidationVar, setSelectedValidationVar] = useState("");
  const [validationData, setValidationData] = useState(null);
  const [validationLoading, setValidationLoading] = useState(false);

  useEffect(() => {
    if (transformConfig.length > 0 && (!selectedValidationVar || !transformConfig.some((c) => c["Channel Name"] === selectedValidationVar))) {
      setSelectedValidationVar(transformConfig[0]["Channel Name"]);
    }
  }, [transformConfig, selectedValidationVar]);

  useEffect(() => {
    if (!activeCsv || !selectedValidationVar) return;
    const cfg = transformConfig.find((c) => c["Channel Name"] === selectedValidationVar);
    if (!cfg) return;

    const primaryDate = selTime[0] || "";
    const primaryGeo = selCrossSectional[0] || "";
    const primaryDep = selDependent[0] || "";
    const primaryPop = cfg["Population Column"] || selBaseline[0] || "";

    setValidationLoading(true);
    transformationPreviewSingle({
      csv_data: activeCsv,
      channel: selectedValidationVar,
      geo_column: primaryGeo,
      date_column: primaryDate,
      dependent_variable: primaryDep,
      config: { 
        ...cfg, 
        Lags: cfg["Adstock Horizon"] ?? 2,
        pop_column: cfg["Population Column"] || primaryPop || undefined,
      },
      derived_variables: derivedVars,
      pop_column: cfg["Population Column"] || primaryPop || undefined,
    })
      .then((res) => setValidationData(res))
      .catch(() => {})
      .finally(() => setValidationLoading(false));
  }, [selectedValidationVar, activeCsv, transformConfig, derivedVars, selDependent, selCrossSectional, selTime, selBaseline]);

  const handleProceedToModelling = async () => {
    await saveWorkflowSnapshot("MMM Modelling", "/modelling", {
      transformation: "completed",
      modelling: "in_progress",
    });
    toast.success("Proceeding to Module 6: Modelling.");
    navigate("/modelling");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 5: Data Transformation & Feature Engineering"
        subtitle="Detect outliers, customize adstock decay, adstock horizon, and pure lags dynamically aligned with your dataset's time grain"
        icon="⚙️"
      />

      {!activeCsv && <Alert type="warning">No dataset available. Complete Data Ingestion and Stitching first.</Alert>}

      <Card title="Active ARD Dataset & Time Grain Calibration">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Select ARD Table:
            </label>
            <select
              value={selectedArdId}
              onChange={(e) => setSelectedArdId(e.target.value)}
              className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
            >
              {ardList.length === 0 ? (
                <option value="active">Active Stitched ARD</option>
              ) : (
                ardList.map((ard) => (
                  <option key={ard.id} value={ard.id}>
                    📄 {ard.name} ({ard.grain?.toUpperCase()} Grain • {(ard.rows || 0).toLocaleString()} rows)
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Dataset Time Grain (Detected):
            </label>
            <select
              value={detectedGrain}
              onChange={(e) => {
                const val = e.target.value;
                setDetectedGrain(val);
                setGrainUnit(val === "Daily" ? "Days" : val === "Weekly" ? "Weeks" : val === "Monthly" ? "Months" : "Quarters");
              }}
              className="w-full text-xs font-bold border-2 border-slate-300 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
            >
              <option value="Daily">Daily (Units: Days)</option>
              <option value="Weekly">Weekly (Units: Weeks)</option>
              <option value="Monthly">Monthly (Units: Months)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Select Active Transformation Version:
            </label>
            <select
              value={activeSetIndex}
              onChange={(e) => handleSelectVersion(parseInt(e.target.value))}
              disabled={savedSets.length === 0}
              className="w-full text-xs font-bold border-2 border-slate-300 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none disabled:bg-slate-100"
            >
              {savedSets.length === 0 ? (
                <option value={0}>Draft Transformation Set (Unsaved)</option>
              ) : (
                savedSets.map((s, idx) => (
                  <option key={idx} value={idx}>
                    🏷️ {s.name} ({s.grain || "HCP"} • {s.configs?.length || 0} channels)
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      </Card>

      {/* Step 1: Outliers */}
      <Card title="Step 1: Outlier Diagnostics & Pre-Treatment">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-4">
          <Select label="Select Variable to Inspect:" value={distCol} onChange={setDistCol} options={allCols} />
          <Select
            label="Detection Strategy:"
            value={outlierMethod}
            onChange={setOutlierMethod}
            options={[
              { value: "percentile", label: "Percentile Cutoffs (Bottom & Top Tails)" },
              { value: "zscore", label: "Z-Score (Standard Deviations)" },
            ]}
          />

          {outlierMethod === "percentile" ? (
            <>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Bottom Tail Cutoff %:</label>
                <input
                  type="number"
                  step="0.5"
                  value={lowerPercentile}
                  onChange={(e) => setLowerPercentile(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Top Tail Cutoff %:</label>
                <input
                  type="number"
                  step="0.5"
                  value={upperPercentile}
                  onChange={(e) => setUpperPercentile(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                />
              </div>
            </>
          ) : (
            <div className="sm:col-span-2">
              <label className="block text-xs font-bold text-slate-700 mb-1">Z-Score Threshold (σ):</label>
              <input
                type="number"
                step="0.5"
                value={zScoreThreshold}
                onChange={(e) => setZScoreThreshold(e.target.value)}
                className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mb-4">
          <Btn onClick={() => loadDistAndOutliers()} disabled={distLoading} className="text-xs py-2">
            ↻ Re-Scan Outliers
          </Btn>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="any"
              placeholder="Bucket width"
              value={customBinWidth}
              onChange={(e) => setCustomBinWidth(e.target.value)}
              className="text-xs font-bold border border-slate-200 rounded-xl px-3 py-1.5 bg-white w-36"
            />
            <button
              type="button"
              onClick={handleApplyCustomBucketWidth}
              className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700"
            >
              Apply Width
            </button>
          </div>
        </div>

        {distLoading && <Spinner label="Loading distribution and outlier scans..." />}

        {outlierResult && !distLoading && (
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-50 p-3 rounded-xl text-center border border-slate-200">
                <div className="text-lg font-bold text-slate-800">{outlierResult.outlier_count.toLocaleString()}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase">Outlier Points</div>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl text-center border border-slate-200">
                <div className="text-lg font-bold text-slate-800">{outlierResult.outlier_pct}%</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase">Dataset Proportion</div>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl text-center border border-slate-200">
                <div className="text-lg font-bold text-slate-800">{outlierResult.lower_bound}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase">Lower Cutoff</div>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl text-center border border-slate-200">
                <div className="text-lg font-bold text-slate-800">{outlierResult.upper_bound}</div>
                <div className="text-[10px] text-slate-400 font-bold uppercase">Upper Cutoff</div>
              </div>
            </div>

            {histData && (
              <div className="bg-white p-3 rounded-xl border border-slate-200">
                <span className="text-[11px] font-bold text-slate-600 block mb-2">Raw Distribution Histogram ({distCol})</span>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={histData.counts.map((c, i) => {
                    const edges = histData.bin_edges || [];
                    const midVal = edges[i] !== undefined && edges[i + 1] !== undefined ? (edges[i] + edges[i + 1]) / 2 : i;
                    return {
                      binLabel: histData.bin_labels[i],
                      midpoint: format1Dec(midVal),
                      count: c
                    };
                  })}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="midpoint"
                      tick={{ fontSize: 9 }}
                      angle={-35}
                      textAnchor="end"
                      height={40}
                      interval={Math.max(0, Math.floor(histData.counts.length / 10))}
                    />
                    <YAxis tickFormatter={format1Dec} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v, _n, item) => [`${v} records`, `Range: ${item.payload.binLabel}`]} />
                    <Bar dataKey="count" fill="#001E96" radius={[4, 4, 0, 0]} name="Frequency" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {outlierResult.outlier_count > 0 && (
              <div className="flex items-center gap-3 pt-2">
                <Btn variant="danger" onClick={() => setOutlierModalOpen(true)} className="text-xs">
                  Exclude {outlierResult.outlier_count} Outliers from Dataset
                </Btn>
                <Btn variant="outline" onClick={handleRestoreOriginalDataset} className="text-xs">
                  ↺ Restore Original Dataset
                </Btn>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Step 2: Roles */}
      <Card title="Step 2: Column Categorization & Variable Roles">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          <IngestionCategoryBox title="1. Time Variable" subtitle="Dates, Weeks, Periods" columns={timeCols} selected={selTime} onToggle={(c) => toggleCategorySelection(c, selTime, setSelTime)} colorBadge="bg-blue-100 text-blue-800" />
          <IngestionCategoryBox title="2. Cross-sectional Variable" subtitle="HCP IDs, DMA, Zip Keys" columns={crossCols} selected={selCrossSectional} onToggle={(c) => toggleCategorySelection(c, selCrossSectional, setSelCrossSectional)} colorBadge="bg-purple-100 text-purple-800" />
          <IngestionCategoryBox title="3. Dependent Variable (KPI)" subtitle="Sales, TRx, NRx, Revenue" columns={depCols} selected={selDependent} onToggle={(c) => toggleCategorySelection(c, selDependent, setSelDependent)} colorBadge="bg-red-100 text-red-800" />
          <IngestionCategoryBox title="4. Independent Promotions" subtitle="Calls, Details, Spend, Emails" columns={promoCols} selected={selPromotions} onToggle={(c) => toggleCategorySelection(c, selPromotions, setSelPromotions)} colorBadge="bg-emerald-100 text-emerald-800" />
          <IngestionCategoryBox title="5. Baseline Variables" subtitle="Target Population, Macro" columns={baseCols} selected={selBaseline} onToggle={(c) => toggleCategorySelection(c, selBaseline, setSelBaseline)} colorBadge="bg-amber-100 text-amber-800" />
          <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4 flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block mb-2">Sales KPI Lock Control</span>
              <label className="flex items-start gap-2.5 text-xs font-bold text-slate-700 cursor-pointer p-3 bg-white rounded-xl border border-slate-200">
                <input type="checkbox" checked={!lockDepVar} onChange={(e) => setLockDepVar(!e.target.checked)} className="accent-[#001E96] h-4 w-4 mt-0.5" />
                <div>
                  <span>Unlock Dependent Variable (Sales KPI)</span>
                  <span className="block text-[10px] font-normal text-slate-500 mt-0.5">{lockDepVar ? "🔒 Locked" : "🔓 Unlocked"}</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </Card>

      {/* Step 3: Transformation Table */}
      {transformConfig.length > 0 && (
        <Card title={`Step 3: Transformation Configuration Table (Units: ${grainUnit})`}>
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <p className="text-xs text-slate-500">Configure Adstock Decay, Adstock Horizon, and Pure Lags.</p>
            <Btn variant="outline" onClick={() => setDerivedModalOpen(true)} className="text-xs py-1.5 px-3">
              ➕ Add Derived Channel
            </Btn>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[520px]">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 z-10 font-bold">
                <tr>
                  <th className="px-3 py-3">Channel Name</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3">Normalization</th>
                  <th className="px-3 py-3">Adstock Decay (λ)</th>
                  <th className="px-3 py-3">Adstock Horizon ({grainUnit})</th>
                  <th className="px-3 py-3">Lag Shift ({grainUnit})</th>
                  <th className="px-3 py-3">Saturation Curve</th>
                  <th className="px-3 py-3">Param (k / p)</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transformConfig.map((row) => (
                  <tr key={row["Channel Name"]} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-bold text-slate-800">{row["Channel Name"]}</td>
                    <td className="px-3 py-2"><span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">{row["Grain"] || "Promo"}</span></td>
                    <td className="px-3 py-2">
                      <select value={row["Normalization"] || "none"} onChange={(e) => updateConfigRow(row["Channel Name"], "Normalization", e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white">
                        {NORMALIZATION_OPTIONS.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" step="0.05" min="0.0" max="0.99" value={row["Adstock"] ?? 0.5} onChange={(e) => updateConfigRow(row["Channel Name"], "Adstock", parseFloat(e.target.value) || 0)} className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-xs" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" step="1" min="0" value={row["Adstock Horizon"] ?? 2} onChange={(e) => updateConfigRow(row["Channel Name"], "Adstock Horizon", parseInt(e.target.value, 10) || 0)} className="w-16 border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold text-brand-700" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" step="1" min="0" value={row["Lag"] ?? 0} onChange={(e) => updateConfigRow(row["Channel Name"], "Lag", parseInt(e.target.value, 10) || 0)} className="w-16 border-2 border-slate-200 rounded-lg px-2 py-1 text-xs font-bold" />
                    </td>
                    <td className="px-3 py-2">
                      <select value={row["Saturation Function"] || "None"} onChange={(e) => updateConfigRow(row["Channel Name"], "Saturation Function", e.target.value === "None" ? null : e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white">
                        <option value="None">None (Linear)</option>
                        <option value="Log">Log: ln(1 + k·x)</option>
                        <option value="Power">Power: x^p</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {row["Saturation Function"] === "Power" ? (
                        <input type="number" step="0.05" min="0.1" max="1.0" value={row["Power (k)"] ?? 0.5} onChange={(e) => updateConfigRow(row["Channel Name"], "Power (k)", parseFloat(e.target.value) || 0.5)} className="w-14 border rounded-lg px-2 py-1 text-xs font-mono" />
                      ) : row["Saturation Function"] === "Log" ? (
                        <input type="number" step="0.1" min="0.1" value={row["Log (k)"] ?? 1.0} onChange={(e) => updateConfigRow(row["Channel Name"], "Log (k)", parseFloat(e.target.value) || 1.0)} className="w-14 border rounded-lg px-2 py-1 text-xs font-mono" />
                      ) : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.is_derived && (
                        <button type="button" onClick={() => removeDerivedVariable(row["Channel Name"])} className="text-red-500 font-bold px-1.5 py-0.5">✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-700">Set Name:</label>
              <input type="text" value={setNameInput} onChange={(e) => setSetNameInput(e.target.value)} className="text-xs font-bold border border-slate-200 rounded-lg px-3 py-2 bg-white w-64" />
            </div>
            <Btn onClick={handleApplyTransformations} disabled={loading || !transformConfig.length} className="py-2.5 px-6 font-bold uppercase tracking-wider text-xs">
              {loading ? "Applying…" : "▶ Save & Apply Transformation Set"}
            </Btn>
          </div>
        </Card>
      )}

      {/* Step 4: Correlation */}
      {(preCorrMatrix || transCorrMatrix) && (
        <Card title="Step 4: Pre vs. Post Transformation Correlation Comparison">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div><HeatmapGrid matrix={preCorrMatrix} columns={preCorrColumns} threshold={transCorrThreshold} title="1. Pre-Transformation Matrix (Raw Features)" /></div>
            <div>
              {transCorrMatrix ? (
                <HeatmapGrid matrix={transCorrMatrix.matrix} columns={transCorrMatrix.columns} threshold={transCorrThreshold} title="2. Post-Transformation Matrix (Transformed Features)" />
              ) : (
                <div className="h-[280px] rounded-xl border border-dashed border-slate-200 flex items-center justify-center text-xs text-slate-400">
                  Save & Apply Transformation Set above to view post-transformation matrix.
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Step 5: Restored Dataset Preview Table */}
      {result && (
        <Card title="Step 5: Transformed Dataset Preview">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500">
              Showing first 15 rows of {(result.rows || 0).toLocaleString()} total rows ({result.cols} columns)
            </span>
          </div>
          <DataTable data={result.preview} maxRows={15} />
        </Card>
      )}

      {/* Step 6: Bivariate Scatter Explorer */}
      <Card title="Step 6: Bivariate Relationship Explorer (Pre vs. Post Transformation)">
        <p className="text-xs text-slate-500 mb-4">
          Select an Independent Variable and Target KPI to visually inspect the scatter distribution before and after nonlinear adstock and saturation transformations.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <Select label="Independent Variable (X-Axis):" value={scatterX} onChange={setScatterX} options={activeTransformableList} />
          <Select label="Dependent Variable (Y-Axis):" value={scatterY} onChange={setScatterY} options={selDependent.length ? selDependent : allCols} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <span className="text-xs font-bold text-slate-700 block mb-2 uppercase">
              1. Pre-Transformation (Raw: {scatterX} vs {scatterY})
            </span>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" dataKey="x" tickFormatter={format1Dec} tick={{ fontSize: 10 }} label={{ value: scatterX, position: "insideBottom", offset: -10, fontSize: 10 }} />
                <YAxis type="number" dataKey="y" tickFormatter={format1Dec} tick={{ fontSize: 10 }} label={{ value: scatterY, angle: -90, position: "insideLeft", fontSize: 10 }} />
                <Tooltip formatter={(v) => Number(v)?.toFixed(1)} />
                <Scatter name="Raw Data" data={rawScatterPoints} fill="#64748B" opacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <span className="text-xs font-bold text-brand-700 block mb-2 uppercase">
              2. Post-Transformation ({scatterX}_transformed vs {scatterY})
            </span>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" dataKey="x" tickFormatter={format1Dec} tick={{ fontSize: 10 }} label={{ value: `${scatterX}_transformed`, position: "insideBottom", offset: -10, fontSize: 10 }} />
                <YAxis type="number" dataKey="y" tickFormatter={format1Dec} tick={{ fontSize: 10 }} label={{ value: scatterY, angle: -90, position: "insideLeft", fontSize: 10 }} />
                <Tooltip formatter={(v) => Number(v)?.toFixed(1)} />
                <Scatter name="Transformed Data" data={transScatterPoints} fill="#001E96" opacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      {/* Step 7: Single Channel Validation */}
      {transformConfig.length > 0 && validationData && (
        <Card title="Step 7: Single Channel Validation & Response Shape">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white p-3 rounded-2xl border border-slate-200">
              <span className="text-[11px] font-bold text-slate-600 block mb-1">Before: {validationData.channel} vs {selDependent[0]}</span>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={validationData.raw_curve?.binned_curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="spend_x" tickFormatter={format1Dec} tick={{ fontSize: 9 }} />
                  <YAxis dataKey="response_y" tickFormatter={format1Dec} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => [format1Dec(v), "Raw Response"]} />
                  <Line type="linear" dataKey="response_y" stroke="#94A3B8" strokeWidth={2.5} dot={{ r: 3 }} name="Raw Response" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white p-3 rounded-2xl border border-slate-200">
              <span className="text-[11px] font-bold text-brand-700 block mb-1">After: {validationData.channel} (Transformed) vs {selDependent[0]}</span>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={validationData.trans_curve?.binned_curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="spend_x" tickFormatter={format1Dec} tick={{ fontSize: 9 }} />
                  <YAxis dataKey="response_y" tickFormatter={format1Dec} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => [format1Dec(v), "Transformed Response"]} />
                  <Line type="linear" dataKey="response_y" stroke="#001E96" strokeWidth={2.5} dot={{ r: 3 }} name="Transformed Response" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>
      )}

      {/* Bottom Bar */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
        <Btn onClick={handleApplyTransformations} disabled={loading || !transformConfig.length} className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-brand-600 hover:bg-brand-700">
          {loading ? "Saving…" : "💾 Save Transformation Set"}
        </Btn>
        <Btn onClick={handleProceedToModelling} disabled={!result && savedSets.length === 0} className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-[#1ABC9C] hover:bg-[#16a085]">
          Proceed to Modeling →
        </Btn>
      </div>

      {/* Outlier Modal */}
      {outlierModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Confirm Outlier Exclusion</h3>
            <p className="text-xs text-slate-600">Excluding <strong>{outlierResult?.outlier_count} rows</strong> with extreme values in <code>{distCol}</code>.</p>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setOutlierModalOpen(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={handleConfirmRemoveOutliers}>Confirm & Exclude Rows</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Derived Variable Modal */}
      {derivedModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-black text-slate-800">Create Arithmetic Derived Channel</h3>
            <input type="text" placeholder="e.g. TOTAL_PERSONAL_PROMO" value={newDerivedName} onChange={(e) => setNewDerivedName(e.target.value)} className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white" />
            <select value={derivedOperator} onChange={(e) => setDerivedOperator(e.target.value)} className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white">
              <option value="+">Addition (+)</option>
              <option value="-">Subtraction (-)</option>
              <option value="*">Multiplication (*)</option>
              <option value="/">Division (/)</option>
            </select>
            <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 border border-slate-200 rounded-xl">
              {allCols.map((v) => {
                const isSel = selectedDerivedVars.includes(v);
                return (
                  <button key={v} type="button" onClick={() => setSelectedDerivedVars(isSel ? selectedDerivedVars.filter((x) => x !== v) : [...selectedDerivedVars, v])} className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all ${isSel ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                    {v}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="secondary" onClick={() => setDerivedModalOpen(false)}>Cancel</Btn>
              <Btn onClick={handleAddDerivedVariable}>Save & Add to Table</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
