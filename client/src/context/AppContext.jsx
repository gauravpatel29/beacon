import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { v1PatchWorkflow } from "../services/api";

const AppContext = createContext(null);

const initialState = {
  // Workflow Entity Tracking (v1 = Postgres-backed; required by the v2 dataset API)
  workflowId: null,
  workflowName: null,

  // ─── Ingestion (v2) ─────────────────────────────────────────────────────────
  // Metadata only. The bytes live in Neon Object Storage and are addressed by
  // (workflowId, filename) - never carried in the browser or in localStorage.
  datasets: [],          // [{filename, row_count, columns, category, spec, applied, kind}]
  activeDataset: null,   // filename the downstream stages read

  // Column Configuration
  dateColumn: null,
  geoColumn: null,
  zipColumn: null,
  dmaColumn: null,
  dependentVariable: null,

  // ─── Legacy CSV payloads ────────────────────────────────────────────────────
  // TRANSITIONAL: EDA and everything after it still take a `csv_data` string.
  // Ingestion fills granularCsvData from /v2/.../csv on handoff. Once those
  // routers resolve datasets by id, these fields and the fetch both go away.
  mergedCsvData: null,
  filteredCsvData: null,
  transformedCsvData: null,
  granularCsvData: null,

  // Transformation Parameters
  transformationConfig: [],
  addCarryover: false,

  // Modelling
  selectedChannels: [],
  modellingStartDate: null,
  modellingEndDate: null,
  regressionOutputs: [],
  selectedModelIdx: null,

  // Response Curves
  responseCurves: {},
  responseCurveConfig: [],
  mergedRc: {},

  // Optimization
  optimizationResult: null,
};

const STORAGE_KEY = "proctimize_active_state";

// CSV payloads are megabytes and blow the ~5MB localStorage quota, which fails
// silently and loses the whole session. They are recoverable from the server by
// id, so they are never persisted.
const NEVER_PERSIST = [
  "mergedCsvData",
  "filteredCsvData",
  "transformedCsvData",
  "granularCsvData",
];

function persistable(state) {
  const out = { ...state };
  for (const key of NEVER_PERSIST) out[key] = null;
  return out;
}

export function AppProvider({ children }) {
  const [state, setState] = useState(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      return cached ? { ...initialState, ...JSON.parse(cached) } : initialState;
    } catch (e) {
      return initialState;
    }
  });

  // Keep local storage in sync. Quota failures are reported, not swallowed:
  // a silent failure here is how a session used to disappear on refresh.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(state)));
    } catch (e) {
      console.warn("Could not persist session state to localStorage:", e?.name || e);
    }
  }, [state]);

  const setField = useCallback((key, value) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setFields = useCallback((patch) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Re-hydrate from a workflow record fetched from the server.
  const loadWorkflowState = useCallback((workflow) => {
    const saved = workflow.state_data || {};
    const hydrated = {
      ...initialState,
      ...saved,
      workflowId: workflow.id,
      workflowName: workflow.workflow_name || workflow.name || saved.workflowName || null,
    };
    setState(hydrated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(hydrated)));
    } catch (e) {
      console.warn("Could not persist restored workflow:", e?.name || e);
    }
  }, []);

  // Snapshot to the server. Sends metadata only - the datasets themselves are
  // already durable in Postgres + Object Storage.
  const saveWorkflowSnapshot = useCallback(
    async (stageName, routePath, moduleStatusUpdates = {}) => {
      if (!state.workflowId) return;
      try {
        await v1PatchWorkflow(state.workflowId, {
          state: "running",
          state_data: {
            ...persistable(state),
            current_stage: stageName,
            current_route: routePath,
            module_status: moduleStatusUpdates,
          },
        });
      } catch (err) {
        console.error("Auto-save workflow failed:", err);
      }
    },
    [state]
  );

  const resetWorkflow = useCallback(() => {
    setState(initialState);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        setField,
        setFields,
        setState,
        loadWorkflowState,
        saveWorkflowSnapshot,
        resetWorkflow,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export const useAppState = () => useContext(AppContext);
