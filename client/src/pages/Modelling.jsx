import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  runRegression, runRidge, v2ListArds, v2GetCsv, problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Metric, MultiSelect } from "../components/UI";

const ALPHA_GRID = "0.001  0.01  0.1  1  2  4  8  10  20  50  100";

function RidgePriorWeights({ channels, weights, onChange }) {
  return (
    <div className="space-y-2 mt-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
      <div className="grid grid-cols-4 gap-2 text-xs font-bold text-slate-600 px-1 uppercase tracking-wider">
        <span>Channel</span>
        <span>Prior Weight</span>
        <span>Scale Factor</span>
        <span>Shrinkage Effect</span>
      </div>
      {channels.map((ch) => {
        const w = weights[ch] ?? 1.0;
        return (
          <div key={ch} className="grid grid-cols-4 gap-2 items-center text-xs">
            <span className="truncate font-bold text-slate-700" title={ch}>{ch.replace("_transformed", "")}</span>
            <input
              type="number"
              step="0.5"
              min="0.01"
              max="100"
              value={w}
              onChange={(e) => onChange(ch, parseFloat(e.target.value) || 1)}
              className="border border-slate-200 rounded-lg px-2.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="font-mono text-slate-500">× {(1 / w).toFixed(4)}</span>
            <span className={`text-[11px] font-semibold ${
              w > 1 ? "text-amber-700" : w < 1 ? "text-blue-700" : "text-slate-500"
            }`}>
              {w > 1 ? "More shrinkage" : w < 1 ? "Less shrinkage" : "Uniform (Standard)"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function Modelling() {
  const { state, setField } = useAppState();
  const workflowId = state.workflowId;

  // ─── Step 1: Model Level (HCP vs DMA) ─────────────────────────────────────
  const [modelLevel, setModelLevel] = useState("HCP"); // "HCP" | "DMA"

  // ─── Step 2: Datasets (From Saved Module 5 Transformation Sets) ────────────
  const savedTransformationSets = useMemo(() => {
    return state.savedTransformationSets || [];
  }, [state.savedTransformationSets]);

  const filteredDatasets = useMemo(() => {
    if (!savedTransformationSets.length) return [];
    return savedTransformationSets.filter((d) => {
      const g = (d.grain || "").toUpperCase();
      const n = (d.name || "").toUpperCase();
      if (modelLevel === "HCP") return g === "HCP" || (!g.includes("DMA") && !n.includes("DMA"));
      return g.includes("DMA") || n.includes("DMA");
    });
  }, [savedTransformationSets, modelLevel]);

  const [selectedDatasetName, setSelectedDatasetName] = useState("");
  const [datasetCsv, setDatasetCsv] = useState("");
  const [activeTransformedSet, setActiveTransformedSet] = useState(null);

  // Metadata populated from selected transformed dataset
  const [datasetCols, setDatasetCols] = useState([]);
  const [dateCol, setDateCol] = useState(state.dateColumn || "week_end_date");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "npi_id");
  const [depVarCandidates, setDepVarCandidates] = useState(["trx", "crx", "nbrx"]);
  const [depVar, setDepVar] = useState("trx");
  const [availableChannels, setAvailableChannels] = useState([]);
  const [selectedChannels, setSelectedChannels] = useState([]);
  const [startDate, setStartDate] = useState(state.modellingStartDate || "2026-01-04");
  const [endDate, setEndDate] = useState(state.modellingEndDate || "2026-12-31");
  const [minDate, setMinDate] = useState("");
  const [maxDate, setMaxDate] = useState("");

  // Auto-select first matching dataset on load or level change
  useEffect(() => {
    if (filteredDatasets.length > 0) {
      if (!selectedDatasetName || !filteredDatasets.some((d) => d.name === selectedDatasetName)) {
        setSelectedDatasetName(filteredDatasets[0].name);
      }
    } else {
      setSelectedDatasetName("");
      setDatasetCsv("");
      setActiveTransformedSet(null);
    }
  }, [filteredDatasets, modelLevel]);

  // Handle Level Switch
  const handleModelLevelChange = (newLevel) => {
    if (newLevel === modelLevel) return;
    setModelLevel(newLevel);
    setSelectedDatasetName("");
    setDatasetCsv("");
    setActiveTransformedSet(null);
    setSelectedChannels([]);
    setStage1Result(null);
    toast(`Switched model level to ${newLevel}.`, { icon: "ℹ️" });
  };

  // When a Transformation Dataset is Selected: Load all candidate KPIs and IVs
  useEffect(() => {
    if (!selectedDatasetName) return;
    const targetSet = filteredDatasets.find((d) => d.name === selectedDatasetName) || filteredDatasets[0];
    if (!targetSet) return;

    setActiveTransformedSet(targetSet);
    const csv = targetSet.csv_data || state.transformedCsvData || "";
    setDatasetCsv(csv);

    // Populate Key metadata from the saved Transformation Set
    const dCol = targetSet.dateColumn || targetSet.timeVars?.[0] || "week_end_date";
    const gCol = targetSet.geoColumn || targetSet.crossVars?.[0] || (modelLevel === "DMA" ? "dma_id" : "npi_id");
    setDateCol(dCol);
    setGeoCol(gCol);

    // Dependent Variables Candidates: Inherit all checked KPIs from Transformation
    let dvList = [];
    if (targetSet.depVars && targetSet.depVars.length > 0) {
      dvList = targetSet.depVars;
    } else if (targetSet.columns) {
      dvList = targetSet.columns.filter((c) => /trx|crx|nbrx|sale|revenue|kpi/i.test(c) && !c.endsWith("_transformed"));
    }
    if (!dvList.length) dvList = ["trx", "crx", "nbrx"];
    
    setDepVarCandidates(dvList);
    const initialDep = targetSet.dependentVariable && dvList.includes(targetSet.dependentVariable)
      ? targetSet.dependentVariable
      : dvList[0];
    setDepVar(initialDep);

    // Independent Variables: Promotional features from Transformation Table
    let ivs = [];
    if (targetSet.transformed_channels?.length) {
      ivs = targetSet.transformed_channels;
    } else if (targetSet.columns?.length) {
      ivs = targetSet.columns.filter((c) => c.endsWith("_transformed") || c === "Carryover");
    } else if (targetSet.configs?.length) {
      ivs = targetSet.configs.map((c) => `${c["Channel Name"]}_transformed`);
      if (targetSet.addCarryover) ivs.push("Carryover");
    }

    if (!ivs.length) {
      ivs = ["calls_transformed", "rte_transformed", "samples_transformed", "speaker_transformed"];
    }

    // Exclude selected dependent variable from independent channels
    const safeIvs = ivs.filter((c) => c !== initialDep && c !== `${initialDep}_transformed`);
    setAvailableChannels(safeIvs);
    setSelectedChannels(safeIvs);

    // Parse date boundaries from CSV
    if (csv) {
      try {
        const lines = csv.trim().split("\n");
        const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        setDatasetCols(header);
        const dateIdx = header.indexOf(dCol);
        if (dateIdx !== -1 && lines.length > 2) {
          const d1 = lines[1].split(",")[dateIdx]?.trim().replace(/^["']|["']$/g, "");
          const dLast = lines[lines.length - 1].split(",")[dateIdx]?.trim().replace(/^["']|["']$/g, "");
          if (d1) { setStartDate(d1); setMinDate(d1); }
          if (dLast) { setEndDate(dLast); setMaxDate(dLast); }
        }
      } catch (e) {}
    }
  }, [selectedDatasetName, filteredDatasets, modelLevel]);

  // Dynamically update available IVs when Target KPI changes
  const handleDependentVariableChange = (newDep) => {
    setDepVar(newDep);
    if (activeTransformedSet) {
      let rawIvs = activeTransformedSet.transformed_channels || [];
      if (!rawIvs.length && activeTransformedSet.columns) {
        rawIvs = activeTransformedSet.columns.filter((c) => c.endsWith("_transformed") || c === "Carryover");
      }
      const safeIvs = rawIvs.filter((c) => c !== newDep && c !== `${newDep}_transformed`);
      setAvailableChannels(safeIvs);
      setSelectedChannels((prev) => prev.filter((c) => c !== newDep && c !== `${newDep}_transformed`));
    }
  };

  // ─── Step 3: Model Setup (Name, Type, Dates) ──────────────────────────────
  const [modelName, setModelName] = useState(() => `${modelLevel} Marketing Mix Model v1`);
  const [modelType, setModelType] = useState("ols"); // "ols" | "ridge"

  // ─── DMA Configuration (Standalone vs Residual) ───────────────────────────
  const [dmaMode, setDmaMode] = useState("standalone");
  const [sourceHcpModelId, setSourceHcpModelId] = useState("");

  // ─── Ridge Configuration ──────────────────────────────────────────────────
  const [alphaMode, setAlphaMode] = useState("auto");
  const [manualAlpha, setManualAlpha] = useState(1.0);
  const [cvSplits, setCvSplits] = useState(5);
  const [positiveCoef, setPositiveCoef] = useState(false);
  const [useCustomPenalties, setUseCustomPenalties] = useState(false);
  const [priorWeights, setPriorWeights] = useState({});

  useEffect(() => {
    const initWeights = {};
    availableChannels.forEach((ch) => { initWeights[ch] = 1.0; });
    setPriorWeights(initWeights);
  }, [availableChannels]);

  // ─── Execution State & Results ────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [stage1Result, setStage1Result] = useState(null);

  // Model History State
  const [modelHistory, setModelHistory] = useState(() => state.regressionOutputs || []);
  const [activeLoadedModelId, setActiveLoadedModelId] = useState(null);

  const completedHcpModels = useMemo(() => {
    return modelHistory.filter((m) => m.modelLevel === "HCP" && m.status === "complete");
  }, [modelHistory]);

  const isDuplicateModelName = useMemo(() => {
    return modelHistory.some(
      (m) => m.modelName?.trim().toLowerCase() === modelName?.trim().toLowerCase() && m.id !== activeLoadedModelId
    );
  }, [modelHistory, modelName, activeLoadedModelId]);

  const isReadyForStage1 = useMemo(() => {
    if (!datasetCsv) return false;
    if (!modelName.trim() || isDuplicateModelName) return false;
    if (!depVar) return false;
    if (selectedChannels.length === 0) return false;
    if (modelLevel === "DMA" && dmaMode === "residual" && !sourceHcpModelId) return false;
    return true;
  }, [datasetCsv, modelName, isDuplicateModelName, depVar, selectedChannels, modelLevel, dmaMode, sourceHcpModelId]);

  // ─── Execute Regression (Stage 1) ─────────────────────────────────────────
  const handleRunStage1 = async () => {
    if (!isReadyForStage1) return toast.error("Complete required configuration before running.");

    setLoading(true);

    const targetCsv = datasetCsv;
    const effectiveGranularCsv = state.granularCsvData || targetCsv;

    const basePayload = {
      transformed_csv: targetCsv,
      granular_csv: effectiveGranularCsv,
      date_column: dateCol,
      geo_column: geoCol,
      dependent_variable: depVar,
      dependent_variable_user_input: depVar,
      selected_channels: selectedChannels,
      start_date: startDate,
      end_date: endDate,
    };

    try {
      let data;
      if (modelType === "ols") {
        data = await runRegression(basePayload);
        data.model_type = `OLS Stage 1 (${modelLevel}${modelLevel === "DMA" ? ` - ${dmaMode}` : ""})`;
      } else {
        data = await runRidge({
          ...basePayload,
          stage: 1,
          alpha_mode: alphaMode,
          manual_alpha: manualAlpha,
          cv_splits: cvSplits,
          positive_coef: positiveCoef,
          use_custom_penalties: useCustomPenalties,
          prior_weights: priorWeights,
        });
        data.model_type = `Ridge Stage 1 (${modelLevel}${modelLevel === "DMA" ? ` - ${dmaMode}` : ""})`;
      }

      setStage1Result(data);

      const historyEntry = {
        id: `mod_${Date.now()}`,
        modelName: modelName.trim(),
        modelLevel,
        dataset: selectedDatasetName || "Transformed Dataset",
        modelType: modelType.toUpperCase(),
        dmaMode: modelLevel === "DMA" ? dmaMode : null,
        sourceHcpModel: modelLevel === "DMA" && dmaMode === "residual" ? sourceHcpModelId : null,
        targetKpi: depVar,
        dateRange: `${startDate} → ${endDate}`,
        startDate,
        endDate,
        variablesSelected: [depVar, ...selectedChannels],
        channels: selectedChannels,
        timestamp: new Date().toISOString(),
        status: "complete",
        r_squared: data.r_squared,
        adj_r_squared: data.adj_r_squared,
        rmse: data.rmse,
        alpha: data.alpha ?? null,
        coefficients: data.coefficients,
        summary: data.summary,
        cv_results: data.cv_results || [],
        alphaMode,
        manualAlpha,
        cvSplits,
        positiveCoef,
        useCustomPenalties,
        priorWeights,
      };

      const updatedHistory = [historyEntry, ...modelHistory.filter((m) => m.id !== historyEntry.id)];
      setModelHistory(updatedHistory);
      setActiveLoadedModelId(historyEntry.id);
      setField("regressionOutputs", updatedHistory);
      setField("selectedChannels", selectedChannels);
      setField("modellingStartDate", startDate);
      setField("modellingEndDate", endDate);

      toast.success(`Regression Complete — R² = ${data.r_squared?.toFixed(4)} (${depVar})`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Regression execution failed");
    } finally {
      setLoading(false);
    }
  };

  // ─── Click on Model History Row: Load Configuration & View Results ─────────
  const handleLoadModelFromHistory = (m) => {
    setActiveLoadedModelId(m.id);
    setModelLevel(m.modelLevel || "HCP");

    if (m.dataset && filteredDatasets.some((d) => d.name === m.dataset)) {
      setSelectedDatasetName(m.dataset);
    }

    setModelName(m.modelName || "");
    setModelType((m.modelType || "ols").toLowerCase());
    if (m.dmaMode) setDmaMode(m.dmaMode);
    if (m.sourceHcpModel) setSourceHcpModelId(m.sourceHcpModel);
    if (m.targetKpi) setDepVar(m.targetKpi);

    if (m.startDate) setStartDate(m.startDate);
    if (m.endDate) setEndDate(m.endDate);
    else if (m.dateRange && m.dateRange.includes("→")) {
      const [s, e] = m.dateRange.split("→").map((x) => x.trim());
      if (s) setStartDate(s);
      if (e) setEndDate(e);
    }

    if (m.channels && m.channels.length > 0) {
      setSelectedChannels(m.channels);
    } else if (m.variablesSelected && m.variablesSelected.length > 0) {
      const ivs = m.variablesSelected.filter((v) => v !== m.targetKpi && v !== `${m.targetKpi}_transformed`);
      setSelectedChannels(ivs);
    }

    if (m.alphaMode) setAlphaMode(m.alphaMode);
    if (m.manualAlpha) setManualAlpha(m.manualAlpha);
    if (m.cvSplits) setCvSplits(m.cvSplits);
    if (m.positiveCoef !== undefined) setPositiveCoef(m.positiveCoef);
    if (m.useCustomPenalties !== undefined) setUseCustomPenalties(m.useCustomPenalties);
    if (m.priorWeights) setPriorWeights(m.priorWeights);

    // Restore results & summary immediately to the view
    setStage1Result({
      model_type: `${m.modelType} (${m.modelLevel})`,
      r_squared: m.r_squared,
      adj_r_squared: m.adj_r_squared,
      rmse: m.rmse,
      alpha: m.alpha,
      coefficients: m.coefficients || [],
      summary: m.summary || "",
      cv_results: m.cv_results || [],
    });

    window.scrollTo({ top: 400, behavior: "smooth" });
    toast.success(`Loaded configuration & results for "${m.modelName}"`);
  };

  const renderCoeffTable = (result, title) => result && (
    <Card title={title}>
      <DataTable data={result.coefficients?.map((row) => ({
        Variable: row.Variable,
        Coefficient: typeof row.Coefficient === "number" ? row.Coefficient.toFixed(6) : row.Coefficient,
        "Impactable (%)": row["Impactable (%)"],
        "Impactable Sales": typeof row["Impactable Sales"] === "number"
          ? row["Impactable Sales"].toLocaleString(undefined, { maximumFractionDigits: 0 })
          : row["Impactable Sales"],
        Note: row.Note || "",
      }))} />
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 6: Marketing Mix Modelling"
        subtitle="Configure HCP or DMA models from saved Transformation sets across OLS and Ridge regressions with standalone or residual workflows and interactive model history"
        icon="🤖"
      />

      {/* ─── Step 1: Select Model Level ───────────────────────────────────── */}
      <Card title="Step 1 — Select Model Level">
        <div className="grid grid-cols-2 max-w-md gap-3">
          {[
            { id: "HCP", label: "HCP-Level Modelling", icon: "🩺", desc: "Physician & Rep grain models" },
            { id: "DMA", label: "DMA-Level Modelling", icon: "📡", desc: "Designated Market Area grain models" },
          ].map((lvl) => (
            <button
              key={lvl.id}
              type="button"
              onClick={() => handleModelLevelChange(lvl.id)}
              className={`p-4 rounded-2xl border-2 text-left transition-all ${
                modelLevel === lvl.id
                  ? "border-[#001E96] bg-brand-50/60 shadow-sm"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <span className="text-2xl block mb-1">{lvl.icon}</span>
              <strong className="text-sm text-slate-800 block">{lvl.label}</strong>
              <span className="text-[11px] text-slate-500">{lvl.desc}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* ─── Step 2: Transformed Dataset Selection ────────────────────────── */}
      <Card title={`Step 2 — ${modelLevel} Transformed Dataset Selection`}>
        <div className="space-y-4">
          <div className="max-w-xl">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Select Transformed {modelLevel} Dataset *
            </label>
            <select
              value={selectedDatasetName}
              onChange={(e) => setSelectedDatasetName(e.target.value)}
              className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-4 py-3 bg-white text-slate-800 focus:outline-none"
            >
              {filteredDatasets.length === 0 ? (
                <option value="">-- No {modelLevel} Transformed Sets Found (Complete Module 5 First) --</option>
              ) : (
                filteredDatasets.map((d) => (
                  <option key={d.name} value={d.name}>
                    🏷️ {d.name} ({d.grain || modelLevel} • {d.columnsCount || d.columns?.length || 0} columns)
                  </option>
                ))
              )}
            </select>
          </div>

          {datasetCsv && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
              <div>
                <span className="text-slate-400 font-bold block uppercase text-[10px]">Date Column</span>
                <strong className="text-slate-800 font-mono">{dateCol || "week_end_date"}</strong>
              </div>
              <div>
                <span className="text-slate-400 font-bold block uppercase text-[10px]">Geography Column</span>
                <strong className="text-slate-800 font-mono">{geoCol || "npi_id"}</strong>
              </div>
              <div>
                <span className="text-slate-400 font-bold block uppercase text-[10px]">Target Sales KPI Candidate(s)</span>
                <strong className="text-brand-700 font-bold">
                  {depVar} <span className="text-[10px] font-normal text-slate-500">({depVarCandidates.length} available: {depVarCandidates.join(", ")})</span>
                </strong>
              </div>
              <div>
                <span className="text-slate-400 font-bold block uppercase text-[10px]">Transformed IVs</span>
                <strong className="text-slate-800">{availableChannels.length} tactics ready</strong>
              </div>
            </div>
          )}

          {!datasetCsv && (
            <Alert type="warning">
              No saved {modelLevel} transformation sets found. Go to <strong>Data Transformation</strong>, save your set (e.g. <code>{modelLevel === "HCP" ? "HCP FINAL ARD" : "DMA FINAL ARD"}</code>), and return here.
            </Alert>
          )}
        </div>
      </Card>

      {/* Downstream Configuration Sections */}
      <div className={!datasetCsv ? "opacity-40 pointer-events-none select-none" : "space-y-6"}>
        {/* ─── Step 3: Model Setup ────────────────────────────────────────── */}
        <Card title="Step 3 — Model Setup">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="lg:col-span-2">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Model Name *
              </label>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g. HCP OLS Baseline Model"
                className={`w-full text-xs font-bold border rounded-xl px-3.5 py-2.5 bg-white focus:outline-none focus:ring-2 ${
                  isDuplicateModelName
                    ? "border-red-500 focus:ring-red-400 text-red-700 bg-red-50/20"
                    : "border-slate-200 focus:ring-brand-500 text-slate-800"
                }`}
              />
              {isDuplicateModelName && (
                <span className="text-[11px] text-red-600 font-bold mt-1 block">
                  ⚠️ A model with this name already exists in Model History.
                </span>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                min={minDate}
                max={maxDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full text-xs font-semibold border border-slate-200 rounded-xl px-3.5 py-2.5 bg-white text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                min={minDate}
                max={maxDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full text-xs font-semibold border border-slate-200 rounded-xl px-3.5 py-2.5 bg-white text-slate-800"
              />
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
              Model Type *
            </label>
            <div className="flex flex-wrap gap-4 items-center">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                <input
                  type="radio"
                  name="modelType"
                  value="ols"
                  checked={modelType === "ols"}
                  onChange={() => setModelType("ols")}
                  className="accent-[#001E96]"
                />
                <span>OLS (Ordinary Least Squares)</span>
              </label>

              <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                <input
                  type="radio"
                  name="modelType"
                  value="ridge"
                  checked={modelType === "ridge"}
                  onChange={() => setModelType("ridge")}
                  className="accent-[#001E96]"
                />
                <span>Ridge Regression ($L_2$ Regularization)</span>
              </label>

              <label className="flex items-center gap-2 text-xs font-bold text-slate-400 cursor-not-allowed opacity-60">
                <input
                  type="radio"
                  name="modelType"
                  value="bayesian"
                  disabled
                />
                <span>Bayesian MMM</span>
                <span className="bg-amber-100 text-amber-800 text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                  Coming Soon
                </span>
              </label>
            </div>
          </div>
        </Card>

        {/* ─── DMA Configuration Section (Only for DMA Level) ──────────────── */}
        {modelLevel === "DMA" && (
          <Card title="DMA Configuration Mode">
            <div className="space-y-4">
              <div className="flex gap-6 items-center">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="dmaMode"
                    value="standalone"
                    checked={dmaMode === "standalone"}
                    onChange={() => setDmaMode("standalone")}
                    className="accent-[#001E96]"
                  />
                  <span>Standalone DMA Model</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="dmaMode"
                    value="residual"
                    checked={dmaMode === "residual"}
                    onChange={() => setDmaMode("residual")}
                    className="accent-[#001E96]"
                  />
                  <span>Residual DMA Model (Sales − Predicted HCP Sales)</span>
                </label>
              </div>

              {dmaMode === "residual" && (
                <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3 max-w-xl">
                  <span className="text-xs font-bold text-blue-950 block">
                    Select Completed Source HCP Model *
                  </span>
                  <select
                    value={sourceHcpModelId}
                    onChange={(e) => setSourceHcpModelId(e.target.value)}
                    className="w-full text-xs font-bold border border-blue-300 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
                  >
                    <option value="">-- Choose Completed HCP Model --</option>
                    {completedHcpModels.map((m) => (
                      <option key={m.id} value={m.modelName}>
                        🏆 {m.modelName} (R² = {m.r_squared?.toFixed(3)} • {m.dateRange})
                      </option>
                    ))}
                  </select>

                  {completedHcpModels.length === 0 && (
                    <p className="text-[11px] text-red-600 font-bold">
                      ⚠️ No completed HCP models available in Model History. Run an HCP Model first to enable Residual DMA modelling.
                    </p>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}

        {/* ─── Ridge Configuration Section (Only for Ridge Model Type) ──────── */}
        {modelType === "ridge" && (
          <Card title="Ridge Configuration">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Alpha Selection Strategy
                </label>
                <div className="flex gap-4 text-xs font-bold mb-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={alphaMode === "auto"} onChange={() => setAlphaMode("auto")} className="accent-[#001E96]" />
                    <span>Auto (Time-Series Cross Validation)</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={alphaMode === "manual"} onChange={() => setAlphaMode("manual")} className="accent-[#001E96]" />
                    <span>Manual Alpha</span>
                  </label>
                </div>

                {alphaMode === "manual" ? (
                  <div>
                    <label className="block text-[11px] text-slate-500 font-bold mb-1">Manual Regularization Alpha (λ):</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0.0001"
                      value={manualAlpha}
                      onChange={(e) => setManualAlpha(parseFloat(e.target.value))}
                      className="w-40 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-white"
                    />
                  </div>
                ) : (
                  <div>
                    <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                      <span>CV Folds: {cvSplits}</span>
                      <span className="text-[11px] text-slate-400 font-mono">Grid: {ALPHA_GRID}</span>
                    </div>
                    <input
                      type="range"
                      min="2"
                      max="10"
                      value={cvSplits}
                      onChange={(e) => setCvSplits(parseInt(e.target.value))}
                      className="w-full"
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Regularization Constraints
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={positiveCoef}
                    onChange={(e) => setPositiveCoef(e.target.checked)}
                    className="rounded text-brand-600"
                  />
                  <span>Enforce Non-Negative Marketing Coefficients ($\beta_i \ge 0$)</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useCustomPenalties}
                    onChange={(e) => setUseCustomPenalties(e.target.checked)}
                    className="rounded text-brand-600"
                  />
                  <span>Enable Custom Prior Shrinkage Weights Per Channel</span>
                </label>
              </div>
            </div>

            {useCustomPenalties && selectedChannels.length > 0 && (
              <RidgePriorWeights channels={selectedChannels} weights={priorWeights} onChange={updatePriorWeight} />
            )}
          </Card>
        )}

        {/* ─── Step 4: Variable Selection (From Transformation Output) ──────── */}
        <Card title="Step 4 — Variable Selection (From Transformed Set)">
          <div className="space-y-4">
            <div className="max-w-md">
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Dependent Variable (Target Sales KPI) *
                </label>
                <span className="text-[10px] font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full border border-brand-200">
                  {depVarCandidates.length} candidate(s) from Transformation
                </span>
              </div>
              <select
                value={depVar}
                onChange={(e) => handleDependentVariableChange(e.target.value)}
                className="w-full text-xs font-bold border-2 border-slate-300 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none focus:border-brand-500"
              >
                {depVarCandidates.map((c) => (
                  <option key={c} value={c}>
                    🎯 {c} {c === depVar ? "(Active Target)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                Independent Variables (Transformed Marketing Promotions) * ({selectedChannels.length} selected)
              </label>
              <div className="flex flex-wrap gap-2">
                {availableChannels.map((ch) => {
                  const isChecked = selectedChannels.includes(ch);
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => {
                        setSelectedChannels(isChecked ? selectedChannels.filter((c) => c !== ch) : [...selectedChannels, ch]);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border ${
                        isChecked
                          ? "bg-[#001E96] text-white border-[#001E96] shadow-sm"
                          : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <span>{isChecked ? "✓" : "+"}</span> {ch.replace("_transformed", "")}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>

        {/* ─── Run Regression Button Card ──────────────────────────────────── */}
        <Card>
          <div className="flex justify-between items-center flex-wrap gap-4">
            <div>
              <span className="text-xs font-bold text-slate-800 block">
                Ready to run {modelLevel} {modelType.toUpperCase()} {modelLevel === "DMA" ? `(${dmaMode})` : ""}
              </span>
              <span className="text-[11px] text-slate-500">
                {selectedChannels.length} transformed tactics regressed against {depVar}
              </span>
            </div>
            <Btn
              onClick={handleRunStage1}
              disabled={loading || !isReadyForStage1}
              className="py-3 px-8 text-xs font-bold uppercase tracking-wider bg-brand-600 hover:bg-brand-700"
            >
              {loading ? "Running Regression…" : `▶ Run Regression`}
            </Btn>
          </div>
        </Card>

        {loading && <Spinner label="Calculating regression model..." />}

        {/* ─── Regression Results Display ──────────────────────────────────── */}
        {stage1Result && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Metric label="R² (Fit)" value={stage1Result.r_squared?.toFixed(4)} />
              <Metric label="Adjusted R²" value={stage1Result.adj_r_squared?.toFixed(4)} />
              <Metric label="RMSE" value={stage1Result.rmse?.toFixed(2)} />
              {stage1Result.alpha != null ? (
                <Metric label="Best Regularization Alpha" value={String(stage1Result.alpha)} />
              ) : (
                <Metric label="Modelling Period" value={`${startDate} → ${endDate}`} />
              )}
            </div>

            {renderCoeffTable(stage1Result, "Estimated Coefficients & Impactable Attribution")}

            {stage1Result.cv_results?.length > 0 && (
              <Card title="Cross-Validation Results (CV Split Scores)">
                <DataTable data={stage1Result.cv_results} />
              </Card>
            )}

            <Card title="OLS Regression Statistical Summary">
              <pre className="text-xs text-slate-600 bg-slate-50 rounded-xl p-4 overflow-auto whitespace-pre-wrap font-mono leading-relaxed max-h-80">
                {stage1Result.summary || "No summary text available."}
              </pre>
            </Card>
          </div>
        )}

        {/* ─── Interactive Model History & Iteration Registry ──────────────── */}
        <Card title="Model History & Iteration Registry">
          <p className="text-xs text-slate-500 mb-4">
            Click any model name below to load its exact configuration, variables, and summary back into the screen for editing and review.
          </p>

          {modelHistory.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No models executed yet. Configure and run a model above.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-96">
              <table className="w-full text-xs text-left bg-white">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-3">Model Name</th>
                    <th className="px-3 py-3">Level</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Target KPI</th>
                    <th className="px-3 py-3">R²</th>
                    <th className="px-3 py-3">Adj. R²</th>
                    <th className="px-3 py-3">RMSE</th>
                    <th className="px-3 py-3">Training Window</th>
                    <th className="px-3 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {modelHistory.map((m) => {
                    const isSelected = activeLoadedModelId === m.id;
                    return (
                      <tr
                        key={m.id}
                        onClick={() => handleLoadModelFromHistory(m)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? "bg-brand-50/70 border-l-4 border-brand-600" : "hover:bg-slate-50"
                        }`}
                        title="Click to load configuration & view summary"
                      >
                        <td className="px-3 py-2.5 font-bold text-brand-700 underline flex items-center gap-1.5">
                          <span>🔍</span>
                          <span>{m.modelName}</span>
                          {m.sourceHcpModel && (
                            <span className="block text-[10px] text-blue-600 font-normal no-underline">
                              (Src: {m.sourceHcpModel})
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            m.modelLevel === "HCP" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"
                          }`}>
                            {m.modelLevel}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-semibold text-slate-700">{m.modelType}</td>
                        <td className="px-3 py-2 font-bold text-slate-800">{m.targetKpi || "trx"}</td>
                        <td className="px-3 py-2 font-bold text-brand-700">{m.r_squared?.toFixed(4) ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-700">{m.adj_r_squared?.toFixed(4) ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-700">{m.rmse?.toFixed(2) ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-500 font-mono text-[11px]">{m.dateRange}</td>
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            ✓ Complete
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}