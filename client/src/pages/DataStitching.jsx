import React, { useState, useMemo, useEffect } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { v2BuildArd, v2ListFiles, v2GetCsv, problemMessage } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, DataTable, Alert, Spinner, Select } from "../components/UI";

export default function DataStitching() {
  const navigate = useNavigate();
  const { state, setField, setFields, saveWorkflowSnapshot } = useAppState();
  const workflowId = state.workflowId;

  // Datasets live in Neon; the browser holds only their names and columns.
  // The steps name them and the server resolves the bytes, so no CSV text is
  // sent up to build an ARD.
  const [datasets, setDatasets] = useState(() => state.datasets || []);
  const ingestedFiles = datasets;

  useEffect(() => {
    if (!workflowId) return;
    v2ListFiles(workflowId)
      .then((res) => {
        // Only real sources here - an ARD must not be an input to itself.
        const items = (res.items || []).filter((d) => d.kind !== "ard");
        setDatasets(items);
        setField("datasets", items);
      })
      .catch((err) => toast.error(problemMessage(err, "Could not load datasets")));
    /* eslint-disable-next-line */
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

  // ─── 1. Tab Selection (HCP, DMA, Custom) ──────────────────────────────────
  const [activeTab, setActiveTab] = useState("hcp"); // 'hcp' | 'dma' | 'custom'

  // ─── 2. Source Files Checklist per Tab ────────────────────────────────────
  const [selectedSourceFiles, setSelectedSourceFiles] = useState(() => fileNames);

  // Auto-filter suggested source files when switching tabs
  useEffect(() => {
    if (!fileNames.length) return;
    if (activeTab === "hcp") {
      const hcpFiles = fileNames.filter((f) => {
        const l = f.toLowerCase();
        return (
          l.includes("sale") ||
          l.includes("call") ||
          l.includes("sample") ||
          l.includes("social") ||
          l.includes("rte") ||
          l.includes("speaker") ||
          l.includes("email") ||
          l.includes("hcp")
        );
      });
      setSelectedSourceFiles(hcpFiles.length > 0 ? hcpFiles : fileNames);
    } else if (activeTab === "dma") {
      const dmaFiles = fileNames.filter((f) => {
        const l = f.toLowerCase();
        return (
          l.includes("dma") ||
          l.includes("tv") ||
          l.includes("digital") ||
          l.includes("radio") ||
          l.includes("print") ||
          l.includes("pop") ||
          l.includes("media")
        );
      });
      setSelectedSourceFiles(dmaFiles.length > 0 ? dmaFiles : fileNames);
    } else {
      setSelectedSourceFiles(fileNames);
    }
  }, [activeTab, fileNames]);

  const toggleSourceFile = (fname) => {
    if (selectedSourceFiles.includes(fname)) {
      if (selectedSourceFiles.length === 1) {
        return toast.error("At least one source file must be selected.");
      }
      setSelectedSourceFiles(selectedSourceFiles.filter((f) => f !== fname));
    } else {
      setSelectedSourceFiles([...selectedSourceFiles, fname]);
    }
  };

  // ─── 3. Result Dataset Name ───────────────────────────────────────────────
  const [ardDatasetName, setArdDatasetName] = useState(() => {
    return activeTab === "hcp" ? "HCP_Master_ARD" : activeTab === "dma" ? "DMA_Master_ARD" : "Custom_Master_ARD";
  });

  useEffect(() => {
    setArdDatasetName(
      activeTab === "hcp" ? "HCP_Master_ARD" : activeTab === "dma" ? "DMA_Master_ARD" : "Custom_Master_ARD"
    );
  }, [activeTab]);

  // ─── 4. Sequential Pipeline State ─────────────────────────────────────────
  const getSuggestedKeys = (lFile, rFile) => {
    const lCols = datasetColumns[lFile] || allKnownCols;
    const rCols = datasetColumns[rFile] || allKnownCols;

    const autoLKey =
      lCols.find((c) => c.toLowerCase().includes("npi") || c.toLowerCase().includes("id") || c.toLowerCase().includes("dma")) ||
      lCols[0] ||
      "";
    const autoRKey =
      rCols.find((c) => c.toLowerCase() === autoLKey.toLowerCase()) ||
      rCols.find((c) => c.toLowerCase().includes("npi") || c.toLowerCase().includes("id") || c.toLowerCase().includes("dma")) ||
      rCols[0] ||
      "";

    const autoLDate =
      lCols.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month") || c.toLowerCase().includes("period")) ||
      "";
    const autoRDate =
      rCols.find((c) => c.toLowerCase() === autoLDate.toLowerCase()) ||
      rCols.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month") || c.toLowerCase().includes("period")) ||
      "";

    return { autoLKey, autoRKey, autoLDate, autoRDate };
  };

  const [steps, setSteps] = useState(() => {
    const s1Left = selectedSourceFiles[0] || fileNames[0] || "";
    const s1Right = selectedSourceFiles[1] || fileNames[1] || "";
    const { autoLKey, autoRKey, autoLDate, autoRDate } = getSuggestedKeys(s1Left, s1Right);

    return [
      {
        left_file: s1Left,
        right_file: s1Right,
        join_type: "left",
        left_key: autoLKey,
        right_key: autoRKey,
        left_date_key: autoLDate,
        right_date_key: autoRDate,
      },
    ];
  });

  // Re-sync initial step if selectedSourceFiles change
  useEffect(() => {
    if (selectedSourceFiles.length >= 2 && (!steps[0]?.left_file || !selectedSourceFiles.includes(steps[0]?.left_file))) {
      const s1Left = selectedSourceFiles[0];
      const s1Right = selectedSourceFiles[1];
      const { autoLKey, autoRKey, autoLDate, autoRDate } = getSuggestedKeys(s1Left, s1Right);

      setSteps([
        {
          left_file: s1Left,
          right_file: s1Right,
          join_type: "left",
          left_key: autoLKey,
          right_key: autoRKey,
          left_date_key: autoLDate,
          right_date_key: autoRDate,
        },
      ]);
    }
  }, [selectedSourceFiles]);

  const [loading, setLoading] = useState(false);
  const [ardResult, setArdResult] = useState(null);

  const getAvailableLeftDatasets = (stepIndex) => {
    const prevSteps = [];
    for (let i = 0; i < stepIndex; i++) {
      prevSteps.push(`Step ${i + 1} Result`);
    }
    return [...selectedSourceFiles, ...prevSteps];
  };

  const addJoinStep = () => {
    const prevResultName = `Step ${steps.length} Result`;
    // Find next unused source file
    const usedRights = steps.map((s) => s.right_file);
    const defaultRight =
      selectedSourceFiles.find((f) => f !== steps[0]?.left_file && !usedRights.includes(f)) ||
      selectedSourceFiles[0] ||
      "";

    const { autoLKey, autoRKey, autoLDate, autoRDate } = getSuggestedKeys(steps[0]?.left_file, defaultRight);

    setSteps((prev) => [
      ...prev,
      {
        left_file: prevResultName,
        right_file: defaultRight,
        join_type: "left",
        left_key: steps[0]?.left_key || autoLKey,
        right_key: autoRKey,
        left_date_key: steps[0]?.left_date_key || autoLDate,
        right_date_key: autoRDate,
      },
    ]);
  };

  const updateStep = (index, field, value) => {
    setSteps((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };

      if (field === "right_file") {
        const { autoRKey, autoRDate } = getSuggestedKeys(updated[index].left_file, value);
        updated[index].right_key = autoRKey;
        updated[index].right_date_key = autoRDate;
      }
      return updated;
    });
  };

  const removeStep = (index) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── 5. Execution Pipeline ────────────────────────────────────────────────
  const handleExecutePipeline = async () => {
    if (!selectedSourceFiles.length) {
      return toast.error("Please select at least one source file.");
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.left_file || !s.right_file) {
        return toast.error(`Step ${i + 1}: Please select both Left and Right datasets.`);
      }
      if (!s.left_key || !s.right_key) {
        return toast.error(`Step ${i + 1}: Primary ID Key is missing on ${s.left_file} or ${s.right_file}.`);
      }
    }

    setLoading(true);
    setArdResult(null);

    try {
      // A date key is optional: some sources (a crosswalk, a population file)
      // join on the id alone. Both sides must supply the same number of keys.
      const formattedSteps = steps.map((s) => {
        const pairDates = Boolean(s.left_date_key && s.right_date_key);
        return {
          left_file: s.left_file,
          right_file: s.right_file,
          join_type: s.join_type,
          left_key: [s.left_key, pairDates ? s.left_date_key : null].filter(Boolean),
          right_key: [s.right_key, pairDates ? s.right_date_key : null].filter(Boolean),
        };
      });

      const res = await v2BuildArd(workflowId, {
        steps: formattedSteps,
        target_grain: activeTab === "dma" ? "dma" : "hcp",
        output: ardDatasetName,
      });

      // Normalised for the panel below, which was written against the old
      // response shape.
      setArdResult({
        rows: res.row_count,
        cols: (res.columns || []).length,
        version: res.version,
        preview: res.preview || [],
        lineage: res.lineage || res.derived_from || {},
        filename: res.filename,
      });

      // Hand the ARD to the stages downstream. They still take a CSV string,
      // so it is fetched once here rather than being carried through the app.
      const csv = await v2GetCsv(workflowId, res.filename);
      if (activeTab === "dma") {
        setFields({ activeDataset: res.filename, filteredCsvData: csv });
      } else {
        setFields({ activeDataset: res.filename, granularCsvData: csv, mergedCsvData: csv });
      }

      toast.success(`Generated ${res.filename} with ${res.row_count.toLocaleString()} rows!`);
    } catch (err) {
      console.error(err);
      toast.error(problemMessage(err, "Pipeline join failed"), { duration: 6000 });
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
      {/* Page Header */}
      <PageHeader
        title="Data Stitching & ARD Creation"
        subtitle="Join your mapped files into analytic record datasets"
        icon="🧬"
      />

      {/* Top Segmented Navigation Tabs */}
      <div className="bg-slate-200/70 p-1.5 rounded-2xl flex items-center gap-1 shadow-inner border border-slate-200">
        {[
          { id: "hcp", label: "HCP-Level ARD", icon: "🩺" },
          { id: "dma", label: "DMA-Level ARD", icon: "📡" },
          { id: "custom", label: "Create Custom ARD", icon: "✨" },
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

      {/* Section 1: Source Files Checklist */}
      <Card title="Source Files">
        <p className="text-xs text-slate-500 mb-3">
          Select the mapped source files to include in this <strong>{activeTab.toUpperCase()} ARD</strong> pipeline:
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
                  onChange={() => {}} // Handled by container
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

        <div className="mt-3 bg-slate-50 border border-slate-100 p-2.5 rounded-xl text-[11px] text-slate-500 flex items-center justify-between">
          <span>Mapping file and population universe files included automatically</span>
          <span className="font-semibold text-slate-700">{selectedSourceFiles.length} file(s) active</span>
        </div>
      </Card>

      {/* Section 2: Sequential Join Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Sequential Pipeline Builder */}
        <div className="lg:col-span-5 space-y-4">
          <Card title="Sequential Join Pipeline Sequence">
            <p className="text-xs text-slate-500 mb-4">
              Build your dataset step-by-step. Each step outputs an intermediate dataset (e.g. <em>Step 1 Result</em>) that can be paired with subsequent source files.
            </p>

            <div className="space-y-4 max-h-[560px] overflow-y-auto pr-1">
              {steps.map((step, idx) => {
                const leftCols = datasetColumns[step.left_file] || allKnownCols;
                const rightCols = datasetColumns[step.right_file] || allKnownCols;

                return (
                  <div key={idx} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3 relative shadow-sm">
                    <div className="flex justify-between items-center border-b border-slate-200/60 pb-2">
                      <span className="text-[11px] font-bold text-brand-700 uppercase tracking-wider">
                        Step {idx + 1} Join
                      </span>
                      {steps.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeStep(idx)}
                          className="text-red-400 hover:text-red-600 text-xs font-bold px-1.5 py-0.5 rounded"
                        >
                          ✕ Remove
                        </button>
                      )}
                    </div>

                    {/* Dataset Dropdowns */}
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
                        { value: "inner", label: "Inner Join (Match only)" },
                      ]}
                    />

                    {/* 1. Primary ID Key Selectors */}
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label={`1. ID Key (${step.left_file || "Left"})`}
                        value={step.left_key}
                        onChange={(v) => updateStep(idx, "left_key", v)}
                        options={leftCols}
                        placeholder="Select ID Key"
                      />
                      <Select
                        label={`1. ID Key (${step.right_file || "Right"})`}
                        value={step.right_key}
                        onChange={(v) => updateStep(idx, "right_key", v)}
                        options={rightCols}
                        placeholder="Select ID Key"
                      />
                    </div>

                    {/* 2. Date / Period Key Selectors */}
                    <div className="grid grid-cols-2 gap-2 bg-white p-2.5 rounded-xl border border-slate-200">
                      <Select
                        label={`2. Date Key (${step.left_file || "Left"})`}
                        value={step.left_date_key}
                        onChange={(v) => updateStep(idx, "left_date_key", v)}
                        options={["", ...leftCols]}
                        placeholder="Select Date (Optional)"
                      />
                      <Select
                        label={`2. Date Key (${step.right_file || "Right"})`}
                        value={step.right_date_key}
                        onChange={(v) => updateStep(idx, "right_date_key", v)}
                        options={["", ...rightCols]}
                        placeholder="Select Date (Optional)"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pipeline Action Controls */}
            <div className="pt-2 space-y-3">
              <Btn variant="outline" onClick={addJoinStep} className="w-full justify-center text-xs">
                + Add Next Join Step
              </Btn>

              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-1.5">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                  Resulting ARD Dataset Name
                </label>
                <input
                  type="text"
                  value={ardDatasetName}
                  onChange={(e) => setArdDatasetName(e.target.value)}
                  placeholder="e.g. HCP_Master_ARD_v1"
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

        {/* Right: Live Stitched Preview & Lineage */}
        <div className="lg:col-span-7 space-y-4">
          {loading && <Spinner label="Executing composite join pipeline..." />}

          {!ardResult && !loading && (
            <Card className="text-center py-24 text-slate-400">
              <span className="text-5xl block mb-3">🧬</span>
              <h3 className="text-base font-bold text-slate-700">No ARD Generated Yet</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                Configure your source files and join keys on the left panel, then click <strong>Execute & Generate ARD</strong> to create your analytic dataset.
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

              {/* Lineage Audit Badge */}
              {ardResult.lineage?.steps_executed?.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-4 text-xs space-y-1">
                  <span className="font-bold text-slate-700 block">🔍 Join Lineage Audit Trail</span>
                  {ardResult.lineage.steps_executed.map((st, i) => (
                    <p key={i} className="text-slate-500 text-[11px]">
                      Step {st.step}: <strong className="text-slate-700">{st.left}</strong> ({st.join} join) +{" "}
                      <strong className="text-slate-700">{st.right}</strong> on{" "}
                      <code className="bg-slate-100 px-1 rounded text-slate-800 font-mono">
                        {Array.isArray(st.keys) ? st.keys.join(", ") : st.keys}
                      </code>
                    </p>
                  ))}
                </div>
              )}

              {/* Table Preview */}
              <div className="mt-4 space-y-2">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Sample Stitched Records (First 100 rows)
                </span>
                <DataTable data={ardResult.preview || []} />
              </div>

              {/* Action Buttons */}
              <div className="mt-6 flex justify-end gap-3 flex-wrap">
                <Btn
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([ardResult.csv_data], { type: "text/csv;charset=utf-8;" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `${ardDatasetName}_v${ardResult.version || 1}.csv`;
                    a.click();
                  }}
                >
                  📥 Download ARD CSV
                </Btn>

                <Btn onClick={handleProceedToNext}>
                  Proceed to EDA →
                </Btn>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

