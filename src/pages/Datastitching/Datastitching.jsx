import { useState, useEffect } from 'react';
import { v2ListFiles, v2BuildArd, problemMessage, ensureWorkflow } from '../../services/api.js';
import './Datastitching.css';

const DEFAULT_TABS = [
  { id: 'hcp', title: 'HCP-Level ARD', grain: 'hcp', removable: false, editing: false },
  { id: 'dma', title: 'DMA-Level ARD', grain: 'dma', removable: false, editing: false },
];

// The five join_type values the build endpoint accepts. Labels deliberately
// carry no file name — the guide warns that a label like "Left Join (Keep all
// crosswalk.csv rows)" is ambiguous — and only `value` is ever sent.
const JOIN_TYPES = [
  { value: 'left', label: 'Left Join | keep every left row' },
  { value: 'inner', label: 'Inner Join | keep only rows matching on both sides' },
  { value: 'right', label: 'Right Join | keep every right row' },
  { value: 'outer', label: 'Outer Join | keep every row from both sides' },
  { value: 'cross', label: 'Cross Join | every combination, no keys' },
];

const JOIN_LABELS = Object.fromEntries(
  JOIN_TYPES.map((j) => [j.value, j.label.split(' | ')[0]])
);

const CUSTOM_GRAIN_OPTIONS = [
  { value: 'geo', label: 'Geo-Level ARD' },
  { value: 'zip', label: 'ZIP-Level ARD' },
  { value: 'national', label: 'National-Level ARD' },
];

function makeEmptyStep() {
  return {
    leftFile: '', rightFile: '', joinType: 'left',
    // Positional pairs: keyPairs[n].left joins to keyPairs[n].right. A date key
    // is simply a second pair rather than a dedicated field.
    keyPairs: [{ left: '', right: '' }],
  };
}

function makeDefaultDraft() {
  return {
    customGrain: 'geo',
    // Blank means "use the grain-based default". Kept per tab so each ARD in
    // the workflow can be named separately.
    ardName: '',
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
    generatedArd: null,  // the committed build: { filename, version, row_count, columns, preview }
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
    hcp: makeDefaultDraft(), dma: makeDefaultDraft(),
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
    if (step.joinType === 'cross') return null; // cross takes no keys

    const pairs = step.keyPairs || [];
    const filled = pairs.filter((p) => p.left && p.right);
    if (!filled.length) {
      return 'At least one key pair is required.';
    }
    // The API pairs keys positionally and rejects a count mismatch, so a
    // half-filled row has to be caught before it is sent.
    if (pairs.some((p) => Boolean(p.left) !== Boolean(p.right))) {
      return 'Every key pair needs a column on both sides, or remove the row.';
    }
    const leftKeys = filled.map((p) => p.left);
    if (new Set(leftKeys).size !== leftKeys.length) {
      return 'The same left column is used in more than one key pair.';
    }
    return null;
  };

  // Shown as the placeholder and used when the field is left blank. Matches
  // what the API would pick on its own, so the two never disagree.
  const defaultArdName = `__ard_${targetGrain}__.csv`;

  const payloadFor = (steps) => ({
    steps: steps.map((s) => {
      const base = {
        left_file: s.leftFile,
        right_file: s.rightFile,
        join_type: s.joinType,
      };
      // Omit the key arrays entirely on a cross join; the other four 422 with
      // keys_missing without them.
      if (s.joinType === 'cross') return base;
      const filled = (s.keyPairs || []).filter((p) => p.left && p.right);
      return {
        ...base,
        left_key: filled.map((p) => p.left),
        right_key: filled.map((p) => p.right),
      };
    }),
    target_grain: targetGrain,
    // Only sent when the user typed one; otherwise the API applies its own
    // grain-based default. A name without .csv gets the extension server-side.
    ...(draft.ardName.trim() ? { output: draft.ardName.trim() } : {}),
  });

  // Re-runs the whole pipeline (dry run) for a given steps array and turns
  // the result into joinCards — used after add/edit/delete so the cards
  // and final row/column counts always reflect what's really configured.
  const rebuildCardsFromSteps = async (steps) => {
    if (steps.length === 0) {
      setDraft({ steps: [], joinCards: [], finalRowCount: null, finalColumnCount: null, activePreview: null, generatedArd: null });
      return true;
    }
    setDraft({ isSavingPipeline: true, pipelineError: null });
    try {
      const data = await v2BuildArd(workflowId, payloadFor(steps), { dryRun: true });
      const cards = (data.lineage?.steps_executed || []).map((s) => ({
        step: s.step,
        left: s.left,
        right: s.right,
        join: s.join,
        // The lineage already reports the resolved key names, which is the
        // authoritative answer once the server has matched them case-insensitively.
        keys: s.keys || [],
        rows_in: s.rows_in ?? 0,
        rows_out: s.rows_out ?? 0,
        // What this step produced. A later step joining on "Step N Result"
        // needs these to offer real key columns, and they cannot be derived
        // client-side: a name clash is suffixed ("month_step1") and duplicate
        // right-hand keys are collapsed before the join.
        columns: s.columns || [],
      }));
      setDraft({
        steps,
        joinCards: cards,
        finalRowCount: data.row_count ?? 0,
        finalColumnCount: data.columns?.length ?? 0,
        isSavingPipeline: false,
        activePreview: null,
        // The steps changed, so the last build no longer describes them.
        generatedArd: null,
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
    setDraft({ generateError: null, isGenerating: true, generatedArd: null, activePreview: null });
    try {
      const built = await v2BuildArd(workflowId, payloadFor(draft.steps), { dryRun: false });
      // Keep the steps and cards rather than resetting the draft: the user
      // needs to see what produced this ARD, and may want to adjust and
      // rebuild. The preview panel picks `built` up via shownPreview.
      setDraft({ generatedArd: built });
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

  // "Step N Result" is a virtual name - it is never a dataset, so it is not in
  // `files`. The dry run reports what each step produced, so the modal can look
  // its columns up here instead of falling back to a blind text box.
  const stepResultColumns = Object.fromEntries(
    draft.joinCards
      .filter((card) => (card.columns || []).length)
      .map((card) => [`Step ${card.step} Result`, card.columns])
  );

  const previewedCard = draft.activePreview ? draft.joinCards[draft.activePreview.cardIndex] : null;

  // The panel shows an explicitly requested step preview when one is open,
  // otherwise the ARD just generated. Same table either way.
  const shownPreview = draft.activePreview
    ? {
        heading: previewedCard
          ? `Step ${previewedCard.step} result — ${previewedCard.left} + ${previewedCard.right}`
          : null,
        isLoading: draft.activePreview.isLoading,
        error: draft.activePreview.error,
        data: draft.activePreview.data,
      }
    : draft.generatedArd
    ? {
        heading: `Generated ${draft.generatedArd.filename}` +
          (draft.generatedArd.version ? ` — version ${draft.generatedArd.version}` : ''),
        isLoading: false,
        error: null,
        data: draft.generatedArd,
        isGenerated: true,
      }
    : null;

  // problem+json errors carry a 1-based `step`; use it to mark the card that
  // failed instead of leaving the user to match a banner against a list.
  const failedSteps = new Set(
    (draft.pipelineError?.errors || [])
      .concat(draft.generateError?.errors || [])
      .map((e) => e.step)
      .filter((n) => typeof n === 'number')
  );

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
            <div className="current-joins-header">
              <p className="section-heading">
                Current Joins
                {draft.joinCards.length > 0 && (
                  <span className="heading-note" style={{ marginLeft: '0.6rem' }}>
                    {(draft.finalRowCount ?? 0).toLocaleString()} rows · {draft.finalColumnCount ?? 0} columns
                  </span>
                )}
              </p>
              <button
                className="add-step-btn"
                onClick={openAddJoinModal}
                disabled={draft.selectedFiles.size === 0}
                title={draft.selectedFiles.size === 0 ? 'Select at least one source file above first' : undefined}
              >
                + Add Join
              </button>
            </div>

            {draft.pipelineError && (
              <div className="stitching-error-banner">
                <p className="error-title">{draft.pipelineError.title}</p>
                {draft.pipelineError.errors.map((e, i) => <p key={i}>{e.message}</p>)}
              </div>
            )}

            {draft.joinCards.length === 0 ? (
              <p className="stitching-empty">
                {draft.selectedFiles.size === 0
                  ? 'Select at least one source file above, then click "+ Add Join".'
                  : 'No joins configured yet click "+ Add Join" above to get started.'}
              </p>
            ) : (
              draft.joinCards.map((card, i) => (
                <div
                  key={i}
                  className={`join-summary-card${draft.activePreview?.cardIndex === i ? ' active' : ''}${failedSteps.has(card.step) ? ' has-error' : ''}`}
                >
                  <div className="join-summary-header">
                    <span className="step-card-title">Join {card.step} {JOIN_LABELS[card.join] || card.join}</span>
                    <span className="join-summary-rows">
                      {card.rows_in.toLocaleString()} → {' '}
                      <span className={card.rows_out < card.rows_in ? 'rows-dropped' : ''}>{card.rows_out.toLocaleString()}</span> rows
                    </span>
                  </div>
                  <p className="join-summary-desc">
                    {card.join === 'cross' ? (
                      <>
                        Every combination of <strong>{card.left}</strong> and{' '}
                        <strong>{card.right}</strong> — no keys
                      </>
                    ) : (
                      <>
                        Joining <strong>{card.left}</strong> with{' '}
                        <strong>{card.right}</strong> on{' '}
                        {(card.keys || []).map((k, ki) => (
                          <span key={k}>
                            {ki > 0 && ' + '}
                            <code>{k}</code>
                          </span>
                        ))}
                      </>
                    )}
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

          {/* ---- Preview, then the generate action beneath it ---- */}
          <div className="stitch-result">
            <div className="preview-panel">
              {!shownPreview ? (
                <div className="preview-placeholder">
                  <p className="preview-placeholder-title">No Preview Yet</p>
                  <p className="preview-placeholder-desc">
                    Click <strong>See Preview</strong> on any join step above to see its result here.
                  </p>
                </div>
              ) : (
                <>
                  {shownPreview.heading && (
                    <p className={`preview-panel-heading${shownPreview.isGenerated ? ' is-generated' : ''}`}>
                      {shownPreview.heading}
                    </p>
                  )}
                  {shownPreview.isLoading && <p className="stitching-empty">Loading preview...</p>}
                  {shownPreview.error && <p className="step-error-text">{shownPreview.error}</p>}
                  {shownPreview.data && (
                    <>
                      <div className="sample-table-scroll">
                        <table className="sample-table">
                          <thead>
                            <tr>{(shownPreview.data.columns || []).map((c) => <th key={c}>{c}</th>)}</tr>
                          </thead>
                          <tbody>
                            {(shownPreview.data.preview || []).slice(0, 15).map((row, ri) => (
                              <tr key={ri}>
                                {(shownPreview.data.columns || []).map((c) => (
                                  <td key={c}>{row[c] === null || row[c] === undefined ? '—' : row[c]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="sample-count-line">
                        {(shownPreview.data.row_count ?? 0).toLocaleString()} rows · {(shownPreview.data.columns || []).length} columns
                      </p>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="stitch-generate-actions">
              <div className="ard-name-field">
                <label className="step-field-label" htmlFor="ard-name">
                  Resulting ARD Dataset Name
                </label>
                <input
                  id="ard-name"
                  type="text"
                  className="step-input"
                  value={draft.ardName}
                  onChange={(e) => setDraft({ ardName: e.target.value })}
                  placeholder={defaultArdName}
                />
              </div>
              <button
                className="execute-btn"
                onClick={handleGenerate}
                disabled={draft.joinCards.length === 0 || draft.isGenerating}
                title={draft.joinCards.length === 0 ? 'Add at least one join first' : undefined}
              >
                {draft.isGenerating ? 'Generating...' : 'Generate ARD'}
              </button>
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
          stepResultColumns={stepResultColumns}
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
function SingleJoinModal({ files, selectedFileList, grainLabel, mode, stepIndex, existingSteps, stepResultColumns = {}, step, error, isSaving, onChange, onDone, onClose }) {
  // A real dataset first, then a previous step's result. Returns null only when
  // neither is known yet - the first time a step is configured, before any dry
  // run has reported what it produces - and the key field falls back to free
  // text for that case rather than showing an empty dropdown.
  const columnsForDataset = (name) => {
    const dataset = files.find((f) => f.filename === name);
    if (dataset) return dataset.columns || null;
    const fromStep = stepResultColumns[name];
    return fromStep && fromStep.length ? fromStep : null;
  };

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

  const keyPairs = step.keyPairs || [{ left: '', right: '' }];

  const onChangeKeyPair = (pairIndex, patch) => {
    onChange({
      keyPairs: keyPairs.map((p, i) => (i === pairIndex ? { ...p, ...patch } : p)),
    });
  };

  const onAddKeyPair = () => {
    // Suggest the next unused left column, and the same name on the right when
    // it exists, so the common case needs no further clicks.
    const taken = keyPairs.map((p) => p.left);
    const nextLeft = (leftCols || []).find((c) => !taken.includes(c)) || '';
    const nextRight = (rightCols || []).find(
      (c) => c.toLowerCase() === String(nextLeft).toLowerCase()
    ) || '';
    onChange({ keyPairs: [...keyPairs, { left: nextLeft, right: nextRight }] });
  };

  const onRemoveKeyPair = (pairIndex) => {
    if (keyPairs.length <= 1) return; // one pair is the minimum
    onChange({ keyPairs: keyPairs.filter((_, i) => i !== pairIndex) });
  };

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
                <select className="step-select" value={step.leftFile} onChange={(e) => onChange({ leftFile: e.target.value, keyPairs: [{ left: '', right: '' }] })}>
                  <option value="">Select...</option>
                  {datasetOptions('left').map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <p className="step-field-label">Right Dataset</p>
                <select className="step-select" value={step.rightFile} onChange={(e) => onChange({ rightFile: e.target.value, keyPairs: (step.keyPairs || []).map((p) => ({ ...p, right: '' })) })}>
                  <option value="">Select...</option>
                  {datasetOptions('right').map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '0.6rem' }}>
              <p className="step-field-label">Join Strategy</p>
              <select className="step-select" value={step.joinType} onChange={(e) => onChange({ joinType: e.target.value })}>
                {JOIN_TYPES.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
              </select>
            </div>

            {step.joinType === 'cross' ? (
              <p className="step-hint-text">
                A cross join pairs every left row with every right row, so it takes no keys.
              </p>
            ) : (
              <>
                {/* Keys are positional pairs: the Nth left key joins to the Nth
                    right key. A date key is just another pair, so a crosswalk
                    that joins on the ID alone simply has one. */}
                {(step.keyPairs || []).map((pair, pairIndex) => (
                  <div className="step-grid-2" key={pairIndex}>
                    <div className="step-key-block">
                      <p className="step-field-label">
                        {pairIndex + 1}. Key {step.leftFile && `(${step.leftFile})`}
                      </p>
                      {leftCols ? (
                        <select
                          className="step-select"
                          value={pair.left}
                          onChange={(e) => onChangeKeyPair(pairIndex, { left: e.target.value })}
                        >
                          <option value="">Select column...</option>
                          {leftCols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text" className="step-input" placeholder="e.g. npi"
                          value={pair.left}
                          onChange={(e) => onChangeKeyPair(pairIndex, { left: e.target.value })}
                        />
                      )}
                    </div>

                    <div className="step-key-block">
                      <p className="step-field-label">
                        {pairIndex + 1}. Key {step.rightFile && `(${step.rightFile})`}
                        {(step.keyPairs || []).length > 1 && (
                          <button
                            type="button"
                            className="step-key-remove"
                            onClick={() => onRemoveKeyPair(pairIndex)}
                            aria-label={`Remove key pair ${pairIndex + 1}`}
                          >&#10005;</button>
                        )}
                      </p>
                      {rightCols ? (
                        <select
                          className="step-select"
                          value={pair.right}
                          onChange={(e) => onChangeKeyPair(pairIndex, { right: e.target.value })}
                        >
                          <option value="">Select column...</option>
                          {rightCols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text" className="step-input" placeholder="e.g. npi_id"
                          value={pair.right}
                          onChange={(e) => onChangeKeyPair(pairIndex, { right: e.target.value })}
                        />
                      )}
                    </div>
                  </div>
                ))}

                <button type="button" className="step-key-add" onClick={onAddKeyPair}>
                  + Add key pair
                </button>
              </>
            )}
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