import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { listWorkflows, selectWorkflow, storedWorkflowId } from '../../services/api.js';
import { resumeRouteFor } from '../../services/workflowStages.js';
import WorkflowDialog from './WorkflowDialog.jsx';

/**
 * Which workflow the app is currently working in, and a way to change it.
 *
 * Every screen reads the active workflow from storage on mount, so until now
 * nothing on screen said which one that was - the file list and the ARDs just
 * changed under you if it was ever switched elsewhere.
 */
function WorkflowSwitcher({ collapsed }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [workflows, setWorkflows] = useState([]);
  const [open, setOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // 'create' | 'manage' | null - the dialog open over the current screen.
  const [dialog, setDialog] = useState(null);
  const rootRef = useRef(null);

  const activeId = storedWorkflowId();
  const active = workflows.find((w) => w.id === activeId) || null;

  // Bumped to re-read the list after the dialog changes something.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);

  // Re-read on navigation too: creating a workflow, or resuming one, changes
  // the active id without this component re-mounting.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listWorkflows();
        if (cancelled) return;
        setWorkflows(data.items || []);
        setLoadFailed(false);
      } catch {
        // The sidebar is on every screen; a failed list here must not take the
        // navigation down with it. The chip falls back to a neutral label.
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [location.pathname, reloadKey]);

  // Close on an outside click or Escape, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = active
    ? (active.workflow_name || active.name || 'Untitled workflow')
    : (loadFailed ? 'Workflow' : 'No workflow selected');

  const goTo = (workflow) => {

    // Screens read the workflow id once, on mount. Navigating to a different
    // route remounts the target screen and it picks the new one up. Landing on
    // the route already open would not remount anything, so that case reloads:
    // switching workflow has to change every panel, not just this label.
    const route = resumeRouteFor(workflow);
    if (route === location.pathname) window.location.reload();
    else navigate(route);
  };

  const switchTo = (workflow) => {
    setOpen(false);
    if (workflow.id === activeId) return;
    selectWorkflow(workflow.id);
    goTo(workflow);
  };

  return (
    <div className="workflow-switcher" ref={rootRef}>
      <button
        type="button"
        className={`wf-switch-chip${open ? ' is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={collapsed ? label : `Workflow: ${label}`}
      >
        {collapsed ? (
          // Just the first letter when there is no room for a name.
          <span className="wf-switch-chip-initial" aria-hidden="true">
            {label.trim().charAt(0).toUpperCase() || 'W'}
          </span>
        ) : (
          <>
            <span className="wf-switch-chip-text">
              <span className="wf-switch-chip-label">Workflow</span>
              <span className="wf-switch-chip-name">{label}</span>
            </span>
            <span className="wf-switch-chip-caret" aria-hidden="true">▾</span>
          </>
        )}
      </button>

      {open && (
        <div className="workflow-menu" role="listbox" aria-label="Switch workflow">
          <p className="workflow-menu-head">Switch workflow</p>
          <div className="workflow-menu-list">
            {workflows.map((w) => {
              const name = w.workflow_name || w.name || 'Untitled workflow';
              return (
                <button
                  type="button"
                  key={w.id}
                  role="option"
                  aria-selected={w.id === activeId}
                  className={`workflow-menu-item${w.id === activeId ? ' active' : ''}`}
                  onClick={() => switchTo(w)}
                >
                  <span className="workflow-menu-name">{name}</span>
                  {/* Where it got to, so the list is a progress view as well
                      as a picker. */}
                  <span className="workflow-menu-stage">
                    {w.current_stage || 'Not started'}
                  </span>
                </button>
              );
            })}
            {!workflows.length && (
              <p className="workflow-menu-empty">
                {loadFailed ? 'Could not load workflows.' : 'No workflows yet.'}
              </p>
            )}
          </div>
          {/* Both open a dialog over the current screen. Going to Home for
              either meant abandoning whatever was in progress just to rename
              something or start a second workflow. */}
          <div className="workflow-menu-foot">
            <button
              type="button"
              className="workflow-menu-action"
              onClick={() => { setOpen(false); setDialog('manage'); }}
            >
              Manage
            </button>
            <button
              type="button"
              className="workflow-menu-action is-new"
              onClick={() => { setOpen(false); setDialog('create'); }}
            >
              + New
            </button>
          </div>
        </div>
      )}

      {dialog && (
        <WorkflowDialog
          mode={dialog}
          onClose={() => {
            setDialog(null);
            // Renames and deletes happen inside the dialog, so the chip and
            // the menu are refreshed on the way out.
            reload();
          }}
          onSwitched={(workflow) => { setDialog(null); goTo(workflow); }}
        />
      )}
    </div>
  );
}

export default WorkflowSwitcher;
