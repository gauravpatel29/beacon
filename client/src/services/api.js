import axios from "axios";

const API = axios.create({
  baseURL: "/api",
  timeout: 120000,
});

// ─── Workflows CRUD ───────────────────────────────────────────────────────────
export const listWorkflows = () => API.get("/workflows").then((r) => r.data);
export const createWorkflow = (payload) => API.post("/workflows", payload).then((r) => r.data);
export const getWorkflow = (id) => API.get(`/workflows/${id}`).then((r) => r.data);
export const updateWorkflow = (id, payload) => API.put(`/workflows/${id}`, payload).then((r) => r.data);
export const deleteWorkflow = (id) => API.delete(`/workflows/${id}`).then((r) => r.data);

// ─── Data Ingestion ───────────────────────────────────────────────────────────
export const uploadFiles = (formData) =>
  API.post("/ingestion/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  }).then((r) => r.data);
export const standardizeFile = (payload) => API.post("/ingestion/standardize", payload).then((r) => r.data);
export const mergeFiles = (payload) => API.post("/ingestion/merge", payload).then((r) => r.data);
export const filterData = (payload) => API.post("/ingestion/filter", payload).then((r) => r.data);
export const detectGranularity = (payload) => API.post("/ingestion/detect-granularity", payload).then((r) => r.data);
export const modifyGranularity = (payload) => API.post("/ingestion/modify-granularity", payload).then((r) => r.data);
export const normalizeData = (payload) => API.post("/ingestion/normalize", payload).then((r) => r.data);

// ─── EDA & Diagnostics ────────────────────────────────────────────────────────
export const edaStats = (payload) => API.post("/eda/stats", payload).then((r) => r.data);
export const edaHistogram = (payload) => API.post("/eda/histogram", payload).then((r) => r.data);
export const edaScatter = (payload) => API.post("/eda/scatter", payload).then((r) => r.data);
export const edaSparsity = (payload) => API.post("/eda/sparsity", payload).then((r) => r.data);
export const edaPoorMansCurve = (payload) => API.post("/eda/poor-mans-curve", payload).then((r) => r.data);
export const edaDetectOutliers = (payload) => API.post("/eda/detect-outliers", payload).then((r) => r.data);
export const edaRemoveOutliers = (payload) => API.post("/eda/remove-outliers", payload).then((r) => r.data);
export const edaTrendRollup = (payload) => API.post("/eda/trend-rollup", payload).then((r) => r.data);
export const edaLagCorrelation = (payload) => API.post("/eda/lag-correlation", payload).then((r) => r.data);

// ─── Correlation & Multicollinearity ──────────────────────────────────────────
export const correlationMatrix = (payload) => API.post("/correlation/matrix", payload).then((r) => r.data);
export const pcaAnalysis = (payload) => API.post("/correlation/pca", payload).then((r) => r.data);
export const computeVIF = (payload) => API.post("/correlation/vif", payload).then((r) => r.data);
export const getCandidateFeatures = (payload) => API.post("/correlation/candidate-features", payload).then((r) => r.data);
export const getHighCorrPairs = (payload) => API.post("/correlation/high-pairs", payload).then((r) => r.data);
export const previewRemoval = (payload) => API.post("/correlation/preview-removal", payload).then((r) => r.data);
export const applyRemoval = (payload) => API.post("/correlation/apply-removal", payload).then((r) => r.data);
export const findClusters = (payload) => API.post("/correlation/find-clusters", payload).then((r) => r.data);
export const applyCombination = (payload) => API.post("/correlation/apply-combination", payload).then((r) => r.data);
export const applyWeightedSum = (payload) => API.post("/correlation/apply-weighted-sum", payload).then((r) => r.data);
export const applyPcaTreatment = (payload) => API.post("/correlation/apply-pca-treatment", payload).then((r) => r.data);

// ─── Transformation (Module 5) ────────────────────────────────────────────────
export const applyTransformations = (payload) => API.post("/transformation/apply", payload).then((r) => r.data);
export const runOptuna = (payload) => API.post("/transformation/optuna", payload).then((r) => r.data);
export const transformationAutoSelect = (payload) => API.post("/transformation/auto-select", payload).then((r) => r.data);
export const transformationPreviewSingle = (payload) => API.post("/transformation/preview-single", payload).then((r) => r.data);
export const transformationCorrelation = (payload) => API.post("/transformation/correlation", payload).then((r) => r.data);

// ─── Modelling ────────────────────────────────────────────────────────────────
export const getAvailableChannels = (payload) => API.post("/modelling/available-channels", payload).then((r) => r.data);
export const runRegression = (payload) => API.post("/modelling/run-regression", payload).then((r) => r.data);
export const runOlsStage2 = (payload) => API.post("/modelling/run-ols-stage2", payload).then((r) => r.data);
export const runRidge = (payload) => API.post("/modelling/run-ridge", payload).then((r) => r.data);
export const getCombinedDecomposition = (payload) => API.post("/modelling/combined-decomposition", payload).then((r) => r.data);

// ─── Response Curves & Optimization ───────────────────────────────────────────
export const generateResponseCurves = (payload) => API.post("/response-curves/generate", payload).then((r) => r.data);
export const runOptimization = (payload) => API.post("/optimization/run", payload).then((r) => r.data);

// ─── Beacon v1 & v2 (Postgres & Object Store) ─────────────────────────────────
const V1 = axios.create({ baseURL: "/v1", timeout: 120000 });
export const v1CreateWorkflow = (payload) => V1.post("/workflows", payload).then((r) => r.data);
export const v1ListWorkflows = () => V1.get("/workflows").then((r) => r.data);
export const v1GetWorkflow = (id) => V1.get(`/workflows/${id}`).then((r) => r.data);
export const v1PatchWorkflow = (id, payload) => V1.patch(`/workflows/${id}`, payload).then((r) => r.data);
export const v1DeleteWorkflow = (id) => V1.delete(`/workflows/${id}`).then((r) => r.data);

const V2 = axios.create({ baseURL: "/v2", timeout: 300000 });
export const v2Upload = (workflowId, formData, { dryRun = false, overwrite = false } = {}) =>
  V2.post(`/workflows/${workflowId}/files`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
    params: { dry_run: dryRun, overwrite },
  }).then((r) => r.data);
export const v2Preview = (workflowId, filename, spec) =>
  V2.post(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}/preview`, spec).then((r) => r.data);
export const v2CommitSpec = (workflowId, filename, spec) =>
  V2.patch(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}/spec`, spec).then((r) => r.data);
export const v2ListFiles = (workflowId) => V2.get(`/workflows/${workflowId}/files`).then((r) => r.data);
export const v2GetFile = (workflowId, filename) =>
  V2.get(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}`).then((r) => r.data);
export const v2DeleteFile = (workflowId, filename) =>
  V2.delete(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}`).then((r) => r.data);
export const v2Merge = (workflowId, payload, { dryRun = false } = {}) =>
  V2.post(`/workflows/${workflowId}/merge`, payload, { params: { dry_run: dryRun } }).then((r) => r.data);
export const v2GetCsv = (workflowId, filename) =>
  V2.get(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}/csv`, { responseType: "text" }).then((r) => r.data);
export const v2GetProfile = (workflowId, filename) =>
  V2.get(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}/profile`).then((r) => r.data);
export const v2DetectGranularity = (workflowId, filename, payload) =>
  V2.post(`/workflows/${workflowId}/files/${encodeURIComponent(filename)}/detect-granularity`, payload).then((r) => r.data);
export const v2BuildArd = (workflowId, payload, { dryRun = false } = {}) =>
  V2.post(`/workflows/${workflowId}/ard/build`, payload, { params: { dry_run: dryRun } }).then((r) => r.data);
export const v2ListArds = (workflowId) => V2.get(`/workflows/${workflowId}/ard`).then((r) => r.data);

export function problemMessage(err, fallback = "Request failed") {
  const d = err?.response?.data;
  if (!d) return err?.message || fallback;
  if (Array.isArray(d.errors) && d.errors.length) {
    return d.errors.slice(0, 3).map((e) => e.message).join("  •  ") + (d.errors.length > 3 ? `  (+${d.errors.length - 3} more)` : "");
  }
  return d.detail || d.title || d.error || fallback;
}
