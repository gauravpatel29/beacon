import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { updateWorkflow } from "../services/api";

const AppContext = createContext(null);

const initialState = {
  // Workflow Entity Tracking
  workflowId: null,
  workflowName: null,

  // Multi-file Ingestion Store
  ingestedFiles: [],

  // Saved ARD Datasets Registry (HCP, DMA, Custom with user names)
  savedArds: [],

  // Active Datasets
  fileData: [],
  mergedCsvData: null,
  filteredCsvData: null,
  transformedCsvData: null,
  granularCsvData: null,

  // Column Configuration
  dateColumn: null,
  geoColumn: null,
  zipColumn: null,
  dmaColumn: null,
  dependentVariable: null,

  // Granularity
  detectedGranularity: null,
  targetGranularity: null,

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

  // Module Progress Status
  moduleStatus: {
    ingestion: "pending",
    ard_stitching: "pending",
    eda: "pending",
    transformation: "pending",
    modelling: "pending",
    results: "pending",
    response_curves: "pending",
    optimization: "pending",
  },
};

export function AppProvider({ children }) {
  const [state, setState] = useState(() => {
    try {
      const cached = localStorage.getItem("proctimize_active_state");
      return cached ? JSON.parse(cached) : initialState;
    } catch (e) {
      return initialState;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("proctimize_active_state", JSON.stringify(state));
    } catch (e) {}
  }, [state]);

  const setField = useCallback((key, value) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const loadWorkflowState = useCallback((workflow) => {
    const savedState = workflow.state_data || {};
    const hydrated = {
      ...initialState,
      ...savedState,
      workflowId: workflow.id,
      workflowName: workflow.name || workflow.workflow_name,
      moduleStatus: workflow.module_status || savedState.moduleStatus || initialState.moduleStatus,
    };
    setState(hydrated);
    localStorage.setItem("proctimize_active_state", JSON.stringify(hydrated));
  }, []);

  const saveWorkflowSnapshot = useCallback(
    async (stageName, routePath, moduleStatusUpdates = {}) => {
      if (!state.workflowId) return;

      const updatedModuleStatus = {
        ...(state.moduleStatus || {}),
        ...moduleStatusUpdates,
      };

      setState((prev) => ({
        ...prev,
        moduleStatus: updatedModuleStatus,
      }));

      try {
        await updateWorkflow(state.workflowId, {
          name: state.workflowName,
          current_stage: stageName,
          current_route: routePath,
          module_status: updatedModuleStatus,
          state_data: {
            ...state,
            moduleStatus: updatedModuleStatus,
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
    localStorage.removeItem("proctimize_active_state");
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        setField,
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