import { useEffect, useRef, useState, useMemo } from 'react';
import cloud from '../../assets/sidebar_icon/cloud.png';
import {
  ApiError,
  commitSpec,
  deleteFile,
  detectGranularity,
  ensureWorkflow,
  forgetWorkflow,
  getFile,
  getProfile,
  listFiles,
  previewSpec,
  storedWorkflowId,
  uploadFiles,
} from '../../services/api.js';
import {
  buildFilters,
  buildLiveUpdates,
  buildSpec,
  clampDtype,
  humanFormat,
  localProblems,
  localWarnings,
  numericColumns,
  renamedName,
} from '../../services/manifest.js';
import './DataIngestion.css';

// ─── Category model ──────────────────────────────────────────────────────
// Each category carries its expected grain, a description shown once
// selected, and whether it's required before the workflow can proceed.
export const FILE_CATEGORIES = [
  {
    id: 'sales',
    label: 'Sales File',
    grain: 'HCP × Period',
    desc: 'HCP × Month Week grain; used as allocation base',
    required: true,
  },
  {
    id: 'hcp_promo',
    label: 'HCP-level Marketing Promo File',
    grain: 'HCP × Period',
    desc: 'Calls, Samples, Details, Speaker programs',
    required: false,
  },
  {
    id: 'dma_promo',
    label: 'DMA-level Marketing Activity File',
    grain: 'DMA × Period',
    desc: 'TV, Radio, Print, Digital spend impressions',
    required: false,
  },
  {
    id: 'dma_hcp_map',
    label: 'DMA HCP Mapping File',
    grain: 'HCP ↔ DMA Bridge',
    desc: 'Crosswalk bridge between HCP IDs ZIPs and DMA IDs',
    required: false,
  },
  {
    id: 'dma_pop',
    label: 'DMA Population File',
    grain: 'DMA Grain',
    desc: 'DMA target population or universe sizing',
    required: false,
  },
  {
  id: 'other',
  label: 'Other File',
  grain: 'Varies',
  desc: 'Supplementary or reference data that doesn\'t fit the standard categories above.',
  required: false,
},
];

const DATA_TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'date', label: 'Date' },
];

// `value` is the strftime pattern the API needs; `label` is what the user sees.
const DATE_FORMATS = [
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY (24/05/2026)' },
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY (05/24/2026)' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD (2026-05-24)' },
];

const NUM_OPS = ['sum', 'average', 'min', 'max', 'product'];
const GRAN_OPTIONS = {
  Daily: ['Weekly', 'Monthly'],
  Weekly: ['Monthly'],
  Monthly: ['Yearly'],
};

const TAB_ORDER = ['mapping', 'standardize', 'filter', 'granularity'];

// Guess a category from the filename the user can always override it
// via the dropdown, this just saves them a click for the common cases.
function suggestCategory(filename) {
  const name = filename.toLowerCase();
  if (name.includes('sale') || name.includes('trx') || name.includes('nrx')) return 'sales';
  if (name.includes('call') || name.includes('sample') || name.includes('hcp') || name.includes('rep')) return 'hcp_promo';
  if (name.includes('tv') || (name.includes('dma') && name.includes('spend'))) return 'dma_promo';
  if (name.includes('map') || name.includes('bridge') || name.includes('crosswalk')) return 'dma_hcp_map';
  if (name.includes('pop') || name.includes('universe')) return 'dma_pop';
  return null;
}

let fileIdCounter = 0;

function DataIngestion() {
  // TEMP: using plain local state for now instead of global Context/API
  // persistence. Once workflow-creation APIs are available, swap this back
  // to useAppState() (see AppContext.jsx) so ingestion progress persists
  // across pages/sessions.
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState('mapping'); // mapping | standardize | filter | granularity
  const [visitedTabs, setVisitedTabs] = useState(new Set(['mapping']));
  const [hasClickedNext, setHasClickedNext] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);
  const [isDetectingGranularity, setIsDetectingGranularity] = useState(false);
  const [isModifyingGranularity, setIsModifyingGranularity] = useState(false);
  const [isRestoringFiles, setIsRestoringFiles] = useState(() => Boolean(storedWorkflowId()));
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState(null);
  const [applyMessage, setApplyMessage] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const fileInputRef = useRef(null);

  const unmappedCount = useMemo(
    () => uploadedFiles.filter((f) => !f.category).length,
    [uploadedFiles]
  );

  // At least one file must be tagged with every `required: true` category
  // (currently just "Sales File") before Proceed is allowed.
  const hasRequiredCategories = useMemo(() => {
    const requiredIds = FILE_CATEGORIES.filter((c) => c.required).map((c) => c.id);
    return requiredIds.every((id) => uploadedFiles.some((f) => f.category === id));
  }, [uploadedFiles]);

  const missingRequiredLabels = useMemo(() => {
    const requiredCats = FILE_CATEGORIES.filter((c) => c.required);
    return requiredCats
      .filter((cat) => !uploadedFiles.some((f) => f.category === cat.id))
      .map((cat) => cat.label);
  }, [uploadedFiles]);

  const canProceed = unmappedCount === 0 && hasRequiredCategories && uploadedFiles.length > 0;

  const hasVisitedAllTabs = TAB_ORDER.every((t) => visitedTabs.has(t));

  const handleNext = () => {
    setHasClickedNext(true);
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    const nextTab = TAB_ORDER[Math.min(currentIndex + 1, TAB_ORDER.length - 1)];
    setActiveTab(nextTab);
    setVisitedTabs((prev) => new Set(prev).add(nextTab));
  };

  const handleBack = () => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    const prevTab = TAB_ORDER[Math.max(currentIndex - 1, 0)];
    setActiveTab(prevTab);
  };

  // Resume the server-side datasets for the selected workflow. The browser
  // holds only metadata; bytes remain in object storage and are never
  // re-uploaded just to resume this screen.
  useEffect(() => {
    const workflowId = storedWorkflowId();
    if (!workflowId) return undefined;
    let cancelled = false;

    const hydrate = async () => {
      setIsRestoringFiles(true);
      try {
        const response = await listFiles(workflowId);
        const files = await Promise.all((response.items || []).map(async (dataset) => {
          // Listing metadata is enough to render a resumed file. Profile and
          // preview failures must not hide every file in the workflow.
          const [profileResult, fileResult] = await Promise.allSettled([
            getProfile(workflowId, dataset.filename),
            getFile(workflowId, dataset.filename),
          ]);
          const profileResponse = profileResult.status === 'fulfilled' ? profileResult.value : {};
          const currentDataset = fileResult.status === 'fulfilled' ? fileResult.value : {};
          const profile = profileResponse.profile || [];
          const rawColumns = profileResponse.columns || dataset.columns || [];
          const spec = dataset.spec || {};
          const updates = spec.live_updates || {};
          const dropped = new Set(updates.column_drops || []);
          const typeCastMap = Object.fromEntries(profile.map((p) => [p.column, clampDtype(p.suggested_dtype)]));
          for (const change of updates.dtype_changes || []) typeCastMap[change.column] = change.to;
          return {
            id: `file-${++fileIdCounter}`, filename: dataset.filename, name: dataset.filename, workflowId,
            category: spec.config_metadata?.category || suggestCategory(dataset.filename),
            columns: rawColumns, previewRows: currentDataset.preview || [], totalRows: dataset.row_count || 0,
            isParsing: false, parseError: null, selectedCols: rawColumns.filter((column) => !dropped.has(column)),
            renameMap: Object.fromEntries((updates.column_renames || []).map((item) => [item.from, item.to])),
            profile,
            typeCastMap,
            // Fall back to the detected dates when nothing has been committed
            // yet, so resuming before the first Apply still offers the format
            // controls rather than an empty box.
            dateConfigs: (updates.date_formats || []).length
              ? updates.date_formats.map((item) => ({ col: item.column, format: item.to }))
              : profile.filter((p) => p.suggested_date_from)
                  .map((p) => ({ col: p.column, format: '%Y-%m-%d' })),
            dateSourceFormats: (updates.date_formats || []).length
              ? Object.fromEntries(updates.date_formats.map((item) => [item.column, item.from]))
              : Object.fromEntries(profile.filter((p) => p.suggested_date_from)
                  .map((p) => [p.column, p.suggested_date_from])),
            filterConfig: { npiCol: '', dateCol: '', useLuhn: false, startDate: '', endDate: '' },
            granularityConfig: { dateCol: '', geoCol: '', detected: null, target: '', numOps: {} },
          };
        }));
        if (!cancelled) {
          setUploadedFiles(files);
          setSelectedFileId(files[0]?.id || null);
        }
      } catch (err) {
        if (!cancelled) window.alert(err instanceof ApiError ? err.text : 'Could not load workflow files.');
      } finally {
        if (!cancelled) setIsRestoringFiles(false);
      }
    };
    hydrate();
    return () => { cancelled = true; };
  }, []);

  // ─── File upload + parsing ───────────────────────────────────────────
  const addFiles = async (fileList) => {
    if (isUploadingFiles) return;
    const csvFiles = Array.from(fileList).filter((file) =>
      /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i.test(file.name)
    );
    if (!csvFiles.length) return;
    setIsUploadingFiles(true);
    try {
      const workflowId = await ensureWorkflow();
      const result = await uploadFiles(workflowId, csvFiles);
      const newEntries = await Promise.all(result.files.map(async (dataset) => {
        const profileResponse = dataset.profile ? dataset : await getProfile(workflowId, dataset.filename);
        const profile = profileResponse.profile || [];
        const columns = dataset.columns || profileResponse.columns || [];
        return {
          id: `file-${++fileIdCounter}`, filename: dataset.filename, name: dataset.filename, workflowId,
          category: suggestCategory(dataset.filename), columns, previewRows: dataset.preview || [],
          totalRows: dataset.row_count || 0, isParsing: false, parseError: null, selectedCols: columns,
          renameMap: {},
          profile,
          typeCastMap: Object.fromEntries(profile.map((p) => [p.column, clampDtype(p.suggested_dtype)])),
          // Every detected date column gets a Target Date Format row. Excluding
          // the ambiguous ones hid the control precisely where the user most
          // needs it - a file whose dates are all day <= 12 showed no date
          // options at all.
          dateConfigs: profile.filter((p) => p.suggested_date_from)
            .map((p) => ({ col: p.column, format: '%Y-%m-%d' })),
          dateSourceFormats: Object.fromEntries(profile.filter((p) => p.suggested_date_from)
            .map((p) => [p.column, p.suggested_date_from])),
          filterConfig: { npiCol: '', dateCol: '', useLuhn: false, startDate: '', endDate: '' },
          granularityConfig: { dateCol: '', geoCol: '', detected: null, target: '', numOps: {} },
        };
      }));
      setUploadedFiles((prev) => [...prev, ...newEntries]);
      setSelectedFileId(newEntries[0]?.id || null);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Upload failed.');
    } finally {
      setIsUploadingFiles(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };
  const handleBrowseClick = () => {
    if (!isUploadingFiles) fileInputRef.current?.click();
  };
  const handleFileInputChange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const handleRemoveFile = async (fileId, e) => {
    e.stopPropagation();
    if (deletingFileId) return;
    const file = uploadedFiles.find((item) => item.id === fileId);
    setDeletingFileId(fileId);
    try {
      if (file?.workflowId) await deleteFile(file.workflowId, file.filename);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not remove this file.');
      return;
    } finally {
      setDeletingFileId(null);
    }
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
    if (selectedFileId === fileId) setSelectedFileId(null);
  };

  const handleCategoryChange = (fileId, category) => {
    setUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, category } : f))
    );
  };

  const handleResetWorkflow = () => {
    setUploadedFiles([]);
    setSelectedFileId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    forgetWorkflow();
  };

  const updateFileConfig = (fileId, updates) => {
    setUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, ...updates } : f))
    );
  };

  // Standardize tab
  const toggleKeepColumn = (file, col, keep) => {
    const selectedCols = keep
      ? [...file.selectedCols, col]
      : file.selectedCols.filter((c) => c !== col);
    updateFileConfig(file.id, { selectedCols });
  };
  const setRename = (file, col, value) =>
    updateFileConfig(file.id, { renameMap: { ...file.renameMap, [col]: value } });
  const setColType = (file, col, type) => {
    const typeCastMap = { ...file.typeCastMap, [col]: type };
    let dateConfigs = file.dateConfigs;
    // The API needs the format the file actually uses, not just the target, and
    // it never guesses. Seed it from the server profile so marking a column as
    // Date by hand still produces a usable conversion.
    const dateSourceFormats = { ...(file.dateSourceFormats || {}) };
    if (type === 'date' && !dateConfigs.find((d) => d.col === col)) {
      dateConfigs = [...dateConfigs, { col, format: '%d/%m/%Y' }];
      const detected = (file.profile || []).find((p) => p.column === col);
      if (detected?.suggested_date_from) {
        dateSourceFormats[col] = detected.suggested_date_from;
      }
    } else if (type !== 'date') {
      dateConfigs = dateConfigs.filter((d) => d.col !== col);
      delete dateSourceFormats[col];
    }
    updateFileConfig(file.id, { typeCastMap, dateConfigs, dateSourceFormats });
  };
  const setDateFormat = (file, col, format) =>
    updateFileConfig(file.id, {
      dateConfigs: file.dateConfigs.map((d) => (d.col === col ? { ...d, format } : d)),
    });

  // Filter tab
  const setFilterField = (file, key, value) =>
    updateFileConfig(file.id, {
      filterConfig: { ...file.filterConfig, [key]: value },
    });

  // Granularity tab
  const setGranularityField = (file, key, value) =>
    updateFileConfig(file.id, {
      granularityConfig: { ...file.granularityConfig, [key]: value },
    });

  // PLACEHOLDER: no backend endpoint yet — just marks a granularity as
  // "detected" locally so the UI flow can be reviewed. Replace with a real
  // API call once available.
  const handleDetectGranularity = async (file) => {
    if (!file.granularityConfig.dateCol || isDetectingGranularity) return;
    setIsDetectingGranularity(true);
    try {
      const detail = await detectGranularity(file.workflowId, file.filename, {
        date_column: renamedName(file, file.granularityConfig.dateCol),
        live_updates: buildLiveUpdates(file),
        filters: buildFilters(file),
      });
      setGranularityField(file, 'detected', detail.granularity);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Granularity detection failed.');
    } finally {
      setIsDetectingGranularity(false);
    }
  };

  const applyFile = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsApplying(true);
    setApplyMessage('Validating configuration…');
    try {
      const spec = buildSpec(file);
      setApplyMessage('Previewing transformations…');
      await previewSpec(file.workflowId, file.filename, spec);
      setApplyMessage('Saving transformed dataset…');
      const committed = await commitSpec(file.workflowId, file.filename, spec);
      updateFileConfig(file.id, {
        previewRows: committed.preview || [],
        previewColumns: committed.columns || file.columns,
        totalRows: committed.row_count,
      });
      setApplyMessage(['Configuration applied successfully. The preview now shows the transformed dataset.', ...localWarnings(file)].join(' '));
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Configuration could not be applied.');
    } finally {
      setIsApplying(false);
    }
  };

  const previewFile = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsPreviewing(true);
    setApplyMessage('Previewing changes… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      setApplyMessage(['Preview ready. These changes have not been saved.', ...localWarnings(file)].join(' '));
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Changes could not be previewed.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const modifyGranularity = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsModifyingGranularity(true);
    setApplyMessage('Modifying granularity… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      const dropped = preview.applied?.unhandled_columns || [];
      setApplyMessage(
        dropped.length
          ? `Granularity preview ready. These columns had no aggregation and were dropped: ${dropped.join(', ')}. Nothing has been saved.`
          : 'Granularity preview ready. These changes have not been saved.'
      );
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Granularity could not be modified.');
    } finally {
      setIsModifyingGranularity(false);
    }
  };

  const applyFilter = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsFiltering(true);
    setApplyMessage('Applying filter… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      setApplyMessage('Filter preview ready. These changes have not been saved.');
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Filter could not be applied.');
    } finally {
      setIsFiltering(false);
    }
  };

  const selectedFile = uploadedFiles.find((f) => f.id === selectedFileId);
  const previewColumns = selectedFile?.previewColumns || selectedFile?.columns || [];
  const hasFiles = uploadedFiles.length > 0;
  // Only numeric, kept columns can be aggregated, and never the two grouping
  // keys. The rollup drops anything else, so offering them would be misleading.
  const aggregatableColumns = selectedFile ? numericColumns(selectedFile) : [];

  return (
    <div className="data-ingestion-page">
      {/* ---- Shared header ---- */}
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-header-icon icon-placeholder">
            <img src={cloud} alt="Data Ingestion" />
          </div>
          <div>
            <p className="page-header-title">Data Ingestion</p>
            <p className="page-header-subtitle">
              Upload, standardize, merge, and filter your marketing data
            </p>
          </div>
        </div>

        <button className="page-header-reset-btn" onClick={handleResetWorkflow}>
          <span aria-hidden="true">&#8635;</span> Reset Workflow
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
        multiple
        className="upload-input-hidden"
        onChange={handleFileInputChange}
      />

      {isRestoringFiles ? (
        <div className="operation-loader" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          <span>Loading files from storage…</span>
        </div>
      ) : !hasFiles ? (
        /* ============ DEFAULT VIEW (no files yet) ============ */
        <div className="upload-card">
          <p className="upload-card-title">Upload CSV Files</p>

          <div
            className={`upload-dropzone${isDragging ? ' dragging' : ''}${isUploadingFiles ? ' loading' : ''}`}
            onClick={handleBrowseClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
          >
            {isUploadingFiles ? <span className="loading-spinner" aria-hidden="true" /> : <img src={cloud} alt="Upload" className="icon-placeholder" />}
            <p className="upload-dropzone-text">
              {isUploadingFiles ? 'Uploading files…' : 'Drag & drop CSV files here, or click to browse'}
            </p>
            <p className="upload-dropzone-subtext">
              Supports CSV, TSV, and Excel files
            </p>
          </div>
        </div>
      ) : (
        /* ============ MAPPING VIEW (files uploaded) ============ */
        <div className="mapping-layout">
          {/* ---- Left: file list ---- */}
          <div className="file-list-panel">
            <button className="upload-files-btn" onClick={handleBrowseClick} disabled={isUploadingFiles}>
              {isUploadingFiles ? 'Uploading files…' : 'Upload files'}
            </button>
            {isUploadingFiles && <p className="file-operation-status" role="status"><span className="loading-spinner" aria-hidden="true" /> Uploading and preparing files…</p>}
            <p className="file-list-count">
              Uploaded {uploadedFiles.length} of {uploadedFiles.length}
            </p>

            <div className="file-list">
              {uploadedFiles.map((f, index) => {
                const categoryInfo = FILE_CATEGORIES.find((c) => c.id === f.category);
                return (
                  <div
                    key={f.id}
                    className={`file-list-item${
                      f.id === selectedFileId ? ' selected' : ''
                    }${!f.category ? ' unmapped' : ''}${deletingFileId === f.id ? ' deleting' : ''}`}
                    onClick={() => deletingFileId !== f.id && setSelectedFileId(f.id)}
                  >
                    <div>
                      <p className="file-item-name">{f.name}</p>
                      {/* <p className="file-item-filename">{f.name}</p> */}
                      <p className={`file-item-status${!f.category ? ' unmapped-label' : ''}`}>
                        {categoryInfo ? categoryInfo.label : 'Unmapped'}
                        {categoryInfo?.required && <span className="file-item-required-badge">Required</span>}
                      </p>
                    </div>
                    <div className="file-item-actions">
                      <button
                        className="file-item-icon-btn"
                        onClick={(e) => handleRemoveFile(f.id, e)}
                        aria-label={`Remove ${f.name}`}
                        disabled={Boolean(deletingFileId)}
                      >
                        {deletingFileId === f.id ? <span className="loading-spinner" aria-hidden="true" /> : '×'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="file-list-footer">Edit remaps · Delete removes</p>
          </div>

          {/* ---- Right: mapping configuration ---- */}
          <div className="mapping-config-panel">
            {selectedFile ? (
              <>
                <div className="mapping-panel-header">
                  <div className="tab-group">
                    <button
                      className={`tab-btn${activeTab === 'mapping' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('mapping');
                        setVisitedTabs((prev) => new Set(prev).add('mapping'));
                      }}
                    >
                      Assign Category
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'standardize' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('standardize');
                        setVisitedTabs((prev) => new Set(prev).add('standardize'));
                      }}
                    >
                      Standardize
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'filter' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('filter');
                        setVisitedTabs((prev) => new Set(prev).add('filter'));
                      }}
                    >
                      Filter
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'granularity' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('granularity');
                        setVisitedTabs((prev) => new Set(prev).add('granularity'));
                      }}
                    >
                      Granularity
                    </button>
                  </div>
                  <div className="mapping-top-actions">
                    {applyMessage && <p className="apply-config-message" role="status">{applyMessage}</p>}

                    {hasClickedNext && (
                      <button className="mapping-btn secondary" onClick={handleBack}>
                        Back
                      </button>
                    )}

                    <button className="mapping-btn secondary" disabled={!selectedFile || isApplying || isPreviewing || isFiltering} onClick={() => previewFile(selectedFile)}>
                      {isPreviewing ? 'Previewing changes…' : 'Preview changes'}
                    </button>

                    {hasVisitedAllTabs ? (
                      <button className="mapping-btn primary" disabled={!selectedFile || isApplying || isPreviewing || isFiltering} onClick={() => applyFile(selectedFile)}>
                        {isApplying ? 'Applying configurations…' : 'Apply configuration'}
                      </button>
                    ) : (
                      <button className="mapping-btn primary" onClick={handleNext}>
                        Next
                      </button>
                    )}
                  </div>
                </div>

                {activeTab === 'mapping' && (
                  <>
                <hr className="mapping-divider" />

                <p className="mapping-section-label">Assign category</p>
                <select
                  className="category-select"
                  value={selectedFile.category || ''}
                  onChange={(e) =>
                    handleCategoryChange(selectedFile.id, e.target.value)
                  }
                >
                  <option value="">Select a category...</option>
                  {FILE_CATEGORIES.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.label}
                      {cat.required ? ' (required)' : ''}
                    </option>
                  ))}
                </select>

                {selectedFile.category && (
                  <div className="category-info-box">
                    <p className="category-info-title">
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.label}
                    </p>
                    <p className="category-info-desc">
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.desc}
                    </p>
                    <p className="category-info-grain">
                      Expected grain:{' '}
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.grain}
                    </p>
                  </div>
                )}

                {unmappedCount > 0 && (
                  <div className="mapping-warning-banner">
                    {unmappedCount} file{unmappedCount > 1 ? 's' : ''} still
                    need{unmappedCount === 1 ? 's' : ''} a category
                  </div>
                )}

                {unmappedCount === 0 && !hasRequiredCategories && (
                  <div className="mapping-warning-banner">
                    Please assign at least one file to:{' '}
                    {missingRequiredLabels.join(', ')}
                  </div>
                )}

                {canProceed && (
                  <div className="mapping-success-banner">
                    All files mapped ready to proceed
                  </div>
                )}
                  </>
                )}

                {activeTab === 'standardize' && (
                  <>
                    <p className="mapping-section-label">
                      Column Schema &amp; Data Type Configuration
                    </p>
                    <div className="schema-table-wrapper">
                      <table className="schema-table">
                        <thead>
                          <tr>
                            <th style={{ width: 50 }}>Keep</th>
                            <th>Original Column</th>
                            <th>Rename To</th>
                            <th>Data Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedFile.columns.map((col) => {
                            const isKept = selectedFile.selectedCols.includes(col);
                            const currentType = selectedFile.typeCastMap[col] || 'string';
                            return (
                              <tr key={col} className={!isKept ? 'dropped' : ''}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={isKept}
                                    onChange={(e) =>
                                      toggleKeepColumn(selectedFile, col, e.target.checked)
                                    }
                                  />
                                </td>
                                <td className="schema-col-name">{col}</td>
                                <td>
                                  <input
                                    type="text"
                                    className="schema-rename-input"
                                    disabled={!isKept}
                                    placeholder={col}
                                    value={selectedFile.renameMap[col] || ''}
                                    onChange={(e) => setRename(selectedFile, col, e.target.value)}
                                  />
                                </td>
                                <td>
                                  <select
                                    className="schema-type-select"
                                    disabled={!isKept}
                                    value={currentType}
                                    onChange={(e) => setColType(selectedFile, col, e.target.value)}
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

                    {selectedFile.dateConfigs.length > 0 && (
                      <div className="date-format-box">
                        <p className="mapping-section-label" style={{ marginBottom: 0 }}>
                          Date Format (source &rarr; target)
                        </p>
                        {selectedFile.dateConfigs.map((dc) => {
                          // Read-only: the source format is detected from the
                          // file itself, so it is shown rather than chosen.
                          const source = selectedFile.dateSourceFormats?.[dc.col];
                          return (
                            <div key={dc.col} className="date-format-row">
                              <span>{dc.col}</span>
                              <span>{humanFormat(source) || 'not detected'}</span>
                              <span>&rarr;</span>
                              <select
                                value={dc.format}
                                onChange={(e) => setDateFormat(selectedFile, dc.col, e.target.value)}
                              >
                                {DATE_FORMATS.map((f) => (
                                  <option key={f.value} value={f.value}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="tab-placeholder-note">
                      The source format is the one your file already uses. It is detected per
                      column and never guessed at conversion time, which is what stops day and
                      month being swapped for days of the month up to 12.
                    </p>
                  </>
                )}

                {activeTab === 'filter' && (
                  <>
                    <div className="filter-grid">
                      <div>
                        <p className="filter-field-label">NPI</p>
                        <select
                          className="filter-select"
                          value={selectedFile.filterConfig.npiCol}
                          onChange={(e) => setFilterField(selectedFile, 'npiCol', e.target.value)}
                        >
                          <option value="">Select column (optional)</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <p className="filter-field-label">Date</p>
                        <select
                          className="filter-select"
                          value={selectedFile.filterConfig.dateCol}
                          onChange={(e) => setFilterField(selectedFile, 'dateCol', e.target.value)}
                        >
                          <option value="">Select column (optional)</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <label className="filter-checkbox-row">
                      <input
                        type="checkbox"
                        checked={selectedFile.filterConfig.useLuhn}
                        onChange={(e) => setFilterField(selectedFile, 'useLuhn', e.target.checked)}
                      />
                      Apply Luhn algorithm validation to NPI (checks 10-digit US NPI numbers)
                    </label>

                    <div className="filter-grid">
                      <div>
                        <p className="filter-field-label">Start Date</p>
                        <input
                          type="text"
                          className="filter-input"
                          placeholder="e.g. 01/01/2026"
                          value={selectedFile.filterConfig.startDate}
                          onChange={(e) => setFilterField(selectedFile, 'startDate', e.target.value)}
                        />
                      </div>
                      <div>
                        <p className="filter-field-label">End Date</p>
                        <input
                          type="text"
                          className="filter-input"
                          placeholder="e.g. 31/12/2026"
                          value={selectedFile.filterConfig.endDate}
                          onChange={(e) => setFilterField(selectedFile, 'endDate', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="filter-actions">
                      {previewResult?.fileId === selectedFile.id && previewResult.applied.filters_applied > 0 && (
                        <p className="preview-filter-result" role="status">
                          {previewResult.applied.rows_out} of {previewResult.applied.rows_in} rows match
                          {previewResult.applied.rows_removed > 0 && ` (${previewResult.applied.rows_removed} removed)`}.
                        </p>
                      )}
                      <button
                        className="mapping-btn primary"
                        disabled={isPreviewing || isApplying || isFiltering}
                        onClick={() => applyFilter(selectedFile)}
                      >
                        {isFiltering ? 'Applying filter…' : 'Apply Filter'}
                      </button>
                    </div>
                    <p className="tab-placeholder-note">
                      Applying the filter previews the matching rows without saving changes.
                    </p>
                  </>
                )}

                {activeTab === 'granularity' && (
                  <>
                    <div className="filter-grid">
                      <div>
                        <p className="filter-field-label">Date</p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.dateCol}
                          onChange={(e) => setGranularityField(selectedFile, 'dateCol', e.target.value)}
                        >
                          <option value="">Select date column</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <p className="filter-field-label">Grouping (Geo/NPI/DMA)</p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.geoCol}
                          onChange={(e) => setGranularityField(selectedFile, 'geoCol', e.target.value)}
                        >
                          <option value="">Select geo/ID column</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <button
                      className="granularity-detect-btn"
                      onClick={() => handleDetectGranularity(selectedFile)}
                      disabled={!selectedFile.granularityConfig.dateCol || isDetectingGranularity}
                    >
                      {isDetectingGranularity ? 'Detecting granularity…' : 'Detect Granularity'}
                    </button>
                    {selectedFile.granularityConfig.detected && (
                      <span className="granularity-detected-badge">
                        Detected: {selectedFile.granularityConfig.detected}
                      </span>
                    )}

                    {selectedFile.granularityConfig.detected && (
                      <>
                        {aggregatableColumns.map((col) => (
                          <div key={col} className="agg-op-row">
                            <span>{col}</span>
                            <select
                              className="filter-select"
                              value={selectedFile.granularityConfig.numOps[col] || 'sum'}
                              onChange={(e) =>
                                setGranularityField(selectedFile, 'numOps', {
                                  ...selectedFile.granularityConfig.numOps,
                                  [col]: e.target.value,
                                })
                              }
                            >
                              {NUM_OPS.map((op) => (
                                <option key={op} value={op}>{op}</option>
                              ))}
                            </select>
                          </div>
                        ))}

                        <p className="filter-field-label" style={{ marginTop: '1rem' }}>
                          Target Granularity
                        </p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.target}
                          onChange={(e) => setGranularityField(selectedFile, 'target', e.target.value)}
                        >
                          <option value="">Select target granularity</option>
                          {(GRAN_OPTIONS[selectedFile.granularityConfig.detected] || []).map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                        </select>

                        <div className="filter-actions">
                          {previewResult?.fileId === selectedFile.id
                            && previewResult.applied.granularity_applied && (
                            <p className="preview-filter-result" role="status">
                              {previewResult.applied.rows_out} rows after rolling up to{' '}
                              {selectedFile.granularityConfig.target}
                              {previewResult.applied.unhandled_columns?.length > 0
                                && ` · not aggregated: ${previewResult.applied.unhandled_columns.join(', ')}`}.
                            </p>
                          )}
                          <button
                            className="mapping-btn primary"
                            disabled={
                              !selectedFile.granularityConfig.target
                              || isPreviewing || isApplying || isFiltering || isModifyingGranularity
                            }
                            onClick={() => modifyGranularity(selectedFile)}
                          >
                            {isModifyingGranularity ? 'Modifying granularity…' : 'Modify Granularity'}
                          </button>
                        </div>
                      </>
                    )}
                    <p className="tab-placeholder-note">
                      Only numeric columns can be aggregated. Modifying granularity previews the
                      rolled-up rows without saving changes.
                    </p>
                  </>
                )}

                {/* Shared across every tab: previewing from Standardize, Filter or
                    Granularity should show its result in place, not send the user
                    back to Assign Category. */}
                <hr className="mapping-divider" />

                <div className="mapping-preview-section">
                  <p className="mapping-section-label">Preview</p>

                  {isPreviewing && (
                    <p className="mapping-config-subtitle" role="status">
                      <span className="loading-spinner" aria-hidden="true" /> Previewing changes…
                    </p>
                  )}

                  {selectedFile.isParsing && (
                    <p className="mapping-config-subtitle">Parsing file...</p>
                  )}

                  {selectedFile.parseError && (
                    <p className="mapping-config-subtitle">
                      Couldn't read this file: {selectedFile.parseError}
                    </p>
                  )}

                  {!selectedFile.isParsing &&
                    !selectedFile.parseError &&
                    previewColumns.length > 0 && (
                      <div className="preview-table-wrapper">
                        <div className="preview-table-scroll">
                            <table className="preview-table">
                            <thead>
                                <tr>
                                {previewColumns.map((col) => (
                                    <th key={col}>{col}</th>
                                ))}
                                </tr>
                            </thead>
                            <tbody>
                                {selectedFile.previewRows.map((row, i) => (
                                <tr key={i}>
                                    {previewColumns.map((col) => (
                                    <td key={col}>{row[col]}</td>
                                    ))}
                                </tr>
                                ))}
                            </tbody>
                            </table>
                        </div>
                        <p className="preview-row-count">
                          {(selectedFile.previewRowCount ?? selectedFile.totalRows).toLocaleString()} rows
                        </p>
                      </div>
                    )}
                </div>


              </>
            ) : (
              <p className="mapping-config-subtitle">
                Select a file on the left to configure its mapping.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DataIngestion;
