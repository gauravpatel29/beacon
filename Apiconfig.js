// Base URL for the API.
//
// Read from the environment first: set VITE_API_BASE_URL in .env.local (see
// .env.example) or in the deploy environment. Vite inlines VITE_* vars at
// build time, so this works for production builds as well as `npm run dev`.
// The literals below are only the fallback when the var is unset.
//
// Empty means same-origin, which the Vite dev proxy forwards to the backend
// (see vite.config.js). Leave it empty for local work.
//
// Set an absolute URL to talk to a backend on another machine without the
// proxy — e.g. 'https://<tunnel-host>'. CORS on the API echoes the caller's
// origin, so that works too. Note a production build has no proxy, so a
// deployed app needs either an absolute URL here or an API on the same origin.
const DEFAULT_API_BASE_URL = '';

// Not used any more: a workflow is created on demand at first upload and
// remembered in localStorage (see src/services/api.js -> ensureWorkflow).
// Set this to pin the app to one existing workflow while debugging.
const DEFAULT_WORKFLOW_ID = '';

// import.meta.env is statically replaced by Vite; an unset var comes through
// as undefined, so `??` keeps the fallback rather than an empty string.
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL
).trim();

export const WORKFLOW_ID = (
  import.meta.env.VITE_WORKFLOW_ID ?? DEFAULT_WORKFLOW_ID
).trim();
