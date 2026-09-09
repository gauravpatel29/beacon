// Beacon API client.
//
// See docs/FRONTEND_API_GUIDE.md in the backend repo for the full contract.
// Two surfaces:
//   /v1/workflows            the workflow entity (Neon Postgres)
//   /v2/workflows/{id}/...   datasets: upload, profile, preview, commit
//
// The browser holds an id, never the file. Uploaded bytes live in Neon Object
// Storage; nothing here sends or stores CSV text.
//
// Uses native fetch so the app takes no new dependency.

import { API_BASE_URL } from '../../Apiconfig.js';

// Empty API_BASE_URL means same-origin, which the Vite dev proxy forwards to
// the backend (see vite.config.js). Set it to a tunnel URL to talk to a
// backend running on someone else's machine.
const BASE = (API_BASE_URL || '').replace(/\/$/, '');

const url = (path) => `${BASE}${path}`;

// ─── Errors ──────────────────────────────────────────────────────────────
// Every backend error is RFC 9457 problem+json:
//   { type, title, status, detail?, errors?: [{ code, column?, message }] }
export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.title || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem || {};
    this.errors = problem?.errors || [];
  }

  /** A single line suitable for showing the user. */
  get text() {
    if (this.errors.length) {
      const head = this.errors
        .slice(0, 3)
        .map((e) => (e.column ? `${e.column}: ${e.message}` : e.message))
        .join(' · ');
      return this.errors.length > 3
        ? `${head} (+${this.errors.length - 3} more)`
        : head;
    }
    return this.problem.detail || this.problem.title || this.message;
  }
}

async function request(path, { method = 'GET', body, headers, raw } = {}) {
  let response;
  try {
    response = await fetch(url(path), { method, body, headers });
  } catch (cause) {
    throw new ApiError(0, {
      title: 'Cannot reach the API',
      detail:
        'The backend did not respond. Check it is running and that ' +
        'Apiconfig.js / the Vite proxy points at it.',
    });
  }

  if (response.status === 204) return null;

  if (!response.ok) {
    let problem = null;
    try {
      problem = await response.json();
    } catch {
      problem = { title: `Request failed (${response.status})` };
    }
    throw new ApiError(response.status, problem);
  }

  return raw ? response.text() : response.json();
}

const json = (payload) => ({
  body: JSON.stringify(payload),
  headers: { 'Content-Type': 'application/json' },
});

// ─── Workflows (/v1) ─────────────────────────────────────────────────────

export const createWorkflow = (payload) =>
  request('/v1/workflows', { method: 'POST', ...json(payload) });

export const listWorkflows = () => request('/v1/workflows');

export const getWorkflow = (id) => request(`/v1/workflows/${id}`);

export const updateWorkflow = (id, payload) =>
  request(`/v1/workflows/${id}`, { method: 'PATCH', ...json(payload) });

export const deleteWorkflow = (id) =>
  request(`/v1/workflows/${id}`, { method: 'DELETE' });

// ─── Datasets (/v2) ──────────────────────────────────────────────────────

/**
 * Upload files. Send an empty manifest to land the raw bytes first, then
 * configure against the columns the response reports.
 * Each returned file carries `preview`, `profile`, `columns` and `row_count`.
 */
export function uploadFiles(workflowId, files, { manifest = {}, overwrite = true } = {}) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  form.append('manifest', JSON.stringify(manifest));
  const query = `?overwrite=${overwrite ? 'true' : 'false'}`;
  return request(`/v2/workflows/${workflowId}/files${query}`, {
    method: 'POST',
    body: form, // no Content-Type: the browser sets the multipart boundary
  });
}

export const listFiles = (workflowId) =>
  request(`/v2/workflows/${workflowId}/files`);

export const getFile = (workflowId, filename, previewRows = 100) =>
  request(
    `/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}` +
      `?preview_rows=${previewRows}`
  );

/** Per-column suggestions: detected dtype, candidate date formats, samples. */
export const getProfile = (workflowId, filename) =>
  request(`/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/profile`);

/** Dry run: applies the manifest to the stored bytes and stores nothing. */
export const previewSpec = (workflowId, filename, spec) =>
  request(
    `/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/preview`,
    { method: 'POST', ...json(spec) }
  );

/** Persist the manifest and re-derive the dataset from the immutable raw bytes. */
export const commitSpec = (workflowId, filename, spec) =>
  request(
    `/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/spec`,
    { method: 'PATCH', ...json(spec) }
  );

/** What time grain is this date column already at? */
export const detectGranularity = (workflowId, filename, payload) =>
  request(
    `/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/detect-granularity`,
    { method: 'POST', ...json(payload) }
  );

export const deleteFile = (workflowId, filename) =>
  request(`/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
  });

/** The resolved dataset as CSV text — for handing off to later screens. */
export const getCsv = (workflowId, filename) =>
  request(`/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/csv`, {
    raw: true,
  });

// ─── Workflow session ────────────────────────────────────────────────────
// Every /v2 route is scoped to a workflow, but there is no workflow-creation
// screen yet. One is created on demand at first upload and remembered, so the
// UI needs no extra control for it. Replace this with the real Workflow
// Creation screen when that lands.

const STORAGE_KEY = 'beacon_workflow_id';

export function storedWorkflowId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function forgetWorkflow() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing - the id simply does not persist */
  }
}

/** Make an existing, server-side workflow the active upload container. */
export function selectWorkflow(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* the workflow remains active for this page visit through the caller */
  }
}

/** Returns the explicitly selected workflow, verifying it still exists. */
export async function ensureWorkflow() {
  const existing = storedWorkflowId();
  if (!existing) {
    throw new ApiError(0, {
      title: 'Choose a workflow first',
      detail: 'Return to Home and create or select a workflow before uploading files.',
    });
  }
  try {
    await getWorkflow(existing);
    return existing;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) forgetWorkflow();
    throw err;
  }
}
