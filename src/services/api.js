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

/**
 * Control totals and per-column filter bounds, over the WHOLE resolved frame.
 * GET /v2/workflows/{workflow_id}/files/{filename}/stats
 * -> { row_count, duplicate_rows, columns: [{ column, kind, null_count,
 *      null_pct, distinct_count, min, max }] }
 * `kind` is 'number' | 'date' | 'string', taken from the committed spec -
 * a column the user has not typed yet reads as 'string'.
 */
export const getStats = (workflowId, filename) =>
  request(`/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/stats`);

/**
 * Distinct values of one column, for the categorical filter's type-ahead.
 * GET /v2/workflows/{workflow_id}/files/{filename}/values?column=&q=&limit=
 * The search runs server-side, so an ID column with a million distinct values
 * is never shipped to the browser to be filtered here.
 */
export const getColumnValues = (workflowId, filename, column, q = '', limit = 50) =>
  request(
    `/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/values` +
      `?column=${encodeURIComponent(column)}&q=${encodeURIComponent(q)}&limit=${limit}`
  );

// ─── Data Review (EDA) ───────────────────────────────────────────────────
// These post the CSV itself rather than naming a dataset. That is deliberate:
// the screen lets the user exclude outlier rows locally, and the analysis has
// to run on what they are actually looking at. `routers/v2_review.py` is the
// name-based equivalent for callers that do not need that.
const edaPost = (endpoint, payload) =>
  request(`/api/eda/${endpoint}`, { method: 'POST', ...json(payload) });

/** Summary table (with control totals), trend series and per-geo breakdown. */
export const edaStats = (payload) => edaPost('stats', payload);

/** Non-zero share per metric — which tactics are too sparse to model. */
export const edaSparsity = (payload) => edaPost('sparsity', payload);

/** Binned distribution of one numeric column. */
export const edaHistogram = (payload) => edaPost('histogram', payload);

/** Scatter of two columns, with r and a least-squares trendline. */
export const edaScatter = (payload) => edaPost('scatter', payload);

/** Binned average of Y against X — the response shape before any model. */
export const edaPoorMansCurve = (payload) => edaPost('poor-mans-curve', payload);

/** IQR or Z-score outliers, with the bounds used and the flagged rows. */
export const edaDetectOutliers = (payload) => edaPost('detect-outliers', payload);

/** The dataset with flagged rows dropped. Returns CSV; writes nothing. */
export const edaRemoveOutliers = (payload) => edaPost('remove-outliers', payload);

/** Metrics aggregated by week or month. */
export const edaTrendRollup = (payload) => edaPost('trend-rollup', payload);

/** Cross-correlation of X against Y across time lags. */
export const edaLagCorrelation = (payload) => edaPost('lag-correlation', payload);

// ─── Correlation & multicollinearity ─────────────────────────────────────
// Same csv_data contract as the EDA engines. These replace a browser-side
// implementation: VIF in particular needs a real least-squares fit, and the
// hand-rolled normal equations it used went singular on collinear inputs -
// which is exactly the case VIF exists to measure.
const corrPost = (endpoint, payload) =>
  request(`/api/correlation/${endpoint}`, { method: 'POST', ...json(payload) });

/** Pairwise correlation matrix. -> { matrix, columns } */
export const correlationMatrix = (payload) => corrPost('matrix', payload);

/** Variance inflation factors. -> { vif: [{ variable, VIF, status }] } */
export const computeVIF = (payload) => corrPost('vif', payload);

/** Pairs above a threshold. -> { pairs: [{ feature1, feature2, corr }] } */
export const getHighCorrPairs = (payload) => corrPost('high-pairs', payload);

/**
 * Which variables a removal would drop, and why - without changing anything.
 * -> { pairs: [{ feature1, feature2, correlation, will_drop, will_keep, reason }],
 *      dropped, kept, total_pairs, total_dropped, total_kept }
 */
export const previewRemoval = (payload) => corrPost('preview-removal', payload);

/** Apply the removal. Returns the REDUCED dataset as csv_data. */
export const applyRemoval = (payload) => corrPost('apply-removal', payload);

/** Groups of mutually correlated variables. -> { clusters: [[col, col], …] } */
export const findClusters = (payload) => corrPost('find-clusters', payload);

/** Apply the combination. Returns the COMBINED dataset as csv_data. */
export const applyCombination = (payload) => corrPost('apply-combination', payload);

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


// ─── Data Stitching & ARD (/v2/workflows/{id}/ard) ────────────────────────
// For the Data Stitching & ARD Creation screen only. See
// ARD_STITCHING_API.md for the full contract. Four calls, all scoped to the
// current workflow. The screen sends step *definitions*, not data — the
// server loads named datasets from storage itself.
 
/**
 * On page load — fill the source-file dropdowns.
 * GET /v2/workflows/{workflow_id}/files
 * Returns { items: [{ filename, columns, row_count, kind }] }.
 * Callers should filter out kind === 'ard' so a previously built ARD can't
 * be joined into itself.
 */
export const v2ListFiles = (workflowId) =>
  request(`/v2/workflows/${workflowId}/files`);
 
/**
 * Run the stitching pipeline.
 * POST /v2/workflows/{workflow_id}/ard/build
 * Pass { dryRun: true } to preview the result without saving
 * (adds ?dry_run=true).
 *
 * payload shape:
 *   {
 *     steps: [{ left_file, right_file, left_key, right_key, join_type }],
 *     target_grain: 'hcp' | 'dma' | 'geo' | 'zip' | 'national',
 *     output?: string,
 *   }
 *
 * left_file/right_file: a dataset filename, or "Step N Result" to chain off
 * an earlier step. left_key/right_key: array (or comma-separated string) —
 * both sides must have the same count. join_type: 'left' | 'inner'.
 *
 * Resolves to the built/dry-run ARD:
 *   { filename, kind: 'ard', version, row_count, columns, preview,
 *     lineage: { steps_executed: [{ step, left, right, join, rows_in,
 *     rows_out, rows_matched }] }, derived_from: { grain, inputs } }
 */
export const v2BuildArd = (workflowId, payload, { dryRun = false } = {}) =>
  request(
    `/v2/workflows/${workflowId}/ard/build${dryRun ? '?dry_run=true' : ''}`,
    { method: 'POST', ...json(payload) }
  );
 
/**
 * List previously built ARDs for this workflow, newest first.
 * GET /v2/workflows/{workflow_id}/ard
 * Returns { items: [...] }, each item shaped like a v2BuildArd response
 * (plus a `grain` field).
 */
export const v2ListArds = (workflowId) =>
  request(`/v2/workflows/${workflowId}/ard`);
 
/**
 * Hand off a built ARD to the next screen (EDA, etc.) as CSV text.
 * GET /v2/workflows/{workflow_id}/files/{filename}/csv
 * Call this once, right after a successful build, and pass the result
 * along — don't put it in localStorage.
 */
export const v2GetCsv = (workflowId, filename) =>
  request(`/v2/workflows/${workflowId}/files/${encodeURIComponent(filename)}/csv`, {
    raw: true,
  });
 
/**
 * Turn a caught error into a single string suitable for a toast.
 * ApiError already carries this as `.text`; this helper also copes with a
 * plain Error (e.g. something that didn't come from `request()`).
 */
export function problemMessage(err, fallback = 'Something went wrong.') {
  if (err instanceof ApiError) return err.text;
  return err?.message || fallback;
}