
import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import {
  applyTransformations,
  runOptuna,
  transformationAutoSelect,
  transformationPreviewSingle,
  transformationCorrelation,
  v2ListArds,
  v2GetCsv,
  problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Select, Metric } from "../components/UI";

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
  const { state, setField, setFields, saveWorkflowSnapshot } = useAppState();
  const workflowId = state.workflowId;

  // ─── 1. Scope & ARD Selector ──────────────────────────────────────────────
  const [scope, setScope] = useState("both"); // "hcp", "dma", "both"
  const [ardList, setArdList] = useState(() => state.savedArds || []);
  const [selectedArdId, setSelectedArdId] = useState(() => state.activeDataset || "active");
  const [activeCsv, setActiveCsv] = useState(() => state.granularCsvData || state.filteredCsvData || "");

  // Load available ARDs
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

  // Load selected ARD's CSV
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

  // ─── 2. Key Columns ───────────────────────────────────────────────────────
  const [allCols, setAllCols] = useState([]);
  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [depVar, setDepVar] = useState(state.dependentVariable || "");
  const [popCol, setPopCol] = useState("");
  const [addCarryover, setAddCarryover] = useState(state.addCarryover || false);

  // Extract columns & auto-detect defaults
  useEffect(() => {
    if (!activeCsv) return;
    try {
      const firstLine = activeCsv.split("\n")[0];
      const cols = firstLine.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setAllCols(cols);

      if (!dateCol || !cols.includes(dateCol)) {
        const d = cols.find((c) => /date|week|month|time/i.test(c)) || cols[0];
        setDateCol(d);
      }
      if (!geoCol || !cols.includes(geoCol)) {
        const g = cols.find((c) => /npi|geo|id|dma/i.test(c)) || cols[1] || cols[0];
        setGeoCol(g);
      }
      if (!depVar || !cols.includes(depVar)) {
        const s = cols.find((c) => /sale|trx|nrx|kpi|rev/i.test(c)) || "";
        setDepVar(s);
      }
      if (!popCol || !cols.includes(popCol)) {
        const p = cols.find((c) => /pop|universe|target/i.test(c)) || "";
        if (p) setPopCol(p);
      }
    } catch (e) {}
  }, [activeCsv]);

  // Transformable variables (Strictly EXCLUDING Sales & Key columns)
  const candidateVariables = useMemo(() => {
    const excluded = new Set([dateCol, geoCol, depVar].filter(Boolean));
    return allCols.filter((c) => !excluded.has(c) && !c.toLowerCase().includes("id"));
  }, [allCols, dateCol, geoCol, depVar]);

  // ─── 3. Transformation Table Configuration ───────────────────────────────
  const [configs, setConfigs] = useState(() => {
    return state.transformationConfig && state.transformationConfig.length > 0
      ? state.transformationConfig
      : [];
  });

  // Initialize config table when variables load
  useEffect(() => {
    if (candidateVariables.length === 0) return;
    setConfigs((prev) => {
      const existingMap = new Map(prev.map((r) => [r["Channel Name"], r]));
      return candidateVariables.map((v) => {
        if (existingMap.has(v)) return existingMap.get(v);
        return {
          "Channel Name": v,
          "Normalization": "none",
          "Adstock": 0.5,
          "Lags": 2,
          "Saturation Function": "Log",
          "Power (k)": 0.5,
          "Log (k)": 1.0,
          "auto_selected": false,
        };
      });
    });
  }, [candidateVariables]);

  const updateConfigRow = (channelName, field, value) => {
    setConfigs((prev) =>
      prev.map((row) => {
        if (row["Channel Name"] !== channelName) return row;
        return { ...row, [field]: value, auto_selected: false };
      })
    );
  };

  // ─── 4. Arithmetic Derived Variable Builder ───────────────────────────────
  const [derivedVars, setDerivedVars] = useState([]);
  const [derivedModalOpen, setDerivedModalOpen] = useState(false);
  const [newDerivedName, setNewDerivedName] = useState("");
  const [derivedOperator, setDerivedOperator] = useState("+");
  const [selectedDerivedVars, setSelectedDerivedVars] = useState([]);
  const [derivedWeights, setDerivedWeights] = useState({});

  const handleAddDerivedVariable = () => {
    if (!newDerivedName.trim()) return toast.error("Provide a name for the derived variable.");
    if (selectedDerivedVars.length < 2) return toast.error("Select at least 2 source variables.");

    const entry = {
      name: newDerivedName.trim().toUpperCase(),
      operator: derivedOperator,
      variables: selectedDerivedVars,
      weights: derivedWeights,
    };

    setDerivedVars((prev) => [...prev, entry]);
    setNewDerivedName("");
    setSelectedDerivedVars([]);
    setDerivedWeights({});
    setDerivedModalOpen(false);
    toast.success(`Derived variable "${entry.name}" created!`);
  };

  const removeDerivedVariable = (idx) => {
    setDerivedVars((prev) => prev.filter((_, i) => i !== idx));
  };

  // ─── 5. Auto-Selection Engine ─────────────────────────────────────────────
  const [autoSelecting, setAutoSelecting] = useState(false);

  const handleAutoSelectAll = async () => {
    if (!activeCsv) return toast.error("No dataset loaded.");
    if (!depVar) return toast.error("Set Dependent Variable (Sales KPI) first.");
    setAutoSelecting(true);
    try {
      const res = await transformationAutoSelect({
        csv_data: activeCsv,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        channels: candidateVariables,
        pop_column: popCol || undefined,
      });

      const recsMap = new Map((res.recommendations || []).map((r) => [r["Channel Name"], r]));
      setConfigs((prev) =>
        prev.map((row) => {
          const rec = recsMap.get(row["Channel Name"]);
          return rec ? { ...row, ...rec } : row;
        })
      );
      toast.success(`Auto-selected optimal parameters for ${res.count} variables!`);
    } catch (err) {
      toast.error(problemMessage(err, "Auto-selection failed"));
    } finally {
      setAutoSelecting(false);
    }
  };

  const handleAutoSelectSingle = async (channelName) => {
    if (!activeCsv || !depVar) return toast.error("Set Target Sales variable first.");
    try {
      const res = await transformationAutoSelect({
        csv_data: activeCsv,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        channels: [channelName],
        pop_column: popCol || undefined,
      });
      if (res.recommendations && res.recommendations.length > 0) {
        const rec = res.recommendations[0];
        setConfigs((prev) =>
          prev.map((row) => (row["Channel Name"] === channelName ? { ...row, ...rec } : row))
        );
        toast.success(`Auto-tuned ${channelName}! (Fit Score: ${rec.fit_score})`);
      }
    } catch (err) {
      toast.error("Auto-tune failed");
    }
  };

  // ─── 6. Single Variable Preview Modal ─────────────────────────────────────
  const [previewChannel, setPreviewChannel] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleOpenPreview = async (channelName) => {
    setPreviewChannel(channelName);
    setPreviewLoading(true);
    const cfg = configs.find((c) => c["Channel Name"] === channelName) || {};
    try {
      const res = await transformationPreviewSingle({
        csv_data: activeCsv,
        channel: channelName,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        config: cfg,
        pop_column: popCol || undefined,
      });
      setPreviewData(res);
    } catch (err) {
      toast.error("Could not generate variable preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  // ─── 7. Execute Transformations ───────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedSets, setSavedSets] = useState(() => state.savedTransformationSets || []);
  const [setNameInput, setSetNameInput] = useState("Transformation Set v1");

  // Transformed Correlation diagnostics
  const [transCorrMatrix, setTransCorrMatrix] = useState(null);
  const [transCorrThreshold, setTransCorrThreshold] = useState(0.7);

  const handleApplyTransformations = async () => {
    if (!activeCsv) return toast.error("No dataset available.");
    if (!dateCol || !geoCol || !depVar) return toast.error("Specify Date, Geo, and Target Sales columns.");
    if (configs.length === 0 && derivedVars.length === 0) return toast.error("Configure at least one variable.");

    setLoading(true);
    try {
      const data = await applyTransformations({
        csv_data: activeCsv,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        transformations: configs,
        derived_variables: derivedVars,
        pop_column: popCol || undefined,
        add_carryover: addCarryover,
      });

      setResult(data);
      setField("transformedCsvData", data.csv_data);
      setField("dateColumn", dateCol);
      setField("geoColumn", geoCol);
      setField("dependentVariable", depVar);
      setField("transformationConfig", configs);
      setField("addCarryover", addCarryover);

      // Save versioned transformation set
      const newSet = {
        name: setNameInput.trim() || `Transform Set ${savedSets.length + 1}`,
        createdAt: new Date().toISOString(),
        configs: [...configs],
        derivedVars: [...derivedVars],
        columnsCount: data.cols,
      };
      const updatedSets = [newSet, ...savedSets];
      setSavedSets(updatedSets);
      setField("savedTransformationSets", updatedSets);

      // Run correlation on transformed features
      if (data.transformed_channels && data.transformed_channels.length >= 2) {
        transformationCorrelation({
          csv_data: data.csv_data,
          columns: data.transformed_channels,
          threshold: transCorrThreshold,
        })
          .then((cRes) => setTransCorrMatrix(cRes))
          .catch(() => {});
      }

      toast.success(`Transformed ${data.transformed_channels.length} channel(s) successfully!`);
    } catch (err) {
      toast.error(problemMessage(err, "Transformation execution failed"));
    } finally {
      setLoading(false);
    }
  };

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
        subtitle="Apply normalization, geometric adstock decay, log/power saturation curves, and create arithmetic derived variables"
        icon="⚙️"
      />

      {/* ─── Step 1: Scope & Dataset Selector ─────────────────────────────── */}
      <Card title="Step 1: Transformation Scope & Target ARD Dataset">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-2">
            {[
              { id: "hcp", label: "🩺 HCP-Level ARD" },
              { id: "dma", label: "📡 DMA-Level ARD" },
              { id: "both", label: "✨ All ARD Tables" },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScope(s.id)}
                className={`px-4 py-2.5 rounded-xl text-xs font-bold border transition-all ${
                  scope === s.id
                    ? "bg-[#001E96] text-white border-[#001E96] shadow-sm"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-[260px]">
            <Select
              label="Select Active ARD Table:"
              value={selectedArdId}
              onChange={setSelectedArdId}
              options={ardList.map((a) => ({
                value: a.id,
                label: `📄 ${a.name} (${a.grain?.toUpperCase()} Grain • ${a.rows?.toLocaleString()} rows)`,
              }))}
            />
          </div>
        </div>
      </Card>

      {/* ─── Step 2: Key Columns ──────────────────────────────────────────── */}
      <Card title="Step 2: Key Columns & Model Target">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Select label="Date Key (Time Period):" value={dateCol} onChange={setDateCol} options={allCols} />
          <Select label="Geo / HCP Key:" value={geoCol} onChange={setGeoCol} options={allCols} />
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Target KPI (Sales / Dependent Var):
            </label>
            <select
              value={depVar}
              onChange={(e) => setDepVar(e.target.value)}
              className="w-full text-xs font-bold border-2 border-red-300 rounded-xl px-3 py-2 bg-red-50 text-red-900 focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <option value="">Select Sales KPI</option>
              {allCols.map((c) => (
                <option key={c} value={c}>
                  🔒 {c} (Excluded from transforms)
                </option>
              ))}
            </select>
            <span className="text-[10px] text-red-600 block mt-0.5 font-semibold">
              * Sales variable is strictly protected from being transformed.
            </span>
          </div>

          <Select
            label="Population Column (Optional for Normalization):"
            value={popCol}
            onChange={setPopCol}
            options={["", ...allCols]}
            placeholder="None"
          />
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
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
            {candidateVariables.length} transformable variable(s) detected
          </span>
        </div>
      </Card>

      {/* ─── Step 3: Transformation Table & Controls ───────────────────────── */}
      <Card title="Step 3: Variable Transformation Controls">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <p className="text-xs text-slate-500">
            Configure Normalization, Adstock Decay ($\alpha$), Lag Horizon ($L$), and Functional Saturation (Log/Power) per channel.
          </p>

          <div className="flex gap-2 flex-wrap">
            <Btn
              onClick={handleAutoSelectAll}
              disabled={autoSelecting || !candidateVariables.length}
              className="text-xs py-2 bg-[#1ABC9C] hover:bg-[#16a085]"
            >
              {autoSelecting ? "Evaluating Fit Grids…" : "⚡ Auto-Select All Variables"}
            </Btn>

            <Btn
              variant="outline"
              onClick={() => setDerivedModalOpen(true)}
              className="text-xs py-2"
            >
              ➕ Create Arithmetic Variable
            </Btn>
          </div>
        </div>

        {autoSelecting && <Spinner label="Running grid search for optimal transformations..." />}

        {/* Configurations Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px]">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 sticky top-0 z-10 font-bold">
              <tr>
                <th className="px-3 py-3">Variable Name</th>
                <th className="px-3 py-3">Normalization</th>
                <th className="px-3 py-3">Adstock Decay ($\alpha$)</th>
                <th className="px-3 py-3">Lags Horizon ($L$)</th>
                <th className="px-3 py-3">Saturation Curve</th>
                <th className="px-3 py-3">Param ($k$ / $p$)</th>
                <th className="px-3 py-3">Source</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {configs.map((row) => {
                const isPower = row["Saturation Function"] === "Power";
                const isLog = row["Saturation Function"] === "Log";

                return (
                  <tr key={row["Channel Name"]} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-bold text-slate-800 whitespace-nowrap">
                      {row["Channel Name"]}
                    </td>

                    {/* Normalization */}
                    <td className="px-3 py-2">
                      <select
                        value={row["Normalization"] || "none"}
                        onChange={(e) => updateConfigRow(row["Channel Name"], "Normalization", e.target.value)}
                        className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none"
                      >
                        <option value="none">None</option>
                        <option value="minmax">Min-Max Scaling</option>
                        <option value="population" disabled={!popCol}>
                          Population-based {popCol ? `(÷ ${popCol})` : "(No Pop Col)"}
                        </option>
                        <option value="zscore">Z-Score</option>
                      </select>
                    </td>

                    {/* Adstock Decay */}
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="0.99"
                        value={row["Adstock"] ?? 0.5}
                        onChange={(e) => updateConfigRow(row["Channel Name"], "Adstock", parseFloat(e.target.value))}
                        className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                      />
                    </td>

                    {/* Lags Horizon */}
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="1"
                        min="0"
                        max="12"
                        value={row["Lags"] ?? 1}
                        onChange={(e) => updateConfigRow(row["Channel Name"], "Lags", parseInt(e.target.value))}
                        className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                      />
                    </td>

                    {/* Saturation Function */}
                    <td className="px-3 py-2">
                      <select
                        value={row["Saturation Function"] || "None"}
                        onChange={(e) => updateConfigRow(row["Channel Name"], "Saturation Function", e.target.value === "None" ? null : e.target.value)}
                        className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none font-semibold"
                      >
                        <option value="None">Linear (None)</option>
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

                    {/* Auto-selected Badge */}
                    <td className="px-3 py-2">
                      {row.auto_selected ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          ⚡ Auto
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">
                          Manual
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenPreview(row["Channel Name"])}
                          className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-[11px] font-bold text-slate-700"
                        >
                          👁️ Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAutoSelectSingle(row["Channel Name"])}
                          className="px-2 py-1 rounded bg-brand-50 hover:bg-brand-100 text-[11px] font-bold text-brand-700"
                          title="Auto-tune single variable"
                        >
                          ⚡ Auto
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Derived Variables Summary List */}
        {derivedVars.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-200 space-y-2">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
              Configured Arithmetic Derived Variables ({derivedVars.length}):
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {derivedVars.map((dv, idx) => (
                <div key={idx} className="bg-slate-50 p-3 rounded-xl border border-slate-200 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-xs text-brand-800 block">{dv.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {dv.variables.join(` ${dv.operator} `)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeDerivedVariable(idx)}
                    className="text-red-400 hover:text-red-600 text-xs font-bold p-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transformation Action Bar */}
        <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-slate-700">Set Name:</label>
            <input
              type="text"
              value={setNameInput}
              onChange={(e) => setSetNameInput(e.target.value)}
              className="text-xs font-bold border border-slate-200 rounded-lg px-3 py-1.5 bg-white w-56"
            />
          </div>

          <Btn
            onClick={handleApplyTransformations}
            disabled={loading || !candidateVariables.length}
            className="py-2.5 px-6 font-bold uppercase tracking-wider text-xs"
          >
            {loading ? "Applying Transformations…" : "▶ Apply & Persist Transformation Layer"}
          </Btn>
        </div>
      </Card>

      {loading && <Spinner label="Executing transformation pipeline..." />}

      {/* ─── Step 4: Transformed Multicollinearity Diagnostics ────────────── */}
      {result && (
        <Card title="Step 4: Post-Transformation Multicollinearity Matrix (Diagnostics)">
          <p className="text-xs text-slate-500 mb-4">
            Check correlation across transformed channels to ensure adstock and saturation transformations haven't introduced high multicollinearity before MMM regression.
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
              {result.transformed_channels?.length || 0} Features Ready for Modelling
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

      {/* ─── Step 5: Transformed Dataset Preview ──────────────────────────── */}
      {result && (
        <Card title="Step 5: Transformed Dataset Preview">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500">
              {result.rows.toLocaleString()} rows × {result.cols} total columns
            </span>
            <a
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(result.csv_data)}`}
              download={`${setNameInput.replace(/\s+/g, "_")}.csv`}
              className="text-xs font-bold text-brand-600 hover:underline flex items-center gap-1"
            >
              📥 Download Transformed CSV
            </a>
          </div>
          <DataTable data={result.preview} maxRows={15} />
        </Card>
      )}

      {/* ─── MODAL: Arithmetic Derived Variable Builder ───────────────────── */}
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
                <label className="block text-xs font-bold text-slate-700 mb-1">Derived Variable Name:</label>
                <input
                  type="text"
                  placeholder="e.g. TOTAL_PERSONAL_PROMO"
                  value={newDerivedName}
                  onChange={(e) => setNewDerivedName(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3 py-2 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Arithmetic Operator:</label>
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
                  Select Source Variables to Combine:
                </label>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 border border-slate-200 rounded-xl">
                  {candidateVariables.map((v) => {
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
                Save Derived Variable
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: Single Variable Before / After Preview ────────────────── */}
      {previewChannel && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-black text-slate-800">
                  Before vs. After Transformation Preview: {previewChannel}
                </h3>
                <span className="text-xs text-slate-400">Inspecting curvature and time response</span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewChannel(null)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            {previewLoading && <Spinner label="Loading preview..." />}

            {previewData && !previewLoading && (
              <div className="space-y-4">
                {/* Stats comparison grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-base font-bold text-slate-800">{previewData.stats.raw_mean}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Raw Mean</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-base font-bold text-brand-700">{previewData.stats.trans_mean}</div>
                    <div className="text-[10px] text-brand-500 font-bold uppercase">Transformed Mean</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-base font-bold text-slate-800">{previewData.stats.correlation_with_kpi_raw ?? "—"}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase">Raw Corr with Sales</div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl text-center">
                    <div className="text-base font-bold text-emerald-600">{previewData.stats.correlation_with_kpi_trans ?? "—"}</div>
                    <div className="text-[10px] text-emerald-600 font-bold uppercase">Transformed Corr</div>
                  </div>
                </div>

                {/* Time Trend Comparison Chart */}
                {previewData.time_trend?.length > 0 && (
                  <div>
                    <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                      Time Series Response (Raw vs. Transformed Decay):
                    </span>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={previewData.time_trend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Line type="monotone" dataKey="raw" stroke="#94A3B8" strokeWidth={2} dot={false} name="Raw Metric" />
                        <Line type="monotone" dataKey="transformed" stroke="#001E96" strokeWidth={2.5} dot={false} name="Transformed" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <Btn onClick={() => setPreviewChannel(null)}>Close Preview</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ─── Bottom Proceed Bar ───────────────────────────────────────────── */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
        <div>
          <span className="text-emerald-400 font-bold text-sm block">
            {result ? "✅ Transformation Layer Persisted" : "Transformation Configuration Ready"}
          </span>
          <p className="text-xs text-slate-400">
            Proceed to Module 6 to run OLS / Ridge regressions and 2-stage channel decomposition.
          </p>
        </div>
        <Btn onClick={handleProceedToModelling} disabled={!result}>
          Proceed to MMM Modelling →
        </Btn>
      </div>
    </div>
  );
}

