// Base URL for the API.
//
// Empty means same-origin, which the Vite dev proxy forwards to the backend
// (see vite.config.js). Leave it empty for local work.
//
// Set an absolute URL to talk to a backend on another machine without the
// proxy — e.g. 'https://<tunnel-host>'. CORS on the API echoes the caller's
// origin, so that works too.
export const API_BASE_URL = '';

// Not used any more: a workflow is created on demand at first upload and
// remembered in localStorage (see src/services/api.js -> ensureWorkflow).
// Set this to pin the app to one existing workflow while debugging.
export const WORKFLOW_ID = '';
