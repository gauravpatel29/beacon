import React, { useState, useMemo, useEffect } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { API } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, DataTable, Alert, Spinner, Select } from "../components/UI";

export default function DataStitching() {
  const navigate = useNavigate();
  const { state, setField, saveWorkflowSnapshot } = useAppState();

  const ingestedFiles = state.ingestedFiles || [];
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
  const [activeTab, setActiveTab] = useState("hcp");

  // ─── 2. Source Files Checklist ────────────────────────────────────────────
  const [selectedSourceFiles, setSelectedSourceFiles] = useState(() => fileNames);

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

  // ─── 4. Helper to get default single primary key pair ─────────────────────
  const getSingleDefaultKeyPair = (lFile, rFile) => {
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

    return [{ left_key: autoLKey, right_key: autoRKey }];
  };

  // ─── 5. Steps State ───────────────────────────────────────────────────────
  const [steps, setSteps] = useState(() => {
    const s1Left = selectedSourceFiles[0] || fileNames[0] || "";
    const s1Right = selectedSourceFiles[1] || fileNames[1] || "";
    return [
      {
        left_file: s1Left,
        right_file: s1Right,
        join_type: "left",
        key_pairs: getSingleDefaultKeyPair(s1Left, s1Right),
      },
    ];
  });

  useEffect(() => {
    if (selectedSourceFiles.length >= 2 && (!steps[0]?.left_file || !selectedSourceFiles.includes(steps[0]?.left_file))) {
      const s1Left = selectedSourceFiles[0];
      const s1Right = selectedSourceFiles[1];

      setSteps([
        {
          left_file: s1Left,
          right_file: s1Right,
          join_type: "left",
          key_pairs: getSingleDefaultKeyPair(s1Left, s1Right),
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

  // ─── Step Operations ──────────────────────────────────────────────────────
  const addJoinStep = () => {
    const prevResultName = `Step ${steps.length} Result`;
    const usedRights = steps.map((s) => s.right_file);
    const defaultRight =
      selectedSourceFiles.find((f) => f !== steps[0]?.left_file && !usedRights.includes(f)) ||
      selectedSourceFiles[0] ||
      "";

    setSteps((prev) => [
      ...prev,
      {
        left_file: prevResultName,
        right_file: defaultRight,
        join_type: "left",
        key_pairs: getSingleDefaultKeyPair(steps[0]?.left_file, defaultRight),
      },
    ]);
  };

  const updateStep = (index, field, value) => {
    setSteps((prev) =>
      prev.map((step, idx) => {
        if (idx !== index) return step;
        const updated = { ...step, [field]: value };
        if (field === "left_file" || field === "right_file") {
          updated.key_pairs = getSingleDefaultKeyPair(
            field === "left_file" ? value : updated.left_file,
            field === "right_file" ? value : updated.right_file
          );
        }
        return updated;
      })
    );
  };

  const removeStep = (index) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── Pure Immutable Key Pair Operations (Adds Exactly 1 Pair) ─────────────
  const addKeyPair = (stepIndex) => {
    setSteps((prev) =>
      prev.map((step, idx) => {
        if (idx !== stepIndex) return step;
        const lCols = datasetColumns[step.left_file] || allKnownCols;
        const rCols = datasetColumns[step.right_file] || allKnownCols;

        const currentLeftKeys = (step.key_pairs || []).map((kp) => kp.left_key);
        const nextLeftKey = lCols.find((c) => !currentLeftKeys.includes(c)) || lCols[0] || "";
        const nextRightKey =
          rCols.find((c) => c.toLowerCase() === nextLeftKey.toLowerCase()) ||
          rCols[0] ||
          "";

        return {
          ...step,
          key_pairs: [...(step.key_pairs || []), { left_key: nextLeftKey, right_key: nextRightKey }],
        };
      })
    );
  };

  const updateKeyPair = (stepIndex, pairIndex, side, value) => {
    setSteps((prev) =>
      prev.map((step, idx) => {
        if (idx !== stepIndex) return step;
        const updatedPairs = step.key_pairs.map((pair, pIdx) => {
          if (pIdx !== pairIndex) return pair;
          return { ...pair, [side]: value };
        });
        return { ...step, key_pairs: updatedPairs };
      })
    );
  };

  const removeKeyPair = (stepIndex, pairIndex) => {
    setSteps((prev) =>
      prev.map((step, idx) => {
        if (idx !== stepIndex) return step;
        if (step.key_pairs.length <= 1) {
          toast.error("At least one key pair is required.");
          return step;
        }
        return {
          ...step,
          key_pairs: step.key_pairs.filter((_, pIdx) => pIdx !== pairIndex),
        };
      })
    );
  };

  // ─── 6. Execution Pipeline ────────────────────────────────────────────────
  const handleExecutePipeline = async () => {
    if (!selectedSourceFiles.length) {
      return toast.error("Please select at least one source file.");
    }

    // Client-side Validation
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.left_file || !s.right_file) {
        return toast.error(`Step ${i + 1}: Select both Left and Right datasets.`);
      }
      if (s.join_type !== "cross") {
        if (!s.key_pairs || s.key_pairs.length === 0) {
          return toast.error(`Step ${i + 1}: Add at least one join key pair.`);
        }
        for (let k = 0; k < s.key_pairs.length; k++) {
          const kp = s.key_pairs[k];
          if (!kp.left_key || !kp.right_key) {
            return toast.error(`Step ${i + 1} (Key Pair #${k + 1}): Please select both Left and Right column keys.`);
          }
        }
      }
    }

    setLoading(true);
    setArdResult(null);

    try {
      const filesMap = {};
      ingestedFiles.forEach((f) => {
        filesMap[f.filename] = f.workingCsv || f.rawCsv || "";
      });

      const formattedSteps = steps.map((s) => {
        const lKeys = s.join_type === "cross" ? [] : s.key_pairs.map((kp) => kp.left_key).filter(Boolean);
        const rKeys = s.join_type === "cross" ? [] : s.key_pairs.map((kp) => kp.right_key).filter(Boolean);
        return {
          left_file: s.left_file,
          right_file: s.right_file,
          join_type: s.join_type,
          left_key: lKeys,
          right_key: rKeys,
        };
      });

      const payload = {
        workflow_id: state.workflowId || "wf_default",
        target_grain: activeTab === "hcp" ? "hcp" : "dma",
        steps: formattedSteps,
        files_map: filesMap,
      };

      const res = await API.post("/ard/build-ard-pipeline", payload).then((r) => r.data);
      setArdResult(res);

      // Register the generated ARD into savedArds for downstream selection
      const newArdEntry = {
        id: `ard_${Date.now()}`,
        name: ardDatasetName.trim() || `${activeTab.toUpperCase()}_ARD_v${res.version}`,
        grain: activeTab,
        version: res.version,
        rows: res.rows,
        cols: res.cols,
        columns: res.columns,
        csv_data: res.csv_data,
        createdAt: new Date().toISOString(),
      };

      const existingArds = (state.savedArds || []).filter((a) => a.name !== newArdEntry.name);
      const updatedArds = [...existingArds, newArdEntry];

      setField("savedArds", updatedArds);

      // Update active working datasets for downstream modules
      if (activeTab === "hcp" || activeTab === "custom") {
        setField("granularCsvData", res.csv_data);
        setField("mergedCsvData", res.csv_data);
      } else {
        setField("filteredCsvData", res.csv_data);
      }

      toast.success(`Generated & Saved "${newArdEntry.name}" (${res.rows.toLocaleString()} rows)`);
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.error || err.response?.data?.detail || err.message || "Pipeline join failed";
      toast.error(msg, { duration: 6000 });
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

      {/* Top Navigation Tabs */}
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
          Select the source files to include in this <strong>{activeTab.toUpperCase()} ARD</strong> pipeline:
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

        <div className="mt-3 bg-slate-50 border border-slate-100 p-2.5 rounded-xl text-[11px] text-slate-500 flex items-center justify-between">
          <span>Mapping file and population universe files included automatically</span>
          <span className="font-semibold text-slate-700">{selectedSourceFiles.length} file(s) active</span>
        </div>
      </Card>

      {/* Section 2: Sequential Join Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Sequential Pipeline Builder */}
        <div className="lg:col-span-6 space-y-4">
          <Card title="Sequential Join Pipeline Sequence">
            <p className="text-xs text-slate-500 mb-4">
              Build your dataset step-by-step. Each step outputs an intermediate dataset (e.g. <em>Step 1 Result</em>) that can be paired with subsequent source files.
            </p>

            <div className="space-y-4 max-h-[580px] overflow-y-auto pr-1">
              {steps.map((step, idx) => {
                const leftCols = datasetColumns[step.left_file] || allKnownCols;
                const rightCols = datasetColumns[step.right_file] || allKnownCols;
                const isCrossJoin = step.join_type === "cross";

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
                          className="text-red-400 hover:text-red-600 text-xs font-bold px-1.5 py-0.5 rounded hover:bg-red-50"
                        >
                          ✕ Remove Step
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

                    {/* Join Strategy Dropdown with Cross Join */}
                    <Select
                      label="Join Strategy"
                      value={step.join_type}
                      onChange={(v) => updateStep(idx, "join_type", v)}
                      options={[
                        { value: "left", label: `Left Join (Keep all ${step.left_file || "left"} rows)` },
                        { value: "inner", label: "Inner Join (Match only — keep common rows)" },
                        { value: "right", label: `Right Join (Keep all ${step.right_file || "right"} rows)` },
                        { value: "outer", label: "Full Outer Join (Keep all rows from both)" },
                        { value: "cross", label: "Cross Join (Cartesian Product — all combinations)" },
                      ]}
                    />

                    {/* ─── DYNAMIC MULTIPLE KEY PAIRS BLOCK ─────────────────────── */}
                    {isCrossJoin ? (
                      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800">
                        ℹ️ <strong>Cross Join active:</strong> Combines every row from <strong>{step.left_file || "Left"}</strong> with every row from <strong>{step.right_file || "Right"}</strong> (no join keys needed).
                      </div>
                    ) : (
                      <div className="bg-white rounded-xl p-3 border border-slate-200 space-y-2.5">
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                            Join Key Pairs (Composite Keys)
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
                                title="Remove this key pair"
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
                  </div>
                );
              })}
            </div>

            {/* Pipeline Controls */}
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
        <div className="lg:col-span-6 space-y-4">
          {loading && <Spinner label="Executing multi-step join pipeline..." />}

          {!ardResult && !loading && (
            <Card className="text-center py-24 text-slate-400">
              <span className="text-5xl block mb-3">🧬</span>
              <h3 className="text-base font-bold text-slate-700">No ARD Generated Yet</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                Select your join strategy, configure key pairs, and click <strong>Execute & Generate ARD</strong>.
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
                      Step {st.step}: <strong className="text-slate-700">{st.left}</strong> ({st.join}) +{" "}
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