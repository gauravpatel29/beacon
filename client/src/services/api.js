
import axios from "axios";

export const API = axios.create({
  baseURL: "/api",
  timeout: 120000,
});

// ─── Workflows CRUD ───────────────────────────────────────────────────────────
export const listWorkflows = () => API.get("/workflows").then((r) => r.data);

export const createWorkflow = (payload) =>
  API.post("/workflows", payload).then((r) => r.data);

export const getWorkflow = (id) =>
  API.get(`/workflows/${id}`).then((r) => r.data);

export const updateWorkflow = (id, payload) =>
  API.put(`/workflows/${id}`, payload).then((r) => r.data);

export const deleteWorkflow = (id) =>
  API.delete(`/workflows/${id}`).then((r) => r.data);

// ─── Data Ingestion ───────────────────────────────────────────────────────────
export const uploadFiles = (formData) =>
  API.post("/ingestion/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  }).then((r) => r.data);

export const standardizeFile = (payload) =>
  API.post("/ingestion/standardize", payload).then((r) => r.data);

export const mergeFiles = (payload) =>
  API.post("/ingestion/merge", payload).then((r) => r.data);

export const filterData = (payload) =>
  API.post("/ingestion/filter", payload).then((r) => r.data);

export const detectGranularity = (payload) =>
  API.post("/ingestion/detect-granularity", payload).then((r) => r.data);

export const modifyGranularity = (payload) =>
  API.post("/ingestion/modify-granularity", payload).then((r) => r.data);

export const normalizeData = (payload) =>
  API.post("/ingestion/normalize", payload).then((r) => r.data);

export const buildARD = (payload) =>
  API.post("/ard/build-ard", payload).then((r) => r.data);

// ─── EDA & Relationships ──────────────────────────────────────────────────────
// ─── EDA & Relationships ──────────────────────────────────────────────────────
export const edaStats = (payload) =>
  API.post("/eda/stats", payload).then((r) => r.data);

export const edaSparsity = (payload) =>
  API.post("/eda/sparsity", payload).then((r) => r.data);

export const edaPoorMansCurve = (payload) =>
  API.post("/eda/poor-mans-curve", payload).then((r) => r.data);

export const edaDetectOutliers = (payload) =>
  API.post("/eda/detect-outliers", payload).then((r) => r.data);

export const edaRemoveOutliers = (payload) =>
  API.post("/eda/remove-outliers", payload).then((r) => r.data);

export const edaTrendRollup = (payload) =>
  API.post("/eda/trend-rollup", payload).then((r) => r.data);

export const edaHistogram = (payload) =>
  API.post("/eda/histogram", payload).then((r) => r.data);

export const edaScatter = (payload) =>
  API.post("/eda/scatter", payload).then((r) => r.data);

// ─── Correlation & Multicollinearity ──────────────────────────────────────────
export const correlationMatrix = (payload) =>
  API.post("/correlation/matrix", payload).then((r) => r.data);

export const pcaAnalysis = (payload) =>
  API.post("/correlation/pca", payload).then((r) => r.data);

export const computeVIF = (payload) =>
  API.post("/correlation/vif", payload).then((r) => r.data);

export const getCandidateFeatures = (payload) =>
  API.post("/correlation/candidate-features", payload).then((r) => r.data);

export const getHighCorrPairs = (payload) =>
  API.post("/correlation/high-pairs", payload).then((r) => r.data);

export const previewRemoval = (payload) =>
  API.post("/correlation/preview-removal", payload).then((r) => r.data);

export const applyRemoval = (payload) =>
  API.post("/correlation/apply-removal", payload).then((r) => r.data);

export const findClusters = (payload) =>
  API.post("/correlation/find-clusters", payload).then((r) => r.data);

export const previewCombination = (payload) =>
  API.post("/correlation/preview-combination", payload).then((r) => r.data);

export const applyCombination = (payload) =>
  API.post("/correlation/apply-combination", payload).then((r) => r.data);

export const applyWeightedSum = (payload) =>
  API.post("/correlation/apply-weighted-sum", payload).then((r) => r.data);

export const applyPcaTreatment = (payload) =>
  API.post("/correlation/apply-pca-treatment", payload).then((r) => r.data);

// ─── Transformation ───────────────────────────────────────────────────────────
export const applyTransformations = (payload) =>
  API.post("/transformation/apply", payload).then((r) => r.data);

export const runOptuna = (payload) =>
  API.post("/transformation/optuna", payload).then((r) => r.data);

// ─── Modelling ────────────────────────────────────────────────────────────────
export const getAvailableChannels = (payload) =>
  API.post("/modelling/available-channels", payload).then((r) => r.data);

export const runRegression = (payload) =>
  API.post("/modelling/run-regression", payload).then((r) => r.data);

export const runOlsStage2 = (payload) =>
  API.post("/modelling/run-ols-stage2", payload).then((r) => r.data);

export const runRidge = (payload) =>
  API.post("/modelling/run-ridge", payload).then((r) => r.data);

export const getCombinedDecomposition = (payload) =>
  API.post("/modelling/combined-decomposition", payload).then((r) => r.data);

// ─── Response Curves ──────────────────────────────────────────────────────────
export const generateResponseCurves = (payload) =>
  API.post("/response-curves/generate", payload).then((r) => r.data);

// ─── Optimization ─────────────────────────────────────────────────────────────
export const runOptimization = (payload) =>
  API.post("/optimization/run", payload).then((r) => r.data);