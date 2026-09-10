import { useState, useEffect } from 'react';
import { v2ListFiles, v2BuildArd, problemMessage, ensureWorkflow } from '../../services/api.js';
import './Datastitching.css';

const DEFAULT_TABS = [
  { id: 'hcp', title: 'HCP-Level ARD', grain: 'hcp', removable: false, editing: false },
  { id: 'dma', title: 'DMA-Level ARD', grain: 'dma', removable: false, editing: false },
  { id: 'custom', title: 'Create Custom ARD', grain: 'custom', removable: false, editing: false },
];

const CUSTOM_GRAIN_OPTIONS = [
  { value: 'geo', label: 'Geo-Level ARD' },
  { value: 'zip', label: 'ZIP-Level ARD' },
  { value: 'national', label: 'National-Level ARD' },
];

function makeEmptyStep() {
  return {
    leftFile: '', rightFile: '', joinType: 'left',
    leftIdKey: '', rightIdKey: '', leftDateKey: '', rightDateKey: '',
  };
}

function makeDefaultDraft() {
  return {
    customGrain: 'geo',
    selectedFiles: new Set(),
    steps: [],
    joinCards: [],
    finalRowCount: null,
    finalColumnCount: null,
    isSavingPipeline: false,
    pipelineError: null,
    isGenerating: false,
    generateError: null,
    activePreview: null, // { cardIndex, data, isLoading, error }
  };
}

let tabCounter = 1;

function Datastitching() {
  const [workflowId, setWorkflowId] = useState(null);
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [tabs, setTabs] = useState(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState('hcp');
  const [drafts, setDrafts] = useState(() => ({
    hcp: makeDefaultDraft(), dma: makeDefaultDraft(), custom: makeDefaultDraft(),
  }));

  // Modal now edits exactly ONE step at a time.
  const [modal, setModal] = useState(null); // { mode: 'add'|'edit', stepIndex, step }

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const draft = drafts[activeTabId] || makeDefaultDraft();

  const setDraft = (updates) =>
    setDrafts((prev) => ({ ...prev, [activeTabId]: { ...prev[activeTabId], ...updates } }));

  const updateDraft = (updaterFn) =>
    setDrafts((prev) => ({ ...prev, [activeTabId]: updaterFn(prev[activeTabId]) }));

  const targetGrain = activeTab.grain === 'custom' ? draft.customGrain : activeTab.grain;
  const grainLabel = activeTab.grain === 'custom'
    ? CUSTOM_GRAIN_OPTIONS.find((g) => g.value === draft.customGrain)?.label.replace(' ARD', '')
    : activeTab.title.replace(' ARD', '');

  const loadEverything = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const id = await ensureWorkflow();
      setWorkflowId(id);
      const filesData = await v2ListFiles(id);
      setFiles((filesData.items || []).filter((f) => f.kind !== 'ard'));
    } catch (err) {
      setLoadError(problemMessage(err, 'Could not load this workflow.'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadEverything(); }, []);

  const addNewArdTab = () => {
    tabCounter += 1;
    const newId = `ard-${Date.now()}`;
    setTabs((prev) => [
      ...prev,
      { id: newId, title: `New ARD ${tabCounter}`, grain: 'custom', removable: true, editing: true },
    ]);
    setDrafts((prev) => ({ ...prev, [newId]: makeDefaultDraft() }));
    setActiveTabId(newId);
  };

  const startRenameTab = (tabId, e) => {
    e.stopPropagation();
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, editing: true } : t)));
  };

  const finishRenameTab = (tabId, newTitle) => {
    setTabs((prev) => prev.map((t) => (
      t.id === tabId ? { ...t, title: newTitle.trim() || t.title, editing: false } : t
    )));
  };

  const removeTab = (tabId, e) => {
    e.stopPropagation();
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    if (activeTabId === tabId) setActiveTabId('hcp');
  };

  const toggleFile = (filename) => {
    const next = new Set(draft.selectedFiles);
    if (next.has(filename)) next.delete(filename);
    else next.add(filename);
    setDraft({ selectedFiles: next });
  };

  const selectedFileList = files.filter((f) => draft.selectedFiles.has(f.filename));

  const validateStep = (step) => {
    if (!step.leftFile || !step.rightFile) {
      return 'Choose both a left and right dataset.';
    }
    if (!step.leftIdKey || !step.rightIdKey) {
      return 'An ID key is required on both sides.';
    }
    if (Boolean(step.leftDateKey) !== Boolean(step.rightDateKey)) {
      return 'Pair the date key on both sides, or leave both empty.';
    }
    return null;
  };

  const payloadFor = (steps) => ({
    steps: steps.map((s) => ({
      left_file: s.leftFile,
      right_file: s.rightFile,
      left_key: s.leftDateKey ? [s.leftIdKey, s.leftDateKey] : [s.leftIdKey],
      right_key: s.rightDateKey ? [s.rightIdKey, s.rightDateKey] : [s.rightIdKey],
      join_type: s.joinType,
    })),
    target_grain: targetGrain,
  });

  // Re-runs the whole pipeline (dry run) for a given steps array and turns
  // the result into joinCards — used after add/edit/delete so the cards
  // and final row/column counts always reflect what's really configured.
  const rebuildCardsFromSteps = async (steps) => {
    if (steps.length === 0) {
      setDraft({ steps: [], joinCards: [], finalRowCount: null, finalColumnCount: null, activePreview: null });
      return true;
    }
    setDraft({ isSavingPipeline: true, pipelineError: null });
    try {
      const data = await v2BuildArd(workflowId, payloadFor(steps), { dryRun: true });
      const cards = (data.lineage?.steps_executed || []).map((s, i) => ({
        step: s.step,
        left: s.left,
        right: s.right,
        join: s.join,
        leftIdKey: steps[i]?.leftIdKey,
        rightIdKey: steps[i]?.rightIdKey,
        rows_in: s.rows_in ?? 0,
        rows_out: s.rows_out ?? 0,
      }));
      setDraft({
        steps,
        joinCards: cards,
        finalRowCount: data.row_count ?? 0,
        finalColumnCount: data.columns?.length ?? 0,
        isSavingPipeline: false,
        activePreview: null,
      });
      return true;
    } catch (err) {
      setDraft({
        isSavingPipeline: false,
        pipelineError: {
          title: problemMessage(err, 'Stitching failed'),
          errors: err.errors?.length ? err.errors : [{ message: problemMessage(err) }],
        },
      });
      return false;
    }
  };

  // ---- Modal open/close for a single step ----
  const openAddJoinModal = () => {
    if (draft.selectedFiles.size === 0) return;
    setModal({ mode: 'add', stepIndex: draft.steps.length, step: makeEmptyStep(), error: null });
  };

  const openEditJoinModal = (cardIndex) => {
    setModal({ mode: 'edit', stepIndex: cardIndex, step: { ...draft.steps[cardIndex] }, error: null });
  };

  const handleModalStepChange = (updates) => {
    setModal((prev) => ({ ...prev, step: { ...prev.step, ...updates } }));
  };

  const handleModalDone = async () => {
    const err = validateStep(modal.step);
    if (err) {
      setModal((prev) => ({ ...prev, error: err }));
      return;
    }
    const newSteps = modal.mode === 'add'
      ? [...draft.steps, modal.step]
      : draft.steps.map((s, i) => (i === modal.stepIndex ? modal.step : s));

    const ok = await rebuildCardsFromSteps(newSteps);
    if (ok) setModal(null);
    else setModal((prev) => ({ ...prev, error: 'See error below  pipeline could not be validated.' }));
  };

  const handleDeleteJoin = async (cardIndex) => {
    const newSteps = draft.steps.filter((_, i) => i !== cardIndex);
    await rebuildCardsFromSteps(newSteps);
  };

  const handleCardPreview = async (cardIndex) => {
    if (draft.activePreview?.cardIndex === cardIndex && !draft.activePreview.isLoading) {
      setDraft({ activePreview: null });
      return;
    }
    setDraft({ activePreview: { cardIndex, data: null, isLoading: true, error: null } });
    try {
      const truncatedSteps = draft.steps.slice(0, cardIndex + 1);
      const data = await v2BuildArd(workflowId, payloadFor(truncatedSteps), { dryRun: true });
      updateDraft((current) => {
        if (current.activePreview?.cardIndex !== cardIndex) return current;
        return { ...current, activePreview: { cardIndex, data, isLoading: false, error: null } };
      });
    } catch (err) {
      updateDraft((current) => {
        if (current.activePreview?.cardIndex !== cardIndex) return current;
        return { ...current, activePreview: { cardIndex, data: null, isLoading: false, error: problemMessage(err) } };
      });
    }
  };

  const handleGenerate = async () => {
    setDraft({ generateError: null, isGenerating: true });
    try {
      await v2BuildArd(workflowId, payloadFor(draft.steps), { dryRun: false });
      setDraft(makeDefaultDraft());
    } catch (err) {
      setDraft({
        isGenerating: false,
        generateError: {
          title: problemMessage(err, 'Stitching failed'),
          errors: err.errors?.length ? err.errors : [{ message: problemMessage(err) }],
        },
      });
      return;
    }
    setDraft({ isGenerating: false });
  };

  const previewedCard = draft.activePreview ? draft.joinCards[draft.activePreview.cardIndex] : null;

  return (
    <div className="stitching-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Data Stitching &amp; ARD Creation</p>
          <p className="page-header-subtitle">Join your mapped files into analytic record datasets</p>
        </div>
        <button className="new-ard-btn" onClick={addNewArdTab}>+ Add New ARD</button>
      </div>

      {isLoading && <p className="stitching-empty">Loading...</p>}

      {!isLoading && loadError && (
        <div className="stitching-error-banner">
          <p className="error-title">Couldn't load this workflow</p>
          <p>{loadError}</p>
        </div>
      )}

      {!isLoading && !loadError && (
        <div className="stitching-card">
          {/* ---- Tab bar ---- */}
          <div className="grain-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`grain-tab${activeTabId === t.id ? ' active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
                onDoubleClick={(e) => t.removable && startRenameTab(t.id, e)}
                role="button"
                tabIndex={0}
              >
                {t.editing ? (
                  <input
                    className="tab-rename-input"
                    defaultValue={t.title}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => finishRenameTab(t.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  />
                ) : (
                  <>
                    {t.title}
                    {t.removable && (
                      <span className="tab-remove-x" onClick={(e) => removeTab(t.id, e)}>✕</span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {activeTab.grain === 'custom' && (
            <select
              className="custom-grain-select"
              value={draft.customGrain}
              onChange={(e) => setDraft({ customGrain: e.target.value })}
            >
              {CUSTOM_GRAIN_OPTIONS.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          )}

          {/* ---- Source files ---- */}
          <div className="source-files-card">
            <p className="section-heading">Source Files</p>
            <p className="section-desc">
              Select the mapped source files to include in this <strong>{grainLabel}</strong> ARD pipeline:
            </p>
            <div className="file-checkbox-grid">
              {files.map((f) => (
                <label key={f.filename} className={`file-checkbox-card${draft.selectedFiles.has(f.filename) ? ' selected' : ''}`}>
                  <input type="checkbox" checked={draft.selectedFiles.has(f.filename)} onChange={() => toggleFile(f.filename)} />
                  <div>
                    <p className="file-checkbox-name">{f.filename}</p>
                    <p className="file-checkbox-meta">{f.columns?.length ?? 0} columns</p>
                  </div>
                </label>
              ))}
            </div>
            <div className="source-files-footer">
              <span>Mapping file and population universe files included automatically</span>
              <span>{draft.selectedFiles.size} file(s) active</span>
            </div>
          </div>

          {/* ---- Current Joins ---- */}
          <div className="current-joins-card">
            <p className="section-heading">
              Current Joins
              {draft.joinCards.length > 0 && (
                <span className="heading-note" style={{ marginLeft: '0.6rem' }}>
                  {(draft.finalRowCount ?? 0).toLocaleString()} rows · {draft.finalColumnCount ?? 0} columns
                </span>
              )}
            </p>

            {draft.pipelineError && (
              <div className="stitching-error-banner">
                <p className="error-title">{draft.pipelineError.title}</p>
                {draft.pipelineError.errors.map((e, i) => <p key={i}>{e.message}</p>)}
              </div>
            )}

            {draft.joinCards.length === 0 ? (
              <p className="stitching-empty">
                No joins configured yet click "Configure Join Pipeline" below to get started.
              </p>
            ) : (
              draft.joinCards.map((card, i) => (
                <div key={i} className={`join-summary-card${draft.activePreview?.cardIndex === i ? ' active' : ''}`}>
                  <div className="join-summary-header">
                    <span className="step-card-title">Join {card.step} {card.join === 'left' ? 'Left Join' : 'Inner Join'}</span>
                    <span className="join-summary-rows">
                      {card.rows_in.toLocaleString()} → {' '}
                      <span className={card.rows_out < card.rows_in ? 'rows-dropped' : ''}>{card.rows_out.toLocaleString()}</span> rows
                    </span>
                  </div>
                  <p className="join-summary-desc">
                    Joining <strong>{card.left}</strong> on <code>{card.leftIdKey}</code> with{' '}
                    <strong>{card.right}</strong> on <code>{card.rightIdKey}</code>
                  </p>
                  <div className="join-summary-actions">
                    <button className="preview-btn" onClick={() => handleCardPreview(i)}>
                      {draft.activePreview?.cardIndex === i ? 'Hide Preview' : 'See Preview'}
                    </button>
                    <button className="edit-btn" onClick={() => openEditJoinModal(i)}>Edit</button>
                    <button className="delete-btn" onClick={() => handleDeleteJoin(i)}>Delete</button>
                  </div>
                </div>
              ))
            )}
          </div>

          {draft.selectedFiles.size === 0 && (
            <p className="step-error-text">Select at least one source file above first.</p>
          )}
          {draft.generateError && (
            <div className="stitching-error-banner">
              <p className="error-title">{draft.generateError.title}</p>
              {draft.generateError.errors.map((e, i) => <p key={i}>{e.message}</p>)}
            </div>
          )}

          {/* ---- Two-column: action buttons (left) | preview panel (right) ---- */}
          <div className="stitch-two-part">
            <div className="stitch-part-actions">
              <button className="add-step-btn" onClick={openAddJoinModal}>
                {draft.joinCards.length > 0 ? '+ Add New Join' : '+ Configure Join Pipeline'}
              </button>
              <button
                className="execute-btn"
                onClick={handleGenerate}
                disabled={draft.joinCards.length === 0 || draft.isGenerating}
                title={draft.joinCards.length === 0 ? 'Add at least one join first' : undefined}
              >
                {draft.isGenerating ? 'Generating...' : `Generate ${grainLabel} ARD`}
              </button>
            </div>

            <div className="preview-panel">
              {!draft.activePreview ? (
                <div className="preview-placeholder">
                  <p className="preview-placeholder-title">No Preview Yet</p>
                  <p className="preview-placeholder-desc">
                    Click <strong>See Preview</strong> on any join step above to see its result here.
                  </p>
                </div>
              ) : (
                <>
                  {previewedCard && (
                    <p className="preview-panel-heading">
                      Step {previewedCard.step} result — {previewedCard.left} + {previewedCard.right}
                    </p>
                  )}
                  {draft.activePreview.isLoading && <p className="stitching-empty">Loading preview...</p>}
                  {draft.activePreview.error && <p className="step-error-text">{draft.activePreview.error}</p>}
                  {draft.activePreview.data && (
                    <>
                      <div className="sample-table-scroll">
                        <table className="sample-table">
                          <thead>
                            <tr>{(draft.activePreview.data.columns || []).map((c) => <th key={c}>{c}</th>)}</tr>
                          </thead>
                          <tbody>
                            {(draft.activePreview.data.preview || []).slice(0, 15).map((row, ri) => (
                              <tr key={ri}>
                                {(draft.activePreview.data.columns || []).map((c) => (
                                  <td key={c}>{row[c] === null || row[c] === undefined ? '—' : row[c]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="sample-count-line">
                        {(draft.activePreview.data.row_count ?? 0).toLocaleString()} rows · {(draft.activePreview.data.columns || []).length} columns
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <SingleJoinModal
          files={files}
          selectedFileList={selectedFileList}
          grainLabel={grainLabel}
          mode={modal.mode}
          stepIndex={modal.stepIndex}
          existingSteps={draft.steps}
          step={modal.step}
          error={modal.error}
          isSaving={draft.isSavingPipeline}
          onChange={handleModalStepChange}
          onDone={handleModalDone}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ─── Modal: configure exactly ONE join step (add or edit) ──────────────────
function SingleJoinModal({ files, selectedFileList, grainLabel, mode, stepIndex, existingSteps, step, error, isSaving, onChange, onDone, onClose }) {
  const columnsForDataset = (name) => files.find((f) => f.filename === name)?.columns || null;

  // Exclude files already used by OTHER steps (not this one), so the same
  // source file can't be picked twice across the pipeline. Prior steps'
  // results are offered as chaining options.
  const usedFilenames = (side) => {
    const used = new Set();
    existingSteps.forEach((s, i) => {
      if (i === stepIndex) return; // editing this step — don't exclude its own current values
      if (s.leftFile) used.add(s.leftFile);
      if (s.rightFile) used.add(s.rightFile);
    });
    return used;
  };

  const datasetOptions = (side) => {
    const priorResults = Array.from({ length: stepIndex }, (_, i) => `Step ${i + 1} Result`);
    const used = usedFilenames(side);
    const available = selectedFileList.map((f) => f.filename).filter((name) => !used.has(name));
    return [...available, ...priorResults];
  };

  const leftCols = columnsForDataset(step.leftFile);
  const rightCols = columnsForDataset(step.rightFile);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="create-ard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-ard-header">
          <div>
            <p className="create-ard-title">{mode === 'edit' ? 'Edit Join' : 'Add New Join'}</p>
            <p className="create-ard-subtitle">Building a {grainLabel} ARD from {selectedFileList.length} selected file(s)</p>
          </div>
          <button className="create-ard-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="create-ard-body">
          <div className="step-card">
            <div className="step-card-header">
              <span className="step-card-title">Step {stepIndex + 1} Join</span>
            </div>

            <div className="step-grid-2">
              <div>
                <p className="step-field-label">Left Dataset</p>
                <select className="step-select" value={step.leftFile} onChange={(e) => onChange({ leftFile: e.target.value, leftIdKey: '', leftDateKey: '' })}>
                  <option value="">Select...</option>
                  {datasetOptions('left').map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <p className="step-field-label">Right Dataset</p>
                <select className="step-select" value={step.rightFile} onChange={(e) => onChange({ rightFile: e.target.value, rightIdKey: '', rightDateKey: '' })}>
                  <option value="">Select...</option>
                  {datasetOptions('right').map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '0.6rem' }}>
              <p className="step-field-label">Join Strategy</p>
              <select className="step-select" value={step.joinType} onChange={(e) => onChange({ joinType: e.target.value })}>
                <option value="left">Left Join (Keep all {step.leftFile || 'left dataset'} rows)</option>
                <option value="inner">Inner Join (Keep only matching rows)</option>
              </select>
            </div>

            <div className="step-grid-2">
              <div className="step-key-block">
                <p className="step-field-label">1. ID Key {step.leftFile && `(${step.leftFile})`}</p>
                {leftCols ? (
                  <select className="step-select" value={step.leftIdKey} onChange={(e) => onChange({ leftIdKey: e.target.value })}>
                    <option value="">Select column...</option>
                    {leftCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input type="text" className="step-input" placeholder="e.g. npi" value={step.leftIdKey} onChange={(e) => onChange({ leftIdKey: e.target.value })} />
                )}
                <p className="step-field-label" style={{ marginTop: '0.5rem' }}>2. Date Key</p>
                {leftCols ? (
                  <select className="step-select" value={step.leftDateKey} onChange={(e) => onChange({ leftDateKey: e.target.value })}>
                    <option value="">Select Date (Optional)</option>
                    {leftCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input type="text" className="step-input" placeholder="Select Date (Optional)" value={step.leftDateKey} onChange={(e) => onChange({ leftDateKey: e.target.value })} />
                )}
              </div>

              <div className="step-key-block">
                <p className="step-field-label">1. ID Key {step.rightFile && `(${step.rightFile})`}</p>
                {rightCols ? (
                  <select className="step-select" value={step.rightIdKey} onChange={(e) => onChange({ rightIdKey: e.target.value })}>
                    <option value="">Select column...</option>
                    {rightCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input type="text" className="step-input" placeholder="e.g. npi_id" value={step.rightIdKey} onChange={(e) => onChange({ rightIdKey: e.target.value })} />
                )}
                <p className="step-field-label" style={{ marginTop: '0.5rem' }}>2. Date Key</p>
                {rightCols ? (
                  <select className="step-select" value={step.rightDateKey} onChange={(e) => onChange({ rightDateKey: e.target.value })}>
                    <option value="">Select Date (Optional)</option>
                    {rightCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input type="text" className="step-input" placeholder="Select Date (Optional)" value={step.rightDateKey} onChange={(e) => onChange({ rightDateKey: e.target.value })} />
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="stitching-error-banner">
              <p className="error-title">{error}</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn primary" onClick={onDone} disabled={isSaving}>
            {isSaving ? 'Checking...' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Datastitching;