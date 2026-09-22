import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  runRegression, runRidge, v2ListArds, v2GetCsv,
  correlationMatrix, computeVIF, getHighCorrPairs, findClusters, applyCombination
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Metric } from "../components/UI";

const NON_PROMO_KEYWORDS = [
  "npi", "dma", "geo", "id", "state", "name", "zip", "city", "fips", "code",
  "county", "market", "region", "territory", "population", "pop", "universe",
  "date", "week", "month", "year", "period", "time", "day", "quarter",
  "target", "trx", "crx", "nbrx", "sale", "sales", "revenue", "kpi"
];

function isPromotionalChannel(colName, depVarList = []) {
  if (!colName) return false;
  const l = colName.toLowerCase().trim();

  if (depVarList.some((d) => d.toLowerCase() === l || `${d.toLowerCase()}_transformed` === l)) {
    return false;
  }

  if (l.endsWith("_transformed") || l.startsWith("combo_") || l.startsWith("sum_") || l.startsWith("weighted_sum_")) {
    if (NON_PROMO_KEYWORDS.some((kw) => l.startsWith(`${kw}_`) || l === `${kw}_transformed`)) {
      return false;
    }
    return true;
  }

  if (NON_PROMO_KEYWORDS.some((kw) => l === kw || l.startsWith(`${kw}_`) || l.endsWith(`_${kw}`) || l.includes(`_${kw}_`))) {
    return false;
  }

  return true;
}

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
            <span className="truncate font-bold text-slate-700" title={ch}>{ch}</span>
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

  const savedTransformationSets = useMemo(() => state.savedTransformationSets || [], [state.savedTransformationSets]);

  const [availableDatasets, setAvailableDatasets] = useState([]);
  const [selectedDatasetName, setSelectedDatasetName] = useState("");
  const [datasetCsv, setDatasetCsv] = useState("");
  const [backupDatasetCsv, setBackupDatasetCsv] = useState(null);

  useEffect(() => {
    if (!workflowId) return;
    v2ListArds(workflowId)
      .then((res) => setAvailableDatasets(res.items || []))
      .catch(() => {});
  }, [workflowId]);

  const allAvailableSets = useMemo(() => {
    if (savedTransformationSets.length > 0) {
      return savedTransformationSets.map((s) => ({
        id: s.name,
        name: s.name,
        filename: s.name,
        grain: s.grain || "HCP",
        columns: s.columns || [],
        csv_data: s.csv_data,
        sourceType: "transformation_set",
      }));
    }
    return availableDatasets.map((a) => ({
      id: a.filename,
      name: a.filename.replace(/\.csv$/i, ""),
      filename: a.filename,
      grain: a.grain || (a.filename.toLowerCase().includes("dma") ? "DMA" : "HCP"),
      columns: a.columns || [],
      sourceType: "ard_table",
    }));
  }, [savedTransformationSets, availableDatasets]);

  useEffect(() => {
    if (allAvailableSets.length > 0 && !selectedDatasetName) {
      setSelectedDatasetName(allAvailableSets[0].name);
    }
  }, [allAvailableSets, selectedDatasetName]);

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

  const [modelLevel, setModelLevel] = useState("HCP");
  const [modelTimeGrain, setModelTimeGrain] = useState("Weekly");

  useEffect(() => {
    if (!selectedDatasetName || !allAvailableSets.length) return;
    const targetSet = allAvailableSets.find((d) => d.name === selectedDatasetName) || allAvailableSets[0];
    if (!targetSet) return;

    setBackupDatasetCsv(null);

    const parseAndFilter = (csv) => {
      setDatasetCsv(csv);
      setBackupDatasetCsv(csv);
      try {
        const lines = csv.trim().split("\n");
        const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        setDatasetCols(header);

        const dCol = header.find((c) => /date|week|month|period/i.test(c)) || header[0] || "week_end_date";
        setDateCol(dCol);

        const gCol = header.find((c) => modelLevel === "DMA" ? /dma/i.test(c) : /npi|hcp|geo|id/i.test(c)) || header[1] || header[0];
        setGeoCol(gCol);

        const dvList = header.filter((c) => /trx|crx|nbrx|sale|revenue|kpi/i.test(c) && !c.endsWith("_transformed"));
        const activeDvList = dvList.length > 0 ? dvList : ["trx", "crx", "nbrx"];
        setDepVarCandidates(activeDvList);
        const initialDep = activeDvList[0] || "trx";
        setDepVar(initialDep);

        // Show ALL modeling variables (both raw and transformed, excluding IDs, Dates & Target KPI)
        const allModelingVariables = header.filter((c) => {
          const l = c.toLowerCase();
          if (l === dCol.toLowerCase() || l === gCol.toLowerCase()) return false;
          if (l === initialDep.toLowerCase() || l === `${initialDep.toLowerCase()}_transformed`) return false;
          return isPromotionalChannel(c, [initialDep]);
        });

        setAvailableChannels(allModelingVariables);
        setSelectedChannels(allModelingVariables);

        if (lines.length > 2) {
          const dateIdx = header.indexOf(dCol);
          if (dateIdx !== -1) {
            const d1 = lines[1].split(",")[dateIdx]?.trim().replace(/^["']|["']$/g, "");
            const dLast = lines[lines.length - 1].split(",")[dateIdx]?.trim().replace(/^["']|["']$/g, "");
            if (d1) { setStartDate(d1); setMinDate(d1); }
            if (dLast) { setEndDate(dLast); setMaxDate(dLast); }
          }
        }
      } catch (e) {}
    };

    if (targetSet.csv_data) {
      parseAndFilter(targetSet.csv_data);
    } else if (workflowId && targetSet.filename) {
      v2GetCsv(workflowId, targetSet.filename)
        .then(parseAndFilter)
        .catch(() => {});
    }
  }, [selectedDatasetName, allAvailableSets, workflowId, modelLevel]);

  const [modelName, setModelName] = useState("HCP OLS Model v1");
  const [modelType, setModelType] = useState("ols");
  const [modelMode, setModelMode] = useState("standalone");
  const [manualAlpha, setManualAlpha] = useState(1.0);
  const [positiveCoef, setPositiveCoef] = useState(false);
  const [useCustomPenalties, setUseCustomPenalties] = useState(false);
  const [priorWeights, setPriorWeights] = useState({});

  useEffect(() => {
    const initWeights = {};
    availableChannels.forEach((ch) => { initWeights[ch] = 1.0; });
    setPriorWeights(initWeights);
  }, [availableChannels]);

  const [loading, setLoading] = useState(false);
  const [stage1Result, setStage1Result] = useState(null);
  const [modelHistory, setModelHistory] = useState(() => state.regressionOutputs || []);

  const [postCorrThreshold, setPostCorrThreshold] = useState(0.70);
  const [postCorrMatrix, setPostCorrMatrix] = useState(null);
  const [postHighPairs, setPostHighPairs] = useState([]);
  const [vifTable, setVifTable] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [foundClusters, setFoundClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [comboLoading, setComboLoading] = useState(false);
  const [combinationSuccessMsg, setCombinationSuccessMsg] = useState("");

  const handleRunRegression = async () => {
    setLoading(true);
    setCombinationSuccessMsg("");
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
        data.model_type = `OLS (${modelLevel})`;
      } else {
        data = await runRidge({
          ...basePayload,
          stage: 1,
          alpha_mode: "manual",
          manual_alpha: manualAlpha,
          positive_coef: positiveCoef,
          use_custom_penalties: useCustomPenalties,
          prior_weights: priorWeights,
        });
        data.model_type = `Ridge (${modelLevel})`;
      }

      setStage1Result(data);

      const historyEntry = {
        id: `mod_${Date.now()}`,
        modelName: modelName.trim(),
        modelLevel,
        modelTimeGrain,
        modelType: modelType.toUpperCase(),
        modelMode,
        targetKpi: depVar,
        dateRange: `${startDate} → ${endDate}`,
        channels: selectedChannels,
        timestamp: new Date().toISOString(),
        status: "complete",
        r_squared: data.r_squared,
        adj_r_squared: data.adj_r_squared,
        rmse: data.rmse,
        coefficients: data.coefficients,
        summary: data.summary,
      };

      const updatedHistory = [historyEntry, ...modelHistory.filter((m) => m.id !== historyEntry.id)];
      setModelHistory(updatedHistory);
      setField("regressionOutputs", updatedHistory);
      toast.success(`Regression Complete — R² = ${data.r_squared?.toFixed(4)}`);
    } catch (err) {
      toast.error(err.response?.data?.error || "Regression failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckCollinearity = async () => {
    if (!datasetCsv || selectedChannels.length < 2) {
      return toast.error("At least 2 channels must be selected.");
    }
    setDiagLoading(true);
    try {
      const mRes = await correlationMatrix({
        csv_data: datasetCsv,
        columns: selectedChannels,
        method: "pearson",
      });
      setPostCorrMatrix(mRes.matrix);

      const pRes = await getHighCorrPairs({
        csv_data: datasetCsv,
        columns: selectedChannels,
        threshold: postCorrThreshold,
      });
      setPostHighPairs(pRes.pairs || []);

      const clRes = await findClusters({
        csv_data: datasetCsv,
        columns: selectedChannels,
        threshold: postCorrThreshold,
      });
      const clusters = clRes.clusters || [];
      setFoundClusters(clusters);
      setClusterNames(
        clusters.map((pair) => `SUM_${pair[0].replace("_transformed", "").toUpperCase()}_${pair[1].replace("_transformed", "").toUpperCase()}`)
      );

      if (!pRes.pairs?.length) {
        toast.success(`No pairs with |r| ≥ ${postCorrThreshold}. Collinearity is clean!`);
      } else {
        toast(`Detected ${pRes.pairs.length} highly correlated pair(s).`, { icon: "⚠️" });
      }
    } catch (err) {
      toast.error("Failed to calculate correlation diagnostics");
    } finally {
      setDiagLoading(false);
    }
  };

  const handleComputeVIFScores = async () => {
    if (!datasetCsv || selectedChannels.length < 2) return toast.error("Select at least 2 channels.");
    setDiagLoading(true);
    try {
      const vRes = await computeVIF({
        csv_data: datasetCsv,
        columns: selectedChannels,
      });
      setVifTable(vRes.vif || []);
      toast.success("VIF scores computed successfully");
    } catch (err) {
      toast.error("VIF calculation failed");
    } finally {
      setDiagLoading(false);
    }
  };

  const handleApplyVariableCombination = async () => {
    if (!foundClusters.length) return toast.error("No correlated pairs found to combine.");
    setComboLoading(true);
    try {
      const res = await applyCombination({
        csv_data: datasetCsv,
        columns: selectedChannels,
        clusters: foundClusters,
        new_names: clusterNames,
        method: "sum",
        drop_original: true,
      });

      const updatedCsv = res.csv_data;
      setDatasetCsv(updatedCsv);
      setField("transformedCsvData", updatedCsv);
      setField("granularCsvData", updatedCsv);

      const lines = updatedCsv.trim().split("\n");
      const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setDatasetCols(header);

      const updatedPromoTactics = header.filter((c) => isPromotionalChannel(c, depVarCandidates));
      setAvailableChannels(updatedPromoTactics);
      setSelectedChannels(updatedPromoTactics);

      setPostCorrMatrix(null);
      setPostHighPairs([]);
      setFoundClusters([]);
      setVifTable(null);

      const msg = `Successfully combined ${foundClusters.length} pair(s) into [${clusterNames.join(", ")}]. Dataset updated!`;
      setCombinationSuccessMsg(msg);
      toast.success(msg, { duration: 6000 });
    } catch (err) {
      toast.error(err.response?.data?.detail || "Variable combination failed");
    } finally {
      setComboLoading(false);
    }
  };

  const handleRevertCombinations = () => {
    if (!backupDatasetCsv) return toast.error("No original backup found.");

    setDatasetCsv(backupDatasetCsv);
    setField("transformedCsvData", backupDatasetCsv);
    setField("granularCsvData", backupDatasetCsv);

    const lines = backupDatasetCsv.trim().split("\n");
    const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    setDatasetCols(header);

    const originalPromoTactics = header.filter((c) => isPromotionalChannel(c, depVarCandidates));
    setAvailableChannels(originalPromoTactics);
    setSelectedChannels(originalPromoTactics);

    setPostCorrMatrix(null);
    setPostHighPairs([]);
    setFoundClusters([]);
    setVifTable(null);
    setCombinationSuccessMsg("");

    toast.success("Restored original variables & dataset.");
  };

  const hasCombinationsApplied = backupDatasetCsv && datasetCsv && datasetCsv !== backupDatasetCsv;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 6: Marketing Mix Modelling"
        subtitle="Configure OLS and Ridge models with P-values, confidence intervals, and full parameter estimation"
        icon="🤖"
      />

      {/* Step 1: Dataset & Granularity Selection */}
      <Card title="Step 1 — Select Dataset & Granularity">
        <div className="space-y-4">
          <div className="max-w-xl">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Select Dataset *
            </label>
            <select
              value={selectedDatasetName}
              onChange={(e) => setSelectedDatasetName(e.target.value)}
              className="w-full text-xs font-bold border-2 border-brand-500 rounded-xl px-4 py-3 bg-white text-slate-800 focus:outline-none"
            >
              {allAvailableSets.map((d) => (
                <option key={d.name} value={d.name}>
                  📄 {d.name} ({d.grain} • {d.columns?.length || 0} columns)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3 pt-3 border-t border-slate-200">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Model Cross-Sectional Entity (Grain):
              </label>
              <select
                value={modelLevel}
                onChange={(e) => setModelLevel(e.target.value)}
                className="w-full text-xs font-bold border rounded-xl px-3 py-2 bg-white focus:outline-none"
              >
                <option value="HCP">HCP Level (Physician / Prescriber)</option>
                <option value="DMA">DMA Level (Designated Market Area)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Model Time Period Granularity:
              </label>
              <select
                value={modelTimeGrain}
                onChange={(e) => setModelTimeGrain(e.target.value)}
                className="w-full text-xs font-bold border rounded-xl px-3 py-2 bg-white focus:outline-none"
              >
                <option value="Weekly">Weekly (Default)</option>
                <option value="Monthly">Monthly</option>
                <option value="Daily">Daily</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* Step 2: Model Setup */}
      <Card title="Step 2 — Model Setup">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">Model Name</label>
            <input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3.5 py-2.5 bg-white" />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">Model Algorithm</label>
            <div className="flex gap-4 items-center pt-2">
              <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                <input type="radio" checked={modelType === "ols"} onChange={() => setModelType("ols")} className="accent-[#001E96]" />
                OLS
              </label>
              <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                <input type="radio" checked={modelType === "ridge"} onChange={() => setModelType("ridge")} className="accent-[#001E96]" />
                Ridge ($L_2$)
              </label>
            </div>
          </div>
        </div>
      </Card>

      {/* Step 3: Standalone vs Residual */}
      <Card title={`Step 3 — ${modelLevel} Modeling Mode`}>
        <div className="flex gap-6 items-center flex-wrap">
          <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
            <input type="radio" checked={modelMode === "standalone"} onChange={() => setModelMode("standalone")} className="accent-[#001E96]" />
            Standalone Model
          </label>
          <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
            <input type="radio" checked={modelMode === "residual"} onChange={() => setModelMode("residual")} className="accent-[#001E96]" />
            Residual Model
          </label>
        </div>
      </Card>

      {/* Step 4: Ridge Settings */}
      {modelType === "ridge" && (
        <Card title="Step 4 — Ridge Regularization Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Manual Alpha (λ)</label>
              <input type="number" step="0.5" min="0.001" value={manualAlpha} onChange={(e) => setManualAlpha(parseFloat(e.target.value) || 0.001)} className="w-48 border rounded-xl px-3 py-2 text-xs font-bold bg-white" />
            </div>
            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                <input type="checkbox" checked={positiveCoef} onChange={(e) => setPositiveCoef(e.target.checked)} className="rounded" />
                Enforce Non-Negative Marketing Coefficients (β ≥ 0)
              </label>
              <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                <input type="checkbox" checked={useCustomPenalties} onChange={(e) => setUseCustomPenalties(e.target.checked)} className="rounded" />
                Enable Custom Prior Shrinkage Weights Per Channel
              </label>
            </div>
          </div>
          {useCustomPenalties && (
            <RidgePriorWeights channels={selectedChannels} weights={priorWeights} onChange={(ch, v) => setPriorWeights({ ...priorWeights, [ch]: v })} />
          )}
        </Card>
      )}

      {/* Step 5: Variable Selection (Shows All Variables: Raw & Transformed) */}
      <Card title="Step 5 — Variable Selection (Choose Raw or Transformed Variables)">
        <div className="space-y-4">
          <div className="max-w-md">
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">Dependent Variable (Target KPI)</label>
            <select value={depVar} onChange={(e) => setDepVar(e.target.value)} className="w-full text-xs font-bold border rounded-xl px-3.5 py-2.5 bg-white">
              {depVarCandidates.map((c) => (<option key={c} value={c}>🎯 {c}</option>))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                Independent Variables ({selectedChannels.length} of {availableChannels.length} selected)
              </label>
              <span className="text-[11px] text-slate-400">Select any mix of Raw or Transformed channels</span>
            </div>
            
            <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto p-3 border border-slate-200 rounded-xl bg-slate-50/50">
              {availableChannels.map((ch) => {
                const isChecked = selectedChannels.includes(ch);
                const isTrans = ch.endsWith("_transformed");
                const isCombo = ch.startsWith("SUM_") || ch.startsWith("COMBO_");
                const baseName = ch.replace("_transformed", "");

                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setSelectedChannels(isChecked ? selectedChannels.filter((c) => c !== ch) : [...selectedChannels, ch])}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 ${
                      isChecked
                        ? "bg-[#001E96] text-white border-[#001E96] shadow-sm"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    <span>{isChecked ? "✓" : "+"}</span>
                    <span>{baseName}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                      isTrans ? "bg-blue-100 text-blue-800" : isCombo ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
                    }`}>
                      {isTrans ? "Transformed" : isCombo ? "Combined" : "Raw"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <Btn onClick={handleRunRegression} disabled={loading || !selectedChannels.length} className="py-3 px-8 text-xs font-bold uppercase tracking-wider">
            {loading ? "Running Regression…" : "▶ Run Regression"}
          </Btn>
        </div>
      </Card>

      {/* Regression Results Display */}
      {stage1Result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric label="R² (Fit)" value={stage1Result.r_squared?.toFixed(4) ?? "—"} />
            <Metric label="Adjusted R²" value={stage1Result.adj_r_squared?.toFixed(4) ?? "—"} />
            <Metric label="RMSE" value={stage1Result.rmse?.toFixed(2) ?? "—"} />
            <Metric label="Model Algorithm" value={stage1Result.model_type} />
          </div>

          <Card title="Estimated Coefficients, Standard Errors & Inference">
            <DataTable data={stage1Result.coefficients?.map((row) => ({
              Variable: row.Variable,
              Coefficient: Number(row.Coefficient)?.toFixed(4),
              "Std Error": Number(row["Std Error"])?.toFixed(4) ?? "—",
              "t-statistic": Number(row["t-stat"])?.toFixed(2) ?? "—",
              "P-value": row["P-value"] != null
                ? (row["P-value"] < 0.001 ? "< 0.001 ***" : `${Number(row["P-value"]).toFixed(4)} ${row["P-value"] < 0.05 ? "**" : ""}`)
                : "—",
              "95% Conf. Interval": row["CI Lower (2.5%)"] != null
                ? `[${Number(row["CI Lower (2.5%)"]).toFixed(3)}, ${Number(row["CI Upper (97.5%)"]).toFixed(3)}]`
                : "—",
              "Impactable (%)": row["Impactable (%)"],
              "Impactable Sales": Number(row["Impactable Sales"])?.toLocaleString(undefined, { maximumFractionDigits: 0 }),
            }))} />
          </Card>

          {/* Multicollinearity & Combination Panel */}
          <Card title="Multicollinearity Check & Variable Combination">
            <div className="flex justify-between items-start flex-wrap gap-4 mb-3">
              <p className="text-xs text-slate-500 max-w-2xl">
                Check for correlated tactics and combine collinear variables into a unified sum metric.
              </p>
              {hasCombinationsApplied && (
                <Btn variant="outline" onClick={handleRevertCombinations} className="text-xs py-1.5 px-3 border-amber-400 text-amber-900 bg-amber-50">
                  ↺ Revert Combinations
                </Btn>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 mb-4 flex-wrap pt-1 border-t border-slate-100">
              <div className="flex items-center gap-3">
                <label className="text-xs font-bold text-slate-700">Threshold (|r| ≥ {postCorrThreshold}):</label>
                <input type="range" min="0.5" max="0.99" step="0.05" value={postCorrThreshold} onChange={(e) => setPostCorrThreshold(parseFloat(e.target.value))} className="w-48" />
              </div>
              <div className="flex gap-2">
                <Btn onClick={handleCheckCollinearity} disabled={diagLoading} className="text-xs py-2">🔍 Scan Pairs</Btn>
                <Btn onClick={handleComputeVIFScores} disabled={diagLoading} variant="outline" className="text-xs py-2">📊 VIF Scores</Btn>
              </div>
            </div>

            {combinationSuccessMsg && <Alert type="success">{combinationSuccessMsg}</Alert>}

            {postHighPairs.length > 0 && (
              <div className="space-y-4 pt-2">
                <DataTable data={postHighPairs.map((p) => ({ "Tactic 1": p.feature1, "Tactic 2": p.feature2, "Correlation (|r|)": p.corr?.toFixed(4) }))} />
                <div className="bg-brand-50 p-4 rounded-xl border border-brand-200 space-y-3">
                  <span className="text-xs font-bold text-brand-900 uppercase">➕ Combine Correlated Variables (Sum Method)</span>
                  {foundClusters.map((cluster, cIdx) => (
                    <div key={cIdx} className="bg-white p-3 rounded-lg border border-brand-200 text-xs">
                      <span>Pair #{cIdx + 1}: <code>{cluster[0]}</code> + <code>{cluster[1]}</code></span>
                      <input type="text" value={clusterNames[cIdx] || ""} onChange={(e) => { const next = [...clusterNames]; next[cIdx] = e.target.value.trim().toUpperCase(); setClusterNames(next); }} className="text-xs font-bold border border-slate-300 rounded px-2.5 py-1 ml-2" />
                    </div>
                  ))}
                  <div className="flex justify-end pt-2">
                    <Btn onClick={handleApplyVariableCombination} disabled={comboLoading} className="text-xs py-2 px-6 bg-emerald-600">
                      {comboLoading ? "Combining…" : "➕ Combine Variables & Update Dataset"}
                    </Btn>
                  </div>
                </div>
              </div>
            )}

            {vifTable && (
              <div className="pt-2">
                <DataTable data={vifTable.map((r) => ({
                  Variable: r.variable,
                  "VIF Score": typeof r.VIF === "number" ? r.VIF.toFixed(2) : r.VIF,
                  Status: r.status || (r.VIF > 10 ? "🔴 High (>10)" : "✅ OK (<5)"),
                }))} />
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

