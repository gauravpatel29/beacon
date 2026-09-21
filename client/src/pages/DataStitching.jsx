import React, { useState, useMemo, useEffect } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { v2BuildArd, v2ListFiles, v2ListArds, v2GetCsv, problemMessage } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, DataTable, Spinner, Select } from "../components/UI";

const STEP_TYPES = [
  { value: "join", label: "Relational Join (Same Grain)", icon: "🔗" },
  { value: "rollup", label: "Rollup (Lower Grain → Higher Grain)", icon: "📈" },
  { value: "allocate", label: "Allocate (Higher Grain → Lower Grain)", icon: "⚖️" },
];

const ALLOCATION_METHODS = [
  { value: "equal", label: "Equal Distribution (1/N Prescribers)" },
  { value: "weighted_column", label: "Population / Target Universe Weight" },
];

const AGG_OPTIONS = [
  { value: "sum", label: "Sum (Default / Conserved)" },
  { value: "avg", label: "Average (Mean)" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "count", label: "Count" },
  { value: "distinct_count", label: "Distinct Count" },
  { value: "first", label: "First Occurrence" },
  { value: "last", label: "Last Occurrence" },
];

export default function DataStitching() {
  const navigate = useNavigate();
  const { state, setField, setFields, saveWorkflowSnapshot } = useAppState();
  const workflowId = state.workflowId;

  const [datasets, setDatasets] = useState(() => state.datasets || []);
  const [savedArdsList, setSavedArdsList] = useState(() => state.savedArds || []);
  const ingestedFiles = datasets;
  const columnRoles = state.columnRoles || {};

  const refreshArds = async () => {
    if (!workflowId) return;
    try {
      const res = await v2ListArds(workflowId);
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
      setSavedArdsList(ards);
      setField("savedArds", ards);
    } catch (err) {
      console.warn("Could not list ARDs:", err);
    }
  };

  useEffect(() => {
    if (!workflowId) return;
    v2ListFiles(workflowId)
      .then((res) => {
        const items = (res.items || []).filter((d) => d.kind !== "ard");
        setDatasets(items);
        setField("datasets", items);
      })
      .catch((err) => toast.error(problemMessage(err, "Could not load datasets")));

    refreshArds();
  }, [workflowId]);

  const fileNames = useMemo(() => ingestedFiles.map((f) => f.filename), [ingestedFiles]);

  const datasetColumns = useMemo(() => {
    const map = {};
    ingestedFiles.forEach((f) => {
      map[f.filename] = f.columns || [];
    });
    return map;
  }, [ingestedFiles]);

  const allKnownCols = useMemo(() => {
    return Array.from(new Set(ingestedFiles.flatMap((f) => f.columns || [])));
  }, [ingestedFiles]);

  const [activeTab, setActiveTab] = useState("hcp");
  const [selectedSourceFiles, setSelectedSourceFiles] = useState(() => state.stitchingSourceFiles || fileNames);

  useEffect(() => {
    if (!fileNames.length) return;
    if (state.stitchingSourceFiles && state.stitchingSourceFiles.length > 0) {
      setSelectedSourceFiles(state.stitchingSourceFiles);
      return;
    }
    if (activeTab === "hcp") {
      const hcpFiles = fileNames.filter((f) => {
        const l = f.toLowerCase();
        return (
          l.includes("sale") || l.includes("call") || l.includes("sample") ||
          l.includes("social") || l.includes("rte") || l.includes("speaker") ||
          l.includes("email") || l.includes("hcp") || l.includes("map") || l.includes("cross")
        );
      });
      setSelectedSourceFiles(hcpFiles.length > 0 ? hcpFiles : fileNames);
    } else if (activeTab === "dma") {
      const dmaFiles = fileNames.filter((f) => {
        const l = f.toLowerCase();
        return (
          l.includes("dma") || l.includes("tv") || l.includes("digital") ||
          l.includes("radio") || l.includes("print") || l.includes("pop") ||
          l.includes("media") || l.includes("map") || l.includes("cross")
        );
      });
      setSelectedSourceFiles(dmaFiles.length > 0 ? dmaFiles : fileNames);
    } else {
      setSelectedSourceFiles(fileNames);
    }
  }, [activeTab, fileNames]);

  const toggleSourceFile = (fname) => {
    const updated = selectedSourceFiles.includes(fname)
      ? selectedSourceFiles.filter((f) => f !== fname)
      : [...selectedSourceFiles, fname];
    if (updated.length === 0) {
      return toast.error("At least one source file must be selected.");
    }
    setSelectedSourceFiles(updated);
    setField("stitchingSourceFiles", updated);
  };

  const [ardDatasetName, setArdDatasetName] = useState(() => {
    return activeTab === "hcp" ? "HCP_Master_ARD" : activeTab === "dma" ? "DMA_Master_ARD" : "Custom_Master_ARD";
  });

  useEffect(() => {
    setArdDatasetName(
      activeTab === "hcp" ? "HCP_Master_ARD" : activeTab === "dma" ? "DMA_Master_ARD" : "Custom_Master_ARD"
    );
  }, [activeTab]);

  const getColumnsForDataset = (dsName, stepIdx = 0) => {
    if (!dsName) return [];
    if (datasetColumns[dsName]) return datasetColumns[dsName];

    if (dsName.toLowerCase().startsWith("step ")) {
      const stepMatch = dsName.match(/step\s*(\d+)/i);
      if (stepMatch) {
        const stepNum = parseInt(stepMatch[1], 10);
        const executedStep = ardResult?.lineage?.steps_executed?.[stepNum - 1];
        if (executedStep?.columns?.length) return executedStep.columns;
      }
      if (stepIdx > 0 && steps[stepIdx - 1]) {
        const prev = steps[stepIdx - 1];
        const prevLeft = datasetColumns[prev.left_file || prev.source_file] || [];
        const prevRight = datasetColumns[prev.right_file || prev.target_file || prev.mapping_file] || [];
        const combined = Array.from(new Set([...prevLeft, ...prevRight]));
        if (combined.length) return combined;
      }
      return allKnownCols;
    }
    return allKnownCols;
  };

  const findDefaultKey = (cols = [], patterns = []) => {
    for (const p of patterns) {
      const found = cols.find((c) => c.toLowerCase().includes(p));
      if (found) return found;
    }
    return cols[0] || "";
  };

  const isMetricOrPromo = (colName) => {
    const role = columnRoles[colName];
    if (role === "Independent Promotions" || role === "Dependent Variable") return true;
    if (role === "Time Variable" || role === "Cross-sectional Variable") return false;

    const l = colName.toLowerCase();
    const idTokens = ["npi", "id", "zip", "fips", "code", "dma", "state", "account", "date", "week", "month", "year", "time"];
    if (idTokens.some((tok) => l === tok || l.startsWith(`${tok}_`) || l.endsWith(`_${tok}`))) return false;
    return true;
  };

  const getSingleDefaultKeyPair = (lFile, rFile, stepIdx = 0) => {
    const lCols = getColumnsForDataset(lFile, stepIdx);
    const rCols = getColumnsForDataset(rFile, stepIdx);

    const autoLKey = findDefaultKey(lCols, ["npi", "dma", "id", "account", "key"]);
    const autoRKey =
      rCols.find((c) => c.toLowerCase() === autoLKey.toLowerCase()) ||
      findDefaultKey(rCols, ["npi", "dma", "id", "account", "key"]);

    return [{ left_key: autoLKey, right_key: autoRKey }];
  };

  const [steps, setSteps] = useState(() => {
    if (state.stitchingSteps && state.stitchingSteps.length > 0) {
      return state.stitchingSteps;
    }
    const s1Left = selectedSourceFiles[0] || fileNames[0] || "";
    const s1Right = selectedSourceFiles[1] || fileNames[1] || "";
    const leftCols = datasetColumns[s1Left] || [];
    const rightCols = datasetColumns[s1Right] || [];
    const mapFile = selectedSourceFiles.find((f) => f.toLowerCase().includes("map") || f.toLowerCase().includes("cross")) || "";
    const mapCols = datasetColumns[mapFile] || [];
    const popFile = selectedSourceFiles.find((f) => f.toLowerCase().includes("pop") || f.toLowerCase().includes("weight")) || "";
    const popCols = datasetColumns[popFile] || [];

    return [
      {
        step_type: "join",
        left_file: s1Left,
        right_file: s1Right,
        source_file: s1Left,
        target_file: s1Right,
        mapping_file: mapFile,
        weight_file: popFile,
        join_type: "left",
        key_pairs: getSingleDefaultKeyPair(s1Left, s1Right, 0),
        source_grain: "HCP",
        target_grain: "DMA",
        source_grain_key: findDefaultKey(leftCols, ["dma", "market", "code"]),
        target_grain_key: findDefaultKey(rightCols, ["npi", "hcp", "id"]),
        source_entity_key: findDefaultKey(leftCols, ["npi", "hcp", "id"]),
        target_entity_key: findDefaultKey(mapCols, ["dma", "market", "code"]),
        mapping_source_key: findDefaultKey(mapCols, ["npi", "hcp", "id"]),
        mapping_target_key: findDefaultKey(mapCols, ["dma", "market", "code"]),
        time_key: findDefaultKey(leftCols, ["date", "week", "month", "period"]),
        allocation_method: "equal",
        weight_column: findDefaultKey(popCols, ["weight", "pop", "universe"]),
        agg_rules: {},
        allocated_metrics: [],
      },
    ];
  });

  const updateStepsAndState = (newSteps) => {
    setSteps(newSteps);
    setField("stitchingSteps", newSteps);
  };

  const [loading, setLoading] = useState(false);
  const [ardResult, setArdResult] = useState(null);

  const getAvailableLeftDatasets = (stepIndex) => {
    const prevSteps = [];
    for (let i = 0; i < stepIndex; i++) {
      prevSteps.push(`Step ${i + 1} Result`);
    }
    return [...selectedSourceFiles, ...prevSteps];
  };

  const addPipelineStep = (type = "join") => {
    const prevResultName = `Step ${steps.length} Result`;
    const defaultRight = selectedSourceFiles[0] || "";
    const leftCols = getColumnsForDataset(prevResultName, steps.length);
    const rightCols = getColumnsForDataset(defaultRight, steps.length);
    const mapFile = selectedSourceFiles.find((f) => f.toLowerCase().includes("map") || f.toLowerCase().includes("cross")) || "";
    const mapCols = datasetColumns[mapFile] || [];
    const popFile = selectedSourceFiles.find((f) => f.toLowerCase().includes("pop") || f.toLowerCase().includes("weight")) || "";
    const popCols = datasetColumns[popFile] || [];

    const newStep = {
      step_type: type,
      left_file: prevResultName,
      right_file: defaultRight,
      source_file: type === "allocate" ? defaultRight : prevResultName,
      target_file: prevResultName,
      join_type: "left",
      key_pairs: getSingleDefaultKeyPair(prevResultName, defaultRight, steps.length),
      source_grain: type === "rollup" ? "HCP" : "DMA",
      target_grain: type === "rollup" ? "DMA" : "HCP",
      source_grain_key: findDefaultKey(type === "allocate" ? rightCols : leftCols, ["dma", "market", "code"]),
      target_grain_key: findDefaultKey(leftCols, ["npi", "hcp", "id"]),
      source_entity_key: findDefaultKey(leftCols, ["npi", "hcp", "id"]),
      target_entity_key: findDefaultKey(mapCols, ["dma", "market", "code"]),
      mapping_file: mapFile,
      mapping_source_key: findDefaultKey(mapCols, ["npi", "hcp", "id"]),
      mapping_target_key: findDefaultKey(mapCols, ["dma", "market", "code"]),
      time_key: findDefaultKey(type === "allocate" ? rightCols : leftCols, ["date", "week", "month", "period"]),
      allocation_method: "weighted_column",
      weight_column: findDefaultKey(popCols, ["weight", "pop", "universe"]),
      agg_rules: {},
      allocated_metrics: [],
    };
    updateStepsAndState([...steps, newStep]);
  };

  const updateStep = (index, field, value) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== index) return step;
      const updated = { ...step, [field]: value };

      if (field === "source_file" || field === "left_file") {
        const cols = getColumnsForDataset(value, idx);
        if (!updated.source_entity_key || !cols.includes(updated.source_entity_key)) {
          updated.source_entity_key = findDefaultKey(cols, ["npi", "hcp", "id"]);
        }
        if (!updated.source_grain_key || !cols.includes(updated.source_grain_key)) {
          updated.source_grain_key = findDefaultKey(cols, ["dma", "market", "code"]);
        }
        if (!updated.time_key || !cols.includes(updated.time_key)) {
          updated.time_key = findDefaultKey(cols, ["date", "week", "month", "period"]);
        }
      }

      if (field === "target_file") {
        const cols = getColumnsForDataset(value, idx);
        if (!updated.target_grain_key || !cols.includes(updated.target_grain_key)) {
          updated.target_grain_key = findDefaultKey(cols, ["npi", "hcp", "id"]);
        }
      }

      if (field === "mapping_file") {
        if (value) {
          const mCols = datasetColumns[value] || [];
          updated.mapping_source_key = findDefaultKey(mCols, ["npi", "hcp", "id"]);
          updated.target_entity_key = findDefaultKey(mCols, ["dma", "market", "code"]);
          updated.mapping_target_key = findDefaultKey(mCols, ["dma", "market", "code"]);
        } else {
          const sCols = getColumnsForDataset(updated.source_file || updated.left_file, idx);
          updated.target_entity_key = findDefaultKey(sCols, ["dma", "market", "code"]);
        }
      }

      if (field === "weight_file") {
        if (value) {
          const wCols = datasetColumns[value] || [];
          updated.weight_column = findDefaultKey(wCols, ["weight", "pop", "universe", "dma_population"]);
        } else {
          updated.weight_column = "";
        }
      }

      if (field === "left_file" || field === "right_file") {
        updated.key_pairs = getSingleDefaultKeyPair(
          field === "left_file" ? value : updated.left_file,
          field === "right_file" ? value : updated.right_file,
          idx
        );
      }

      return updated;
    });
    updateStepsAndState(nextSteps);
  };

  const updateAggRule = (stepIdx, colName, aggFunc) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== stepIdx) return step;
      const currentRules = { ...(step.agg_rules || {}) };
      currentRules[colName] = aggFunc;
      return { ...step, agg_rules: currentRules };
    });
    updateStepsAndState(nextSteps);
  };

  const toggleAllocatedMetric = (stepIdx, colName) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== stepIdx) return step;
      const cur = step.allocated_metrics || [];
      const updated = cur.includes(colName) ? cur.filter((c) => c !== colName) : [...cur, colName];
      return { ...step, allocated_metrics: updated };
    });
    updateStepsAndState(nextSteps);
  };

  const removeStep = (index) => {
    updateStepsAndState(steps.filter((_, i) => i !== index));
  };

  const addKeyPair = (stepIndex) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== stepIndex) return step;
      const lCols = getColumnsForDataset(step.left_file, idx);
      const rCols = getColumnsForDataset(step.right_file, idx);
      const currentLeftKeys = (step.key_pairs || []).map((kp) => kp.left_key);
      const nextLeftKey = lCols.find((c) => !currentLeftKeys.includes(c)) || lCols[0] || "";
      const nextRightKey = rCols.find((c) => c.toLowerCase() === nextLeftKey.toLowerCase()) || rCols[0] || "";

      return {
        ...step,
        key_pairs: [...(step.key_pairs || []), { left_key: nextLeftKey, right_key: nextRightKey }],
      };
    });
    updateStepsAndState(nextSteps);
  };

  const updateKeyPair = (stepIndex, pairIndex, side, value) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== stepIndex) return step;
      const updatedPairs = step.key_pairs.map((pair, pIdx) => {
        if (pIdx !== pairIndex) return pair;
        return { ...pair, [side]: value };
      });
      return { ...step, key_pairs: updatedPairs };
    });
    updateStepsAndState(nextSteps);
  };

  const removeKeyPair = (stepIndex, pairIndex) => {
    const nextSteps = steps.map((step, idx) => {
      if (idx !== stepIndex) return step;
      if (step.key_pairs.length <= 1) {
        toast.error("At least one key pair is required.");
        return step;
      }
      return {
        ...step,
        key_pairs: step.key_pairs.filter((_, pIdx) => pIdx !== pairIndex),
      };
    });
    updateStepsAndState(nextSteps);
  };

  const handleDownloadArd = async (ardFilename) => {
    try {
      toast.loading("Preparing full CSV download...", { id: "dl-ard" });
      const csvData = await v2GetCsv(workflowId, ardFilename);
      const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = ardFilename.endsWith(".csv") ? ardFilename : `${ardFilename}.csv`;
      link.click();
      toast.success(`Downloaded ${ardFilename}`, { id: "dl-ard" });
    } catch (err) {
      toast.error(problemMessage(err, "Failed to download ARD"), { id: "dl-ard" });
    }
  };

  const handleExecutePipeline = async () => {
    if (!selectedSourceFiles.length) {
      return toast.error("Please select at least one source file.");
    }

    // Comprehensive validation per step type
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.step_type === "allocate") {
        if (!s.source_grain_key) {
          return toast.error(`Step ${i + 1} (Allocation): Please select a Source Grain Key (e.g. DMA).`);
        }
        if (!s.target_grain_key) {
          return toast.error(`Step ${i + 1} (Allocation): Please select a Target Grain Key (e.g. NPI).`);
        }
        if (s.allocation_method === "weighted_column") {
          if (!s.weight_file) {
            return toast.error(`Step ${i + 1} (Allocation): Please select a Weight Dataset.`);
          }
          if (!s.weight_column) {
            return toast.error(`Step ${i + 1} (Allocation): Please select a Weight Column.`);
          }
        }
      }
      if (s.step_type === "rollup") {
        if (!s.target_entity_key) {
          return toast.error(`Step ${i + 1} (Rollup): Please select a Target Entity Key.`);
        }
      }
    }

    setLoading(true);
    setArdResult(null);

    try {
      const formattedSteps = steps.map((s, idx) => {
        const srcCols = getColumnsForDataset(s.source_file || s.left_file, idx);
        const autoAggRules = { ...(s.agg_rules || {}) };

        srcCols.forEach((col) => {
          if (isMetricOrPromo(col) && !autoAggRules[col]) {
            autoAggRules[col] = "sum";
          }
        });

        const pairs = s.join_type === "cross" ? [] : s.key_pairs || [];
        return {
          step_type: s.step_type || "join",
          left_file: s.left_file || s.source_file,
          right_file: s.right_file || s.target_file,
          source_file: s.source_file || s.left_file,
          target_file: s.target_file || s.left_file,
          mapping_file: s.mapping_file,
          weight_file: s.weight_file,
          join_type: s.join_type || "left",
          left_key: pairs.map((kp) => kp.left_key).filter(Boolean),
          right_key: pairs.map((kp) => kp.right_key).filter(Boolean),
          source_grain: s.source_grain,
          target_grain: s.target_grain,
          source_grain_key: s.source_grain_key || s.source_entity_key,
          target_grain_key: s.target_grain_key || s.target_entity_key,
          source_entity_key: s.source_entity_key || s.source_grain_key,
          target_entity_key: s.target_entity_key || s.target_grain_key,
          mapping_source_key: s.mapping_source_key || s.source_entity_key || s.source_grain_key,
          mapping_target_key: s.mapping_target_key || s.target_entity_key || s.target_grain_key,
          time_key: s.time_key,
          allocation_method: s.allocation_method,
          weight_column: s.weight_column,
          agg_rules: autoAggRules,
          allocated_metrics: s.allocated_metrics || [],
        };
      });

      const res = await v2BuildArd(workflowId, {
        steps: formattedSteps,
        target_grain: activeTab === "dma" ? "dma" : "hcp",
        output: ardDatasetName,
      });

      const csv = await v2GetCsv(workflowId, res.filename);

      const ardObj = {
        id: res.filename,
        name: ardDatasetName,
        filename: res.filename,
        grain: activeTab === "dma" ? "dma" : "hcp",
        rows: res.row_count,
        cols: (res.columns || []).length,
        columns: res.columns || [],
        version: res.version || 1,
        csv_data: csv,
        createdAt: new Date().toISOString(),
      };

      const existingArds = (state.savedArds || []).filter((a) => a.filename !== res.filename);
      const updatedArds = [ardObj, ...existingArds];

      setArdResult({
        rows: res.row_count,
        cols: (res.columns || []).length,
        version: res.version,
        preview: res.preview || [],
        lineage: res.lineage || res.derived_from || {},
        filename: res.filename,
        csv_data: csv,
      });

      setSavedArdsList(updatedArds);
      setFields({
        savedArds: updatedArds,
        activeDataset: res.filename,
        granularCsvData: csv,
        filteredCsvData: csv,
        mergedCsvData: csv,
      });

      await refreshArds();
      toast.success(`Generated ${res.filename} (${res.row_count.toLocaleString()} rows)`);
    } catch (err) {
      console.error(err);
      toast.error(problemMessage(err, "Pipeline execution failed"), { duration: 6000 });
    } finally {
      setLoading(false);
    }
  };

  const handleProceedToNext = async () => {
    await saveWorkflowSnapshot("Exploratory Data Analysis", "/eda", {
      ingestion: "completed",
      ard_stitching: "completed",
      eda: "in_progress",
    });
    toast.success("ARD Saved! Proceeding to Exploratory Data Analysis.");
    navigate("/eda");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Grain-Aware Data Stitching & ARD Creation"
        subtitle="Integrate datasets across same-grain or cross-grain hierarchies with automated metric conservation"
        icon="🧬"
      />

      <div className="bg-slate-200/70 p-1.5 rounded-2xl flex items-center gap-1 shadow-inner border border-slate-200">
        {[
          { id: "hcp", label: "HCP-Level ARD (Physician Grain)", icon: "🩺" },
          { id: "dma", label: "DMA-Level ARD (Market Grain)", icon: "📡" },
          { id: "custom", label: "Custom Hierarchical ARD", icon: "✨" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-3 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === tab.id
                ? "bg-white text-slate-800 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:text-slate-800 hover:bg-white/40"
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <Card title="Source & Mapping Datasets">
        <p className="text-xs text-slate-500 mb-3">
          Select participating files for this <strong>{activeTab.toUpperCase()}</strong> stitching pipeline:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {fileNames.map((fname) => {
            const isChecked = selectedSourceFiles.includes(fname);
            const colsCount = datasetColumns[fname]?.length || 0;

            return (
              <div
                key={fname}
                onClick={() => toggleSourceFile(fname)}
                className={`p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5 ${
                  isChecked
                    ? "bg-brand-50/50 border-brand-300 ring-2 ring-brand-500/20 shadow-sm"
                    : "bg-slate-50 border-slate-200 hover:bg-slate-100 opacity-60"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => {}}
                  className="mt-0.5 rounded text-brand-600 focus:ring-brand-500 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-bold text-slate-800 truncate block">{fname}</span>
                  <span className="text-[10px] text-slate-400 font-mono block mt-0.5">{colsCount} columns</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-6 space-y-4">
          <Card title="Sequential Transformation & Stitching Pipeline">
            <p className="text-xs text-slate-500 mb-4">
              Configure joins, rollups, and allocations. Each step outputs a dataset accessible by downstream steps.
            </p>

            <div className="space-y-4 max-h-[640px] overflow-y-auto pr-1">
              {steps.map((step, idx) => {
                const srcCols = getColumnsForDataset(step.source_file || step.left_file, idx);
                const tgtCols = getColumnsForDataset(step.target_file || step.left_file, idx);
                const mapCols = datasetColumns[step.mapping_file] || [];
                const leftCols = getColumnsForDataset(step.left_file, idx);
                const rightCols = getColumnsForDataset(step.right_file, idx);
                const isCrossJoin = step.join_type === "cross";

                const promoAndKpiCols = srcCols.filter(
                  (c) =>
                    c !== step.source_entity_key &&
                    c !== step.time_key &&
                    c !== step.target_entity_key &&
                    isMetricOrPromo(c)
                );

                const higherGrainMediaCols = srcCols.filter(
                  (c) => c !== step.source_grain_key && c !== step.time_key && isMetricOrPromo(c)
                );

                return (
                  <div key={idx} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3 relative shadow-sm">
                    <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-brand-700 uppercase tracking-wider">
                          Step {idx + 1}
                        </span>
                        <span className="text-xs font-semibold text-slate-700">
                          {step.step_type === "rollup"
                            ? "📈 Rollup (Lower → Higher Grain)"
                            : step.step_type === "allocate"
                            ? "⚖️ Allocation (Higher → Lower Grain)"
                            : "🔗 Relational Join (Same Grain)"}
                        </span>
                      </div>
                      {steps.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeStep(idx)}
                          className="text-red-400 hover:text-red-600 text-xs font-bold px-1.5 py-0.5 rounded hover:bg-red-50"
                        >
                          ✕ Remove Step
                        </button>
                      )}
                    </div>

                    <Select
                      label="Operation Type"
                      value={step.step_type || "join"}
                      onChange={(v) => updateStep(idx, "step_type", v)}
                      options={STEP_TYPES}
                    />

                    {/* STEP TYPE: ROLLUP */}
                    {step.step_type === "rollup" && (
                      <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200">
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            label="Lower Grain Source Dataset (e.g. Sales, Calls)"
                            value={step.source_file || step.left_file}
                            onChange={(v) => updateStep(idx, "source_file", v)}
                            options={getAvailableLeftDatasets(idx)}
                          />
                          <Select
                            label="Bridge / Crosswalk Mapping Dataset"
                            value={step.mapping_file}
                            onChange={(v) => updateStep(idx, "mapping_file", v)}
                            options={["", ...selectedSourceFiles]}
                            placeholder="Optional (if Source already has DMA)"
                          />
                        </div>

                        {step.mapping_file ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <Select
                              label="1. Source Key (in Source)"
                              value={step.source_entity_key}
                              onChange={(v) => updateStep(idx, "source_entity_key", v)}
                              options={srcCols}
                              placeholder="e.g. npi_id"
                            />
                            <Select
                              label="2. Match Key (in Bridge)"
                              value={step.mapping_source_key}
                              onChange={(v) => updateStep(idx, "mapping_source_key", v)}
                              options={mapCols}
                              placeholder="e.g. npi_id"
                            />
                            <Select
                              label="3. Target Key (in Bridge)"
                              value={step.target_entity_key}
                              onChange={(v) => updateStep(idx, "target_entity_key", v)}
                              options={mapCols}
                              placeholder="e.g. dma_code"
                            />
                            <Select
                              label="4. Time / Date Key"
                              value={step.time_key}
                              onChange={(v) => updateStep(idx, "time_key", v)}
                              options={srcCols}
                              placeholder="e.g. date"
                            />
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            <Select
                              label="Target Entity Key (Rollup Grain in Source)"
                              value={step.target_entity_key}
                              onChange={(v) => updateStep(idx, "target_entity_key", v)}
                              options={srcCols}
                              placeholder="Select DMA column in source"
                            />
                            <Select
                              label="Time / Date Key"
                              value={step.time_key}
                              onChange={(v) => updateStep(idx, "time_key", v)}
                              options={srcCols}
                              placeholder="Select Date"
                            />
                          </div>
                        )}

                        {promoAndKpiCols.length > 0 && (
                          <div className="mt-3 space-y-2 pt-2 border-t border-slate-100">
                            <div className="flex justify-between items-center">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                                Group-by Aggregation Rules (Promotional &amp; Sales Metrics)
                              </span>
                              <span className="text-[10px] text-brand-600 font-mono font-bold">
                                Default: SUM (Conserved)
                              </span>
                            </div>

                            <div className="max-h-44 overflow-y-auto space-y-1.5 p-2 bg-slate-50 rounded-lg border border-slate-200">
                              {promoAndKpiCols.map((col) => {
                                const currentAgg = step.agg_rules?.[col] || "sum";
                                const roleBadge = columnRoles[col] || "Metric";
                                return (
                                  <div key={col} className="flex items-center justify-between gap-2 text-xs">
                                    <div className="flex items-center gap-1.5 truncate max-w-[220px]">
                                      <span className="font-bold text-slate-800 truncate">{col}</span>
                                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-semibold truncate">
                                        {roleBadge}
                                      </span>
                                    </div>
                                    <select
                                      value={currentAgg}
                                      onChange={(e) => updateAggRule(idx, col, e.target.value)}
                                      className="border border-slate-200 rounded px-2 py-1 text-xs font-semibold bg-white focus:outline-none"
                                    >
                                      {AGG_OPTIONS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* STEP TYPE: ALLOCATE */}
                    {step.step_type === "allocate" && (
                      <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200">
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            label="Higher Grain Spend/Media Dataset"
                            value={step.source_file || step.right_file}
                            onChange={(v) => updateStep(idx, "source_file", v)}
                            options={selectedSourceFiles}
                          />
                          <Select
                            label="Target Lower Grain Structure Dataset"
                            value={step.target_file || step.left_file}
                            onChange={(v) => updateStep(idx, "target_file", v)}
                            options={getAvailableLeftDatasets(idx)}
                          />
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <Select
                            label="Source Grain Key (e.g. DMA)"
                            value={step.source_grain_key}
                            onChange={(v) => updateStep(idx, "source_grain_key", v)}
                            options={srcCols}
                            placeholder="Select DMA Key"
                          />
                          <Select
                            label="Target Grain Key (e.g. NPI)"
                            value={step.target_grain_key}
                            onChange={(v) => updateStep(idx, "target_grain_key", v)}
                            options={tgtCols}
                            placeholder="Select NPI Key"
                          />
                          <Select
                            label="Time / Date Key"
                            value={step.time_key}
                            onChange={(v) => updateStep(idx, "time_key", v)}
                            options={srcCols}
                            placeholder="Select Date"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            label="Crosswalk Mapping Dataset"
                            value={step.mapping_file}
                            onChange={(v) => updateStep(idx, "mapping_file", v)}
                            options={["", ...selectedSourceFiles]}
                            placeholder="Optional if already joined"
                          />
                          <Select
                            label="Allocation Method"
                            value={step.allocation_method || "equal"}
                            onChange={(v) => updateStep(idx, "allocation_method", v)}
                            options={ALLOCATION_METHODS}
                          />
                        </div>

                        {step.allocation_method === "weighted_column" && (
                          <div className="grid grid-cols-2 gap-2 p-2.5 bg-brand-50/60 rounded-lg border border-brand-200">
                            <Select
                              label="Weight Dataset (e.g. dma_population_weights.csv)"
                              value={step.weight_file}
                              onChange={(v) => updateStep(idx, "weight_file", v)}
                              options={["", ...selectedSourceFiles]}
                              placeholder="Select Weight Dataset"
                            />
                            <Select
                              label="Weight Column"
                              value={step.weight_column}
                              onChange={(v) => updateStep(idx, "weight_column", v)}
                              options={step.weight_file ? (datasetColumns[step.weight_file] || []) : []}
                              placeholder={step.weight_file ? "Select Weight Column" : "Select Weight Dataset first..."}
                            />
                          </div>
                        )}

                        {higherGrainMediaCols.length > 0 && (
                          <div className="mt-2 space-y-1.5 pt-2 border-t border-slate-100">
                            <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider block">
                              Select Media Metrics to Allocate Down:
                            </span>
                            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 bg-slate-50 rounded-lg border border-slate-200">
                              {higherGrainMediaCols.map((col) => {
                                const isSelected =
                                  (step.allocated_metrics || []).length === 0 ||
                                  (step.allocated_metrics || []).includes(col);
                                return (
                                  <button
                                    key={col}
                                    type="button"
                                    onClick={() => toggleAllocatedMetric(idx, col)}
                                    className={`px-2.5 py-1 rounded text-xs font-bold transition-all border ${
                                      isSelected
                                        ? "bg-[#001E96] text-white border-[#001E96]"
                                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                                    }`}
                                  >
                                    <span>{isSelected ? "✓ " : "+ "}</span>
                                    <span>{col}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* STEP TYPE: RELATIONAL JOIN */}
                    {step.step_type === "join" && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            label="Left Dataset"
                            value={step.left_file}
                            onChange={(v) => updateStep(idx, "left_file", v)}
                            options={getAvailableLeftDatasets(idx)}
                          />
                          <Select
                            label="Right Dataset"
                            value={step.right_file}
                            onChange={(v) => updateStep(idx, "right_file", v)}
                            options={selectedSourceFiles}
                          />
                        </div>

                        <Select
                          label="Join Strategy"
                          value={step.join_type}
                          onChange={(v) => updateStep(idx, "join_type", v)}
                          options={[
                            { value: "left", label: `Left Join (Keep all ${step.left_file || "left"} rows)` },
                            { value: "inner", label: "Inner Join (Match only | keep common rows)" },
                            { value: "right", label: `Right Join (Keep all ${step.right_file || "right"} rows)` },
                            { value: "outer", label: "Full Outer Join (Keep all rows from both)" },
                            { value: "cross", label: "Cross Join (Cartesian Product | all combinations)" },
                          ]}
                        />

                        {!isCrossJoin && (
                          <div className="bg-white rounded-xl p-3 border border-slate-200 space-y-2.5">
                            <div className="flex justify-between items-center">
                              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                                Composite Join Keys
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                {step.key_pairs?.length || 1} key(s) mapped
                              </span>
                            </div>

                            {step.key_pairs?.map((pair, kIdx) => (
                              <div key={kIdx} className="flex items-center gap-2">
                                <div className="grid grid-cols-2 gap-2 flex-1">
                                  <Select
                                    label={kIdx === 0 ? `Key (${step.left_file || "Left"})` : ""}
                                    value={pair.left_key}
                                    onChange={(v) => updateKeyPair(idx, kIdx, "left_key", v)}
                                    options={leftCols}
                                    placeholder="Select Column"
                                  />
                                  <Select
                                    label={kIdx === 0 ? `Key (${step.right_file || "Right"})` : ""}
                                    value={pair.right_key}
                                    onChange={(v) => updateKeyPair(idx, kIdx, "right_key", v)}
                                    options={rightCols}
                                    placeholder="Select Column"
                                  />
                                </div>

                                {step.key_pairs.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => removeKeyPair(idx, kIdx)}
                                    className="text-slate-400 hover:text-red-500 font-bold text-xs p-1 mt-auto mb-2 rounded hover:bg-red-50"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            ))}

                            <div className="pt-1">
                              <button
                                type="button"
                                onClick={() => addKeyPair(idx)}
                                className="text-[11px] font-bold text-brand-600 hover:text-brand-700 flex items-center gap-1 hover:underline"
                              >
                                <span>+ Add Another Key Pair</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-2 space-y-3">
              <div className="flex gap-2">
                <Btn variant="outline" onClick={() => addPipelineStep("join")} className="flex-1 justify-center text-xs">
                  + Add Join
                </Btn>
                <Btn variant="outline" onClick={() => addPipelineStep("rollup")} className="flex-1 justify-center text-xs">
                  + Add Rollup
                </Btn>
                <Btn variant="outline" onClick={() => addPipelineStep("allocate")} className="flex-1 justify-center text-xs">
                  + Add Allocation
                </Btn>
              </div>

              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-1.5">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                  Resulting ARD Dataset Name
                </label>
                <input
                  type="text"
                  value={ardDatasetName}
                  onChange={(e) => setArdDatasetName(e.target.value)}
                  placeholder="e.g. HCP_Master_ARD"
                  className="w-full text-xs font-bold border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <Btn
                onClick={handleExecutePipeline}
                disabled={loading || !selectedSourceFiles.length}
                className="w-full justify-center py-3 text-xs uppercase tracking-wider font-bold"
              >
                {loading ? "Executing Pipeline…" : `Execute & Generate ${activeTab.toUpperCase()} ARD 🚀`}
              </Btn>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-6 space-y-4">
          {loading && <Spinner label="Executing multi-grain transformation and stitching pipeline..." />}

          {!ardResult && !loading && (
            <Card className="text-center py-24 text-slate-400">
              <span className="text-5xl block mb-3">🧬</span>
              <h3 className="text-base font-bold text-slate-700">No ARD Generated Yet</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                Configure join, rollup, or allocation steps and click <strong>Execute &amp; Generate ARD</strong>.
              </p>
            </Card>
          )}

          {ardResult && (
            <Card title={`${ardDatasetName} (Version ${ardResult.version}) Preview`}>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-brand-50 p-3 rounded-xl text-center">
                  <div className="text-lg font-bold text-brand-700">
                    {(ardResult.rows || 0).toLocaleString()}
                  </div>
                  <div className="text-[10px] text-brand-500 uppercase font-semibold">Total Rows</div>
                </div>
                <div className="bg-brand-50 p-3 rounded-xl text-center">
                  <div className="text-lg font-bold text-brand-700">{ardResult.cols || 0}</div>
                  <div className="text-[10px] text-brand-500 uppercase font-semibold">Total Columns</div>
                </div>
                <div className="bg-brand-50 p-3 rounded-xl text-center">
                  <div className="text-lg font-bold text-brand-700">v{ardResult.version || 1}</div>
                  <div className="text-[10px] text-brand-500 uppercase font-semibold">Saved Version</div>
                </div>
              </div>

              {/* Lineage & Metric Conservation Audit Trail */}
              {ardResult.lineage?.steps_executed?.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-4 text-xs space-y-2">
                  <span className="font-bold text-slate-700 block">🔍 Grain Lineage &amp; Metric Conservation Audit</span>
                  {ardResult.lineage.steps_executed.map((st, i) => (
                    <div key={i} className="border-b border-slate-200/60 pb-1.5 last:border-b-0">
                      <p className="text-slate-600 text-[11px]">
                        Step {st.step}: <strong className="text-brand-700 uppercase">{st.type}</strong> — {st.source || st.left} → {st.target || st.right}
                      </p>
                      {st.metric_conservation && (
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            st.metric_conservation.status === "PASS" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                          }`}>
                            Metric Conservation: {st.metric_conservation.status}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 space-y-2">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Sample Stitched Records (First 100 rows)
                </span>
                <DataTable data={ardResult.preview || []} />
              </div>

              <div className="mt-6 flex justify-between items-center gap-3 flex-wrap pt-4 border-t border-slate-100">
                <Btn
                  variant="outline"
                  onClick={() => handleDownloadArd(ardResult.filename)}
                >
                  📥 Download {ardResult.filename} (Full CSV)
                </Btn>

                <Btn onClick={handleProceedToNext}>
                  Proceed to EDA →
                </Btn>
              </div>
            </Card>
          )}

          {savedArdsList.length > 0 && (
            <Card title="Saved Stitched ARD Datasets">
              <div className="space-y-3">
                {savedArdsList.map((ard) => (
                  <div key={ard.filename} className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <strong className="text-xs text-slate-800 block">{ard.filename}</strong>
                      <span className="text-[11px] text-slate-500 font-medium">
                        {ard.grain?.toUpperCase()} Grain • {(ard.rows || 0).toLocaleString()} rows • {ard.cols || 0} cols • v{ard.version}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDownloadArd(ard.filename)}
                      className="px-3.5 py-1.5 text-xs font-bold rounded-lg border border-brand-500 text-brand-600 bg-white hover:bg-brand-50 transition-colors shadow-sm"
                    >
                      📥 Download CSV
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}