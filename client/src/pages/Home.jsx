import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useAppState } from "../context/AppContext";
import {
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
} from "../services/api";

const PIPELINE_MODULES = [
  {
    stage: "Data Ingestion",
    path: "/ingestion",
    icon: "📂",
    desc: "Bulk ingest multi-grain source files (Sales, HCP promo, DMA media, Crosswalks) and map roles.",
  },
  {
    stage: "Exploratory Data Analysis",
    path: "/eda",
    icon: "🔍",
    desc: "Summary statistics, multi-variable indexed trends, histograms, scatter plots, and multicollinearity treatment.",
  },
  {
    stage: "Data Transformation",
    path: "/transformation",
    icon: "⚙️",
    desc: "Apply Adstock decay, saturation functions (Log/Power), lag effects, and Optuna parameter search.",
  },
  {
    stage: "MMM Modelling",
    path: "/modelling",
    icon: "🤖",
    desc: "Run OLS & Ridge regressions with two-stage decomposition, attribution waterfalls, and cross-validation.",
  },
  {
    stage: "Model Results",
    path: "/results",
    icon: "📋",
    desc: "Compare model iterations, attribution percentages, ROI, and long-term channel multiplier metrics.",
  },
  {
    stage: "Response Curves",
    path: "/response-curves",
    icon: "📈",
    desc: "Simulate channel spend vs. impact curves and inspect marginal ROI (mROI) saturation ceilings.",
  },
  {
    stage: "Optimization",
    path: "/optimization",
    icon: "🎯",
    desc: "Allocate marketing budgets or target sales goals across channels using marginal ROI optimization.",
  },
];

export default function Home() {
  const navigate = useNavigate();
  const { state, resetWorkflow, loadWorkflowState, setField } = useAppState();

  const [showWorkflowsModal, setShowWorkflowsModal] = useState(false);
  const [showNewWorkflowModal, setShowNewWorkflowModal] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [workflowsList, setWorkflowsList] = useState([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [sortOption, setSortOption] = useState("updated_desc");
  const [stageFilter, setStageFilter] = useState("all");

  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const fetchWorkflows = async () => {
    setLoadingWorkflows(true);
    try {
      const res = await listWorkflows();
      setWorkflowsList(res?.workflows || []);
    } catch (err) {
      console.warn("Could not fetch workflows:", err);
    } finally {
      setLoadingWorkflows(false);
    }
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  useEffect(() => {
    if (showWorkflowsModal) {
      fetchWorkflows();
    }
  }, [showWorkflowsModal]);

  // ─── Start New Workflow with Auto-Fallback ──────────────────────────────────
  const handleStartNewWorkflow = async (e) => {
    e?.preventDefault();
    setActionLoading(true);
    try {
      resetWorkflow();
      const defaultName = `MMM Analysis — ${new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })} ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
      const wfName = newWorkflowName.trim() || defaultName;

      const payload = {
        name: wfName,
        current_stage: "Data Ingestion",
        current_route: "/ingestion",
        module_status: {
          ingestion: "in_progress",
          eda: "pending",
          transformation: "pending",
          modelling: "pending",
          results: "pending",
          response_curves: "pending",
          optimization: "pending",
        },
        state_data: {},
      };

      let createdId = `wf_${Date.now().toString(36)}`;
      try {
        const created = await createWorkflow(payload);
        if (created && created.id) {
          createdId = created.id;
        }
      } catch (apiErr) {
        console.warn("Backend workflow endpoint not responding yet, initializing session locally:", apiErr);
      }

      setField("workflowId", createdId);
      setField("workflowName", wfName);
      toast.success(`Created workflow: "${wfName}"`);
      setShowNewWorkflowModal(false);
      navigate("/ingestion");
    } catch (err) {
      console.error("Workflow creation error:", err);
      toast.error("Could not initialize workflow session");
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Resume Workflow ────────────────────────────────────────────────────────
  const handleResumeWorkflow = async (wfSummary) => {
    setActionLoading(true);
    try {
      const fullWf = await getWorkflow(wfSummary.id);
      loadWorkflowState(fullWf);
      toast.success(`Resumed "${fullWf.name}" at ${fullWf.current_stage || "Data Ingestion"}`);
      setShowWorkflowsModal(false);
      const targetRoute = fullWf.current_route || "/ingestion";
      navigate(targetRoute);
    } catch (err) {
      toast.error("Failed to load workflow state");
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Delete Workflow ────────────────────────────────────────────────────────
  const handleDeleteWorkflow = async (e, wfId, wfName) => {
    e.stopPropagation();
    if (!window.confirm(`Permanently delete workflow "${wfName}"?`)) return;
    try {
      await deleteWorkflow(wfId);
      setWorkflowsList((prev) => prev.filter((w) => w.id !== wfId));
      toast.success("Workflow deleted");
      if (state.workflowId === wfId) {
        resetWorkflow();
      }
    } catch (err) {
      toast.error("Failed to delete workflow");
    }
  };

  // ─── Rename Workflow ────────────────────────────────────────────────────────
  const handleSaveRename = async (e, wfId) => {
    e.stopPropagation();
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await updateWorkflow(wfId, { name: renameValue.trim() });
      setWorkflowsList((prev) =>
        prev.map((w) => (w.id === wfId ? { ...w, name: renameValue.trim() } : w))
      );
      if (state.workflowId === wfId) {
        setField("workflowName", renameValue.trim());
      }
      toast.success("Workflow renamed");
      setRenamingId(null);
    } catch (err) {
      toast.error("Failed to rename workflow");
    }
  };

  const formatDate = (isoStr) => {
    if (!isoStr) return "—";
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return isoStr;
    }
  };
  
const getProgressCount = (moduleStatus = {}) => {
    const modules = [
      "ingestion", 
      "ard_stitching", 
      "eda", 
      "transformation", 
      "modelling", 
      "results", 
      "response_curves", 
      "optimization"
    ];
    const completed = modules.filter((m) => moduleStatus[m] === "completed").length;
    return { completed, total: modules.length, pct: Math.round((completed / modules.length) * 100) };
  };

  const filteredWorkflows = useMemo(() => {
    let list = [...workflowsList];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (w) =>
          (w.name && w.name.toLowerCase().includes(q)) ||
          (w.id && w.id.toLowerCase().includes(q)) ||
          (w.current_stage && w.current_stage.toLowerCase().includes(q))
      );
    }

    if (stageFilter !== "all") {
      list = list.filter((w) => w.current_stage === stageFilter);
    }

    list.sort((a, b) => {
      if (sortOption === "updated_desc") {
        return (b.updated_at || "").localeCompare(a.updated_at || "");
      }
      if (sortOption === "created_desc") {
        return (b.created_at || "").localeCompare(a.created_at || "");
      }
      if (sortOption === "name_asc") {
        return (a.name || "").localeCompare(b.name || "");
      }
      if (sortOption === "progress_desc") {
        const pA = getProgressCount(a.module_status).completed;
        const pB = getProgressCount(b.module_status).completed;
        return pB - pA;
      }
      return 0;
    });

    return list;
  }, [workflowsList, searchQuery, stageFilter, sortOption]);

  const uniqueStages = useMemo(() => {
    const s = new Set(workflowsList.map((w) => w.current_stage).filter(Boolean));
    return Array.from(s);
  }, [workflowsList]);

  const recentWorkflows = useMemo(() => {
    return [...workflowsList]
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
      .slice(0, 3);
  }, [workflowsList]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#001E96] via-[#0028B8] to-[#001060] flex flex-col font-sans selection:bg-[#1ABC9C] selection:text-white">
      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center flex-1 px-6 py-20 text-center max-w-5xl mx-auto w-full">
        <div className="inline-flex items-center gap-2.5 bg-white/10 backdrop-blur-md text-white/90 text-xs px-4 py-2 rounded-full mb-6 border border-white/20 shadow-lg">
          <span className="w-2.5 h-2.5 bg-[#1ABC9C] rounded-full animate-pulse shadow-sm shadow-[#1ABC9C]" />
          Marketing Mix Modeling Platform • Enterprise Analytics
        </div>

        <h1 className="text-5xl sm:text-6xl md:text-7xl font-black text-white tracking-tight mb-4 drop-shadow-md">
          Proc<span className="text-[#1ABC9C]">Timize</span>
        </h1>

        <p className="text-white/70 text-base sm:text-lg max-w-2xl mx-auto mb-10 leading-relaxed font-normal">
          End-to-end Marketing Mix Modeling suite. Ingest raw datasets, run transparent exploratory analyses, apply nonlinear adstock curves, and optimize marketing ROI.
        </p>

        {/* Primary CTAs */}
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-center w-full max-w-md">
          <button
            type="button"
            onClick={() => {
              setNewWorkflowName("");
              setShowNewWorkflowModal(true);
            }}
            className="w-full sm:w-1/2 bg-[#1ABC9C] hover:bg-[#17a589] text-white font-bold px-7 py-4 rounded-2xl text-sm transition-all duration-200 shadow-xl shadow-[#1ABC9C]/30 hover:scale-105 active:scale-95 flex items-center justify-center gap-2 border border-[#1ABC9C]"
          >
            <span>✨</span>
            <span>Start New Workflow</span>
          </button>

          <button
            type="button"
            onClick={() => setShowWorkflowsModal(true)}
            className="w-full sm:w-1/2 bg-white/15 hover:bg-white/25 text-white font-semibold px-7 py-4 rounded-2xl text-sm transition-all duration-200 border border-white/20 backdrop-blur-md shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
          >
            <span>📂</span>
            <span>Continue Existing</span>
            {workflowsList.length > 0 && (
              <span className="bg-white/20 text-white text-[11px] font-bold px-2 py-0.5 rounded-full ml-1">
                {workflowsList.length}
              </span>
            )}
          </button>
        </div>

        {/* Active Workspace Banner */}
        {state.workflowId && (
          <div className="mt-8 bg-white/10 hover:bg-white/15 transition-all p-3.5 px-6 rounded-2xl border border-white/20 text-xs text-white/90 backdrop-blur-md flex items-center justify-between gap-4 max-w-xl w-full shadow-lg">
            <div className="flex items-center gap-2.5 truncate text-left">
              <span className="text-base">⚡</span>
              <div className="truncate">
                <span className="text-white/50 block text-[10px] uppercase font-bold tracking-wider">Active Workspace</span>
                <span className="font-bold text-sm text-white truncate">{state.workflowName || "Current Session"}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate("/ingestion")}
              className="bg-[#1ABC9C] hover:bg-[#17a589] text-white font-bold px-4 py-2 rounded-xl text-xs shadow-md transition-all whitespace-nowrap"
            >
              Resume Active →
            </button>
          </div>
        )}

        {/* Recent Workflows */}
        {recentWorkflows.length > 0 && (
          <div className="mt-12 w-full text-left">
            <div className="flex justify-between items-center mb-3 text-xs text-white/60 font-semibold px-1">
              <span>Recent Workflows</span>
              <button
                type="button"
                onClick={() => setShowWorkflowsModal(true)}
                className="text-[#1ABC9C] hover:underline"
              >
                View all ({workflowsList.length}) →
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              {recentWorkflows.map((wf) => {
                const progress = getProgressCount(wf.module_status);
                return (
                  <div
                    key={wf.id}
                    onClick={() => handleResumeWorkflow(wf)}
                    className="bg-white/10 hover:bg-white/20 border border-white/15 hover:border-white/30 rounded-2xl p-4 transition-all duration-200 cursor-pointer text-left backdrop-blur-md shadow-md group"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#1ABC9C]/20 text-[#1ABC9C] border border-[#1ABC9C]/30">
                        {wf.current_stage || "Data Ingestion"}
                      </span>
                      <span className="text-[10px] text-white/40">{progress.completed}/7 Steps</span>
                    </div>
                    <div className="font-bold text-sm text-white truncate group-hover:text-[#1ABC9C] transition-colors mb-1">
                      {wf.name}
                    </div>
                    <div className="text-[11px] text-white/50 truncate">
                      Updated: {formatDate(wf.updated_at)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Modules Grid */}
      <div className="bg-slate-50 px-8 py-16 border-t border-slate-200/60 shadow-2xl">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-black text-slate-800 tracking-tight">
              Full Marketing Mix Modeling Pipeline
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              A structured 7-module workflow engineered for healthcare, retail, and multi-channel brand analytics.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {PIPELINE_MODULES.map((m, idx) => (
              <div
                key={m.path}
                className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:border-[#001E96]/30 hover:shadow-md transition-all duration-200 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-2xl">{m.icon}</span>
                    <span className="text-[10px] font-bold text-slate-400 font-mono">
                      Module {idx + 2}
                    </span>
                  </div>
                  <h3 className="font-bold text-sm text-slate-800 mb-1">{m.stage}</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">{m.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-slate-50 text-center py-6 text-xs text-slate-400 border-t border-slate-100">
        © 2026 ProcDNA. All rights reserved. • ProcTimize Marketing Mix Modeling Platform
      </div>

      {/* MODAL 1: Start New Workflow */}
      {showNewWorkflowModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl max-w-md w-full p-7 shadow-2xl space-y-6">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">✨</span>
                <div>
                  <h3 className="text-lg font-black text-slate-800 tracking-tight">
                    Start New Workflow
                  </h3>
                  <p className="text-xs text-slate-400">Initialize a fresh modeling session</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNewWorkflowModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 text-sm rounded-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleStartNewWorkflow} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                  Workflow Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Q4 Brand Marketing Mix Model"
                  value={newWorkflowName}
                  onChange={(e) => setNewWorkflowName(e.target.value)}
                  autoFocus
                  className="w-full text-xs font-medium border border-slate-200 rounded-xl px-3.5 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50 focus:bg-white text-slate-800"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Leave blank to auto-generate a timestamped name.
                </p>
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3.5 text-[11px] text-blue-900 space-y-1">
                <span className="font-bold block">🚀 What happens next?</span>
                <p className="text-blue-800 leading-relaxed">
                  A new workflow record will be created. You will be routed into <strong>Module 2 (Data Ingestion)</strong> to upload and categorize your datasets.
                </p>
              </div>

              <div className="pt-2 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowNewWorkflowModal(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-6 py-2.5 rounded-xl text-xs font-bold text-white bg-[#001E96] hover:bg-[#0028B8] shadow-md shadow-[#001E96]/20 transition-all disabled:opacity-50"
                >
                  {actionLoading ? "Initializing…" : "Begin Ingestion →"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Continue Existing Workflow */}
      {showWorkflowsModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl max-w-4xl w-full p-7 shadow-2xl space-y-5 max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-3">
                <span className="text-3xl">📂</span>
                <div>
                  <h3 className="text-xl font-black text-slate-800 tracking-tight">
                    Continue Existing Workflow
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Select a prior analysis to resume exactly at the step and state you left off.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWorkflowsModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1.5 text-sm rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                placeholder="Search by workflow name or ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50 focus:bg-white"
              />

              <select
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50 focus:bg-white font-medium text-slate-700"
              >
                <option value="all">All Stages ({workflowsList.length})</option>
                {uniqueStages.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>

              <select
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50 focus:bg-white font-medium text-slate-700"
              >
                <option value="updated_desc">Sort: Last Modified (Newest first)</option>
                <option value="created_desc">Sort: Created Date (Newest first)</option>
                <option value="name_asc">Sort: Workflow Name (A-Z)</option>
                <option value="progress_desc">Sort: Highest Progress Completed</option>
              </select>
            </div>

            <div className="flex-1 overflow-y-auto rounded-2xl border border-slate-100 shadow-sm max-h-[420px]">
              {loadingWorkflows ? (
                <div className="py-16 text-center text-slate-400">
                  <div className="w-8 h-8 border-3 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-xs font-medium">Fetching saved workflows…</p>
                </div>
              ) : filteredWorkflows.length === 0 ? (
                <div className="py-16 text-center text-slate-400 space-y-3">
                  <span className="text-4xl block">🔍</span>
                  <p className="text-sm font-bold text-slate-700">No workflows found</p>
                  <p className="text-xs text-slate-400">
                    {searchQuery ? "No workflows match your search query." : "You haven't created any workflows yet."}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowWorkflowsModal(false);
                      setShowNewWorkflowModal(true);
                    }}
                    className="text-xs text-[#1ABC9C] font-bold underline hover:text-[#17a589]"
                  >
                    Start a New Workflow Now →
                  </button>
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-100 text-slate-600 sticky top-0 z-10">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Workflow Name</th>
                      <th className="px-4 py-3 font-semibold">Current Stage</th>
                      <th className="px-4 py-3 font-semibold">Progress</th>
                      <th className="px-4 py-3 font-semibold">Last Modified</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 bg-white">
                    {filteredWorkflows.map((wf) => {
                      const progress = getProgressCount(wf.module_status);
                      const isRenaming = renamingId === wf.id;

                      return (
                        <tr
                          key={wf.id}
                          onClick={() => !isRenaming && handleResumeWorkflow(wf)}
                          className="hover:bg-slate-50/80 cursor-pointer transition-colors group"
                        >
                          <td className="px-5 py-3.5">
                            {isRenaming ? (
                              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  autoFocus
                                  className="text-xs font-bold border border-brand-500 rounded-lg px-2 py-1 bg-white focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={(e) => handleSaveRename(e, wf.id)}
                                  className="text-xs bg-brand-600 text-white px-2 py-1 rounded-md font-bold"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingId(null);
                                  }}
                                  className="text-xs text-slate-400 p-1"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-slate-800 text-sm group-hover:text-[#001E96] transition-colors">
                                    {wf.name}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRenamingId(wf.id);
                                      setRenameValue(wf.name);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-slate-600 text-[11px] p-0.5"
                                    title="Rename workflow"
                                  >
                                    ✏️
                                  </button>
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                  ID: {wf.id} • Created: {formatDate(wf.created_at)}
                                </div>
                              </div>
                            )}
                          </td>

                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-100">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse" />
                              {wf.current_stage || "Data Ingestion"}
                            </span>
                          </td>

                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <div className="w-28 space-y-1">
                              <div className="flex justify-between text-[10px] font-bold text-slate-500">
                                <span>{progress.completed}/7 Modules</span>
                                <span>{progress.pct}%</span>
                              </div>
                              <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                                <div
                                  className="bg-[#1ABC9C] h-full rounded-full transition-all"
                                  style={{ width: `${Math.max(5, progress.pct)}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-3.5 text-slate-500 whitespace-nowrap">
                            {formatDate(wf.updated_at)}
                          </td>

                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResumeWorkflow(wf);
                                }}
                                className="px-3.5 py-1.5 rounded-xl bg-[#001E96] text-white text-xs font-bold hover:bg-[#0028B8] shadow-sm transition-all"
                              >
                                Resume →
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteWorkflow(e, wf.id, wf.name)}
                                className="p-1.5 text-slate-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                                title="Delete workflow"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
              <span className="text-xs text-slate-400">
                Total saved workflows: <strong>{workflowsList.length}</strong>
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowWorkflowsModal(false);
                    setShowNewWorkflowModal(true);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-[#001E96] bg-brand-50 hover:bg-brand-100 transition-colors"
                >
                  + Start New Instead
                </button>
                <button
                  type="button"
                  onClick={() => setShowWorkflowsModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}