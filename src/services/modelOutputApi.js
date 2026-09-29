// Module 7: Model Output — thin wrappers around the real services/api.js.
import {
  resultsSummary,
  fetchBenchmarkComparison,
  generateResponseCurves as apiGenerateResponseCurves,
  updateWorkflow,
  runOptimization,
} from './api.js';

// ── Section 6 — POST /api/response-curves/generate ─────────────────────────
export async function generateResponseCurves({ channels, numTime, numGeo }) {
  return apiGenerateResponseCurves({ channels, num_time: numTime, num_geo: numGeo });
}

// ── Section 7 — POST /api/results/benchmarks ────────────────────────────────
export async function fetchBenchmarks({ diseaseArea, maturityStage, competitionLevel, channels, userImpactShares }) {
  return fetchBenchmarkComparison({
    disease_area: diseaseArea,
    maturity_stage: maturityStage,
    competition_level: competitionLevel,
    channels,
    user_impact_shares: userImpactShares || {}, // 👈 FIXED: Passes real model shares
  });
}

// ── Sections 1 & 8 — POST /api/results/summary ──────────────────────────────
export async function fetchResultsSummary({ iterations }) {
  return resultsSummary({ iterations });
}

// ── Sections 2 & 4 — persist finalizedModelId / channelSpendMap ────────────
export async function updateWorkflowState(workflowId, patch) {
  return updateWorkflow(workflowId, patch);
}

export { runOptimization };