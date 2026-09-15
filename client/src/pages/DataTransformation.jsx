import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar
} from "recharts";
import {
  applyTransformations,
  transformationPreviewSingle,
  transformationCorrelation,
  v2ListArds,
  v2GetCsv,
  problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable } from "../components/UI";

const ADSTOCK_HORIZON_OPTIONS = [
  { value: 0, label: "0 weeks (No Adstock Decay)" },
  { value: 1, label: "1 week" },
  { value: 2, label: "2 weeks" },
  { value: 3, label: "3 weeks" },
  { value: 4, label: "4 weeks (1 month)" },
  { value: 6, label: "6 weeks" },
  { value: 8, label: "8 weeks (2 months)" },
  { value: 12, label: "12 weeks (1 quarter)" },
];

const PURE_LAG_OPTIONS = [
  { value: 0, label: "Lag 0 (Immediate Effect)" },
  { value: 1, label: "Lag 1 (Shift 1 wk)" },
  { value: 2, label: "Lag 2 (Shift 2 wks)" },
  { value: 3, label: "Lag 3 (Shift 3 wks)" },
  { value: 4, label: "Lag 4 (Shift 4 wks)" },
  { value: 6, label: "Lag 6 (Shift 6 wks)" },
  { value: 8, label: "Lag 8 (Shift 8 wks)" },
];

const NORMALIZATION_OPTIONS = [
  { value: "none", label: "None (Raw Volume)" },
  { value: "population", label: "Population Based (÷ Universe)" },
  { value: "minmax", label: "Min-Max Scaling [0, 1]" },
  { value: "zscore", label: "Z-Score (Standardized σ)" },
  { value: "iqr", label: "Robust / IQR Scaling" },
];

function getChannelGuidance(channelName) {
  const l = channelName.toLowerCase();

  if (l.includes("tv") || l.includes("broad") || l.includes("video")) {
    return {
      tacticType: "Mass Media / Television / CTV",
      adstockDecay: "0.60 – 0.80 (High Memory Retention)",
      adstockHorizon: "4 to 8 weeks",
      pureLag: "1 to 2 weeks",
      saturation: "Logarithmic: ln(1 + k·x) with k ≈ 1.0 or Power (p ≈ 0.40)",
      rationale: "Broad mass media builds brand awareness with a long carryover half-life. High GRPs experience diminishing returns rapidly due to frequency fatigue.",
      actionItem: "Set Adstock Decay to 0.70, Adstock Horizon to 4–6 weeks, Lag to 1 week, and use Log Saturation."
    };
  }
  if (l.includes("call") || l.includes("det") || l.includes("rep") || l.includes("f2f")) {
    return {
      tacticType: "HCP Personal Detailing / Sales Rep Calls",
      adstockDecay: "0.40 – 0.60 (Medium Retention)",
      adstockHorizon: "2 to 4 weeks",
      pureLag: "0 to 1 week",
      saturation: "Power: x^p (p ≈ 0.50 – 0.60) or Log (k ≈ 1.0)",
      rationale: "Sales rep details have an immediate clinical impact with memory decay lasting 2–4 weeks. Detailing frequency saturates after 3–4 calls per HCP per month.",
      actionItem: "Set Adstock Decay to 0.50, Adstock Horizon to 2 weeks, Lag to 0, and Saturation to Power (p = 0.50)."
    };
  }
  if (l.includes("samp") || l.includes("voucher") || l.includes("copay")) {
    return {
      tacticType: "Physical Samples & Co-Pay Vouchers",
      adstockDecay: "0.20 – 0.30 (Short / Immediate)",
      adstockHorizon: "1 to 2 weeks",
      pureLag: "0 weeks (Immediate)",
      saturation: "Power: x^p (p ≈ 0.60) or Linear",
      rationale: "Samples lead directly to immediate trial prescriptions (TRx) with low long-term memory carryover.",
      actionItem: "Set Adstock Decay to 0.20, Adstock Horizon to 1 week, Lag to 0, and Saturation to Power (p = 0.60)."
    };
  }
  if (l.includes("dig") || l.includes("sear") || l.includes("disp") || l.includes("soci") || l.includes("email") || l.includes("rte")) {
    return {
      tacticType: "Digital Media / Search / Social / Emails / RTE",
      adstockDecay: "0.10 – 0.30 (Fast Decay)",
      adstockHorizon: "1 to 2 weeks",
      pureLag: "0 weeks",
      saturation: "Logarithmic (k ≈ 1.5 – 2.0)",
      rationale: "Digital impressions trigger near-instant click-through actions. Saturation happens quickly due to banner blindness.",
      actionItem: "Set Adstock Decay to 0.20, Adstock Horizon to 1 week, Lag to 0, and Saturation to Log (k = 1.5)."
    };
  }
  if (l.includes("speak") || l.includes("symp") || l.includes("conf") || l.includes("event")) {
    return {
      tacticType: "Peer-to-Peer Speaker Programs & Medical Symposia",
      adstockDecay: "0.60 – 0.75 (Long Clinical Half-Life)",
      adstockHorizon: "6 to 8 weeks",
      pureLag: "1 to 3 weeks",
      saturation: "Logarithmic: ln(1 + k·x) (k ≈ 1.0)",
      rationale: "Peer influence and key opinion leader (KOL) events alter physician prescribing behavior over multiple subsequent treatment cycles.",
      actionItem: "Set Adstock Decay to 0.70, Adstock Horizon to 6 weeks, Lag to 2 weeks, and Saturation to Log."
    };
  }

  return {
    tacticType: "General Marketing & Promotion Channel",
    adstockDecay: "0.40 – 0.50 (Standard Benchmark)",
    adstockHorizon: "2 to 4 weeks",
    pureLag: "0 to 1 week",
    saturation: "Logarithmic: ln(1 + k·x) or Power (p = 0.50)",
    rationale: "Standard promotional channel. Balances short-term prescription lift with multi-week memory decay.",
    actionItem: "Set Adstock Decay to 0.50, Adstock Horizon to 2 weeks, Lag to 0, and Saturation to Log."
  };
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
          grain: a.grain || (a.derived_from && a.derived_from.grain) || (a.filename.toLowerCase().includes("dma") ? "dma" : "hcp"),
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

  // ─── Step 1: Parse Columns & Group by 5 Ingestion Categories ───────────────
  const [allCols, setAllCols] = useState([]);
  const [columnRolesMap, setColumnRolesMap] = useState(() => state.columnRoles || {});

  const [selCrossSectional, setSelCrossSectional] = useState([]);
  const [selDependent, setSelDependent] = useState([]);
  const [selTime, setSelTime] = useState([]);
  const [selPromotions, setSelPromotions] = useState([]);
  const [selBaseline, setSelBaseline] = useState([]);

  const [modelSpec, setModelSpec] = useState(() => state.modelSpecification || "linear_log");
  const [addCarryover, setAddCarryover] = useState(state.addCarryover || false);

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
          if (l.includes("sale") || l.includes("trx") || l.includes("nrx") || l.includes("crx") || l.includes("nbrx") || l.includes("kpi") || l.includes("revenue")) {
            roles[c] = "Dependent Variable";
          } else if (l.includes("date") || l.includes("week") || l.includes("month") || l.includes("year") || l.includes("period")) {
            roles[c] = "Time Variable";
          } else if (l.includes("npi") || l.includes("geo") || l.includes("id") || l.includes("dma") || l.includes("zip")) {
            roles[c] = "Cross-sectional Variable";
          } else if (l.includes("pop") || l.includes("universe") || l.includes("macro") || l.includes("base") || l.includes("trend")) {
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
    } catch (e) {}
  }, [activeCsv]);

  const crossCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Cross-sectional Variable"), [allCols, columnRolesMap]);
  const depCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Dependent Variable"), [allCols, columnRolesMap]);
  const timeCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Time Variable"), [allCols, columnRolesMap]);
  const promoCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Independent Promotions"), [allCols, columnRolesMap]);
  const baseCols = useMemo(() => allCols.filter((c) => columnRolesMap[c] === "Baseline Variables"), [allCols, columnRolesMap]);

  const toggleCategorySelection = (col, list, setter) => {
    setter(list.includes(col) ? list.filter((x) => x !== col) : [...list, col]);
  };

  // ─── Step 2: Transformable Channels Table ──────────────────────────────────
  const activeTransformableList = useMemo(() => {
    const list = [...selPromotions, ...selBaseline];
    if (modelSpec === "log_log") {
      selDependent.forEach((d) => {
        if (!list.includes(d)) list.push(d);
      });
    }
    return list;
  }, [selPromotions, selBaseline, selDependent, modelSpec]);

  const [derivedVars, setDerivedVars] = useState([]);
  const [derivedModalOpen, setDerivedModalOpen] = useState(false);
  const [newDerivedName, setNewDerivedName] = useState("");
  const [derivedOperator, setDerivedOperator] = useState("+");
  const [selectedDerivedVars, setSelectedDerivedVars] = useState([]);
  const [derivedWeights, setDerivedWeights] = useState({});

  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoChannelName, setInfoChannelName] = useState("");

  const [transformConfig, setTransformConfig] = useState(() => state.transformationConfig || []);

  useEffect(() => {
    setTransformConfig((prev) => {
      const existingMap = new Map(prev.map((r) => [r["Channel Name"], r]));

      const standardRows = activeTransformableList.map((v) => {
        if (existingMap.has(v)) return existingMap.get(v);
        const isDep = selDependent.includes(v);
        return {
          "Channel Name": v,
          "Grain": isDep ? "KPI" : "Promo",
          "Normalization": "none",
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
  }, [activeTransformableList, derivedVars, selDependent]);

  const updateConfigRow = (channelName, field, value) => {
    setTransformConfig((prev) =>
      prev.map((row) => {
        if (row["Channel Name"] !== channelName) return row;
        return { ...row, [field]: value };
      })
    );
  };

  const handleOpenInfo = (channelName) => {
    setInfoChannelName(channelName);
    setInfoModalOpen(true);
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
    toast.success(`Derived channel "${derivedName}" added!`);
  };

  const removeDerivedVariable = (channelName) => {
    setDerivedVars((prev) => prev.filter((d) => d.name !== channelName));
    setTransformConfig((prev) => prev.filter((r) => r["Channel Name"] !== channelName));
    toast.success(`Removed derived channel "${channelName}"`);
  };

  // ─── Step 3: Execution & Dataset Registry Save ─────────────────────────────
  const [setNameInput, setSetNameInput] = useState("HCP FINAL ARD");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const [transCorrMatrix, setTransCorrMatrix] = useState(null);
  const [transCorrThreshold, setTransCorrThreshold] = useState(0.7);

  const handleApplyTransformations = async () => {
    if (!activeCsv) return toast.error("No dataset available");
    const primaryDate = selTime[0] || "";
    const primaryGeo = selCrossSectional[0] || "";
    const primaryDep = selDependent[0] || "";
    const primaryPop = selBaseline[0] || "";

    if (!primaryDate || !primaryGeo || !primaryDep) {
      return toast.error("Select Time Variable, Cross-sectional Geo Variable, and Dependent Variable.");
    }
    if (!transformConfig.length) return toast.error("Configure at least one channel in the transformation table.");

    setLoading(true);
    try {
      const mappedTransformations = transformConfig.map((c) => ({
        ...c,
        Lags: c["Adstock Horizon"] ?? 2,
        Lag: c["Lag"] ?? 0,
      }));

      const data = await applyTransformations({
        csv_data: activeCsv,
        geo_column: primaryGeo,
        date_column: primaryDate,
        dependent_variable: primaryDep,
        add_carryover: addCarryover,
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
      setField("addCarryover", addCarryover);
      setField("modelSpecification", modelSpec);

      // Detect Grain from selected ARD or name
      const activeArd = ardList.find((a) => a.id === selectedArdId);
      const isDma = (activeArd?.grain || "").toLowerCase().includes("dma") ||
                    (selectedArdId || "").toLowerCase().includes("dma") ||
                    setNameInput.toLowerCase().includes("dma");
      const detectedGrain = isDma ? "DMA" : "HCP";

      const newVersion = {
        id: `trans_${Date.now()}`,
        name: setNameInput.trim() || `Transform Set v${savedSets.length + 1}`,
        grain: detectedGrain, // "HCP" | "DMA"
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
        addCarryover: addCarryover,
        modelSpecification: modelSpec,
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

      toast.success(`Transformation Dataset "${newVersion.name}" saved & ready for Modelling!`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Transformation failed");
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
    if (targetSet.resultData) {
      setResult(targetSet.resultData);
    }
    toast.success(`Switched to "${targetSet.name}"`);
  };

  // ─── Preview & Single Channel Validation ──────────────────────────────────
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
    const primaryPop = selBaseline[0] || "";

    setValidationLoading(true);
    transformationPreviewSingle({
      csv_data: activeCsv,
      channel: selectedValidationVar,
      geo_column: primaryGeo,
      date_column: primaryDate,
      dependent_variable: primaryDep,
      config: { ...cfg, Lags: cfg["Adstock Horizon"] ?? 2 },
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
        subtitle="Configure Normalization, Adstock decay, Adstock Horizon, Pure Lags, and Saturation curves based on Ingestion column categories"
        icon="⚙️"
      />

      {!activeCsv && <Alert type="warning">No dataset available. Complete Data Ingestion and Stitching first.</Alert>}

      {/* ARD Table & Version Selector */}
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

      {/* Step 1: 5 Ingestion Categories */}
      <Card title="Step 1: Column Categorization (From Ingestion)">
        <p className="text-xs text-slate-500 mb-4">
          Variables are categorized according to their Ingestion roles. You can adjust channel inclusions or switch model formulation below.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <IngestionCategoryBox
            title="1. Time Variable"
            subtitle="Dates, Weeks, Periods"
            columns={timeCols}
            selected={selTime}
            onToggle={(c) => toggleCategorySelection(c, selTime, setSelTime)}
            colorBadge="bg-blue-100 text-blue-800"
          />

          <IngestionCategoryBox
            title="2. Cross-sectional Variable"
            subtitle="HCP IDs, DMA, Zip, Region Keys"
            columns={crossCols}
            selected={selCrossSectional}
            onToggle={(c) => toggleCategorySelection(c, selCrossSectional, setSelCrossSectional)}
            colorBadge="bg-purple-100 text-purple-800"
          />

          <IngestionCategoryBox
            title="3. Dependent Variable (KPI)"
            subtitle="Sales, TRx, NRx, Revenue"
            columns={depCols}
            selected={selDependent}
            onToggle={(c) => toggleCategorySelection(c, selDependent, setSelDependent)}
            colorBadge="bg-red-100 text-red-800"
          />

          <IngestionCategoryBox
            title="4. Independent Promotions"
            subtitle="Calls, Details, Spend, Emails, Media"
            columns={promoCols}
            selected={selPromotions}
            onToggle={(c) => toggleCategorySelection(c, selPromotions, setSelPromotions)}
            colorBadge="bg-emerald-100 text-emerald-800"
          />

          <IngestionCategoryBox
            title="5. Baseline Variables"
            subtitle="Target Population, Macro, Universe"
            columns={baseCols}
            selected={selBaseline}
            onToggle={(c) => toggleCategorySelection(c, selBaseline, setSelBaseline)}
            colorBadge="bg-amber-100 text-amber-800"
          />

          {/* Model Formulation Controls */}
          <div className="bg-brand-50/50 rounded-2xl border border-brand-200 p-4 flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold text-brand-900 uppercase tracking-wider block mb-1">
                Model Formulation &amp; KPI Lock
              </span>
              <p className="text-[11px] text-slate-600 mb-3">
                Decide whether the Dependent Variable is transformed (Log-Log) or kept in linear units (Linear-Log).
              </p>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="modelSpec"
                    value="linear_log"
                    checked={modelSpec === "linear_log"}
                    onChange={() => setModelSpec("linear_log")}
                    className="accent-[#001E96]"
                  />
                  <span>Linear-Log (Keep Sales KPI Linear / Un-transformed)</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="modelSpec"
                    value="log_log"
                    checked={modelSpec === "log_log"}
                    onChange={() => setModelSpec("log_log")}
                    className="accent-[#001E96]"
                  />
                  <span>Log-Log (Transform Sales KPI with Log Curve)</span>
                </label>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer pt-3 border-t border-brand-200/60 mt-3">
              <input
                type="checkbox"
                checked={addCarryover}
                onChange={(e) => setAddCarryover(e.target.checked)}
                className="rounded text-brand-600"
              />
              <span>Generate <code>Carryover</code> (Lag 1 of Sales KPI)</span>
            </label>
          </div>
        </div>
      </Card>

      {/* Step 2: Transformation Configuration Table */}
      {transformConfig.length > 0 && (
        <Card title="Step 2: Transformation Configuration Table">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <p className="text-xs text-slate-500">
              Configure Normalization, Adstock Decay, Adstock Horizon (decay span), Pure Lag (delay), and Saturation Curves. Click <strong>ℹ️</strong> on any channel for expert guidance.
            </p>

            <Btn
              variant="outline"
              onClick={() => setDerivedModalOpen(true)}
              className="text-xs py-1.5 px-3"
            >
              ➕ Add Derived Channel
            </Btn>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px]">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 z-10 font-bold">
                <tr>
                  <th className="px-3 py-3">Channel Name</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3">Normalization</th>
                  <th className="px-3 py-3">Adstock (Decay)</th>
                  <th className="px-3 py-3">Adstock Horizon</th>
                  <th className="px-3 py-3">Lag (Shift)</th>
                  <th className="px-3 py-3">Saturation Curve</th>
                  <th className="px-3 py-3">Param (k / p)</th>
                  <th className="px-3 py-3 text-right">Guidance &amp; Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transformConfig.map((row) => {
                  const isPower = row["Saturation Function"] === "Power";
                  const isLog = row["Saturation Function"] === "Log";
                  const isDerived = row.is_derived;
                  const isDep = row.is_dependent;

                  return (
                    <tr key={row["Channel Name"]} className={isDerived ? "bg-amber-50/40" : isDep ? "bg-red-50/30" : "hover:bg-slate-50"}>
                      <td className="px-3 py-2.5 font-bold text-slate-800 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {isDerived && <span className="text-amber-600 font-bold" title="Derived Variable">⚡</span>}
                          {isDep && <span className="text-red-600 font-bold" title="Dependent Variable">🎯</span>}
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
                            ? "bg-amber-100 text-amber-800"
                            : isDep
                            ? "bg-red-100 text-red-800"
                            : "bg-emerald-100 text-emerald-800"
                        }`}>
                          {row["Grain"] || "Promo"}
                        </span>
                      </td>

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

                      <td className="px-3 py-2">
                        <select
                          value={row["Adstock Horizon"] ?? 2}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Adstock Horizon", parseInt(e.target.value))}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white font-semibold"
                        >
                          {ADSTOCK_HORIZON_OPTIONS.map((h) => (
                            <option key={h.value} value={h.value}>
                              {h.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-3 py-2">
                        <select
                          value={row["Lag"] ?? 0}
                          onChange={(e) => updateConfigRow(row["Channel Name"], "Lag", parseInt(e.target.value))}
                          className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white font-semibold"
                        >
                          {PURE_LAG_OPTIONS.map((l) => (
                            <option key={l.value} value={l.value}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </td>

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

                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenInfo(row["Channel Name"])}
                            className="w-6 h-6 rounded-full bg-brand-50 hover:bg-brand-100 text-brand-700 font-black text-xs flex items-center justify-center border border-brand-200 transition-all shadow-sm"
                            title="View GPT-generated transformation guidance"
                          >
                            ℹ️
                          </button>
                          {isDerived && (
                            <button
                              type="button"
                              onClick={() => removeDerivedVariable(row["Channel Name"])}
                              className="px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-[11px] font-bold text-red-600"
                              title="Delete derived channel"
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

          <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-700">Transformation Dataset Name:</label>
              <input
                type="text"
                value={setNameInput}
                onChange={(e) => setSetNameInput(e.target.value)}
                placeholder="e.g. HCP FINAL ARD"
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

      {/* 1st: Post-Transformation Multicollinearity Matrix */}
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

      {/* 2nd: Transformed Dataset Preview */}
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

      {/* 3rd: Single Variable Preview & Validation */}
      {transformConfig.length > 0 && (
        <Card title="3. Preview & Validation">
          <p className="text-xs text-slate-500 mb-5">
            Review the empirical impact of transformations, validate distribution compression, and inspect response shape against KPI before saving.
          </p>

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
                    {c["Channel Name"]} ({c["Grain"] || "Promo"} • {c["Normalization"]} • {c["Saturation Function"] || "Linear"})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {validationLoading && <Spinner label="Loading before/after validation metrics..." />}

          {validationData && !validationLoading && (
            <div className="space-y-6">
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
                      <span className="text-slate-400 block text-[10px] uppercase font-bold">Adstock Decay</span>
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

              <div>
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                  Distribution Comparison:
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white p-3 rounded-2xl border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-600 block mb-2">Original Distribution (Raw)</span>
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
                    <span className="text-[11px] font-bold text-brand-700 block mb-2">Transformed Distribution</span>
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

              {validationData.raw_curve?.binned_curve?.length > 0 && validationData.trans_curve?.binned_curve?.length > 0 && (
                <div>
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                    Relationship with KPI (Poor Man's Curve): Before vs. After Transformation
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-3 rounded-2xl border border-slate-200">
                      <span className="text-[11px] font-bold text-slate-600 block mb-1">
                        Before: {validationData.channel} vs {selDependent[0]} ({validationData.raw_curve.shape_indicator})
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
                        After: {validationData.channel} (Transformed) vs {selDependent[0]} ({validationData.trans_curve.shape_indicator})
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

      {/* Bottom Actions Bar */}
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
          <Btn
            onClick={handleApplyTransformations}
            disabled={loading || !transformConfig.length}
            className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-brand-600 hover:bg-brand-700"
          >
            {loading ? "Saving Set…" : "💾 Save Transformation Set"}
          </Btn>

          <Btn
            onClick={handleProceedToModelling}
            disabled={!result && savedSets.length === 0}
            className="py-2.5 px-5 font-bold uppercase tracking-wider text-xs bg-[#1ABC9C] hover:bg-[#16a085]"
          >
            Proceed to Modeling →
          </Btn>
        </div>
      </div>

      {/* Guidance Modal */}
      {infoModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">🤖</span>
                <div>
                  <h3 className="text-base font-black text-slate-800">
                    Transformation Guidance: {infoChannelName}
                  </h3>
                  <p className="text-xs text-slate-400">GPT Parameter Recommendations &amp; Methodology</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInfoModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 text-sm"
              >
                ✕
              </button>
            </div>

            {(() => {
              const guide = getChannelGuidance(infoChannelName);
              return (
                <div className="space-y-4 text-xs">
                  <div className="p-3 bg-brand-50 border border-brand-100 rounded-xl space-y-1">
                    <span className="font-bold text-brand-900 block">Classified Channel Archetype:</span>
                    <span className="text-brand-700 font-semibold">{guide.tacticType}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                      <span className="text-slate-400 font-bold uppercase text-[10px] block">Recommended Adstock Decay</span>
                      <strong className="text-slate-800 text-sm">{guide.adstockDecay}</strong>
                    </div>
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                      <span className="text-slate-400 font-bold uppercase text-[10px] block">Adstock Horizon</span>
                      <strong className="text-slate-800 text-sm">{guide.adstockHorizon}</strong>
                    </div>
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                      <span className="text-slate-400 font-bold uppercase text-[10px] block">Pure Delay Lag</span>
                      <strong className="text-slate-800 text-sm">{guide.pureLag}</strong>
                    </div>
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                      <span className="text-slate-400 font-bold uppercase text-[10px] block">Saturation Shape</span>
                      <strong className="text-slate-800 text-sm">{guide.saturation}</strong>
                    </div>
                  </div>

                  <div className="space-y-1.5 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <span className="font-bold text-slate-800 block">Behavioral Rationale:</span>
                    <p className="text-slate-600 leading-relaxed">{guide.rationale}</p>
                  </div>

                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900">
                    <span className="font-bold block mb-0.5">Recommended Table Setting:</span>
                    <span>{guide.actionItem}</span>
                  </div>
                </div>
              );
            })()}

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <Btn onClick={() => setInfoModalOpen(false)}>
                Got it, Close
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Derived Variable Modal */}
      {derivedModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-slate-800">Create Arithmetic Derived Channel</h3>
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
                  {allCols.map((v) => {
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