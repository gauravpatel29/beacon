import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar
} from "recharts";
import {
  applyTransformations,
  transformationAutoSelect,
  transformationPreviewSingle,
  transformationCorrelation,
  v2ListArds,
  v2GetCsv,
  problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable } from "../components/UI";

const HORIZON_OPTIONS = [
  { value: 0, label: "0 weeks (Immediate / No Lag)" },
  { value: 1, label: "1 week" },
  { value: 2, label: "2 weeks" },
  { value: 3, label: "3 weeks" },
  { value: 4, label: "4 weeks (1 month)" },
  { value: 6, label: "6 weeks" },
  { value: 8, label: "8 weeks (2 months)" },
  { value: 12, label: "12 weeks (1 quarter)" },
];

const NORMALIZATION_OPTIONS = [
  { value: "none", label: "None (Raw Volume)" },
  { value: "population", label: "Population Based (÷ Universe)" },
  { value: "minmax", label: "Min-Max Scaling [0, 1]" },
  { value: "zscore", label: "Z-Score (Standardized σ)" },
  { value: "iqr", label: "Robust / IQR Scaling" },
];

// ─── Interactive Multi-Select Column Box Component ──────────────────────────
function ColumnSelectBox({ label, options, value = [], onChange, isDanger = false, helperText = "" }) {
  const selectedList = Array.isArray(value) ? value : (value ? [value] : []);

  const toggle = (opt) => {
    if (selectedList.includes(opt)) {
      onChange(selectedList.filter((x) => x !== opt));
    } else {
      onChange([...selectedList, opt]);
    }
  };

  return (
    <div className="flex flex-col space-y-1.5">
      <div className="flex items-center justify-between">
        <label className={`text-xs font-bold uppercase tracking-wider ${isDanger ? "text-red-700" : "text-slate-700"}`}>
          {label} {selectedList.length > 0 && <span className="font-normal opacity-75">({selectedList.length} selected)</span>}
        </label>
        {selectedList.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[10px] text-slate-400 hover:text-red-500 font-semibold transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div className={`p-2.5 rounded-xl border bg-white max-h-32 min-h-[5rem] overflow-y-auto flex flex-wrap gap-1.5 transition-all ${
        isDanger 
          ? "border-red-300 bg-red-50/20 focus-within:ring-2 focus-within:ring-red-400" 
          : "border-slate-200 focus-within:ring-2 focus-within:ring-brand-500"
      }`}>
        {options.length === 0 ? (
          <span className="text-[11px] text-slate-400 italic p-1">No columns available</span>
        ) : (
          options.map((opt) => {
            const isSelected = selectedList.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 border ${
                  isSelected
                    ? (isDanger 
                        ? "bg-red-600 text-white border-red-600 shadow-sm" 
                        : "bg-[#001E96] text-white border-[#001E96] shadow-sm")
                    : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                }`}
              >
                <span>{isSelected ? "✓" : "+"}</span>
                <span>{opt}</span>
              </button>
            );
          })
        )}
      </div>
      {helperText && <span className="text-[10px] text-red-600 font-semibold">{helperText}</span>}
    </div>
  );
}

function TransformedHeatmap({ matrix, columns, threshold = 0.7 }) {
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
    <div className="overflow-auto max-h-[440px] rounded-xl border border-slate-200">
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
                    title={`${row} vs ${col}: ${Number(val).toFixed(3)}`}
                    className="w-14 h-10 text-center font-mono transition-all"
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

export default function DataTransformation() {
  const navigate = useNavigate();
  const { state, setField, saveWorkflowSnapshot } = useAppState();
  const workflowId = state.workflowId;

  // ─── Header: Active ARD & Version Management ──────────────────────────────
  const [ardList, setArdList] = useState(() => state.savedArds || []);
  const [selectedArdId, setSelectedArdId] = useState(() => state.activeDataset || "active");
  const [activeCsv, setActiveCsv] = useState(() => state.granularCsvData || state.filteredCsvData || "");
  const [savedSets, setSavedSets] = useState(() => state.savedTransformationSets || []);
  const [activeSetIndex, setActiveSetIndex] = useState(0);

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

  // ─── Step 1: Key Columns State (Multi-Select Enabled) ─────────────────────
  const [allCols, setAllCols] = useState([]);
  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [zipCol, setZipCol] = useState(state.zipColumn || "");
  const [dmaCol, setDmaCol] = useState(state.dmaColumn || "");
  const [depVar, setDepVar] = useState(state.dependentVariable || "");
  const [popCol, setPopCol] = useState("");
  const [addCarryover, setAddCarryover] = useState(state.addCarryover || false);

  useEffect(() => {
    if (!activeCsv) return;
    try {
      const firstLine = activeCsv.split("\n")[0];
      const cols = firstLine.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setAllCols(cols);

      if (!dateCol || !cols.includes(Array.isArray(dateCol) ? dateCol[0] : dateCol)) {
        const d = cols.find((c) => /date|week|month|time/i.test(c)) || cols[0] || "";
        setDateCol(d ? [d] : []);
      }
      if (!geoCol || !cols.includes(Array.isArray(geoCol) ? geoCol[0] : geoCol)) {
        const g = cols.find((c) => /npi|geo|id|dma/i.test(c)) || cols[1] || cols[0] || "";
        setGeoCol(g ? [g] : []);
      }
      if (!depVar || !cols.includes(Array.isArray(depVar) ? depVar[0] : depVar)) {
        const s = cols.find((c) => /sale|trx|nrx|kpi|rev/i.test(c)) || "";
        setDepVar(s ? [s] : []);
      }
      if (!popCol || !cols.includes(Array.isArray(popCol) ? popCol[0] : popCol)) {
        const p = cols.find((c) => /pop|universe|target/i.test(c)) || "";
        if (p) setPopCol([p]);
      }
    } catch (e) {}
  }, [activeCsv]);

  // ─── Step 2: Variable Selection Grid (Sales Strictly Excluded) ────────────
  const classifiedVariables = useMemo(() => {
    const rawKeys = [dateCol, geoCol, zipCol, dmaCol].flatMap((k) => (Array.isArray(k) ? k : [k])).filter(Boolean);
    const keySet = new Set(rawKeys);
    const depVarList = Array.isArray(depVar) ? depVar : (depVar ? [depVar] : []);
    const depSet = new Set(depVarList);

    return allCols.map((c) => {
      const isSales = depSet.has(c);
      const isKey = keySet.has(c) || /id$/i.test(c);
      let grain = "HCP";
      if (/dma|tv|radio|pop|print|national|media/i.test(c)) {
        grain = "DMA";
      }

      return {
        name: c,
        grain,
        type: "Numeric",
        isSales,
        isKey,
        isTransformable: !isSales && !isKey,
      };
    });
  }, [allCols, dateCol, geoCol, zipCol, dmaCol, depVar]);

  const transformableCandidates = useMemo(() => {
    return classifiedVariables.filter((v) => v.isTransformable).map((v) => v.name);
  }, [classifiedVariables]);

  const [selectedVariables, setSelectedVariables] = useState(() => transformableCandidates);

  useEffect(() => {
    setSelectedVariables(transformableCandidates);
  }, [transformableCandidates]);

  const toggleVariableSelection = (varName) => {
    setSelectedVariables((prev) =>
      prev.includes(varName) ? prev.filter((v) => v !== varName) : [...prev, varName]
    );
  };

  const selectAllVariables = () => {
    setSelectedVariables(transformableCandidates);
  };

  const deselectAllVariables = () => {
    setSelectedVariables([]);
  };

  // ─── Step 3: Transformation Configuration Table (Standard + Derived) ──────
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

      const standardRows = selectedVariables.map((v) => {
        if (existingMap.has(v)) return existingMap.get(v);
        const meta = classifiedVariables.find((x) => x.name === v);
        return {
          "Channel Name": v,
          "Grain": meta?.grain || "HCP",
          "Normalization": "none",
          "Adstock": 0.5,
          "Lags": 2, // Horizon in weeks
          "Saturation Function": "Log",
          "Power (k)": 0.5,
          "Log (k)": 1.0,
          "auto_selected": false,
          "is_derived": false,
        };
      });

      const derivedRows = derivedVars.map((dv) => {
        if (existingMap.has(dv.name)) return existingMap.get(dv.name);
        return {
          "Channel Name": dv.name,
          "Grain": "Derived",
          "Normalization": "none",
          "Adstock": 0.5,
          "Lags": 2,
          "Saturation Function": "Log",
          "Power (k)": 0.5,
          "Log (k)": 1.0,
          "auto_selected": false,
          "is_derived": true,
          "formula": dv.variables.join(` ${dv.operator} `),
        };
      });

      return [...standardRows, ...derivedRows];
    });
  }, [selectedVariables, classifiedVariables, derivedVars]);

  const updateConfigRow = (channelName, field, value) => {
    setTransformConfig((prev) =>
      prev.map((row) => {
        if (row["Channel Name"] !== channelName) return row;
        return { ...row, [field]: value, auto_selected: false };
      })
    );
  };

  const handleAddDerivedVariable = () => {
    if (!newDerivedName.trim()) return toast.error("Provide a name for the derived variable.");
    if (selectedDerivedVars.length < 2) return toast.error("Select at least 2 source variables.");

    const derivedName = newDerivedName.trim().toUpperCase();
    if (allCols.includes(derivedName) || derivedVars.some((d) => d.name === derivedName)) {
      return toast.error(`Variable "${derivedName}" already exists.`);
    }

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
    toast.success(`Derived channel "${derivedName}" added directly to Transformation Table!`);
  };

  const removeDerivedVariable = (channelName) => {
    setDerivedVars((prev) => prev.filter((d) => d.name !== channelName));
    setTransformConfig((prev) => prev.filter((r) => r["Channel Name"] !== channelName));
    toast.success(`Removed derived channel "${channelName}"`);
  };

  // ─── Step 4: Auto-Selection Engine ────────────────────────────────────────
  const [autoSelecting, setAutoSelecting] = useState(false);

  const handleAutoSelectAll = async () => {
    if (!activeCsv) return toast.error("No dataset loaded");
    const primaryDep = Array.isArray(depVar) ? depVar[0] : depVar;
    if (!primaryDep) return toast.error("Set Dependent Variable (Sales KPI) first");
    if (!transformConfig.length) return toast.error("No channels available in table to auto-tune");

    setAutoSelecting(true);
    try {
      const allTableChannels = transformConfig.map((c) => c["Channel Name"]);
      const res = await transformationAutoSelect({
        csv_data: activeCsv,
        geo_column: Array.isArray(geoCol) ? geoCol[0] : geoCol,
        date_column: Array.isArray(dateCol) ? dateCol[0] : dateCol,
        dependent_variable: primaryDep,
        channels: allTableChannels,
        derived_variables: derivedVars,
        pop_column: Array.isArray(popCol) ? popCol[0] : popCol || undefined,
      });

      const recs = res.recommendations || [];
      const recsMap = new Map(recs.map((r) => [r["Channel Name"], r]));

      setTransformConfig((prev) =>
        prev.map((row) => {
          const r = recsMap.get(row["Channel Name"]);
          return r ? { ...row, ...r, auto_selected: true } : row;
        })
      );
      toast.success(`Auto-tuned parameters for ${recs.length} channel(s)!`);
    } catch (err) {
      toast.error(problemMessage(err, "Auto-selection failed"));
    } finally {
      setAutoSelecting(false);
    }
  };

  const handleAutoSelectSingle = async (channelName) => {
    const primaryDep = Array.isArray(depVar) ? depVar[0] : depVar;
    if (!activeCsv || !primaryDep) return toast.error("Set Target Sales KPI first");
    try {
      const res = await transformationAutoSelect({
        csv_data: activeCsv,
        geo_column: Array.isArray(geoCol) ? geoCol[0] : geoCol,
        date_column: Array.isArray(dateCol) ? dateCol[0] : dateCol,
        dependent_variable: primaryDep,
        channels: [channelName],
        derived_variables: derivedVars,
        pop_column: Array.isArray(popCol) ? popCol[0] : popCol || undefined,
      });
      if (res.recommendations && res.recommendations.length > 0) {
        const rec = res.recommendations[0];
        setTransformConfig((prev) =>
          prev.map((row) => (row["Channel Name"] === channelName ? { ...row, ...rec, auto_selected: true } : row))
        );
        toast.success(`Auto-tuned ${channelName}! (Fit Score: ${rec.fit_score})`);
      }
    } catch (err) {
      toast.error("Auto-tune failed");
    }
  };

  // ─── Step 5: Execution & Versioning ───────────────────────────────────────
  const [setNameInput, setSetNameInput] = useState("Q4 National Launch v1");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const [transCorrMatrix, setTransCorrMatrix] = useState(null);
  const [transCorrThreshold, setTransCorrThreshold] = useState(0.7);

  const handleApplyTransformations = async () => {
    if (!activeCsv) return toast.error("No dataset available");
    const primaryDep = Array.isArray(depVar) ? depVar[0] : depVar;
    const primaryDate = Array.isArray(dateCol) ? dateCol[0] : dateCol;
    const primaryGeo = Array.isArray(geoCol) ? geoCol[0] : geoCol;
    const primaryPop = Array.isArray(popCol) ? popCol[0] : popCol;

    if (!primaryDate || !primaryGeo || !primaryDep) {
      return toast.error("Set Date, Geo, and Dependent Variable columns");
    }
    if (!transformConfig.length) return toast.error("Configure at least one channel in table");

    setLoading(true);
    try {
      const data = await applyTransformations({
        csv_data: activeCsv,
        geo_column: primaryGeo,
        date_column: primaryDate,
        dependent_variable: primaryDep,
        add_carryover: addCarryover,
        transformations: transformConfig,
        derived_variables: derivedVars,
        pop_column: primaryPop || undefined,
      });

      setResult(data);
      setField("transformedCsvData", data.csv_data);
      setField("geoColumn", primaryGeo);
      setField("dateColumn", primaryDate);
      setField("dependentVariable", primaryDep);
      setField("zipColumn", Array.isArray(zipCol) ? zipCol[0] : zipCol);
      setField("dmaColumn", Array.isArray(dmaCol) ? dmaCol[0] : dmaCol);
      setField("transformationConfig", transformConfig);
      setField("addCarryover", addCarryover);

      // Save versioned transformation set
      const newVersion = {
        name: setNameInput.trim() || `Transform Set v${savedSets.length + 1}`,
        createdAt: new Date().toISOString(),
        configs: [...transformConfig],
        derivedVars: [...derivedVars],
        columnsCount: data.cols,
        resultData: data,
      };

      const updatedSets = [newVersion, ...savedSets];
      setSavedSets(updatedSets);
      setActiveSetIndex(0);
      setField("savedTransformationSets", updatedSets);

      // Fetch transformed correlation matrix
      if (data.transformed_channels && data.transformed_channels.length >= 2) {
        transformationCorrelation({
          csv_data: data.csv_data,
          columns: data.transformed_channels,
          threshold: transCorrThreshold,
        })
          .then((cRes) => setTransCorrMatrix(cRes))
          .catch(() => {});
      }

      toast.success(`Transformation Set "${newVersion.name}" saved & applied!`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Transformation failed");
    } finally {
      setLoading(false);
    }
  };

  // Switch versions using dropdown
  const handleSelectVersion = (idx) => {
    const targetSet = savedSets[idx];
    if (!targetSet) return;
    setActiveSetIndex(idx);
    setTransformConfig(targetSet.configs || []);
    setDerivedVars(targetSet.derivedVars || []);
    setSetNameInput(targetSet.name);
    if (targetSet.resultData) {
      setResult(targetSet.resultData);
    }
    toast.success(`Switched to "${targetSet.name}"`);
  };

  // ─── Preview & Validation Section State ───────────────────────────────────
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

    const primaryDep = Array.isArray(depVar) ? depVar[0] : depVar;
    const primaryDate = Array.isArray(dateCol) ? dateCol[0] : dateCol;
    const primaryGeo = Array.isArray(geoCol) ? geoCol[0] : geoCol;
    const primaryPop = Array.isArray(popCol) ? popCol[0] : popCol;

    setValidationLoading(true);
    transformationPreviewSingle({
      csv_data: activeCsv,
      channel: selectedValidationVar,
      geo_column: primaryGeo,
      date_column: primaryDate,
      dependent_variable: primaryDep,
      config: cfg,
      derived_variables: derivedVars,
      pop_column: primaryPop || undefined,
    })
      .then((res) => {
        setValidationData(res);
      })
      .catch((err) => {
        console.error("Preview failed:", err);
      })
      .finally(() => setValidationLoading(false));
  }, [selectedValidationVar, activeCsv, transformConfig, derivedVars, depVar, geoCol, dateCol, popCol]);

  const handleProceedToModelling = async () => {
    await saveWorkflowSnapshot("MMM Modelling", "/modelling", {
      transformation: "completed",
      modelling: "in_progress",
    });
    toast.success("Transformation layer saved! Proceeding to Modelling.");
    navigate("/modelling");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 5: Data Transformation & Feature Engineering"
        subtitle="Apply Normalization, Adstock decay, Horizon smoothing, Saturation curves (Log/Power), and manage versioned transformation sets"
        icon="⚙️"
      />

      {!activeCsv && <Alert type="warning">No dataset available. Complete Data Ingestion and Stitching first.</Alert>}

      {/* ─── Header: Active ARD & Version Selector ────────────────────────── */}
      <Card title="Active ARD Dataset & Transformation Set Version">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    📄 {ard.name} ({ard.grain?.toUpperCase()} Grain • {ard.rows?.toLocaleString()} rows • {ard.cols} cols)
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Select Active Transformation Set / Version:
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
                    🏷️ {s.name} ({s.configs?.length || 0} channels • {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      </Card>

      {/* ─── Step 1: Key Columns (Interactive Multi-Select Boxes) ──────────── */}
      <Card title="Step 1: Key Columns & Model Target">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ColumnSelectBox
            label="Date Column(s)"
            options={allCols}
            value={dateCol}
            onChange={setDateCol}
          />

          <ColumnSelectBox
            label="Geo Column(s) (HCP / DMA Keys)"
            options={allCols}
            value={geoCol}
            onChange={setGeoCol}
          />

          <ColumnSelectBox
            label="Dependent Variable(s) (Sales KPI)"
            options={allCols}
            value={depVar}
            onChange={setDepVar}
            isDanger={true}
            helperText="* Selected sales KPI(s) are strictly locked from transformation."
          />

          <ColumnSelectBox
            label="ZIP Column(s) (Optional)"
            options={allCols}
            value={zipCol}
            onChange={setZipCol}
          />

          <ColumnSelectBox
            label="DMA Column(s) (Optional)"
            options={allCols}
            value={dmaCol}
            onChange={setDmaCol}
          />

          <ColumnSelectBox
            label="Population / Universe Column(s)"
            options={allCols}
            value={popCol}
            onChange={setPopCol}
          />
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={addCarryover}
              onChange={(e) => setAddCarryover(e.target.checked)}
              className="rounded text-brand-600"
            />
            <span>Create Lagged Dependent Variable as <code>Carryover</code> (Lag 1)</span>
          </label>
          <span className="text-xs text-slate-400 font-mono">
            {transformableCandidates.length} channel(s) eligible for transformation
          </span>
        </div>
      </Card>

      {/* ─── Step 2: Variable Selection Grid ──────────────────────────────── */}
      <Card title="Step 2: Variable Selection Grid">
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <p className="text-xs text-slate-500">
            Check the marketing variables you want to transform. Target KPI(s) are visible but locked to prevent transformation.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAllVariables}
              className="text-xs font-bold text-brand-600 hover:underline"
            >
              Select All Eligible
            </button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              onClick={deselectAllVariables}
              className="text-xs font-bold text-slate-400 hover:text-slate-600"
            >
              Deselect All
            </button>
            <Btn
              variant="outline"
              onClick={() => setDerivedModalOpen(true)}
              className="text-xs py-1 px-3 ml-2"
            >
              ➕ Add Derived Variable
            </Btn>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-64">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 font-bold z-10">
              <tr>
                <th className="px-4 py-2.5 w-12 text-center">Select</th>
                <th className="px-4 py-2.5">Variable Name</th>
                <th className="px-4 py-2.5">Grain</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Transformation Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {classifiedVariables.map((v) => {
                const isChecked = selectedVariables.includes(v.name);

                return (
                  <tr
                    key={v.name}
                    className={v.isSales ? "bg-red-50/40" : isChecked ? "bg-brand-50/20" : "hover:bg-slate-50"}
                  >
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isChecked && !v.isSales && !v.isKey}
                        disabled={v.isSales || v.isKey}
                        onChange={() => toggleVariableSelection(v.name)}
                        className="accent-[#001E96] h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="px-4 py-2 font-bold text-slate-800">
                      {v.name}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        v.grain === "HCP" ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"
                      }`}>
                        {v.grain}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-500 font-mono">{v.type}</td>
                    <td className="px-4 py-2">
                      {v.isSales ? (
                        <span className="text-red-700 font-bold text-[11px] flex items-center gap-1">
                          🔒 Sales (Dependent Variable) — <em>Transform Disabled</em>
                        </span>
                      ) : v.isKey ? (
                        <span className="text-slate-400 text-[11px]">ID / Group Key (Preserved)</span>
                      ) : isChecked ? (
                        <span className="text-emerald-600 font-bold text-[11px]">✓ Included in Step 3</span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">Excluded</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ─── Step 3: Transformation Configuration Table (Standard + Derived) ── */}
      {transformConfig.length > 0 && (
        <Card title="Step 3: Transformation Configuration Table">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <p className="text-xs text-slate-500">
              Configure Normalization, Adstock Decay, Horizon smoothing (weeks), and Functional Saturation (Log/Power) per channel.
            </p>

            <div className="flex gap-2">
              <Btn
                onClick={handleAutoSelectAll}
                disabled={autoSelecting}
                className="text-xs py-2 bg-[#1ABC9C] hover:bg-[#16a085]"
              >
                {autoSelecting ? "Evaluating Fit Grids…" : "🚀 Auto-Select All Variables"}
              </Btn>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px]">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 z-10 font-bold">
                <tr>
                  <th className="px-3 py-3">Variable</th>
                  <th className="px-3 py-3">Grain</th>
                  <th className="px-3 py-3">Normalization</th>
                  <th className="px-3 py-3">Adstock (Decay)</th>
                  <th className="px-3 py-3">Horizon (Time Horizon)</th>
                  <th className="px-3 py-3">Saturation Curve</th>
                  <th className="px-3 py-3">Param (k / p)</th>
                  <th className="px-3 py-3">Source</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transformConfig.map((row) => {
                  const isPower = row["Saturation Function"] === "Power";
                  const isLog = row["Saturation Function"] === "Log";
                  const isDerived = row.is_derived;

                  return (
                    <tr key={row["Channel Name"]} className={isDerived ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-slate-50"}>
                      <td className="px-3 py-2.5 font-bold text-slate-800 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {isDerived && <span className="text-amber-600 font-bold" title="Arithmetic Derived Channel">⚡</span>}
                          <span>{row["Channel Name"]}</span>
                        </div>
                        {isDerived && row.formula && (
                          <span className="block text-[10px] text-amber-700 font-mono font-normal">
                            = {row.formula}
                          </span>
                        )}
                      </td>

                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          isDerived
                            ? "bg-amber-100 text-amber-800 border border-amber-200"
                            : row["Grain"] === "HCP"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-purple-100 text-purple-800"
                        }`}>
                          {row["Grain"] || "HCP"}
                        </span>
                      </td>

                      {/* Normalization Dropdown */}
                      <td className="px-3 py-2">
                        <select
                          value={row["Normalization"] || "none"}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Normalization", e.target.value)}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none"
                        >
                          {NORMALIZATION_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Adstock Decay */}
                      <td className="px-3 py-2">
                        <select
                          value={row["Adstock"] ?? 0.5}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Adstock", parseFloat(e.target.value))}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white font-mono"
                        >
                          {[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((d) => (
                            <option key={d} value={d}>
                              {d === 0 ? "0.0 (No decay)" : d.toFixed(1)}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Time Horizon (weeks) */}
                      <td className="px-3 py-2">
                        <select
                          value={row["Lags"] ?? 1}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Lags", parseInt(e.target.value))}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white font-semibold"
                        >
                          {HORIZON_OPTIONS.map((h) => (
                            <option key={h.value} value={h.value}>
                              {h.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Saturation Function */}
                      <td className="px-3 py-2">
                        <select
                          value={row["Saturation Function"] || "None"}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Saturation Function", e.target.value === "None" ? null : e.target.value)}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white font-semibold"
                        >
                          <option value="None">None (Linear)</option>
                          <option value="Log">Log: ln(1 + k·x)</option>
                          <option value="Power">Power: x^p</option>
                        </select>
                      </td>

                      {/* Parameter k / p */}
                      <td className="px-3 py-2">
                        {isPower ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-400">p:</span>
                            <input
                              type="number"
                              step="0.05"
                              min="0.1"
                              max="1.0"
                              value={row["Power (k)"] ?? 0.5}
                              onChange={(e) => updateConfigRow(row["Channel Name"], "Power (k)", parseFloat(e.target.value))}
                              className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                            />
                          </div>
                        ) : isLog ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-400">k:</span>
                            <input
                              type="number"
                              step="0.1"
                              min="0.1"
                              max="10.0"
                              value={row["Log (k)"] ?? 1.0}
                              onChange={(e) => updateConfigRow(row["Channel Name"], "Log (k)", parseFloat(e.target.value))}
                              className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                            />
                          </div>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>

                      {/* Source Badge (AUTO vs MANUAL) */}
                      <td className="px-3 py-2">
                        {row.auto_selected ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800">
                            AUTO
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">
                            MANUAL
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleAutoSelectSingle(row["Channel Name"])}
                            className="px-2.5 py-1 rounded bg-brand-50 hover:bg-brand-100 text-[11px] font-bold text-brand-700"
                            title="Auto-select single variable"
                          >
                            ⚡ Auto
                          </button>
                          {isDerived && (
                            <button
                              type="button"
                              onClick={() => removeDerivedVariable(row["Channel Name"])}
                              className="px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-[11px] font-bold text-red-600"
                              title="Delete derived variable"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Save & Apply Set Controls */}
          <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-700">Transformation Set Name:</label>
              <input
                type="text"
                value={setNameInput}
                onChange={(e) => setSetNameInput(e.target.value)}
                className="text-xs font-bold border border-slate-200 rounded-lg px-3 py-2 bg-white w-64"
              />
            </div>

            <Btn
              onClick={handleApplyTransformations}
              disabled={loading || !transformConfig.length}
              className="py-2.5 px-6 font-bold uppercase tracking-wider text-xs"
            >
              {loading ? "Applying Transformations…" : "▶ Save & Apply Transformation Set"}
            </Btn>
          </div>
        </Card>
      )}

      {loading && <Spinner label="Applying transformations and computing diagnostics…" />}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ─── 1st: POST-TRANSFORMATION MULTICOLLINEARITY MATRIX ───────────────── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {result && (
        <Card title="1. Post-Transformation Multicollinearity Matrix">
          <p className="text-xs text-slate-500 mb-4">
            Verify correlation across transformed channels to ensure adstock smoothing and saturation transforms have not introduced severe collinearity before modeling.
          </p>

          <div className="flex items-center justify-between mb-4 flex-wrap gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Highlight Threshold (|r| ≥ {transCorrThreshold}):
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={transCorrThreshold}
                onChange={(e) => setTransCorrThreshold(parseFloat(e.target.value))}
                className="w-56"
              />
            </div>
            <span className="text-xs font-bold text-brand-700 bg-brand-50 px-3 py-1.5 rounded-xl border border-brand-200">
              {result.transformed_channels?.length || 0} Features Ready for Regression
            </span>
          </div>

          {transCorrMatrix && (
            <TransformedHeatmap
              matrix={transCorrMatrix.matrix}
              columns={transCorrMatrix.columns}
              threshold={transCorrThreshold}
            />
          )}

          {transCorrMatrix?.pairs?.length > 0 && (
            <div className="mt-4">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                High Collinearity Pairs (|r| ≥ {transCorrThreshold}):
              </span>
              <DataTable
                data={transCorrMatrix.pairs.map((p) => ({
                  "Transformed Tactic 1": p.feature1,
                  "Transformed Tactic 2": p.feature2,
                  "Correlation (r)": p.corr,
                }))}
              />
            </div>
          )}
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ─── 2nd: TRANSFORMED DATASET PREVIEW (FIRST 10 ROWS ONLY) ──────────── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {result && (
        <Card title="2. Transformed Dataset Preview">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500">
              Showing first 10 rows of {result.rows?.toLocaleString()} total rows ({result.cols} columns)
            </span>
          </div>
          <DataTable data={result.preview} maxRows={10} />
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ─── 3rd: DEDICATED PREVIEW & VALIDATION SECTION ──────────────────────── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {transformConfig.length > 0 && (
        <Card title="3. Preview & Validation">
          <p className="text-xs text-slate-500 mb-5">
            Review the empirical impact of transformations, validate distribution compression, and inspect response shape against KPI before saving.
          </p>

          {/* ─── Transformation Impact Summary Cards ───────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-brand-50 p-3 rounded-xl text-center border border-brand-100">
              <div className="text-xl font-bold text-brand-700">{transformConfig.length}</div>
              <div className="text-[10px] text-brand-600 font-bold uppercase mt-0.5">Variables Transformed</div>
            </div>
            <div className="bg-emerald-50 p-3 rounded-xl text-center border border-emerald-100">
              <div className="text-xl font-bold text-emerald-700">
                {transformConfig.filter((c) => c.auto_selected).length}
              </div>
              <div className="text-[10px] text-emerald-600 font-bold uppercase mt-0.5">Auto Selected</div>
            </div>
            <div className="bg-slate-50 p-3 rounded-xl text-center border border-slate-200">
              <div className="text-xl font-bold text-slate-700">
                {transformConfig.filter((c) => !c.auto_selected).length}
              </div>
              <div className="text-[10px] text-slate-500 font-bold uppercase mt-0.5">Manually Configured</div>
            </div>
            <div className="bg-purple-50 p-3 rounded-xl text-center border border-purple-100">
              <div className="text-xl font-bold text-purple-700">{derivedVars.length}</div>
              <div className="text-[10px] text-purple-600 font-bold uppercase mt-0.5">Derived Variables</div>
            </div>
            <div className="bg-amber-50 p-3 rounded-xl text-center border border-amber-100">
              <div className="text-xl font-bold text-amber-700">{transCorrMatrix?.pairs?.length || 0}</div>
              <div className="text-[10px] text-amber-600 font-bold uppercase mt-0.5">High Corr Pairs</div>
            </div>
            <div className="bg-slate-900 text-white p-3 rounded-xl text-center shadow-sm">
              <div className="text-sm font-bold truncate">{setNameInput || "Set v1"}</div>
              <div className="text-[10px] text-slate-300 uppercase mt-0.5 font-mono">Active Version</div>
            </div>
          </div>

          {/* ─── Variable Selector Dropdown ────────────────────────────────── */}
          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 mb-6 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-[280px]">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Select Variable to Inspect:
              </label>
              <select
                value={selectedValidationVar}
                onChange={(e) => setSelectedValidationVar(e.target.value)}
                className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
              >
                {transformConfig.map((c) => (
                  <option key={c["Channel Name"]} value={c["Channel Name"]}>
                    {c["Channel Name"]} ({c["Grain"] || "HCP"} • {c["Normalization"]} • {c["Saturation Function"] || "Linear"})
                  </option>
                ))}
              </select>
            </div>
            {validationLoading && <span className="text-xs text-brand-600 font-semibold animate-pulse">Calculating metrics…</span>}
          </div>

          {validationLoading && <Spinner label="Loading before/after validation metrics..." />}

          {/* Validation Metrics Display */}
          {validationData && !validationLoading && (
            <div className="space-y-6">
              {/* Row 1: Transformation Details & Summary Statistics */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-5 bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-3">
                  <span className="text-xs font-bold text-brand-800 uppercase tracking-wider block border-b border-slate-200 pb-2">
                    Transformation Details: {validationData.channel}
                  </span>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Normalization</span>
                      <strong className="text-slate-800">{validationData.config?.Normalization || "None"}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Adstock Decay (α)</span>
                      <strong className="text-slate-800">{validationData.config?.Adstock ?? 0.5}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Adstock Horizon</span>
                      <strong className="text-slate-800">{validationData.config?.Lags ?? 2} weeks</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Saturation Transform</span>
                      <strong className="text-slate-800">{validationData.config?.["Saturation Function"] || "Linear"}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Param (k / p)</span>
                      <strong className="text-slate-800">
                        {validationData.config?.["Saturation Function"] === "Power"
                          ? `p = ${validationData.config?.["Power (k)"] ?? 0.5}`
                          : validationData.config?.["Saturation Function"] === "Log"
                          ? `k = ${validationData.config?.["Log (k)"] ?? 1.0}`
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Configuration Source</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        validationData.config?.auto_selected ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"
                      }`}>
                        {validationData.config?.auto_selected ? "Auto Selected" : "Manual"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-7">
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                    Before vs. After Summary Statistics ({validationData.channel}):
                  </span>
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-xs text-left bg-white">
                      <thead className="bg-slate-50 border-b border-slate-200 font-bold text-slate-700">
                        <tr>
                          <th className="px-3 py-2.5">Metric</th>
                          <th className="px-3 py-2.5">Original</th>
                          <th className="px-3 py-2.5">Transformed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono">
                        {validationData.stats_table?.map((st, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-sans font-bold text-slate-700">{st.metric}</td>
                            <td className="px-3 py-2 text-slate-600">{st.original?.toLocaleString()}</td>
                            <td className="px-3 py-2 font-bold text-brand-700">{st.transformed?.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Row 2: Side-by-Side Distribution Comparison */}
              <div>
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                  Variable Distribution Comparison (Compression & Skewness Check):
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white p-3 rounded-2xl border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-600 block mb-2">Original Distribution (Raw Histogram)</span>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={validationData.raw_hist}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="bin" tick={{ fontSize: 9 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#94A3B8" radius={[4, 4, 0, 0]} name="Frequency" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-white p-3 rounded-2xl border border-slate-200">
                    <span className="text-[11px] font-bold text-brand-700 block mb-2">Transformed Distribution (Normalized & Saturated)</span>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={validationData.trans_hist}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="bin" tick={{ fontSize: 9 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#001E96" radius={[4, 4, 0, 0]} name="Frequency" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Row 3: Relationship with KPI (Poor Man's Curve) Before vs After */}
              {validationData.raw_curve?.binned_curve?.length > 0 && validationData.trans_curve?.binned_curve?.length > 0 && (
                <div>
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                    Relationship with KPI (Poor Man's Curve): Before vs. After Transformation
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-3 rounded-2xl border border-slate-200">
                      <span className="text-[11px] font-bold text-slate-600 block mb-1">
                        Before: {validationData.channel} vs {Array.isArray(depVar) ? depVar[0] : depVar} ({validationData.raw_curve.shape_indicator})
                      </span>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={validationData.raw_curve.binned_curve}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="spend_x" tick={{ fontSize: 9 }} />
                          <YAxis dataKey="response_y" tick={{ fontSize: 10 }} />
                          <Tooltip />
                          <Line type="linear" dataKey="response_y" stroke="#94A3B8" strokeWidth={2.5} dot={{ r: 3 }} name="Raw Response" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="bg-white p-3 rounded-2xl border border-slate-200">
                      <span className="text-[11px] font-bold text-brand-700 block mb-1">
                        After: {validationData.channel} (Transformed) vs {Array.isArray(depVar) ? depVar[0] : depVar} ({validationData.trans_curve.shape_indicator})
                      </span>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={validationData.trans_curve.binned_curve}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="spend_x" tick={{ fontSize: 9 }} />
                          <YAxis dataKey="response_y" tick={{ fontSize: 10 }} />
                          <Tooltip />
                          <Line type="linear" dataKey="response_y" stroke="#001E96" strokeWidth={2.5} dot={{ r: 3, fill: "#1ABC9C" }} name="Transformed Response" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ─── Bottom Actions Bar (Download Data / Save Config / Proceed) ────── */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
        <div className="flex items-center gap-2">
          <label className="text-xs font-bold text-slate-300">Set Name:</label>
          <input
            type="text"
            value={setNameInput}
            onChange={(e) => setSetNameInput(e.target.value)}
            className="text-xs font-bold border border-slate-700 rounded-lg px-3 py-1.5 bg-slate-800 text-white w-56"
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {result && (
            <a
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(result.csv_data)}`}
              download={`${(setNameInput || "transformed_data").replace(/\s+/g, "_")}.csv`}
              className="px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-all flex items-center gap-1.5 border border-slate-700"
            >
              📥 Download Transformed Data
            </a>
          )}

          <Btn
            onClick={handleApplyTransformations}
            disabled={loading || !transformConfig.length}
            className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-brand-600 hover:bg-brand-700"
          >
            {loading ? "Saving Set…" : "💾 Save Transformation Set"}
          </Btn>

          <Btn
            onClick={handleProceedToModelling}
            disabled={!result}
            className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-[#1ABC9C] hover:bg-[#16a085]"
          >
            Proceed to Modeling →
          </Btn>
        </div>
      </div>

      {/* ─── MODAL: Derived Variable Builder ──────────────────────────────── */}
      {derivedModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-slate-800">Create Arithmetic Derived Variable</h3>
              <button
                type="button"
                onClick={() => setDerivedModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Derived Channel Name:</label>
                <input
                  type="text"
                  placeholder="e.g. TOTAL_PERSONAL_PROMO"
                  value={newDerivedName}
                  onChange={(e) => setNewDerivedName(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Operator:</label>
                <select
                  value={derivedOperator}
                  onChange={(e) => setDerivedOperator(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                >
                  <option value="+">Addition (+)</option>
                  <option value="-">Subtraction (-)</option>
                  <option value="*">Multiplication (*)</option>
                  <option value="/">Division (/)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Select Source Variables:
                </label>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 border border-slate-200 rounded-xl">
                  {transformableCandidates.map((v) => {
                    const isSel = selectedDerivedVars.includes(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          if (isSel) {
                            setSelectedDerivedVars(selectedDerivedVars.filter((x) => x !== v));
                          } else {
                            setSelectedDerivedVars([...selectedDerivedVars, v]);
                          }
                        }}
                        className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all ${
                          isSel
                            ? "bg-brand-600 text-white"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedDerivedVars.length > 0 && (
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
                  <span className="font-bold text-slate-700 block mb-1">Formula Preview:</span>
                  <code className="text-brand-700 font-bold">
                    {newDerivedName || "NEW_VAR"} = {selectedDerivedVars.join(` ${derivedOperator} `)}
                  </code>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Btn variant="secondary" onClick={() => setDerivedModalOpen(false)}>
                Cancel
              </Btn>
              <Btn onClick={handleAddDerivedVariable}>
                Save & Add to Table
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}