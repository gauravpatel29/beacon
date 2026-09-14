// Where a workflow got to, and what each screen had open when you left it.
//
// The workflow row has carried `current_stage`, `current_route`, `module_status`
// and `state_data` since the first migration, but nothing wrote to them: every
// screen kept its work in component state, so closing the tab lost it and
// Resume always dropped you back on Data Ingestion regardless of how far you
// had got.
//
// File specs are NOT stored here. Those live in the manifest against each
// dataset and are the source of truth for the derived frame; duplicating them
// into `state_data` would create a second copy to disagree with. What belongs
// here is screen state the server cannot otherwise reconstruct - which joins a
// draft holds, which columns a screen had selected.

import { getWorkflow, storedWorkflowId, updateWorkflow } from './api.js';
import { STAGES } from './workflowStages.js';

// Re-exported so callers have one import for session resume.
export { STAGES, resumeRouteFor } from './workflowStages.js';

/**
 * Record that the user is on this screen.
 *
 * Deliberately fire-and-forget: progress tracking must never interrupt the
 * work it is tracking. A failure here leaves the stored stage stale, which
 * costs one extra click on resume - far cheaper than an error dialog over a
 * screen that is otherwise working.
 */
export async function recordStage(key) {
  const entry = STAGES[key];
  const id = storedWorkflowId();
  if (!entry || !id) return null;
  try {
    return await updateWorkflow(id, {
      current_stage: entry.stage,
      current_route: entry.route,
      module_status: { [key]: 'in_progress' },
    });
  } catch {
    return null;
  }
}

/** Mark one stage finished, without moving the user off it. */
export async function markStageComplete(key) {
  const id = storedWorkflowId();
  if (!STAGES[key] || !id) return null;
  try {
    return await updateWorkflow(id, { module_status: { [key]: 'completed' } });
  } catch {
    return null;
  }
}

/**
 * Save one screen's state under its own key.
 *
 * The server merges at the top level, so screens cannot overwrite each other.
 * Also fire-and-forget, for the same reason as `recordStage`.
 */
export async function saveScreenState(key, value) {
  const id = storedWorkflowId();
  if (!id || !key) return null;
  try {
    return await updateWorkflow(id, { state_data: { [key]: value } });
  } catch {
    return null;
  }
}

/**
 * Forget everything the saved state knows about one dataset.
 *
 * Deleting a file used to leave its name behind in `state_data`: the Stitching
 * screen restored joins against a file that no longer existed, and Data Review
 * restored column selections that had gone with it - which reached the API as
 * "None of [...] are in the [columns]" and left the screen stuck.
 *
 * Called after the delete succeeds, so a failed delete never prunes state for
 * a file that is still there.
 */
export async function forgetFile(filename) {
  const id = storedWorkflowId();
  if (!id || !filename) return null;

  let stored;
  try {
    stored = (await getWorkflow(id))?.state_data;
  } catch {
    return null;
  }
  if (!stored || typeof stored !== 'object') return null;

  const patch = {};

  const ingestion = stored.ingestion;
  if (ingestion && typeof ingestion === 'object') {
    const pendingCategories = { ...(ingestion.pendingCategories || {}) };
    delete pendingCategories[filename];
    patch.ingestion = {
      ...ingestion,
      pendingCategories,
      openFile: ingestion.openFile === filename ? null : ingestion.openFile,
    };
  }

  const stitching = stored.stitching;
  if (stitching && typeof stitching === 'object') {
    const drafts = Object.fromEntries(
      Object.entries(stitching.drafts || {}).map(([tabId, draft]) => {
        const steps = draft.steps || [];
        // Each step can feed the next through "Step N Result", so a step that
        // names this file invalidates everything chained after it. Keeping the
        // steps before it preserves the work that still resolves.
        const firstBroken = steps.findIndex(
          (s) => s.leftFile === filename || s.rightFile === filename
        );
        return [tabId, {
          ...draft,
          steps: firstBroken === -1 ? steps : steps.slice(0, firstBroken),
          selectedFiles: (draft.selectedFiles || []).filter((f) => f !== filename),
        }];
      })
    );
    patch.stitching = { ...stitching, drafts };
  }

  if (!Object.keys(patch).length) return null;
  try {
    return await updateWorkflow(id, { state_data: patch });
  } catch {
    return null;
  }
}

/**
 * Read one screen's saved state back.
 *
 * Returns null when there is nothing stored, when the workflow is gone, or
 * when the request fails - all of which mean "start fresh", which is what a
 * screen does with a null.
 */
export async function loadScreenState(key) {
  const id = storedWorkflowId();
  if (!id || !key) return null;
  try {
    const workflow = await getWorkflow(id);
    const stored = workflow?.state_data;
    if (!stored || typeof stored !== 'object') return null;
    return stored[key] ?? null;
  } catch {
    return null;
  }
}
