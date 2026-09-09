import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
// import { API_BASE_URL } from '../../config/apiConfig';
import './Workflows.css';

// Note: these values still map to the API's underlying `state` field
// (new/configured/running/complete/failed) — the filter/badge is just
// labeled "Stage" in the UI since that reads more naturally to users.
const STAGE_OPTIONS = ['new', 'configured', 'running', 'complete', 'failed'];

// TEMP: mock data standing in for GET /v1/workflows until the real API
// is ready. Shape matches the documented response exactly, so swapping
// back to the real fetch later should require no changes to the JSX below.
const INITIAL_MOCK_WORKFLOWS = [
  {
    id: 'mock-1',
    workflow_name: 'Q3 HCP Ingest',
    state: 'running',
    tag: 'finance',
    current_stage: 'Data Ingestion',
    current_route: '/data-ingestion',
    updated_at: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
  },
  {
    id: 'mock-2',
    workflow_name: 'West Region MMM',
    state: 'complete',
    tag: 'sales',
    current_stage: 'Optimization',
    current_route: '/data-ingestion',
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: 'mock-3',
    workflow_name: 'Docs capture b532a',
    state: 'new',
    tag: 'docs',
    current_stage: null,
    current_route: '/data-ingestion',
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
  {
    id: 'mock-4',
    workflow_name: 'East Region Model Refresh',
    state: 'failed',
    tag: null,
    current_stage: 'MMM Modelling',
    current_route: '/data-ingestion',
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  },
];

function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function Workflows() {
  const navigate = useNavigate();

  // TEMP: seeded from INITIAL_MOCK_WORKFLOWS instead of a real fetch.
  const [items, setItems] = useState(INITIAL_MOCK_WORKFLOWS);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState('');

  // CRUD modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState(null); // workflow object | null
  const [deletingWorkflow, setDeletingWorkflow] = useState(null); // workflow object | null

  // ── REAL API VERSION (commented out until backend is ready) ──────────
  //
  // const [nextCursor, setNextCursor] = useState(null);
  // const [isLoadingMore, setIsLoadingMore] = useState(false);
  //
  // const fetchWorkflows = useCallback(async (cursor = null, append = false) => {
  //   if (append) setIsLoadingMore(true);
  //   else setIsLoading(true);
  //   setLoadError(null);
  //
  //   try {
  //     const params = new URLSearchParams();
  //     if (searchQuery.trim()) params.set('q', searchQuery.trim());
  //     if (stageFilter) params.set('state', stageFilter);
  //     if (cursor) params.set('cursor', cursor);
  //
  //     const res = await fetch(`${API_BASE_URL}/v1/workflows?${params.toString()}`);
  //     if (!res.ok) throw new Error(`Failed to load workflows (${res.status})`);
  //     const data = await res.json();
  //
  //     setItems((prev) => (append ? [...prev, ...data.items] : data.items));
  //     setNextCursor(data.next_cursor || null);
  //   } catch (err) {
  //     setLoadError(err.message || 'Something went wrong loading workflows.');
  //   } finally {
  //     setIsLoading(false);
  //     setIsLoadingMore(false);
  //   }
  // }, [searchQuery, stageFilter]);
  //
  // useEffect(() => {
  //   const timeout = setTimeout(() => {
  //     fetchWorkflows();
  //   }, 300);
  //   return () => clearTimeout(timeout);
  //   // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [searchQuery, stageFilter]);
  //
  // const handleLoadMore = () => {
  //   if (nextCursor) fetchWorkflows(nextCursor, true);
  // };

  // TEMP: client-side filtering over the mock array, so the search box
  // and stage dropdown are still testable without a backend.
  const filteredItems = items.filter((wf) => {
    const matchesSearch = wf.workflow_name
      .toLowerCase()
      .includes(searchQuery.trim().toLowerCase());
    const matchesStage = !stageFilter || wf.state === stageFilter;
    return matchesSearch && matchesStage;
  });

  const handleResume = (workflow) => {
    navigate(workflow.current_route || '/data-ingestion');
  };

  // ── CREATE ─────────────────────────────────────────────────────────
  const handleCreated = (newWorkflow) => {
    setItems((prev) => [newWorkflow, ...prev]);
    setShowCreateModal(false);
  };

  // ── UPDATE ─────────────────────────────────────────────────────────
  const handleUpdated = (updatedWorkflow) => {
    setItems((prev) =>
      prev.map((wf) => (wf.id === updatedWorkflow.id ? { ...wf, ...updatedWorkflow } : wf))
    );
    setEditingWorkflow(null);
  };

  // ── DELETE ─────────────────────────────────────────────────────────
  const handleConfirmDelete = async () => {
    if (!deletingWorkflow) return;

    // ── REAL API VERSION (commented out until backend is ready) ──────
    //
    // try {
    //   const res = await fetch(`${API_BASE_URL}/v1/workflows/${deletingWorkflow.id}`, {
    //     method: 'DELETE',
    //   });
    //   if (!res.ok && res.status !== 204) {
    //     throw new Error(`Failed to delete workflow (${res.status})`);
    //   }
    // } catch (err) {
    //   // surface error, keep modal open
    //   return;
    // }

    // TEMP: remove locally instead of calling DELETE /v1/workflows/{id}
    setItems((prev) => prev.filter((wf) => wf.id !== deletingWorkflow.id));
    setDeletingWorkflow(null);
  };

  return (
    <div className="workflows-page">
      <div className="page-header">
        <div className="page-header-left">
          <div className="placeholder page-header-icon icon-placeholder">Icon</div>
          <div>
            <p className="page-header-title">Workflows</p>
            <p className="page-header-subtitle">
              View, resume, or start a new marketing mix modeling workflow
            </p>
          </div>
        </div>

        <button className="new-workflow-btn" onClick={() => setShowCreateModal(true)}>
          + New Workflow
        </button>
      </div>

      <div className="filter-bar">
        <input
          type="text"
          className="filter-bar-search"
          placeholder="Search workflows by name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className="filter-bar-select"
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">All stages</option>
          {STAGE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="workflows-loading">Loading workflows...</p>}

      {!isLoading && loadError && (
        <p className="workflows-error">Couldn't load workflows: {loadError}</p>
      )}

      {!isLoading && !loadError && filteredItems.length === 0 && (
        <p className="workflows-empty">
          No workflows match your search — try a different name or filter.
        </p>
      )}

      {!isLoading && !loadError && filteredItems.length > 0 && (
        <div className="workflow-list">
          {filteredItems.map((wf) => (
            <div key={wf.id} className="workflow-card">
              <div className="workflow-card-main">
                <div className="workflow-card-title-row">
                  <p className="workflow-card-title">{wf.workflow_name}</p>
                  <span className={`stage-badge ${wf.state}`}>
                    {wf.current_stage || 'Not started'}
                  </span>
                  {wf.tag && <span className="tag-badge">{wf.tag}</span>}
                </div>
                <p className="workflow-card-subtitle">
                  Status: {wf.state.charAt(0).toUpperCase() + wf.state.slice(1)}
                </p>
                <p className="workflow-card-updated">
                  Updated {formatRelativeTime(wf.updated_at)}
                </p>
              </div>

              <div className="workflow-card-actions">
                <button className="card-action-btn" onClick={() => setEditingWorkflow(wf)}>
                  Edit
                </button>
                <button
                  className="card-action-btn delete"
                  onClick={() => setDeletingWorkflow(wf)}
                >
                  Delete
                </button>
                <button className="resume-btn" onClick={() => handleResume(wf)}>
                  Resume
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PLACEHOLDER: "Load more" / cursor pagination re-enabled once the
          real API is wired back in — mock data has no pagination. */}

      {showCreateModal && (
        <WorkflowFormModal
          mode="create"
          onClose={() => setShowCreateModal(false)}
          onSaved={handleCreated}
        />
      )}

      {editingWorkflow && (
        <WorkflowFormModal
          mode="edit"
          initialWorkflow={editingWorkflow}
          onClose={() => setEditingWorkflow(null)}
          onSaved={handleUpdated}
        />
      )}

      {deletingWorkflow && (
        <div className="modal-overlay" onClick={() => setDeletingWorkflow(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <p className="modal-title">Delete Workflow</p>
            </div>
            <div className="modal-body">
              <p className="modal-body-text">
                Are you sure you want to delete{' '}
                <strong>{deletingWorkflow.workflow_name}</strong>? This can't be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="modal-btn secondary"
                onClick={() => setDeletingWorkflow(null)}
              >
                Cancel
              </button>
              <button className="modal-btn danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Handles both Create (POST /v1/workflows) and Edit (PATCH /v1/workflows/{id})
// since the form fields and validation are identical — only the submit
// behavior and pre-filled values differ.
function WorkflowFormModal({ mode, initialWorkflow, onClose, onSaved }) {
  const isEdit = mode === 'edit';

  const [workflowName, setWorkflowName] = useState(initialWorkflow?.workflow_name || '');
  const [tag, setTag] = useState(initialWorkflow?.tag || '');
  const [state, setState] = useState(initialWorkflow?.state || 'new');
  const [currentStage, setCurrentStage] = useState(initialWorkflow?.current_stage || '');
  const [currentRoute, setCurrentRoute] = useState(initialWorkflow?.current_route || '');
  const [nameError, setNameError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const validate = () => {
    const trimmed = workflowName.trim();
    if (!trimmed) {
      setNameError('Workflow name is required.');
      return false;
    }
    if (trimmed.length > 200) {
      setNameError('Workflow name must be 200 characters or fewer.');
      return false;
    }
    setNameError('');
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    if (isSaving) return; // guards against double-click / duplicate submits

    setIsSaving(true);
    setSaveError(null);

    // ── REAL API VERSION (commented out until backend is ready) ────────
    //
    // try {
    //   const url = isEdit
    //     ? `${API_BASE_URL}/v1/workflows/${initialWorkflow.id}`
    //     : `${API_BASE_URL}/v1/workflows`;
    //   const method = isEdit ? 'PATCH' : 'POST';
    //   const body = isEdit
    //     ? {
    //         workflow_name: workflowName.trim(),
    //         tag: tag.trim() || null,
    //         state,
    //         current_stage: currentStage.trim() || null,
    //         current_route: currentRoute.trim() || null,
    //         module_status: initialWorkflow?.module_status || {},
    //         state_data: initialWorkflow?.state_data || {},
    //       }
    //     : { workflow_name: workflowName.trim(), ...(tag.trim() ? { tag: tag.trim() } : {}) };
    //
    //   const res = await fetch(url, {
    //     method,
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(body),
    //   });
    //
    //   if (!res.ok) {
    //     const errBody = await res.json().catch(() => null);
    //     throw new Error(errBody?.detail || `Failed to save workflow (${res.status})`);
    //   }
    //
    //   const workflow = await res.json();
    //   onSaved(workflow);
    // } catch (err) {
    //   setSaveError(err.message || 'Something went wrong saving the workflow.');
    //   setIsSaving(false);
    // }

    // TEMP: fake create/update locally, shaped like the real API response,
    // with a short delay to mimic a network call.
    setTimeout(() => {
      if (isEdit) {
        onSaved({
          ...initialWorkflow,
          workflow_name: workflowName.trim(),
          tag: tag.trim() || null,
          state,
          current_stage: currentStage.trim() || null,
          current_route: currentRoute.trim() || null,
          // module_status and state_data intentionally left untouched —
          // not editable in this form.
          updated_at: new Date().toISOString(),
        });
      } else {
        onSaved({
          id: `mock-${Date.now()}`,
          workflow_name: workflowName.trim(),
          state: 'new',
          tag: tag.trim() || null,
          current_stage: null,
          current_route: '/data-ingestion',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      setIsSaving(false);
    }, 500);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <p className="modal-title">{isEdit ? 'Edit Workflow' : 'New Workflow'}</p>
        </div>

        <div className="modal-body">
          {saveError && <div className="modal-error-banner">{saveError}</div>}

          <div className="modal-section modal-grid-2">
            <div className="modal-field">
              <p className="modal-field-label">Workflow Name</p>
              <input
                type="text"
                className={`modal-input${nameError ? ' error' : ''}`}
                placeholder="e.g. Q3 HCP Ingest"
                value={workflowName}
                onChange={(e) => {
                  setWorkflowName(e.target.value);
                  if (nameError) setNameError('');
                }}
                maxLength={200}
                autoFocus
              />
              {nameError && <p className="modal-field-error">{nameError}</p>}
            </div>

            <div className="modal-field">
              <p className="modal-field-label">Tag (optional)</p>
              <input
                type="text"
                className="modal-input"
                placeholder="e.g. finance"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={100}
              />
            </div>
          </div>

          {isEdit && (
            <>
              <div className="modal-section">
                <p className="modal-section-heading">Workflow status</p>
                <div className="modal-grid-2">
                  <div className="modal-field">
                    <p className="modal-field-label">Stage</p>
                    <select
                      className="modal-input"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                    >
                      {STAGE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s.charAt(0).toUpperCase() + s.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="modal-field">
                    <p className="modal-field-label">Current Stage Label</p>
                    <input
                      type="text"
                      className="modal-input"
                      placeholder="e.g. Data Ingestion"
                      value={currentStage}
                      onChange={(e) => setCurrentStage(e.target.value)}
                    />
                  </div>
                </div>

                <p className="modal-field-label">Current Route</p>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="e.g. /ingestion"
                  value={currentRoute}
                  onChange={(e) => setCurrentRoute(e.target.value)}
                />
              </div>

            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Workflow'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Workflows;