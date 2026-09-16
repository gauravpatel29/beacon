// Module 7: Model Output — thin wrappers around the real services/api.js.
// api.js itself does the actual fetch()/ApiError/request() work; this file
// only adapts field names (therapyType -> therapy_type, etc.) so the
// component can keep using the parameter names it already had.
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
  // { curves: { [channelName]: [{ spend, impactable_geo_time, impactable_nation, impactable_nation_currency, roi, mroi }] } }
}

// ── Section 7 — POST /api/results/benchmarks ────────────────────────────────
export async function fetchBenchmarks({ therapyType, maturityStage, competitionLevel, channels }) {
  return fetchBenchmarkComparison({
    therapy_type: therapyType,
    maturity_stage: maturityStage,
    competition_level: competitionLevel,
    channels, // [{ channel, roi }]
  });
  // { benchmark_group, channel_benchmarks: [...], overall_comparison: [...] }
}

// ── Sections 1 & 8 — POST /api/results/summary ──────────────────────────────
export async function fetchResultsSummary({ iterations }) {
  return resultsSummary({ iterations }); // { iterations: [...], count }
}

// ── Sections 2 & 4 — persist finalizedModelId / channelSpendMap ────────────
// api.js's own `updateWorkflow(id, payload)` already does exactly this:
// PATCH /v1/workflows/{id}, matching module7-api-reference.md's documented
// endpoint for these two sections. No separate implementation needed.
export async function updateWorkflowState(workflowId, patch) {
  return updateWorkflow(workflowId, patch);
}

// ── Not yet wired to any Model Output UI section ────────────────────────────
// api.js groups this under the same Module 7 comment block as the three
// endpoints above (POST /api/optimization/run), but nothing here calls it
// yet, and its request/response shape hasn't been documented anywhere we've
// seen. Exported so it's ready the moment a "Budget Optimization" section is
// designed.
export { runOptimization };