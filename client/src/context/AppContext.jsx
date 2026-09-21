import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { v1PatchWorkflow } from "../services/api";

const AppContext = createContext(null);

// In client/src/context/AppContext.jsx

const initialState = {
  // Workflow Entity Tracking
  workflowId: null,
  workflowName: null,

  // Ingestion (v2)
  datasets: [],
  activeDataset: null,

  // ARD Tracking & Stitching State Persistence
  savedArds: [],
  stitchingSteps: null,
  stitchingSourceFiles: null,

  // Column Configuration & Ingestion Roles
  columnRoles: {},
  columnPromoTiers: {},
  dateColumn: null,
  geoColumn: null,
  zipColumn: null,
  dmaColumn: null,
  dependentVariable: null,

  // Economic Unit Value Configuration (Default: $100 / TRx)
  unitValue: 100,
  unitValueLabel: "Revenue Per TRx ($)",

  // CSV payloads
  mergedCsvData: null,
  filteredCsvData: null,
  transformedCsvData: null,
  granularCsvData: null,

  // Transformation Parameters
  transformationConfig: [],
  savedTransformationSets: [],
  addCarryover: false,
  modelSpecification: "linear_log",

  // Modelling
  selectedChannels: [],
  modellingStartDate: null,
  modellingEndDate: null,
  regressionOutputs: [],
  selectedModelIdx: null,

  // Module 7: Finalization, Results & Response Curves
  finalizedModelId: null,
  channelSpendMap: {},
  responseCurves: {},
  responseCurveConfig: [],
  mergedRc: {},

  // Module 8: Optimization & Scenario Planning
  optimizationResult: null,
  savedOptimizationScenarios: [],
};

const STORAGE_KEY = "proctimize_active_state";

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
