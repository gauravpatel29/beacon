import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  runRegression, runRidge, v2ListArds, v2GetCsv,
  correlationMatrix, computeVIF, getHighCorrPairs, findClusters, applyCombination,
  problemMessage
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Metric, MultiSelect } from "../components/UI";

const NON_PROMO_KEYWORDS = [
  "npi", "dma", "geo", "id", "state", "name", "zip", "city", "fips", "code",
  "county", "market", "region", "territory", "population", "pop", "universe",
  "date", "week", "month", "year", "period", "time", "day", "quarter",
  "target", "trx", "crx", "nbrx", "sale", "sales", "revenue", "kpi"
];

function isPromotionalChannel(colName, depVarList = []) {
  if (!colName) return false;
  const l = colName.toLowerCase().trim();

  // 1. Strictly exclude target dependent variables
  if (depVarList.some((d) => d.toLowerCase() === l || `${d.toLowerCase()}_transformed` === l)) {
    return false;
  }

  // 2. Transformed channels & composite sums are definitely promotional
  if (l.endsWith("_transformed") || l.startsWith("combo_") || l.startsWith("sum_") || l.startsWith("weighted_sum_")) {
    if (NON_PROMO_KEYWORDS.some((kw) => l.startsWith(`${kw}_`) || l === `${kw}_transformed`)) {
      return false;
    }
    return true;
  }

  // 3. Exclude dimensions, geography names, demographic populations, and keys
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

  // ─── 1. Datasets & ARD Selection (Step 1) ──────────────────────────────────
  const savedTransformationSets = useMemo(() => {
    return state.savedTransformationSets || [];
  }, [state.savedTransformationSets]);

  const [availableDatasets, setAvailableDatasets] = useState([]);
  const [selectedDatasetName, setSelectedDatasetName] = useState("");
  const [datasetCsv, setDatasetCsv] = useState("");
  const [backupDatasetCsv, setBackupDatasetCsv] = useState(null); // Preserves original uncombined CSV
  const [activeTransformedSet, setActiveTransformedSet] = useState(null);

  useEffect(() => {
    if (!workflowId) return;
    v2ListArds(workflowId)
      .then((res) => {
        setAvailableDatasets(res.items || []);
      })
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

  // ─── Metadata & Grain Detection ───────────────────────────────────────────
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

  const [supportsHcp, setSupportsHcp] = useState(true);
  const [supportsDma, setSupportsDma] = useState(false);
  const [modelLevel, setModelLevel] = useState("HCP");

  // Load and Parse Dataset with strict Promotional Channel filtering
  useEffect(() => {
    if (!selectedDatasetName || !allAvailableSets.length) return;
    const targetSet = allAvailableSets.find((d) => d.name === selectedDatasetName) || allAvailableSets[0];
    if (!targetSet) return;

    setActiveTransformedSet(targetSet);
    setBackupDatasetCsv(null); // Reset backup for new dataset selection

    const parseAndFilter = (csv) => {
      setDatasetCsv(csv);
      setBackupDatasetCsv(csv); // Save original uncombined backup
      try {
        const lines = csv.trim().split("\n");
        const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        setDatasetCols(header);

        const hasNpi = header.some((c) => /npi|hcp|doc|physician/i.test(c));
        const hasDma = header.some((c) => /dma/i.test(c));

        setSupportsHcp(hasNpi || (!hasDma && !targetSet.grain?.toLowerCase().includes("dma")));
        setSupportsDma(hasDma || targetSet.grain?.toLowerCase().includes("dma"));

        if (hasNpi && !hasDma) {
          setModelLevel("HCP");
        } else if (hasDma && !hasNpi) {
          setModelLevel("DMA");
        }

        const dCol = header.find((c) => /date|week|month|period/i.test(c)) || header[0] || "week_end_date";
        setDateCol(dCol);

        const gCol = header.find((c) => modelLevel === "DMA" ? /dma/i.test(c) : /npi|hcp|geo|id/i.test(c)) || header[1] || header[0];
        setGeoCol(gCol);

        const dvList = header.filter((c) => /trx|crx|nbrx|sale|revenue|kpi/i.test(c) && !c.endsWith("_transformed"));
        const activeDvList = dvList.length > 0 ? dvList : ["trx", "crx", "nbrx"];
        setDepVarCandidates(activeDvList);
        const initialDep = activeDvList[0] || "trx";
        setDepVar(initialDep);

        // Strict Promotional Channel Filtering
        const promoTactics = header.filter((c) => isPromotionalChannel(c, activeDvList));
        setAvailableChannels(promoTactics);
        setSelectedChannels(promoTactics);

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

  const handleDependentVariableChange = (newDep) => {
    setDepVar(newDep);
    const safeIvs = datasetCols.filter((c) => isPromotionalChannel(c, [newDep]));
    setAvailableChannels(safeIvs);
    setSelectedChannels((prev) => prev.filter((c) => c !== newDep && c !== `${newDep}_transformed`));
  };

  // ─── 3. Model Setup ───────────────────────────────────────────────────────
  const [modelName, setModelName] = useState("HCP OLS Model v1");
  const [modelType, setModelType] = useState("ols");

  useEffect(() => {
    setModelName(`${modelLevel} ${modelType.toUpperCase()} Model (${depVar})`);
  }, [modelLevel, modelType, depVar]);

  // ─── 4. Modeling Mode (Standalone vs Residual) ────────────────────────────
  const [modelMode, setModelMode] = useState("standalone");
  const [sourceReferenceModelId, setSourceReferenceModelId] = useState("");

  // ─── 5. Ridge Configuration (Manual Only) ─────────────────────────────────
  const [manualAlpha, setManualAlpha] = useState(1.0);
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
  const [modelHistory, setModelHistory] = useState(() => state.regressionOutputs || []);
  const [activeLoadedModelId, setActiveLoadedModelId] = useState(null);

  const completedReferenceModels = useMemo(() => {
    return modelHistory.filter((m) => m.status === "complete");
  }, [modelHistory]);

  const isDuplicateModelName = useMemo(() => {
    return modelHistory.some(
      (m) => m.modelName?.trim().toLowerCase() === modelName?.trim().toLowerCase() && m.id !== activeLoadedModelId
    );
  }, [modelHistory, modelName, activeLoadedModelId]);

  const isReadyToRun = useMemo(() => {
    if (!datasetCsv) return false;
    if (!modelName.trim() || isDuplicateModelName) return false;
    if (!depVar) return false;
    if (selectedChannels.length === 0) return false;
    if (modelMode === "residual" && !sourceReferenceModelId) return false;
    return true;
  }, [datasetCsv, modelName, isDuplicateModelName, depVar, selectedChannels, modelMode, sourceReferenceModelId]);

  // ─── Post-Modelling Multicollinearity & Combination State ─────────────────
  const [postCorrThreshold, setPostCorrThreshold] = useState(0.70);
  const [postCorrMatrix, setPostCorrMatrix] = useState(null);
  const [postHighPairs, setPostHighPairs] = useState([]);
  const [vifTable, setVifTable] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);

  // Combination State
  const [foundClusters, setFoundClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [comboLoading, setComboLoading] = useState(false);
  const [combinationSuccessMsg, setCombinationSuccessMsg] = useState("");

  const handleRunRegression = async () => {
    if (!isReadyToRun) return toast.error("Complete required inputs before running.");

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
        data.model_type = `OLS (${modelLevel} - ${modelMode})`;
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
        data.model_type = `Ridge (${modelLevel} - ${modelMode})`;
      }

      setStage1Result(data);

      const historyEntry = {
        id: `mod_${Date.now()}`,
        modelName: modelName.trim(),
        modelLevel,
        dataset: selectedDatasetName || "Transformed Dataset",
        modelType: modelType.toUpperCase(),
        modelMode,
        sourceReferenceModel: modelMode === "residual" ? sourceReferenceModelId : null,
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
        alpha: modelType === "ridge" ? manualAlpha : null,
        coefficients: data.coefficients,
        summary: data.summary,
        manualAlpha,
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

  // ─── Post-Modelling Multicollinearity Check Handlers ───────────────────────
  const handleCheckCollinearity = async () => {
    if (!datasetCsv || selectedChannels.length < 2) {
      return toast.error("At least 2 promotional channels must be active.");
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

  // ─── Apply Combination & Update Modeling Dataset ───────────────────────────
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

      // Re-read columns and update available & selected channels
      const lines = updatedCsv.trim().split("\n");
      const header = lines[0].split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      setDatasetCols(header);

      const updatedPromoTactics = header.filter((c) => isPromotionalChannel(c, depVarCandidates));
      setAvailableChannels(updatedPromoTactics);
      setSelectedChannels(updatedPromoTactics);

      // Reset diagnostics
      setPostCorrMatrix(null);
      setPostHighPairs([]);
      setFoundClusters([]);
      setVifTable(null);

      const msg = `Successfully combined ${foundClusters.length} pair(s) into [${clusterNames.join(", ")}]. Dataset updated! Click "Run Regression" to model with uncorrelated variables.`;
      setCombinationSuccessMsg(msg);
      toast.success(msg, { duration: 6000 });
    } catch (err) {
      toast.error(err.response?.data?.detail || "Variable combination failed");
    } finally {
      setComboLoading(false);
    }
  };

  // ─── Revert Combinations & Restore Original Variables ──────────────────────
  const handleRevertCombinations = () => {
    if (!backupDatasetCsv) return toast.error("No original backup found for this dataset.");

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

    toast.success("Restored original variables & dataset. All combinations undone.");
  };

  const handleLoadModelFromHistory = (m) => {
    setActiveLoadedModelId(m.id);
    setModelLevel(m.modelLevel || "HCP");

    if (m.dataset && allAvailableSets.some((d) => d.name === m.dataset)) {
      setSelectedDatasetName(m.dataset);
    }

    setModelName(m.modelName || "");
    setModelType((m.modelType || "ols").toLowerCase());
    if (m.modelMode) setModelMode(m.modelMode);
    if (m.sourceReferenceModel) setSourceReferenceModelId(m.sourceReferenceModel);
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
    }

    if (m.manualAlpha) setManualAlpha(m.manualAlpha);
    if (m.positiveCoef !== undefined) setPositiveCoef(m.positiveCoef);
    if (m.useCustomPenalties !== undefined) setUseCustomPenalties(m.useCustomPenalties);
    if (m.priorWeights) setPriorWeights(m.priorWeights);

    setStage1Result({
      model_type: `${m.modelType} (${m.modelLevel} - ${m.modelMode || "standalone"})`,
      r_squared: m.r_squared,
      adj_r_squared: m.adj_r_squared,
      rmse: m.rmse,
      alpha: m.alpha,
      coefficients: m.coefficients || [],
      summary: m.summary || "",
    });

    window.scrollTo({ top: 350, behavior: "smooth" });
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

  const hasCombinationsApplied = backupDatasetCsv && datasetCsv && datasetCsv !== backupDatasetCsv;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Module 6: Marketing Mix Modelling"
        subtitle="Select dataset to auto-detect modeling grain, configure OLS and Ridge models with standalone or residual modes, inspect multicollinearity, and combine correlated features"
        icon="🤖"
      />

      {/* ─── STEP 1: Select Dataset (ARD / Transformed Table) First ─────────── */}
      <Card title="Step 1 — Select Dataset (ARD / Transformed Table)">
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
              {allAvailableSets.length === 0 ? (
                <option value="">-- No Datasets Found (Complete Ingestion/Transformation First) --</option>
              ) : (
                allAvailableSets.map((d) => (
                  <option key={d.name} value={d.name}>
                    📄 {d.name} ({d.grain} • {d.columns?.length || 0} columns)
                  </option>
                ))
              )}
            </select>
          </div>

          {datasetCsv && (
            <div className="space-y-3">
              {/* Grain Compatibility Banner */}
              <div className="p-3.5 rounded-xl border flex items-center justify-between flex-wrap gap-2 text-xs bg-brand-50/60 border-brand-200">
                <div className="flex items-center gap-2">
                  <span className="text-base">💡</span>
                  <span className="text-slate-800 font-semibold">
                    Column Key Detection:{" "}
                    {supportsHcp && supportsDma ? (
                      <strong className="text-emerald-700">Both NPI (Doctor) &amp; DMA columns detected. Suitable for HCP or DMA modeling.</strong>
                    ) : supportsHcp ? (
                      <strong className="text-purple-700">NPI Doctor Key detected. Recommended for HCP-level modeling.</strong>
                    ) : (
                      <strong className="text-blue-700">DMA Regional Key detected. Recommended for DMA-level modeling.</strong>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-bold">
                  <span className={`px-2.5 py-0.5 rounded-full ${supportsHcp ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-400"}`}>
                    HCP Grain {supportsHcp ? "✓" : "✗"}
                  </span>
                  <span className={`px-2.5 py-0.5 rounded-full ${supportsDma ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-400"}`}>
                    DMA Grain {supportsDma ? "✓" : "✗"}
                  </span>
                </div>
              </div>

              {/* Metadata Overview */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                <div>
                  <span className="text-slate-400 font-bold block uppercase text-[10px]">Date Column</span>
                  <strong className="text-slate-800 font-mono">{dateCol}</strong>
                </div>
                <div>
                  <span className="text-slate-400 font-bold block uppercase text-[10px]">Geography Key</span>
                  <strong className="text-slate-800 font-mono">{geoCol}</strong>
                </div>
                <div>
                  <span className="text-slate-400 font-bold block uppercase text-[10px]">Target Sales KPI</span>
                  <strong className="text-brand-700 font-bold">{depVar}</strong>
                </div>
                <div>
                  <span className="text-slate-400 font-bold block uppercase text-[10px]">Promotional IVs</span>
                  <strong className="text-slate-800">{availableChannels.length} promotional channels</strong>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ─── STEP 2: Model Level Selection ─────────────────────────────────── */}
      <Card title="Step 2 — Model Level">
        <p className="text-xs text-slate-500 mb-3">
          Choose the aggregation level for this regression model based on detected dataset capabilities.
        </p>
        <div className="grid grid-cols-2 max-w-md gap-3">
          <button
            type="button"
            onClick={() => setModelLevel("HCP")}
            disabled={!supportsHcp}
            className={`p-4 rounded-2xl border-2 text-left transition-all ${
              modelLevel === "HCP"
                ? "border-[#001E96] bg-brand-50/60 shadow-sm"
                : supportsHcp
                ? "border-slate-200 bg-white hover:border-slate-300"
                : "border-slate-200 bg-slate-100 opacity-50 cursor-not-allowed"
            }`}
          >
            <span className="text-2xl block mb-1">🩺</span>
            <strong className="text-sm text-slate-800 block">HCP-Level Model</strong>
            <span className="text-[11px] text-slate-500">Physician &amp; Sales Rep grain</span>
          </button>

          <button
            type="button"
            onClick={() => setModelLevel("DMA")}
            disabled={!supportsDma}
            className={`p-4 rounded-2xl border-2 text-left transition-all ${
              modelLevel === "DMA"
                ? "border-[#001E96] bg-brand-50/60 shadow-sm"
                : supportsDma
                ? "border-slate-200 bg-white hover:border-slate-300"
                : "border-slate-200 bg-slate-100 opacity-50 cursor-not-allowed"
            }`}
          >
            <span className="text-2xl block mb-1">📡</span>
            <strong className="text-sm text-slate-800 block">DMA-Level Model</strong>
            <span className="text-[11px] text-slate-500">Designated Market Area grain</span>
          </button>
        </div>
      </Card>

      {/* ─── STEP 3: Model Setup ───────────────────────────────────────────── */}
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
            Model Algorithm *
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

      {/* ─── STEP 4: Modeling Mode (Standalone vs Residual for BOTH Levels) ── */}
      <Card title={`Step 4 — ${modelLevel} Modeling Mode (Standalone vs. Residual)`}>
        <div className="space-y-4">
          <div className="flex gap-6 items-center flex-wrap">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
              <input
                type="radio"
                name="modelMode"
                value="standalone"
                checked={modelMode === "standalone"}
                onChange={() => setModelMode("standalone")}
                className="accent-[#001E96]"
              />
              <span>Standalone Model (Direct {modelLevel} Sales Regression)</span>
            </label>

            <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
              <input
                type="radio"
                name="modelMode"
                value="residual"
                checked={modelMode === "residual"}
                onChange={() => setModelMode("residual")}
                className="accent-[#001E96]"
              />
              <span>Residual Model (Sales − Predicted Baseline from Source Model)</span>
            </label>
          </div>

          {modelMode === "residual" && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3 max-w-xl">
              <span className="text-xs font-bold text-blue-950 block">
                Select Source Reference Model *
              </span>
              <select
                value={sourceReferenceModelId}
                onChange={(e) => setSourceReferenceModelId(e.target.value)}
                className="w-full text-xs font-bold border border-blue-300 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none"
              >
                <option value="">-- Choose Completed Source Model --</option>
                {completedReferenceModels.map((m) => (
                  <option key={m.id} value={m.modelName}>
                    🏆 {m.modelName} ({m.modelLevel} • {m.modelType} • R² = {m.r_squared?.toFixed(3)})
                  </option>
                ))}
              </select>

              {completedReferenceModels.length === 0 && (
                <p className="text-[11px] text-red-600 font-bold">
                  ⚠️ No completed models found in Model History. Run a standalone model first to use as a baseline source.
                </p>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* ─── STEP 5: Ridge Configuration (Manual Only) ─────────────────────── */}
      {modelType === "ridge" && (
        <Card title="Step 5 — Ridge Regularization Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Manual Regularization Alpha ($\lambda$) *
              </label>
              <input
                type="number"
                step="0.5"
                min="0.0001"
                value={manualAlpha}
                onChange={(e) => setManualAlpha(parseFloat(e.target.value) || 0.001)}
                className="w-48 border-2 border-slate-200 rounded-xl px-3.5 py-2 text-xs font-bold bg-white focus:border-brand-500 focus:outline-none"
              />
              <span className="block text-[11px] text-slate-400 mt-1">
                Enter your exact $\lambda$ regularization penalty (e.g., 1.0, 2.5, 10.0).
              </span>
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
            <RidgePriorWeights channels={selectedChannels} weights={priorWeights} onChange={(ch, v) => setPriorWeights({ ...priorWeights, [ch]: v })} />
          )}
        </Card>
      )}

      {/* ─── STEP 6: Variable Selection (Strictly Promotional Channels Only) ── */}
      <Card title="Step 6 — Variable Selection (Promotional Tactics Only)">
        <div className="space-y-4">
          <div className="max-w-md">
            <div className="flex justify-between items-center mb-1.5">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                Dependent Variable (Target KPI) *
              </label>
              <span className="text-[10px] font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full border border-brand-200">
                {depVarCandidates.length} candidate(s)
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
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                Independent Variables (Promotional Tactics Only) * ({selectedChannels.length} of {availableChannels.length} selected)
              </label>
              <span className="text-[10px] text-slate-400 font-semibold">
                * Keys, geography names &amp; population variables are filtered out
              </span>
            </div>

            {availableChannels.length === 0 ? (
              <p className="text-xs text-slate-400 italic p-3 bg-slate-50 rounded-xl border border-slate-200">
                No valid promotional channels found in this dataset.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 border border-slate-200 rounded-xl bg-slate-50/50">
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
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <span>{isChecked ? "✓" : "+"}</span> {ch.replace("_transformed", "")}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ─── Run Regression Button Card ──────────────────────────────────── */}
      <Card>
        <div className="flex justify-between items-center flex-wrap gap-4">
          <div>
            <span className="text-xs font-bold text-slate-800 block">
              Ready to execute {modelLevel} {modelType.toUpperCase()} ({modelMode})
            </span>
            <span className="text-[11px] text-slate-500">
              {selectedChannels.length} promotional tactics regressed against {depVar}
            </span>
          </div>
          <Btn
            onClick={handleRunRegression}
            disabled={loading || !isReadyToRun}
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
            <Metric label="R² (Fit)" value={stage1Result.r_squared?.toFixed(4) ?? "—"} />
            <Metric label="Adjusted R²" value={stage1Result.adj_r_squared?.toFixed(4) ?? "—"} />
            <Metric label="RMSE" value={stage1Result.rmse?.toFixed(2) ?? "—"} />
            <Metric
              label={modelType === "ridge" ? "Regularization Alpha (λ)" : "Modelling Period"}
              value={modelType === "ridge" ? String(manualAlpha) : `${startDate} → ${endDate}`}
            />
          </div>

          {renderCoeffTable(stage1Result, "Estimated Coefficients & Impactable Attribution")}

          <Card title="Regression Summary Output">
            <pre className="text-xs text-slate-600 bg-slate-50 rounded-xl p-4 overflow-auto whitespace-pre-wrap font-mono leading-relaxed max-h-80">
              {stage1Result.summary || "No statistical text summary available."}
            </pre>
          </Card>

          {/* ─── POST-MODELLING MULTICOLLINEARITY & COMBINATION WORKFLOW ─────── */}
          <Card title="Multicollinearity Check &amp; Variable Combination">
            <div className="flex justify-between items-start flex-wrap gap-4 mb-3">
              <p className="text-xs text-slate-500 max-w-2xl">
                Check for highly correlated promotional tactics. If multicollinearity is detected, combine them into a single sum variable and re-run the regression on the updated dataset.
              </p>
              
              {hasCombinationsApplied && (
                <Btn
                  variant="outline"
                  onClick={handleRevertCombinations}
                  className="text-xs py-1.5 px-3.5 border-amber-400 text-amber-900 bg-amber-50/70 hover:bg-amber-100 font-bold"
                >
                  ↺ Revert Combinations &amp; Restore Originals
                </Btn>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 mb-4 flex-wrap pt-1 border-t border-slate-100">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-xs font-bold text-slate-700">
                  Highlight Threshold (|r| ≥ {postCorrThreshold}):
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="0.99"
                  step="0.05"
                  value={postCorrThreshold}
                  onChange={(e) => setPostCorrThreshold(parseFloat(e.target.value))}
                  className="w-48"
                />
              </div>

              <div className="flex gap-2">
                <Btn onClick={handleCheckCollinearity} disabled={diagLoading} className="text-xs py-2 bg-brand-600">
                  {diagLoading ? "Checking…" : "🔍 Scan Correlated Pairs"}
                </Btn>
                <Btn onClick={handleComputeVIFScores} disabled={diagLoading} variant="outline" className="text-xs py-2">
                  📊 Compute VIF Scores
                </Btn>
              </div>
            </div>

            {diagLoading && <Spinner label="Calculating collinearity diagnostics..." />}

            {combinationSuccessMsg && (
              <div className="mb-4">
                <Alert type="success">{combinationSuccessMsg}</Alert>
              </div>
            )}

            {/* High Pairs Table */}
            {postHighPairs.length > 0 && (
              <div className="space-y-4 mb-6 pt-2">
                <div>
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block mb-2">
                    Highly Correlated Pairs (|r| ≥ {postCorrThreshold}):
                  </span>
                  <DataTable
                    data={postHighPairs.map((p) => ({
                      "Tactic 1": p.feature1,
                      "Tactic 2": p.feature2,
                      "Correlation (|r|)": p.corr?.toFixed(4),
                    }))}
                  />
                </div>

                {/* Combination Formula and Action Panel */}
                <div className="bg-brand-50 p-4 rounded-xl border border-brand-200 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-xs font-bold text-brand-900 uppercase tracking-wider">
                      ➕ Combine Correlated Variables (Sum Method)
                    </span>
                    <span className="text-[11px] text-brand-700 font-semibold">
                      Creates unified composite variable and updates the modeling dataset
                    </span>
                  </div>

                  <div className="space-y-2">
                    {foundClusters.map((cluster, cIdx) => (
                      <div key={cIdx} className="bg-white p-3 rounded-lg border border-brand-200 text-xs space-y-1">
                        <div className="flex justify-between items-center flex-wrap gap-2">
                          <span className="font-bold text-slate-700">
                            Pair #{cIdx + 1}: <code className="text-brand-700">{cluster[0]}</code> + <code className="text-brand-700">{cluster[1]}</code>
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">
                            Formula: <code>{clusterNames[cIdx] || `SUM_VAR_${cIdx + 1}`} = {cluster[0]} + {cluster[1]}</code>
                          </span>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <label className="text-[11px] font-bold text-slate-600">New Combined Name:</label>
                          <input
                            type="text"
                            value={clusterNames[cIdx] || ""}
                            onChange={(e) => {
                              const next = [...clusterNames];
                              next[cIdx] = e.target.value.trim().toUpperCase();
                              setClusterNames(next);
                            }}
                            className="text-xs font-bold border border-slate-300 rounded px-2.5 py-1 bg-white focus:outline-none w-72"
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end pt-2">
                    <Btn onClick={handleApplyVariableCombination} disabled={comboLoading} className="text-xs py-2 px-6 bg-emerald-600 hover:bg-emerald-700">
                      {comboLoading ? "Combining…" : "➕ Combine Variables & Update Dataset"}
                    </Btn>
                  </div>
                </div>
              </div>
            )}

            {/* VIF Scores Table */}
            {vifTable && (
              <div className="pt-2">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block mb-2">
                  Variance Inflation Factor (VIF Scores):
                </span>
                <DataTable
                  data={vifTable.map((r) => ({
                    Variable: r.variable,
                    "VIF Score": typeof r.VIF === "number" ? r.VIF.toFixed(2) : r.VIF,
                    Status: r.status || (r.VIF > 10 ? "🔴 High Collinearity (>10)" : r.VIF > 5 ? "⚠️ Moderate (5–10)" : "✅ OK (<5)"),
                  }))}
                />
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ─── Model History Table (Interactive) ────────────────────────────── */}
      <Card title="Model History &amp; Saved Model Runs">
        <p className="text-xs text-slate-500 mb-4">
          Click any model row below to reload its exact dataset, variables, and parameters back into the form.
        </p>

        {modelHistory.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No models executed yet. Configure and run a model above.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-96">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3">Model Name</th>
                  <th className="px-3 py-3">Level</th>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Mode</th>
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
                      title="Click to load configuration & view results"
                    >
                      <td className="px-4 py-3 font-bold text-brand-700 underline flex items-center gap-1.5">
                        <span>🔍</span>
                        <span>{m.modelName}</span>
                        {m.sourceReferenceModel && (
                          <span className="block text-[10px] text-blue-600 font-normal no-underline">
                            (Src: {m.sourceReferenceModel})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          m.modelLevel === "HCP" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"
                        }`}>
                          {m.modelLevel}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-semibold text-slate-700">{m.modelType}</td>
                      <td className="px-3 py-3 text-slate-500">{m.modelMode || "standalone"}</td>
                      <td className="px-3 py-3 font-bold text-brand-700">{m.r_squared?.toFixed(4) ?? "—"}</td>
                      <td className="px-3 py-3 text-slate-700">{m.adj_r_squared?.toFixed(4) ?? "—"}</td>
                      <td className="px-3 py-3 text-slate-700">{m.rmse?.toFixed(2) ?? "—"}</td>
                      <td className="px-3 py-3 text-slate-500 font-mono text-[11px]">{m.dateRange}</td>
                      <td className="px-3 py-3">
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
  );
}