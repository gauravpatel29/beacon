import { useEffect, useRef, useState } from 'react';
import {
  ApiError, createWorkflow, deleteWorkflow, forgetWorkflow,
  listWorkflows, selectWorkflow, storedWorkflowId, updateWorkflow,
} from '../../services/api.js';
import './WorkflowDialog.css';

/**
 * Create and manage workflows without leaving the screen you are on.
 *
 * Both used to mean a trip to Home, which threw away whatever you were doing
 * to rename something or start a second workflow. The two modes share this
 * component because they share the list: creating one lands you in it, and
 * managing one is the same list with actions on each row.
 *
 * `mode` is 'create' or 'manage'. `onSwitched` is called with the workflow the
 * caller should move to, so the sidebar owns navigation and this owns the list.
 */
function WorkflowDialog({ mode, onClose, onSwitched }) {
  const [workflows, setWorkflows] = useState([]);
  const [name, setName] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const nameRef = useRef(null);

  const activeId = storedWorkflowId();
  const isCreate = mode === 'create';

  const refresh = async () => {
    try {
      const data = await listWorkflows();
      setWorkflows(data.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.text : 'Could not load workflows.');
    }
  };

  useEffect(() => {
    if (isCreate) {
      nameRef.current?.focus();
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await listWorkflows();
        if (!cancelled) setWorkflows(data.items || []);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.text : 'Could not load workflows.');
      }
    })();
    // Guards against a response landing after the dialog is closed.
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const create = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSaving(true);
    setError(null);
    try {
      const workflow = await createWorkflow({ workflow_name: trimmed, state: 'new' });
      selectWorkflow(workflow.id);
      // A new workflow has nothing in it, so it opens at the start regardless
      // of where the user happened to be standing.
      onSwitched({ ...workflow, current_route: '/data-ingestion' });
    } catch (err) {
      setError(err instanceof ApiError ? err.text : 'Could not create the workflow.');
    } finally {
      setIsSaving(false);
    }
  };

  const rename = async (workflow) => {
    const trimmed = editingName.trim();
    if (!trimmed) return;
    setBusyId(workflow.id);
    try {
      await updateWorkflow(workflow.id, { workflow_name: trimmed, name: trimmed });
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.text : 'Could not rename the workflow.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (workflow) => {
    const label = workflow.workflow_name || workflow.name || 'this workflow';
    const ok = window.confirm(
      `Delete ${label}?\n\nIts uploaded files, ARDs and saved configuration go with it. `
      + 'This cannot be undone.'
    );
    if (!ok) return;
    setBusyId(workflow.id);
    try {
      await deleteWorkflow(workflow.id);
      // Deleting the one in use leaves the app pointing at something that is
      // gone, so the selection is dropped with it.
      if (workflow.id === activeId) forgetWorkflow();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.text : 'Could not delete the workflow.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="wf-dialog-backdrop" onMouseDown={onClose} role="presentation">
      {/* The click that closes is on the backdrop; stopping it here means a
          click inside the dialog does not close it. */}
      <div
        className="wf-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isCreate ? 'Create workflow' : 'Manage workflows'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wf-dialog-head">
          <h2>{isCreate ? 'New workflow' : 'Manage workflows'}</h2>
          <button type="button" className="wf-dialog-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <p className="wf-dialog-error" role="alert">{error}</p>}

        {isCreate ? (
          <form className="wf-dialog-body" onSubmit={create}>
            <label className="wf-field-label" htmlFor="wf-new-name">Workflow name</label>
            <input
              id="wf-new-name"
              ref={nameRef}
              className="wf-input"
              value={name}
              placeholder="e.g. Q3 promotional mix"
              onChange={(e) => setName(e.target.value)}
            />
            <div className="wf-dialog-actions">
              <button type="submit" className="wf-btn primary" disabled={!name.trim() || isSaving}>
                {isSaving ? 'Creating…' : 'Create workflow'}
              </button>
              <button type="button" className="wf-btn" onClick={onClose}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="wf-dialog-body">
            <div className="wf-list">
              {workflows.map((w) => {
                const label = w.workflow_name || w.name || 'Untitled workflow';
                const isActive = w.id === activeId;
                const busy = busyId === w.id;
                return (
                  <div key={w.id} className={`wf-row${isActive ? ' active' : ''}`}>
                    {editingId === w.id ? (
                      <>
                        <input
                          className="wf-input"
                          value={editingName}
                          autoFocus
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') rename(w);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <button
                          type="button"
                          className="wf-btn primary small"
                          disabled={!editingName.trim() || busy}
                          onClick={() => rename(w)}
                        >
                          Save
                        </button>
                        <button type="button" className="wf-btn small" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="wf-row-text">
                          <span className="wf-row-name">
                            {label}
                            {isActive && <span className="wf-row-current">current</span>}
                          </span>
                          <span className="wf-row-stage">{w.current_stage || 'Not started'}</span>
                        </span>
                        <button
                          type="button"
                          className="wf-btn small"
                          disabled={busy}
                          onClick={() => { setEditingId(w.id); setEditingName(label); }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="wf-btn small danger"
                          disabled={busy}
                          onClick={() => remove(w)}
                        >
                          {busy ? 'Working…' : 'Delete'}
                        </button>
                        {/* Disabled on the one already open: the row is marked
                            "current", so the action would do nothing. */}
                        <button
                          type="button"
                          className="wf-btn small primary"
                          disabled={busy || isActive}
                          onClick={() => { selectWorkflow(w.id); onSwitched(w); }}
                        >
                          Open
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
              {!workflows.length && (
                <p className="wf-empty">No workflows yet. Use + New to create one.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorkflowDialog;
