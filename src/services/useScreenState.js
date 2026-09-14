import { useEffect, useRef, useState } from 'react';
import { loadScreenState, saveScreenState } from './workflowState.js';

/**
 * Keep one screen's selections in the workflow, so leaving and coming back
 * resumes the work rather than the blank form.
 *
 * Each screen supplies two functions: `snapshot()` returns the plain-JSON
 * description of what the user has chosen, and `restore(saved)` puts it back.
 * Everything else - when to load, when to save, and the ordering hazard
 * between them - lives here, because getting that ordering wrong silently
 * destroys the user's work rather than failing loudly.
 *
 * Three rules it enforces:
 *
 *   * Saves are armed only after the restore has finished. Without that gate
 *     the blank initial state races the fetch and overwrites what is being
 *     loaded - the screen looks fine and the work is already gone.
 *   * Saves are debounced, so dragging a slider or typing a name is one write
 *     rather than one per event.
 *   * `ready` holds saving off until the screen has the data its snapshot
 *     describes. A screen that saves while its file list is still empty would
 *     persist an empty selection over a real one.
 *
 * Snapshots must be JSON: a Set or a Map has to be converted by the caller,
 * because `JSON.stringify(new Set([1]))` is `{}` and loses the contents
 * without erroring.
 */
export function useScreenState(key, { snapshot, restore, deps = [], ready = true, delay = 600 }) {
  const hasRestored = useRef(false);
  // Returned as state, not just the ref, so a screen can make its own loading
  // wait for the restore. A screen that fetches concurrently would otherwise
  // race it and pick a default before the saved choice arrived.
  const [restored, setRestored] = useState(false);
  // Held in refs so the save effect depends only on `deps` - the screen's
  // actual state - and not on the identity of functions redefined each render.
  const snapshotRef = useRef(snapshot);
  const restoreRef = useRef(restore);

  // Declared first, so it has already run by the time the effects below do on
  // mount. Assigning during render instead would be a write to a ref in the
  // render phase, which React does not allow.
  useEffect(() => {
    snapshotRef.current = snapshot;
    restoreRef.current = restore;
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadScreenState(key);
      if (!cancelled && saved) {
        try {
          restoreRef.current(saved);
        } catch {
          // A snapshot written by an older build may not fit the current
          // shape. Starting fresh beats crashing the screen on open.
        }
      }
      // Armed even when nothing was stored, or the restore threw: from here
      // on the screen's state is the user's, and worth saving.
      if (!cancelled) { hasRestored.current = true; setRestored(true); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!hasRestored.current || !ready) return undefined;
    const timer = setTimeout(() => { saveScreenState(key, snapshotRef.current()); }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, delay, ...deps]);

  return restored;
}
