import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import toast from "react-hot-toast";

import {
  v2Upload,
  v2Preview,
  v2CommitSpec,
  v2ListFiles,
  v2DeleteFile,
  v2GetCsv,
  v2GetFile,
  v2GetProfile,
  v2DetectGranularity,
  problemMessage,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { Alert, Btn, DataTable, Metric, Spinner } from "../components/UI";

export const FILE_CATEGORIES = [
  { id: "sales", label: "Sales File", grain: "HCP × Period",
    desc: "HCP × Month/Week grain; used as allocation base" },
  { id: "hcp_promo", label: "HCP-level Marketing / Promo File", grain: "HCP × Period",
    desc: "Calls, Samples, Details, Speaker programs" },
  { id: "dma_promo", label: "DMA-level Marketing Activity File", grain: "DMA × Period",
    desc: "TV, Radio, Print, Digital spend/impressions" },
  { id: "dma_hcp_map", label: "DMA–HCP Mapping File", grain: "HCP ↔ DMA Bridge",
    desc: "Crosswalk bridge between HCP IDs / ZIPs and DMA IDs" },
  { id: "dma_pop", label: "DMA Population File", grain: "DMA Grain",
    desc: "DMA target population or universe sizing" },
];

const DTYPE_OPTIONS = [
  { value: "string", label: "Text / String" },
  { value: "integer", label: "Integer" },
  { value: "bigint", label: "Big Integer" },
  { value: "float", label: "Decimal / Float" },
  { value: "decimal", label: "Fixed Decimal" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
  { value: "timestamp", label: "Timestamp" },
];

const DATE_FORMATS = [
  { value: "%d/%m/%Y", label: "%d/%m/%Y (e.g. 24/05/2026)" },
  { value: "%m/%d/%Y", label: "%m/%d/%Y (e.g. 05/24/2026)" },
  { value: "%Y-%m-%d", label: "%Y-%m-%d (e.g. 2026-05-24)" },
  { value: "%d-%m-%Y", label: "%d-%m-%Y (e.g. 24-05-2026)" },
  { value: "%m-%d-%Y", label: "%m-%d-%Y (e.g. 05-24-2026)" },
  { value: "%Y/%m/%d", label: "%Y/%m/%d (e.g. 2026/05/24)" },
  { value: "%d.%m.%Y", label: "%d.%m.%Y (e.g. 24.05.2026)" },
  { value: "%Y%m%d", label: "%Y%m%d (e.g. 20260524)" },
];

const NUM_OPS = ["sum", "average", "min", "max", "product"];
const GRAIN_TARGETS = { Daily: ["Weekly", "Monthly"], Weekly: ["Monthly"], Monthly: ["Yearly"] };

const TABS = [
  { id: "category", label: "1. Assign Category" },
  { id: "columns", label: "2. Columns & Types" },
  { id: "filter", label: "3. Filter" },
  { id: "granularity", label: "4. Granularity" },
];

const emptyDraft = () => ({
  category: "",
  keep: {},           // column -> bool (default true)
  renames: {},
  dtypes: {},
  dateFormats: {},    // column -> { from, to }
  npiCol: "",
  dateCol: "",
  useLuhn: false,
  startDate: "",
  endDate: "",
  grainFrom: null,
  grainTo: "",
  grainDateCol: "",
  grainGeoCol: "",
  aggCols: [],        // columns chosen for aggregation
  aggOps: {},         // column -> op
});

function labelFor(fmt) {
  return DATE_FORMATS.find((f) => f.value === fmt)?.label || fmt;
}

/** Accepts DD/MM/YYYY or YYYY-MM-DD; the API takes ISO only. */
function toIso(text) {
  const s = (text || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return undefined;   // unparseable - distinct from "not supplied"
}

/** Column names after renames, for the tabs that run post-rename. */
function afterRenames(columns, draft) {
  return columns
    .filter((c) => draft.keep[c] !== false)
    .map((c) => (draft.renames[c]?.trim() ? draft.renames[c].trim() : c));
}

/** Local draft -> the manifest the API expects. */
function draftToSpec(draft, columns) {
  const kept = columns.filter((c) => draft.keep[c] !== false);
  const column_drops = columns.filter((c) => draft.keep[c] === false);

  const column_renames = kept
    .filter((c) => draft.renames[c]?.trim() && draft.renames[c].trim() !== c)
    .map((c) => ({ from: c, to: draft.renames[c].trim() }));

  // "string" is the resting state (files are read as text), and date/timestamp
  // casts would re-infer the format - that is `date_formats`' job, with an
  // explicit `from`.
  const DATE_TYPES = ["date", "timestamp"];
  const dtype_changes = kept
    .filter((c) => draft.dtypes[c] && draft.dtypes[c] !== "string"
      && !DATE_TYPES.includes(draft.dtypes[c]) && !draft.dateFormats[c])
    .map((c) => (draft.dtypes[c] === "decimal"
      ? { column: c, to: "decimal", precision: 18, scale: 2 }
      : { column: c, to: draft.dtypes[c] }));

  const date_formats = kept
    .filter((c) => draft.dateFormats[c]?.from && draft.dateFormats[c]?.to)
    .map((c) => ({ column: c, from: draft.dateFormats[c].from, to: draft.dateFormats[c].to }));

  const filters = [];
  if (draft.useLuhn && draft.npiCol) {
    filters.push({ type: "npi_luhn", column: draft.npiCol });
  }
  const start = toIso(draft.startDate);
  const end = toIso(draft.endDate);
  if (draft.dateCol && (start || end)) {
    const f = { type: "date_range", column: draft.dateCol };
    if (start) f.start = start;
    if (end) f.end = end;
    filters.push(f);
  }

  const spec = {
    config_metadata: draft.category ? { category: draft.category } : {},
    live_updates: { column_drops, date_formats, dtype_changes, column_renames },
    filters,
  };

  if (draft.grainFrom && draft.grainTo && draft.grainDateCol && draft.grainGeoCol) {
    const numeric = {};
    for (const c of draft.aggCols) numeric[c] = draft.aggOps[c] || "sum";
    spec.granularity = {
      from: draft.grainFrom, to: draft.grainTo,
      date_column: draft.grainDateCol, geo_column: draft.grainGeoCol,
      numeric, categorical: {},
    };
  }
  return spec;
}

export default function DataIngestion() {
  const navigate = useNavigate();
  const { state, setField, setFields, saveWorkflowSnapshot, resetWorkflow } = useAppState();
  const workflowId = state.workflowId;

  const [datasets, setDatasets] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [profiles, setProfiles] = useState({});
  const [previews, setPreviews] = useState({});
  const [activeFile, setActiveFile] = useState(null);
  const [activeTab, setActiveTab] = useState("category");
  const [preview, setPreview] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState("");
  const [proceeding, setProceeding] = useState(false);

  const current = datasets.find((d) => d.filename === activeFile) || null;
  const draft = drafts[activeFile] || emptyDraft();
  const profile = profiles[activeFile] || [];
  const columns = current?.columns || [];

  const patch = useCallback((changes) => {
    setDrafts((prev) => ({
      ...prev, [activeFile]: { ...(prev[activeFile] || emptyDraft()), ...changes },
    }));
    setPreview(null);
    setErrors([]);
  }, [activeFile]);

  const refresh = useCallback(async () => {
    if (!workflowId) return;
    try {
      const data = await v2ListFiles(workflowId);
      const items = (data.items || []).filter((d) => d.kind !== "merge");
      setDatasets(items);
      setField("datasets", items.map((d) => ({
        filename: d.filename, row_count: d.row_count, columns: d.columns,
        category: d.spec?.config_metadata?.category || "",
      })));
      setDrafts((prev) => {
        const next = { ...prev };
        for (const item of items) {
          if (next[item.filename]) continue;
          const spec = item.spec || {};
          const lu = spec.live_updates || {};
          const drops = new Set(lu.column_drops || []);
          const keep = {};
          for (const c of item.columns || []) keep[c] = !drops.has(c);
          const g = spec.granularity || null;
          next[item.filename] = {
            ...emptyDraft(),
            category: spec.config_metadata?.category || guessCategory(item.filename),
            keep,
            renames: Object.fromEntries((lu.column_renames || []).map((r) => [r.from, r.to])),
            dtypes: Object.fromEntries((lu.dtype_changes || []).map((d) => [d.column, d.to])),
            dateFormats: Object.fromEntries(
              (lu.date_formats || []).map((d) => [d.column, { from: d.from, to: d.to }])),
            grainFrom: g?.from || null,
            grainTo: g?.to || "",
            grainDateCol: g?.date_column || "",
            grainGeoCol: g?.geo_column || "",
            aggCols: Object.keys(g?.numeric || {}),
            aggOps: g?.numeric || {},
          };
        }
        return next;
      });
      if (!activeFile && items.length) setActiveFile(items[0].filename);
    } catch (err) {
      toast.error(problemMessage(err, "Could not list datasets"));
    }
  }, [workflowId, activeFile, setField]);

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [workflowId]);

  // Preview rows for the Assign Category tab. Refetched per selection because
  // the stored dataset changes whenever a manifest is applied.
  useEffect(() => {
    if (!workflowId || !activeFile) return;
    let cancelled = false;
    v2GetFile(workflowId, activeFile)
      .then((res) => {
        if (!cancelled) setPreviews((p) => ({ ...p, [activeFile]: res.preview || [] }));
      })
      .catch(() => { /* the tab degrades to an empty table */ });
    return () => { cancelled = true; };
  }, [workflowId, activeFile, datasets]);

  // Profile the selected file once; it describes immutable raw bytes.
  useEffect(() => {
    if (!workflowId || !activeFile || profiles[activeFile]) return;
    let cancelled = false;
    v2GetProfile(workflowId, activeFile)
      .then((res) => {
        if (cancelled) return;
        setProfiles((p) => ({ ...p, [activeFile]: res.profile }));
        setDrafts((prev) => {
          const d = prev[activeFile] || emptyDraft();
          const dtypes = { ...d.dtypes };
          const dateFormats = { ...d.dateFormats };
          const keep = { ...d.keep };
          let npiCol = d.npiCol, dateCol = d.dateCol;
          for (const col of res.profile) {
            const n = col.column;
            if (keep[n] === undefined) keep[n] = true;
            if (!dtypes[n]) dtypes[n] = col.suggested_dtype;
            if (col.date_candidates?.length && !dateFormats[n] && !col.ambiguous_date) {
              dateFormats[n] = { from: col.suggested_date_from, to: "%d/%m/%Y" };
            }
            if (!dateCol && col.date_candidates?.length) dateCol = n;
            if (!npiCol && (col.id_like || /npi|id$/i.test(n))) npiCol = n;
          }
          return { ...prev, [activeFile]: { ...d, dtypes, dateFormats, keep, npiCol, dateCol } };
        });
      })
      .catch((err) => { if (!cancelled) toast.error(problemMessage(err, "Could not read column types")); });
    return () => { cancelled = true; };
    /* eslint-disable-next-line */
  }, [workflowId, activeFile]);

  const onDrop = useCallback(async (accepted, rejections) => {
    if (rejections?.length) return toast.error("Upload CSV or Excel (.xlsx) files only");
    if (!accepted?.length) return;
    if (!workflowId) return toast.error("Start a workflow from Home first");
    setBusy("Uploading…");
    try {
      const form = new FormData();
      accepted.forEach((f) => form.append("files", f));
      form.append("manifest", JSON.stringify({}));
      const res = await v2Upload(workflowId, form, { overwrite: true });
      toast.success(`Uploaded ${res.files.length} file(s)`);
      setActiveFile(res.files[0].filename);
      setActiveTab("category");
      await refresh();
    } catch (err) {
      toast.error(problemMessage(err, "Upload failed"));
    } finally { setBusy(""); }
  }, [workflowId, refresh]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx", ".xlsm"],
      "text/tab-separated-values": [".tsv"],
    },
  });

  const runPreview = async (label = "Previewing…") => {
    if (!current) return null;
    setBusy(label); setErrors([]);
    try {
      const res = await v2Preview(workflowId, current.filename, draftToSpec(draft, columns));
      setPreview(res);
      return res;
    } catch (err) {
      setErrors(err?.response?.data?.errors || []);
      setPreview(null);
      toast.error(problemMessage(err, "Preview failed"));
      return null;
    } finally { setBusy(""); }
  };

  const apply = async (successMsg) => {
    if (!current) return;
    setBusy("Applying…"); setErrors([]);
    try {
      const res = await v2CommitSpec(workflowId, current.filename, draftToSpec(draft, columns));
      setPreview({ row_count: res.row_count, columns: res.columns,
                   preview: res.preview, applied: res.applied, committed: true });
      await refresh();
      toast.success(successMsg || `Applied — ${res.row_count.toLocaleString()} rows`);
    } catch (err) {
      setErrors(err?.response?.data?.errors || []);
      toast.error(problemMessage(err, "Apply failed"));
    } finally { setBusy(""); }
  };

  const removeFile = async (e, filename) => {
    e.stopPropagation();
    try {
      await v2DeleteFile(workflowId, filename);
      setDrafts((p) => { const n = { ...p }; delete n[filename]; return n; });
      setProfiles((p) => { const n = { ...p }; delete n[filename]; return n; });
      setPreviews((p) => { const n = { ...p }; delete n[filename]; return n; });
      if (activeFile === filename) { setActiveFile(null); setPreview(null); }
      await refresh();
      toast.success("File removed");
    } catch (err) { toast.error(problemMessage(err, "Delete failed")); }
  };

  const unmapped = datasets.filter((d) => !(drafts[d.filename]?.category)).length;
  const salesFile = datasets.find((d) => drafts[d.filename]?.category === "sales");

  const proceed = async () => {
    if (!datasets.length) return toast.error("Upload your source files first.");
    if (unmapped > 0) return toast.error(`Assign a category to the remaining ${unmapped} file(s).`);
    if (!salesFile) return toast.error("At least one file must be the Sales File.");
    setProceeding(true);
    try {
      const csv = await v2GetCsv(workflowId, salesFile.filename);
      setFields({ activeDataset: salesFile.filename, granularCsvData: csv, filteredCsvData: csv });
      await saveWorkflowSnapshot("Exploratory Data Analysis", "/eda", {
        ingestion: "completed", eda: "in_progress",
      });
      toast.success("Ingestion complete. Proceeding to EDA.");
      navigate("/eda");
    } catch (err) {
      toast.error(problemMessage(err, "Could not hand off dataset"));
    } finally { setProceeding(false); }
  };

  if (!workflowId) {
    return (
      <div>
        <Header onReset={() => { resetWorkflow(); navigate("/"); }} />
        <Alert type="warning">
          No active workflow. Files are stored against a workflow, so create or resume
          one from <button className="underline font-semibold" onClick={() => navigate("/")}>
            Home</button> first.
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <Header onReset={() => { resetWorkflow(); navigate("/"); }} />

      <div className="grid grid-cols-12 gap-6 items-start">
        {/* ── Left: upload + file list ─────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-4 xl:col-span-3 bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
          <div
            {...getRootProps()}
            className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${
              isDragActive ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-brand-300"
            }`}
          >
            <input {...getInputProps()} />
            <div className="text-4xl mb-3">📁</div>
            <p className="text-sm font-bold text-slate-800">Upload Files (Bulk / Multi-select)</p>
            <p className="text-xs text-slate-400 mt-1">Drag &amp; drop CSV or Excel (.xlsx) files</p>
          </div>

          {datasets.length > 0 && (
            <>
              <div className="flex items-center justify-between mt-5 mb-3 text-sm">
                <span className="text-slate-600">
                  Uploaded: <b className="text-slate-900">{datasets.length} files</b>
                </span>
                {unmapped === 0 ? (
                  <span className="text-emerald-600 font-semibold">All mapped ✅</span>
                ) : (
                  <span className="text-amber-600 font-semibold">{unmapped} unmapped</span>
                )}
              </div>

              <div className="space-y-3">
                {datasets.map((d, i) => {
                  const cat = FILE_CATEGORIES.find((c) => c.id === drafts[d.filename]?.category);
                  const active = activeFile === d.filename;
                  return (
                    <div
                      key={d.filename}
                      onClick={() => { setActiveFile(d.filename); setPreview(null); setErrors([]); }}
                      className={`rounded-xl p-4 cursor-pointer transition-all border-2 ${
                        active
                          ? "bg-slate-900 border-brand-500 text-white"
                          : "bg-white border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className={`text-sm font-bold ${active ? "text-white" : "text-slate-800"}`}>
                          File {i + 1} – {d.filename}
                        </p>
                        <button
                          onClick={(e) => removeFile(e, d.filename)}
                          className={active ? "text-white/50 hover:text-white" : "text-slate-300 hover:text-red-500"}
                          title="Remove file"
                        >✕</button>
                      </div>
                      {cat ? (
                        <span className="inline-block mt-2 px-3 py-1 rounded-full text-[11px] font-semibold bg-brand-600 text-white">
                          {cat.label}
                        </span>
                      ) : (
                        <span className="inline-block mt-2 px-3 py-1 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">
                          Needs category
                        </span>
                      )}
                      <p className={`text-xs mt-2 ${active ? "text-white/60" : "text-slate-500"}`}>
                        {(d.row_count ?? 0).toLocaleString()} rows
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── Right: mapping configuration ─────────────────────────────── */}
        <div className="col-span-12 lg:col-span-8 xl:col-span-9 space-y-5">
          {!current ? (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
              <p className="text-sm text-slate-400 italic">
                Upload a file to begin, then select it to configure.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
              <p className="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">
                Mapping Configuration
              </p>
              <h2 className="text-2xl font-bold text-slate-900">{current.filename}</h2>
              <p className="text-sm text-slate-400 mt-1">
                {(current.row_count ?? 0).toLocaleString()} total rows • {columns.length} columns
              </p>

              <div className="flex gap-2 mt-5 mb-7 bg-slate-50 rounded-xl p-1.5 w-fit max-w-full overflow-x-auto">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`px-5 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
                      activeTab === t.id
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >{t.label}</button>
                ))}
              </div>

              {activeTab === "category" && (
                <CategoryTab file={current} rows={previews[current.filename] || []}
                             draft={draft} patch={patch} />
              )}
              {activeTab === "columns" && (
                <ColumnsTab columns={columns} draft={draft} patch={patch} profile={profile}
                            onApply={() => apply("Columns & types applied")} busy={busy} />
              )}
              {activeTab === "filter" && (
                <FilterTab columns={afterRenames(columns, draft)} draft={draft} patch={patch}
                           onApply={() => apply("Filters applied")} busy={busy} />
              )}
              {activeTab === "granularity" && (
                <GranularityTab
                  workflowId={workflowId} filename={current.filename}
                  columns={afterRenames(columns, draft)} draft={draft} patch={patch}
                  onApply={() => apply("Granularity modified")} busy={busy}
                  specSoFar={() => draftToSpec(draft, columns)}
                />
              )}
            </div>
          )}

          {busy && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <Spinner label={busy} />
            </div>
          )}

          {errors.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
              <Alert type="error">
                <p className="font-bold mb-2">
                  Nothing was saved — {errors.length} problem{errors.length > 1 ? "s" : ""}:
                </p>
                <ul className="space-y-1 text-xs">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <code className="font-mono bg-red-100 px-1 rounded">{e.code}</code>
                      {e.column ? <> · <b>{e.column}</b></> : null} — {e.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          )}

          {preview && !busy && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
              <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4">
                {preview.committed ? "Applied result" : "Preview — nothing saved yet"}
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <Metric label="Rows out" value={(preview.row_count ?? 0).toLocaleString()} />
                <Metric label="Rows removed" value={(preview.applied?.rows_removed ?? 0).toLocaleString()} />
                <Metric label="Columns" value={(preview.columns || []).length} />
                <Metric label="Nulled" value={preview.applied?.nulled_values ?? 0} />
              </div>
              {preview.applied?.unhandled_columns?.length > 0 && (
                <div className="mb-4">
                  <Alert type="warning">
                    Dropped by the rollup because no aggregation was chosen:{" "}
                    <b>{preview.applied.unhandled_columns.join(", ")}</b>.
                  </Alert>
                </div>
              )}
              <DataTable data={preview.preview || []} maxRows={15} />
            </div>
          )}

          {/* ── Proceed bar ─────────────────────────────────────────────── */}
          <div className="bg-slate-900 text-white rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4 shadow-xl">
            <div className="text-sm">
              {!datasets.length ? (
                <span className="text-slate-300">Upload at least one file.</span>
              ) : unmapped > 0 ? (
                <span className="text-amber-400 font-bold">⚠️ {unmapped} file(s) still need a category</span>
              ) : !salesFile ? (
                <span className="text-amber-400 font-bold">⚠️ Assign one file as the Sales File</span>
              ) : (
                <span className="text-emerald-400 font-bold">
                  ✅ All {datasets.length} files mapped — handing off {salesFile.filename}
                </span>
              )}
              <p className="text-[11px] text-slate-400 mt-0.5">
                Files stay in Neon; only the id travels between screens.
              </p>
            </div>
            <div className="flex gap-3">
              <Btn variant="secondary" onClick={() => navigate("/")}>Back to Home</Btn>
              <Btn onClick={proceed} disabled={proceeding || !salesFile || unmapped > 0}>
                {proceeding ? "Preparing…" : "Proceed to EDA →"}
              </Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ onReset }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
      <div className="flex items-start gap-3">
        <span className="text-3xl">📂</span>
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Data Ingestion &amp; Mapping</h1>
          <p className="text-slate-500 text-sm mt-1">
            Upload multi-grain marketing files, assign roles, modify data types, and standardize time grain
          </p>
        </div>
      </div>
      <button
        onClick={onReset}
        className="px-4 py-2 rounded-xl text-xs font-semibold text-red-500 border border-red-200 hover:bg-red-50 transition-all"
      >↺ Reset Workflow</button>
    </div>
  );
}

function guessCategory(filename) {
  const n = filename.toLowerCase();
  if (n.includes("sale") || n.includes("trx") || n.includes("nrx")) return "sales";
  if (n.includes("call") || n.includes("sample") || n.includes("hcp") || n.includes("rep")) return "hcp_promo";
  if (n.includes("map") || n.includes("bridge") || n.includes("crosswalk")) return "dma_hcp_map";
  if (n.includes("pop") || n.includes("universe")) return "dma_pop";
  if (n.includes("tv") || n.includes("dma") || n.includes("spend")) return "dma_promo";
  return "";
}

// ─── 1. Assign Category ──────────────────────────────────────────────────────
function CategoryTab({ file, rows, draft, patch }) {
  const cat = FILE_CATEGORIES.find((c) => c.id === draft.category);
  return (
    <div className="space-y-6">
      <div>
        <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
          File Category
        </label>
        <select
          value={draft.category}
          onChange={(e) => patch({ category: e.target.value })}
          className="w-full sm:w-[28rem] px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
        >
          <option value="">Select a category…</option>
          {FILE_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        {cat && (
          <div className="mt-3 p-4 rounded-xl bg-brand-50 border border-brand-100">
            <p className="text-sm font-bold text-brand-700">{cat.label}</p>
            <p className="text-xs text-slate-600 mt-0.5">{cat.desc}</p>
            <p className="text-[11px] text-brand-500 mt-1">Expected grain: {cat.grain}</p>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Data Preview</h4>
          <span className="text-[11px] text-slate-400">
            First 15 of {(file.row_count ?? 0).toLocaleString()} rows
          </span>
        </div>
        <DataTable data={rows} maxRows={15} />
      </div>
    </div>
  );
}

// ─── 2. Columns & Types ──────────────────────────────────────────────────────
function ColumnsTab({ columns, draft, patch, profile, onApply, busy }) {
  const byCol = useMemo(
    () => Object.fromEntries((profile || []).map((p) => [p.column, p])), [profile]);

  const toggleKeep = (c) => patch({ keep: { ...draft.keep, [c]: draft.keep[c] === false } });
  const setRename = (c, v) => patch({ renames: { ...draft.renames, [c]: v } });
  const setDtype = (c, v) => {
    const dateFormats = { ...draft.dateFormats };
    if (v !== "date" && v !== "timestamp") delete dateFormats[c];
    else if (!dateFormats[c]) {
      dateFormats[c] = { from: byCol[c]?.suggested_date_from || "", to: "%d/%m/%Y" };
    }
    patch({ dtypes: { ...draft.dtypes, [c]: v }, dateFormats });
  };
  const setFmt = (c, key, v) => patch({
    dateFormats: { ...draft.dateFormats, [c]: { ...(draft.dateFormats[c] || {}), [key]: v } },
  });

  const kept = columns.filter((c) => draft.keep[c] !== false);
  const dateCols = kept.filter((c) =>
    draft.dtypes[c] === "date" || draft.dtypes[c] === "timestamp" || draft.dateFormats[c]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider max-w-xs">
          Column Schema &amp; Data Type Configuration
        </h3>
        <p className="text-sm text-slate-400 max-w-xs">
          Modify data types or column names before proceeding
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-slate-600">
              <th className="px-5 py-4 font-semibold w-20">Keep</th>
              <th className="px-5 py-4 font-semibold">Original Column</th>
              <th className="px-5 py-4 font-semibold">Rename To</th>
              <th className="px-5 py-4 font-semibold">Data Type (Modifiable)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {columns.map((c) => {
              const dropped = draft.keep[c] === false;
              const info = byCol[c];
              return (
                <tr key={c} className={dropped ? "bg-slate-50/70 opacity-50" : ""}>
                  <td className="px-5 py-4">
                    <input
                      type="checkbox"
                      checked={!dropped}
                      onChange={() => toggleKeep(c)}
                      className="h-4 w-4 rounded border-slate-300 accent-[#001E96]"
                      aria-label={`Keep column ${c}`}
                    />
                  </td>
                  <td className="px-5 py-4 font-bold text-slate-800">
                    {c}
                    {info?.samples?.length > 0 && (
                      <span className="block text-[11px] font-normal text-slate-400 font-mono truncate max-w-[200px]">
                        {info.samples.slice(0, 2).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <input
                      value={draft.renames[c] || ""}
                      onChange={(e) => setRename(c, e.target.value)}
                      placeholder={c}
                      disabled={dropped}
                      className="w-full max-w-[220px] px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-500 placeholder:text-slate-400 disabled:bg-slate-100"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <select
                      value={draft.dtypes[c] || info?.suggested_dtype || "string"}
                      onChange={(e) => setDtype(c, e.target.value)}
                      disabled={dropped}
                      className="w-full max-w-[240px] px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white disabled:bg-slate-100"
                    >
                      {DTYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dateCols.length > 0 && (
        <div className="rounded-xl border border-slate-200 p-5">
          <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4">
            Target Output Date Format
          </h4>
          <div className="space-y-3">
            {dateCols.map((c) => {
              const info = byCol[c];
              const cfg = draft.dateFormats[c] || {};
              const needsSource = !cfg.from;
              return (
                <div key={c} className="space-y-1.5">
                  <div className="flex items-center gap-4 flex-wrap">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 min-w-[180px]">
                      📅 {draft.renames[c]?.trim() || c}
                    </span>
                    <select
                      value={cfg.to || "%d/%m/%Y"}
                      onChange={(e) => setFmt(c, "to", e.target.value)}
                      className="flex-1 min-w-[240px] px-4 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
                    >
                      {DATE_FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                  {info?.ambiguous_date || needsSource ? (
                    <div className="flex items-center gap-2 flex-wrap pl-1">
                      <span className="text-[11px] text-amber-700 font-semibold">
                        {info?.ambiguous_date
                          ? `Ambiguous — ${(info.ambiguous_between || []).join(" and ")} both fit. Pick the source format:`
                          : "Source format:"}
                      </span>
                      <select
                        value={cfg.from || ""}
                        onChange={(e) => setFmt(c, "from", e.target.value)}
                        className="px-3 py-1.5 rounded-lg border border-amber-400 text-xs bg-white"
                      >
                        <option value="">choose…</option>
                        {(info?.date_candidates?.length
                          ? info.date_candidates.map((d) => d.format)
                          : DATE_FORMATS.map((f) => f.value)
                        ).map((v) => <option key={v} value={v}>{labelFor(v)}</option>)}
                      </select>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-400 pl-1">
                      Source format detected as <code className="font-mono">{cfg.from}</code> —{" "}
                      <button className="underline hover:text-slate-600"
                              onClick={() => setFmt(c, "from", "")}>change</button>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Btn onClick={onApply} disabled={!!busy}>Apply Columns &amp; Types</Btn>
    </div>
  );
}

// ─── 3. Filter ───────────────────────────────────────────────────────────────
function FilterTab({ columns, draft, patch, onApply, busy }) {
  const badStart = draft.startDate.trim() && toIso(draft.startDate) === undefined;
  const badEnd = draft.endDate.trim() && toIso(draft.endDate) === undefined;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">NPI / ID Column</label>
          <select
            value={draft.npiCol}
            onChange={(e) => patch({ npiCol: e.target.value })}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
          >
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Date Column</label>
          <select
            value={draft.dateCol}
            onChange={(e) => patch({ dateCol: e.target.value })}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
          >
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-3 text-sm text-slate-700 cursor-pointer border border-slate-200 rounded-xl px-4 py-3.5">
        <input
          type="checkbox"
          checked={draft.useLuhn}
          onChange={(e) => patch({ useLuhn: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 accent-[#001E96]"
        />
        <span>
          Apply Luhn Algorithm Validation to NPI{" "}
          <em className="text-slate-500">(Checks 10-digit US NPI numbers)</em>
        </span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            Start Date (DD/MM/YYYY or YYYY-MM-DD)
          </label>
          <input
            value={draft.startDate}
            onChange={(e) => patch({ startDate: e.target.value })}
            placeholder="e.g. 01/01/2026 or 2026-01-01"
            className={`w-full px-4 py-3 rounded-xl border text-sm ${
              badStart ? "border-red-400" : "border-slate-200"}`}
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            End Date (DD/MM/YYYY or YYYY-MM-DD)
          </label>
          <input
            value={draft.endDate}
            onChange={(e) => patch({ endDate: e.target.value })}
            placeholder="e.g. 31/12/2026 or 2026-12-31"
            className={`w-full px-4 py-3 rounded-xl border text-sm ${
              badEnd ? "border-red-400" : "border-slate-200"}`}
          />
        </div>
      </div>

      {(badStart || badEnd) && (
        <Alert type="error">
          Dates must be DD/MM/YYYY or YYYY-MM-DD.
        </Alert>
      )}

      {draft.useLuhn && !draft.npiCol && (
        <Alert type="warning">Select an NPI / ID column to validate.</Alert>
      )}
      {(draft.startDate.trim() || draft.endDate.trim()) && !draft.dateCol && (
        <Alert type="warning">Select a date column for the range to apply to.</Alert>
      )}

      <Btn onClick={onApply} disabled={!!busy || badStart || badEnd}>Apply Filters</Btn>
    </div>
  );
}

// ─── 4. Granularity ──────────────────────────────────────────────────────────
function GranularityTab({ workflowId, filename, columns, draft, patch, onApply, busy, specSoFar }) {
  const [detecting, setDetecting] = useState(false);
  const [detail, setDetail] = useState(null);

  const detect = async () => {
    if (!draft.grainDateCol) return toast.error("Select a date column first");
    setDetecting(true);
    try {
      const spec = specSoFar();
      const res = await v2DetectGranularity(workflowId, filename, {
        date_column: draft.grainDateCol,
        live_updates: spec.live_updates,
        filters: spec.filters,
      });
      setDetail(res);
      const targets = GRAIN_TARGETS[res.granularity] || [];
      patch({ grainFrom: res.granularity, grainTo: targets[0] || "" });
      toast.success(`Detected: ${res.granularity}`);
    } catch (err) {
      toast.error(problemMessage(err, "Detection failed"));
    } finally { setDetecting(false); }
  };

  const toggleAgg = (c) => {
    const next = draft.aggCols.includes(c)
      ? draft.aggCols.filter((x) => x !== c)
      : [...draft.aggCols, c];
    const ops = { ...draft.aggOps };
    if (!next.includes(c)) delete ops[c]; else ops[c] = ops[c] || "sum";
    patch({ aggCols: next, aggOps: ops });
  };

  const targets = GRAIN_TARGETS[draft.grainFrom] || [];
  const ready = draft.grainFrom && draft.grainTo && draft.grainDateCol && draft.grainGeoCol;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Date Column</label>
          <select
            value={draft.grainDateCol}
            onChange={(e) => { patch({ grainDateCol: e.target.value, grainFrom: null, grainTo: "" }); setDetail(null); }}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
          >
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">
            Grouping (Geo/NPI/DMA) Column
          </label>
          <select
            value={draft.grainGeoCol}
            onChange={(e) => patch({ grainGeoCol: e.target.value })}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm bg-white"
          >
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <Btn variant="outline" onClick={detect} disabled={detecting || !draft.grainDateCol}>
          {detecting ? "Detecting…" : "Detect Granularity"}
        </Btn>
        {draft.grainFrom && (
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span className="px-3 py-1.5 rounded-full bg-brand-50 text-brand-700 font-semibold">
              Current: {draft.grainFrom}
            </span>
            <span className="text-slate-400">→</span>
            <select
              value={draft.grainTo}
              onChange={(e) => patch({ grainTo: e.target.value })}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white"
            >
              <option value="">Target grain…</option>
              {targets.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {detail && (
              <span className="text-[11px] text-slate-400">
                {detail.distinct_dates} distinct dates · {detail.min_date} → {detail.max_date}
              </span>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-semibold text-slate-700 mb-3">
          Numerical Columns to Aggregate (Summed per HCP/Geo per period)
        </label>
        <div className="flex flex-wrap gap-2">
          {columns.map((c) => (
            <button
              key={c}
              onClick={() => toggleAgg(c)}
              className={`px-5 py-2.5 rounded-full text-sm font-semibold border transition-all ${
                draft.aggCols.includes(c)
                  ? "bg-brand-600 text-white border-brand-600"
                  : "bg-white text-slate-600 border-slate-200 hover:border-brand-300"
              }`}
            >{c}</button>
          ))}
        </div>
      </div>

      {draft.aggCols.length > 0 && (
        <div className="space-y-3">
          {draft.aggCols.map((c) => (
            <div key={c} className="flex items-center gap-4 flex-wrap">
              <span className="text-sm font-semibold text-slate-700 min-w-[140px]">{c}</span>
              <select
                value={draft.aggOps[c] || "sum"}
                onChange={(e) => patch({ aggOps: { ...draft.aggOps, [c]: e.target.value } })}
                className="flex-1 min-w-[240px] px-4 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
              >
                {NUM_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {ready && draft.aggCols.length === 0 && (
        <Alert type="warning">
          No columns selected to aggregate — every non-key column will be dropped by the rollup.
        </Alert>
      )}

      <Btn onClick={onApply} disabled={!!busy || !ready}>Modify Granularity</Btn>
    </div>
  );
}
