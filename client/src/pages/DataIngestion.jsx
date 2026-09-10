import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  uploadFiles,
  standardizeFile,
  filterData,
  detectGranularity,
  modifyGranularity,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import {
  PageHeader,
  Card,
  Btn,
  Select,
  MultiSelect,
  DataTable,
  Alert,
  Spinner,
} from "../components/UI";

// ─── 5 Core Ingestion Categories ──────────────────────────────────────────────
export const FILE_CATEGORIES = [
  {
    id: "sales",
    label: "Sales File",
    grain: "HCP × Period",
    desc: "HCP × Month/Week grain; used as allocation base",
    required: true,
  },
  {
    id: "hcp_promo",
    label: "HCP-level Marketing / Promo File",
    grain: "HCP × Period",
    desc: "Calls, Samples, Details, Speaker programs",
    required: false,
  },
  {
    id: "dma_promo",
    label: "DMA-level Marketing Activity File",
    grain: "DMA × Period",
    desc: "TV, Radio, Print, Digital spend/impressions",
    required: false,
  },
  {
    id: "dma_hcp_map",
    label: "DMA–HCP Mapping File",
    grain: "HCP ↔ DMA Bridge",
    desc: "Crosswalk bridge between HCP IDs / ZIPs and DMA IDs",
    required: true,
  },
  {
    id: "dma_pop",
    label: "DMA Population File",
    grain: "DMA Grain",
    desc: "DMA target population or universe sizing",
    required: false,
  },
];

export default function DataIngestion() {
  const navigate = useNavigate();
  const { state, setField, saveWorkflowSnapshot, resetWorkflow } = useAppState();

  const [fileList, setFileList] = useState(() => {
    return state.ingestedFiles || [];
  });
  const [activeFileId, setActiveFileId] = useState(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("mapping"); // mapping | standardize | filter | granularity

  const activeFile = useMemo(() => {
    if (!fileList.length) return null;
    return fileList.find((f) => f.id === activeFileId) || fileList[0];
  }, [fileList, activeFileId]);

  useEffect(() => {
    if (fileList.length && !activeFileId) {
      setActiveFileId(fileList[0].id);
    }
    setField("ingestedFiles", fileList);

    const salesFile = fileList.find((f) => f.category === "sales");
    if (salesFile && salesFile.workingCsv) {
      setField("granularCsvData", salesFile.workingCsv);
      setField("filteredCsvData", salesFile.workingCsv);
    }
  }, [fileList, activeFileId, setField]);

  // Multi-File Upload
  const onDrop = useCallback(
    async (acceptedFiles, fileRejections) => {
      if (fileRejections && fileRejections.length > 0) {
        toast.error("Please upload valid CSV or Excel (.xlsx/.xls) files");
        return;
      }
      if (!acceptedFiles || !acceptedFiles.length) return;

      setUploadLoading(true);
      try {
        const form = new FormData();
        acceptedFiles.forEach((f) => form.append("files", f));
        const result = await uploadFiles(form);

        if (result && result.files && result.files.length > 0) {
          const newEntries = result.files.map((rf, idx) => {
            const fileId = `file_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
            const lowerName = rf.filename.toLowerCase();
            let suggestedCat = "";
            
            if (lowerName.includes("sale") || lowerName.includes("trx") || lowerName.includes("nrx")) {
              suggestedCat = "sales";
            } else if (lowerName.includes("map") || lowerName.includes("bridge") || lowerName.includes("crosswalk") || lowerName.includes("dma_to_hcp")) {
              suggestedCat = "dma_hcp_map";
            } else if (lowerName.includes("pop") || lowerName.includes("universe")) {
              suggestedCat = "dma_pop";
            } else if (lowerName.includes("call") || lowerName.includes("sample") || lowerName.includes("hcp") || lowerName.includes("rep") || lowerName.includes("speaker") || lowerName.includes("rte")) {
              suggestedCat = "hcp_promo";
            } else {
              suggestedCat = "dma_promo";
            }

            // Detect initial column types
            const initialTypeCastMap = {};
            (rf.columns || []).forEach((c) => {
              const schemaType = (rf.schema && rf.schema[c]) ? rf.schema[c].toLowerCase() : "";
              if (c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month")) {
                initialTypeCastMap[c] = "date";
              } else if (c.toLowerCase().includes("id") || c.toLowerCase().includes("npi") || c.toLowerCase().includes("zip") || c.toLowerCase().includes("code")) {
                initialTypeCastMap[c] = "string";
              } else if (schemaType.includes("int") || schemaType.includes("float") || schemaType.includes("numeric")) {
                initialTypeCastMap[c] = "float";
              } else {
                initialTypeCastMap[c] = "string";
              }
            });

            return {
              id: fileId,
              filename: rf.filename,
              rawCsv: rf.content_b64,
              workingCsv: rf.content_b64,
              columns: rf.columns || [],
              rows: rf.rows || 0,
              cols: rf.cols || (rf.columns ? rf.columns.length : 0),
              preview: rf.preview || [],
              schema: rf.schema || {},
              suggestedDates: rf.suggested_date_columns || [],
              category: suggestedCat,
              isStandardized: false,
              isFiltered: false,
              isGranularized: false,
              selectedCols: rf.columns || [],
              renameMap: {},
              typeCastMap: initialTypeCastMap,
              dateConfigs: (rf.suggested_date_columns || []).map((c) => ({ col: c, format: "%d/%m/%Y" })),
            };
          });

          setFileList((prev) => [...prev, ...newEntries]);

          if (!activeFileId && newEntries.length > 0) {
            setActiveFileId(newEntries[0].id);
          }

          toast.success(`Uploaded ${newEntries.length} file(s)`);
        }
      } catch (err) {
        console.error(err);
        toast.error(err.response?.data?.detail || "Upload failed");
      } finally {
        setUploadLoading(false);
      }
    },
    [activeFileId]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.ms-excel": [".csv", ".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "text/plain": [".csv", ".txt"],
    },
    multiple: true,
  });

  const handleRemoveFile = (e, fileId) => {
    e.stopPropagation();
    const updated = fileList.filter((f) => f.id !== fileId);
    setFileList(updated);
    if (activeFileId === fileId) {
      setActiveFileId(updated.length ? updated[0].id : null);
    }
    toast.success("File removed");
  };

  const handleAssignCategory = (categoryId) => {
    if (!activeFile) return;
    setFileList((prev) =>
      prev.map((f) => (f.id === activeFile.id ? { ...f, category: categoryId } : f))
    );
    toast.success(`Assigned to ${FILE_CATEGORIES.find((c) => c.id === categoryId)?.label || "category"}`);
  };

  const unmappedCount = useMemo(() => {
    return fileList.filter((f) => !f.category).length;
  }, [fileList]);

  const hasRequiredSales = useMemo(() => {
    return fileList.some((f) => f.category === "sales");
  }, [fileList]);

  const handleProceed = async () => {
    if (!fileList.length) {
      toast.error("Please upload your required source files first.");
      return;
    }
    if (unmappedCount > 0) {
      toast.error(`Please assign a category to the remaining ${unmappedCount} file(s).`);
      return;
    }
    if (!hasRequiredSales) {
      toast.error("At least one file must be assigned as the 'Sales File' (Allocation Base).");
      return;
    }

    await saveWorkflowSnapshot("Data Stitching & ARDs", "/ard-stitching", {
      ingestion: "completed",
      ard_stitching: "in_progress",
    });

    toast.success("Ingestion complete! Proceeding to Data Stitching.");
    navigate("/ard-stitching");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Data Ingestion & Mapping"
          subtitle="Upload multi-grain marketing files, assign roles, modify data types, and standardize time grain"
          icon="📂"
        />
        <button
          onClick={resetWorkflow}
          className="text-xs text-red-500 hover:text-red-600 font-medium px-3 py-1.5 rounded-lg border border-red-100 hover:bg-red-50"
        >
          ↺ Reset Workflow
        </button>
      </div>

      {/* Split Ingestion Studio Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Panel: Upload Zone & File Queue */}
        <div className="lg:col-span-4 space-y-4">
          <Card className="p-4 bg-white border border-slate-200 shadow-sm">
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
                isDragActive
                  ? "border-[#001E96] bg-blue-50"
                  : "border-slate-200 hover:border-brand-400 hover:bg-slate-50"
              }`}
            >
              <input {...getInputProps()} />
              <div className="text-3xl mb-2">📁</div>
              <p className="text-xs font-bold text-slate-700">
                {isDragActive ? "Drop files here…" : "Upload Files (Bulk / Multi-select)"}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Drag & drop CSV or Excel (.xlsx) files
              </p>
            </div>
            {uploadLoading && <Spinner label="Reading file schemas…" />}

            <div className="flex justify-between items-center mt-4 px-1 text-xs text-slate-500">
              <span>Uploaded: <strong>{fileList.length} files</strong></span>
              <span>
                {unmappedCount > 0 ? (
                  <span className="text-amber-600 font-semibold">{unmappedCount} unassigned</span>
                ) : (
                  <span className="text-green-600 font-semibold">All mapped ✅</span>
                )}
              </span>
            </div>

            <div className="mt-3 space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {!fileList.length ? (
                <p className="text-xs text-slate-400 text-center py-8 italic">
                  No files uploaded yet. Drag & drop files above.
                </p>
              ) : (
                fileList.map((file, idx) => {
                  const isSelected = activeFile?.id === file.id;
                  const categoryInfo = FILE_CATEGORIES.find((c) => c.id === file.category);

                  return (
                    <div
                      key={file.id}
                      onClick={() => setActiveFileId(file.id)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                        isSelected
                          ? "bg-slate-900 text-white border-slate-900 shadow-md ring-2 ring-brand-500"
                          : "bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold truncate">
                          File {idx + 1} – {file.filename}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          {categoryInfo ? (
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                isSelected ? "bg-brand-500 text-white" : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {categoryInfo.label}
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                              Unmapped ⚠️
                            </span>
                          )}
                          <span className={`text-[10px] ${isSelected ? "text-white/60" : "text-slate-400"}`}>
                            {file.rows?.toLocaleString()} rows
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => handleRemoveFile(e, file.id)}
                        className={`p-1.5 rounded-lg text-xs hover:text-red-500 transition-colors ${
                          isSelected ? "text-white/50 hover:bg-white/10" : "text-slate-400 hover:bg-red-50"
                        }`}
                        title="Remove file"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        {/* Right Panel: Mapping & Processing Workspace */}
        <div className="lg:col-span-8 space-y-4">
          {!activeFile ? (
            <Card className="text-center py-20 text-slate-400">
              <span className="text-5xl block mb-3">📂</span>
              <h3 className="text-base font-bold text-slate-700">No File Selected</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                Upload your source datasets on the left panel or click any uploaded file to configure its role, data types, and grain.
              </p>
            </Card>
          ) : (
            <Card className="space-y-6">
              <div className="flex justify-between items-start border-b border-slate-100 pb-4 flex-wrap gap-3">
                <div>
                  <span className="text-xs font-bold text-brand-600 uppercase tracking-wider">
                    Mapping Configuration
                  </span>
                  <h2 className="text-lg font-black text-slate-800 tracking-tight">
                    {activeFile.filename}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {activeFile.rows.toLocaleString()} total rows • {activeFile.cols} columns
                  </p>
                </div>

                <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
                  {[
                    { id: "mapping", label: "1. Assign Category" },
                    { id: "standardize", label: "2. Columns & Types" },
                    { id: "filter", label: "3. Filter" },
                    { id: "granularity", label: "4. Granularity" },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        activeTab === tab.id
                          ? "bg-white text-slate-800 shadow-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sub-tab 1: Assign Category */}
              {activeTab === "mapping" && (
                <div className="space-y-5">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                      Assign File Category / Grain Role
                    </label>
                    <select
                      value={activeFile.category || ""}
                      onChange={(e) => handleAssignCategory(e.target.value)}
                      className="w-full text-sm font-semibold border-2 border-brand-500 rounded-xl px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 text-slate-800"
                    >
                      <option value="">Select a category…</option>
                      {FILE_CATEGORIES.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.label} ({cat.grain})
                        </option>
                      ))}
                    </select>
                  </div>

                  {activeFile.category && (
                    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-xs text-blue-900 space-y-1">
                      <div className="font-bold text-sm text-blue-950">
                        {FILE_CATEGORIES.find((c) => c.id === activeFile.category)?.label}
                      </div>
                      <p className="text-blue-800">
                        {FILE_CATEGORIES.find((c) => c.id === activeFile.category)?.desc}
                      </p>
                      <div className="text-[11px] text-blue-600 font-mono mt-1">
                        Expected Grain: {FILE_CATEGORIES.find((c) => c.id === activeFile.category)?.grain}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                        File Preview
                      </h4>
                      <span className="text-xs text-slate-400">Sample records</span>
                    </div>
                    <DataTable
                      data={activeFile.preview}
                      totalRows={activeFile.rows}
                      maxRows={50}
                    />
                  </div>
                </div>
              )}

              {/* Sub-tab 2: Standardize Columns & Modify Data Types */}
              {activeTab === "standardize" && (
                <StandardizePanel
                  activeFile={activeFile}
                  onUpdated={(updatedFileData) => {
                    setFileList((prev) =>
                      prev.map((f) => (f.id === activeFile.id ? { ...f, ...updatedFileData } : f))
                    );
                  }}
                />
              )}

              {/* Sub-tab 3: Filter Data */}
              {activeTab === "filter" && (
                <FilterPanel
                  activeFile={activeFile}
                  onUpdated={(updatedFileData) => {
                    setFileList((prev) =>
                      prev.map((f) => (f.id === activeFile.id ? { ...f, ...updatedFileData } : f))
                    );
                  }}
                />
              )}

              {/* Sub-tab 4: Modify Granularity */}
              {activeTab === "granularity" && (
                <GranularityPanel
                  activeFile={activeFile}
                  onUpdated={(updatedFileData) => {
                    setFileList((prev) =>
                      prev.map((f) => (f.id === activeFile.id ? { ...f, ...updatedFileData } : f))
                    );
                  }}
                />
              )}
            </Card>
          )}

          {/* Bottom Proceed Bar */}
          <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
            <div>
              {unmappedCount > 0 ? (
                <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                  <span>⚠️</span>
                  <span>{unmappedCount} file(s) still need category mapping</span>
                </div>
              ) : !hasRequiredSales ? (
                <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                  <span>⚠️</span>
                  <span>Please assign at least one file as the "Sales File"</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                  <span>✅</span>
                  <span>All {fileList.length} files successfully mapped & verified</span>
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-0.5">
                Ready to proceed to Data Stitching & ARDs
              </p>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate("/")}
                className="px-5 py-2.5 rounded-xl text-xs font-semibold text-slate-300 bg-white/10 hover:bg-white/20 transition-all"
              >
                Back to Home
              </button>
              <button
                type="button"
                onClick={handleProceed}
                disabled={!fileList.length || unmappedCount > 0 || !hasRequiredSales}
                className="px-8 py-2.5 rounded-xl text-xs font-bold text-white bg-[#1ABC9C] hover:bg-[#17a589] disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-[#1ABC9C]/20 transition-all hover:scale-105"
              >
                Proceed to Data Stitching →
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-Panel: Standardize Columns & Modify Data Types Table ──────────────────
function StandardizePanel({ activeFile, onUpdated }) {
  const [selectedCols, setSelectedCols] = useState(activeFile.selectedCols || activeFile.columns);
  const [renameMap, setRenameMap] = useState(activeFile.renameMap || {});
  const [typeCastMap, setTypeCastMap] = useState(() => {
    return activeFile.typeCastMap || {};
  });
  const [dateConfigs, setDateConfigs] = useState(activeFile.dateConfigs || []);
  const [loading, setLoading] = useState(false);

  const DATA_TYPE_OPTIONS = [
    { value: "float", label: "Numeric (Float / Decimal)" },
    { value: "integer", label: "Numeric (Integer)" },
    { value: "string", label: "Text / String" },
    { value: "date", label: "Date / Time" },
    { value: "category", label: "Categorical / ID Code" },
  ];

  const DATE_FORMATS = [
    { value: "%d/%m/%Y", label: "%d/%m/%Y (e.g. 24/05/2026)" },
    { value: "%m/%d/%Y", label: "%m/%d/%Y (e.g. 05/24/2026)" },
    { value: "%d-%m-%Y", label: "%d-%m-%Y (e.g. 24-05-2026)" },
    { value: "%m-%d-%Y", label: "%m-%d-%Y (e.g. 05-24-2026)" },
    { value: "%Y-%m-%d", label: "%Y-%m-%d (e.g. 2026-05-24)" },
    { value: "%Y/%m/%d", label: "%Y/%m/%d (e.g. 2026/05/24)" },
  ];

  const handleTypeChange = (col, newType) => {
    setTypeCastMap((prev) => ({ ...prev, [col]: newType }));
    if (newType === "date" && !dateConfigs.find((d) => d.col === col)) {
      setDateConfigs([...dateConfigs, { col, format: "%d/%m/%Y" }]);
    } else if (newType !== "date") {
      setDateConfigs(dateConfigs.filter((d) => d.col !== col));
    }
  };

  const handleApplyStandardize = async () => {
    setLoading(true);
    try {
      const result = await standardizeFile({
        csv_data: activeFile.rawCsv,
        selected_cols: selectedCols,
        rename_map: renameMap,
        type_cast_map: typeCastMap,
        date_configs: dateConfigs,
      });

      onUpdated({
        workingCsv: result.csv_data,
        columns: result.columns,
        rows: result.rows,
        cols: result.cols,
        preview: result.preview,
        isStandardized: true,
        selectedCols,
        renameMap,
        typeCastMap,
        dateConfigs,
      });

      toast.success("Standardized columns & data types successfully");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Standardization failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
            Column Schema & Data Type Configuration
          </label>
          <span className="text-[11px] text-slate-400">
            Modify data types or column names before proceeding
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
              <tr>
                <th className="px-3 py-2.5 text-center w-12">Keep</th>
                <th className="px-4 py-2.5 font-bold">Original Column</th>
                <th className="px-4 py-2.5 font-bold">Rename To</th>
                <th className="px-4 py-2.5 font-bold">Data Type (Modifiable)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeFile.columns.map((col) => {
                const isKept = selectedCols.includes(col);
                const currentType = typeCastMap[col] || "string";

                return (
                  <tr key={col} className={isKept ? "hover:bg-slate-50" : "bg-slate-50/50 opacity-60"}>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isKept}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedCols([...selectedCols, col]);
                          else setSelectedCols(selectedCols.filter((c) => c !== col));
                        }}
                        className="rounded h-4 w-4 text-brand-600 focus:ring-brand-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2 font-bold text-slate-800 whitespace-nowrap">
                      {col}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text"
                        disabled={!isKept}
                        placeholder={col}
                        value={renameMap[col] || ""}
                        onChange={(e) => setRenameMap({ ...renameMap, [col]: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <select
                        disabled={!isKept}
                        value={currentType}
                        onChange={(e) => handleTypeChange(col, e.target.value)}
                        className="w-full text-xs font-semibold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100"
                      >
                        {DATA_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {dateConfigs.length > 0 && (
        <div className="border border-slate-200 bg-slate-50/60 rounded-2xl p-4 space-y-3">
          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
            Target Output Date Format
          </h4>
          {dateConfigs.map((dc) => (
            <div key={dc.col} className="flex items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200">
              <span className="text-xs font-bold text-slate-800">📅 {dc.col}</span>
              <select
                value={dc.format}
                onChange={(e) =>
                  setDateConfigs(dateConfigs.map((d) => (d.col === dc.col ? { ...d, format: e.target.value } : d)))
                }
                className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 bg-slate-50 font-medium"
              >
                {DATE_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <Btn onClick={handleApplyStandardize} disabled={loading}>
        {loading ? "Processing…" : "Standardize File & Cast Types"}
      </Btn>

      <div>
        <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
          Standardized File Preview
        </h4>
        <DataTable data={activeFile.preview} totalRows={activeFile.rows} />
      </div>
    </div>
  );
}

// ─── Sub-Panel: Filter Data ───────────────────────────────────────────────────
function FilterPanel({ activeFile, onUpdated }) {
  const [npiCol, setNpiCol] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [useLuhn, setUseLuhn] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeFile.columns.length) {
      if (!npiCol) {
        const found = activeFile.columns.find((c) => c.toLowerCase().includes("npi") || c.toLowerCase().includes("id") || c.toLowerCase().includes("geo"));
        if (found) setNpiCol(found);
      }
      if (!dateCol) {
        const found = activeFile.columns.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month"));
        if (found) setDateCol(found);
      }
    }
  }, [activeFile.columns]);

  const handleApplyFilter = async () => {
    setLoading(true);
    try {
      const data = await filterData({
        csv_data: activeFile.workingCsv,
        npi_col: npiCol || undefined,
        date_col: dateCol || undefined,
        use_luhn: useLuhn,
        start_date: startDate.trim() || undefined,
        end_date: endDate.trim() || undefined,
      });

      onUpdated({
        workingCsv: data.csv_data,
        columns: data.columns,
        rows: data.rows,
        cols: data.cols,
        preview: data.preview,
        isFiltered: true,
      });

      toast.success(`Filtered: ${data.rows.toLocaleString()} rows remaining`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Filter failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select label="NPI / ID Column" value={npiCol} onChange={setNpiCol} options={activeFile.columns} placeholder="Select NPI Column (Optional)" />
        <Select label="Date Column" value={dateCol} onChange={setDateCol} options={activeFile.columns} placeholder="Select Date Column (Optional)" />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer bg-slate-50 p-2.5 rounded-xl border border-slate-200">
        <input type="checkbox" checked={useLuhn} onChange={(e) => setUseLuhn(e.target.checked)} className="rounded h-4 w-4 text-brand-600" />
        <span>Apply Luhn Algorithm Validation to NPI <em>(Checks 10-digit US NPI numbers)</em></span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Start Date (DD/MM/YYYY or YYYY-MM-DD)</label>
          <input
            type="text"
            placeholder="e.g. 01/01/2026 or 2026-01-01"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">End Date (DD/MM/YYYY or YYYY-MM-DD)</label>
          <input
            type="text"
            placeholder="e.g. 31/12/2026 or 2026-12-31"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white"
          />
        </div>
      </div>

      <Btn onClick={handleApplyFilter} disabled={loading}>
        {loading ? "Filtering…" : "Apply Filters"}
      </Btn>

      <DataTable data={activeFile.preview} totalRows={activeFile.rows} />
    </div>
  );
}

// ─── Sub-Panel: Modify Granularity ────────────────────────────────────────────
function GranularityPanel({ activeFile, onUpdated }) {
  const [dateCol, setDateCol] = useState("");
  const [geoCol, setGeoCol] = useState("");
  const [detected, setDetected] = useState(null);
  const [target, setTarget] = useState("");
  const [numCols, setNumCols] = useState([]);
  const [numOps, setNumOps] = useState({});
  const [loading, setLoading] = useState(false);

  const NUM_OPS = ["sum", "average", "min", "max", "product"];
  const GRAN_OPTIONS = { Daily: ["Weekly", "Monthly"], Weekly: ["Weekly", "Monthly"], Monthly: ["Monthly"] };

  useEffect(() => {
    if (activeFile.columns.length) {
      if (!dateCol) {
        const found = activeFile.columns.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("week") || c.toLowerCase().includes("month"));
        if (found) setDateCol(found);
      }
      if (!geoCol) {
        const found = activeFile.columns.find((c) => c.toLowerCase().includes("npi") || c.toLowerCase().includes("geo") || c.toLowerCase().includes("id") || c.toLowerCase().includes("dma"));
        if (found) setGeoCol(found);
      }

      const excludeKeys = ["date", "npi", "id", "geo", "zip", "dma", "week", "month"];
      const numerics = activeFile.columns.filter((c) => !excludeKeys.some((k) => c.toLowerCase().includes(k)));
      if (numerics.length && !numCols.length) {
        setNumCols(numerics);
        const initOps = {};
        numerics.forEach((c) => { initOps[c] = "sum"; });
        setNumOps(initOps);
      }
    }
  }, [activeFile.columns, dateCol, geoCol, numCols]);

  const handleDetect = async () => {
    if (!dateCol) return toast.error("Select a date column first");
    try {
      const data = await detectGranularity({ csv_data: activeFile.workingCsv, date_col: dateCol });
      setDetected(data.granularity);
      toast.success(`Detected: ${data.granularity}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Detection failed");
    }
  };

  const handleApplyGranularity = async () => {
    if (!detected || !target || !geoCol) return toast.error("Fill all required fields");
    setLoading(true);
    try {
      const data = await modifyGranularity({
        csv_data: activeFile.workingCsv,
        geo_column: geoCol,
        date_column: dateCol,
        current_granularity: detected,
        target_granularity: target,
        work_days: 7,
        numerical_config_dict: numOps,
        categorical_config_dict: {},
      });

      onUpdated({
        workingCsv: data.csv_data,
        columns: data.columns,
        rows: data.rows,
        cols: data.cols,
        preview: data.preview,
        isGranularized: true,
      });

      toast.success("Granularity modified successfully");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Modification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select label="Date Column" value={dateCol} onChange={setDateCol} options={activeFile.columns} placeholder="Select Date Column" />
        <Select label="Grouping (Geo/NPI/DMA) Column" value={geoCol} onChange={setGeoCol} options={activeFile.columns} placeholder="Select Geo/ID Column" />
      </div>

      <Btn variant="outline" onClick={handleDetect}>Detect Granularity</Btn>
      {detected && <Alert type="success">Detected Granularity: <strong>{detected}</strong></Alert>}

      <MultiSelect label="Numerical Columns to Aggregate" value={numCols} onChange={setNumCols} options={activeFile.columns} />
      {numCols.map((col) => (
        <div key={col} className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-700 w-36 truncate">{col}</span>
          <Select value={numOps[col] || "sum"} onChange={(v) => setNumOps({ ...numOps, [col]: v })} options={NUM_OPS} className="flex-1" />
        </div>
      ))}

      {detected && (
        <Select label="Target Granularity" value={target} onChange={setTarget} options={GRAN_OPTIONS[detected] || []} placeholder="Select Target Granularity" />
      )}

      <Btn onClick={handleApplyGranularity} disabled={loading || !detected || !target}>
        {loading ? "Processing…" : "Modify Granularity"}
      </Btn>

      <DataTable data={activeFile.preview} totalRows={activeFile.rows} />
    </div>
  );
}