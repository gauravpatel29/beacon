import { useRef, useState, useMemo } from 'react';
import Papa from 'papaparse';
import cloud from '../../assets/sidebar_icon/cloud.png';
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

const DATE_FORMATS = [
  { value: '%d/%m/%Y', label: '%d/%m/%Y (e.g. 24/05/2026)' },
  { value: '%m/%d/%Y', label: '%m/%d/%Y (e.g. 05/24/2026)' },
  { value: '%Y-%m-%d', label: '%Y-%m-%d (e.g. 2026-05-24)' },
];

const NUM_OPS = ['sum', 'average', 'min', 'max', 'product'];
const GRAN_OPTIONS = {
  Daily: ['Weekly', 'Monthly'],
  Weekly: ['Weekly', 'Monthly'],
  Monthly: ['Monthly'],
};

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

  // ─── File upload + parsing ───────────────────────────────────────────
  const addFiles = (fileList) => {
    const csvFiles = Array.from(fileList).filter((file) =>
      file.name.toLowerCase().endsWith('.csv')
    );
    if (!csvFiles.length) return;

    const newEntries = csvFiles.map((file) => ({
      id: `file-${++fileIdCounter}`,
      file,
      name: file.name,
      category: suggestCategory(file.name), // auto-suggested, user can change
      columns: [],
      previewRows: [],
      totalRows: 0,
      isParsing: true,
      parseError: null,
      // Standardize tab
      selectedCols: [],
      renameMap: {},
      typeCastMap: {},
      dateConfigs: [],
      // Filter tab
      filterConfig: {
        npiCol: '',
        dateCol: '',
        useLuhn: false,
        startDate: '',
        endDate: '',
      },
      // Granularity tab
      granularityConfig: {
        dateCol: '',
        geoCol: '',
        detected: null,
        target: '',
        numOps: {},
      },
    }));

    setUploadedFiles((prev) => [...prev, ...newEntries]);
    setSelectedFileId(newEntries[0].id);

    newEntries.forEach((entry) => {
      Papa.parse(entry.file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const columns = results.meta.fields || [];
          const rows = results.data || [];
          const typeCastMap = {};
          columns.forEach((c) => {
            const lower = c.toLowerCase();
            typeCastMap[c] = lower.includes('date') || lower.includes('week') || lower.includes('month')
              ? 'date'
              : 'string';
          });

          setUploadedFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id
                ? {
                    ...f,
                    columns,
                    previewRows: rows.slice(0, 100),
                    totalRows: rows.length,
                    isParsing: false,
                    selectedCols: columns,
                    typeCastMap,
                    dateConfigs: columns
                      .filter((c) => typeCastMap[c] === 'date')
                      .map((c) => ({ col: c, format: '%d/%m/%Y' })),
                  }
                : f
            )
          );
        },
        error: (err) => {
          setUploadedFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id
                ? { ...f, isParsing: false, parseError: err.message }
                : f
            )
          );
        },
      });
    });
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
  const handleBrowseClick = () => fileInputRef.current?.click();
  const handleFileInputChange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const handleRemoveFile = (fileId, e) => {
    e.stopPropagation();
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
    if (type === 'date' && !dateConfigs.find((d) => d.col === col)) {
      dateConfigs = [...dateConfigs, { col, format: '%d/%m/%Y' }];
    } else if (type !== 'date') {
      dateConfigs = dateConfigs.filter((d) => d.col !== col);
    }
    updateFileConfig(file.id, { typeCastMap, dateConfigs });
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
  const handleDetectGranularity = (file) => {
    if (!file.granularityConfig.dateCol) return;
    setGranularityField(file, 'detected', 'Weekly');
  };

  const selectedFile = uploadedFiles.find((f) => f.id === selectedFileId);
  const hasFiles = uploadedFiles.length > 0;

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
        accept=".csv"
        multiple
        className="upload-input-hidden"
        onChange={handleFileInputChange}
      />

      {!hasFiles ? (
        /* ============ DEFAULT VIEW (no files yet) ============ */
        <div className="upload-card">
          <p className="upload-card-title">Upload CSV Files</p>

          <div
            className={`upload-dropzone${isDragging ? ' dragging' : ''}`}
            onClick={handleBrowseClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
          >
            <img src={cloud} alt="Upload" className="icon-placeholder" />
            <p className="upload-dropzone-text">
              Drag &amp; drop CSV files here, or click to browse
            </p>
            <p className="upload-dropzone-subtext">
              Supports all standard CSV files
            </p>
          </div>
        </div>
      ) : (
        /* ============ MAPPING VIEW (files uploaded) ============ */
        <div className="mapping-layout">
          {/* ---- Left: file list ---- */}
          <div className="file-list-panel">
            <button className="upload-files-btn" onClick={handleBrowseClick}>
              Upload files
            </button>
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
                    }${!f.category ? ' unmapped' : ''}`}
                    onClick={() => setSelectedFileId(f.id)}
                  >
                    <div>
                      <p className="file-item-name">{f.name}</p>
                      {/* <p className="file-item-filename">{f.name}</p> */}
                      <p
                        className={`file-item-status${
                          !f.category
                            ? ' unmapped-label'
                            : categoryInfo?.required
                            ? ' required-label'
                            : ''
                        }`}
                      >
                        {categoryInfo ? categoryInfo.label : 'Unmapped'}
                      </p>
                    </div>
                    <div className="file-item-actions">
                      <button
                        className="file-item-icon-btn"
                        onClick={(e) => handleRemoveFile(f.id, e)}
                        aria-label={`Remove ${f.name}`}
                      >
                        &#10005;
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
                  <div>
                    <p className="mapping-config-title">Mapping configuration</p>
                    <p className="mapping-config-subtitle">
                      File {uploadedFiles.findIndex((f) => f.id === selectedFile.id) + 1}{' '}
                        {selectedFile.name}
                    </p>
                  </div>
                  <div className="tab-group">
                    <button
                      className={`tab-btn${activeTab === 'mapping' ? ' active' : ''}`}
                      onClick={() => setActiveTab('mapping')}
                    >
                      Assign Category
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'standardize' ? ' active' : ''}`}
                      onClick={() => setActiveTab('standardize')}
                    >
                      Standardize
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'filter' ? ' active' : ''}`}
                      onClick={() => setActiveTab('filter')}
                    >
                      Filter
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'granularity' ? ' active' : ''}`}
                      onClick={() => setActiveTab('granularity')}
                    >
                      Granularity
                    </button>
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

                <div className="mapping-preview-section">
                  <p className="mapping-section-label">Preview</p>

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
                    selectedFile.columns.length > 0 && (
                      <div className="preview-table-wrapper">
                        <div className="preview-table-scroll">
                            <table className="preview-table">
                            <thead>
                                <tr>
                                {selectedFile.columns.map((col) => (
                                    <th key={col}>{col}</th>
                                ))}
                                </tr>
                            </thead>
                            <tbody>
                                {selectedFile.previewRows.map((row, i) => (
                                <tr key={i}>
                                    {selectedFile.columns.map((col) => (
                                    <td key={col}>{row[col]}</td>
                                    ))}
                                </tr>
                                ))}
                            </tbody>
                            </table>
                        </div>
                        <p className="preview-row-count">
                          {selectedFile.totalRows.toLocaleString()} rows
                        </p>
                      </div>
                    )}
                </div>

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
                          Target Date Format
                        </p>
                        {selectedFile.dateConfigs.map((dc) => (
                          <div key={dc.col} className="date-format-row">
                            <span>{dc.col}</span>
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
                        ))}
                      </div>
                    )}
                    <p className="tab-placeholder-note">
                      Column config is stored locally will be sent as live_updates once the standardize API is wired in.
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
                    <p className="tab-placeholder-note">
                      Filter config is stored locally will call the filter API once available.
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
                    >
                      Detect Granularity
                    </button>
                    {selectedFile.granularityConfig.detected && (
                      <span className="granularity-detected-badge">
                        Detected: {selectedFile.granularityConfig.detected}
                      </span>
                    )}

                    {selectedFile.granularityConfig.detected && (
                      <>
                        {selectedFile.columns.map((col) => (
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
                      </>
                    )}
                    <p className="tab-placeholder-note">
                      Granularity detection is a local placeholder will call the real detect/modify API once available.
                    </p>
                  </>
                )}

                <div className="mapping-actions">
                  <button className="mapping-btn secondary">Back</button>
                  <button className="mapping-btn primary" disabled={!canProceed}>
                    Proceed
                  </button>
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