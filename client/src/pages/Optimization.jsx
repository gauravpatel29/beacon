import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line
} from "recharts";
import { runOptimization, generateResponseCurves } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, Metric } from "../components/UI";

export default function Optimization() {
  const { state, setField, saveWorkflowSnapshot } = useAppState();

  // ─── 1. Finalized Model Linkage ──────────────────────────────────────────
  const outputs = state.regressionOutputs || [];
  const finalizedModelId = state.finalizedModelId;
  const finalizedModel = outputs.find((m) => m.id === finalizedModelId) || outputs[0] || null;

  const currentSpendMap = state.channelSpendMap || {};
  const storedMergedRc = state.mergedRc || {};
  const storedRcData = state.responseCurves || {};

  // Build effectiveMergedRc dynamically from responseCurves or stored mergedRc
  const effectiveMergedRc = useMemo(() => {
    if (Object.keys(storedMergedRc).length > 0) return storedMergedRc;
    if (Object.keys(storedRcData).length > 0) {
      const built = {};
      Object.entries(storedRcData).forEach(([ch, rows]) => {
        built[`${ch}_spend`] = rows.map((r) => r.spend);
        built[`${ch}_impactable_nation`] = rows.map((r) => r.impactable_nation);
        built[`${ch}_roi`] = rows.map((r) => r.roi);
        built[`${ch}_mroi`] = rows.map((r) => r.mroi);
      });
      return built;
    }
    return {};
  }, [storedMergedRc, storedRcData]);

  // Extract channel names from response curves, mergedRc, or model coefficients
  const channels = useMemo(() => {
    const fromRc = Object.keys(effectiveMergedRc)
      .filter((k) => k.endsWith("_spend"))
      .map((k) => k.replace("_spend", ""));
    if (fromRc.length) return fromRc;
    if (Object.keys(storedRcData).length) return Object.keys(storedRcData);
    if (finalizedModel?.coefficients) {
      return finalizedModel.coefficients
        .filter((r) => r.Note !== "Intercept" && r.Variable !== "const")
        .map((r) => r.Variable.replace("_transformed", ""));
    }
    return [];
  }, [effectiveMergedRc, storedRcData, finalizedModel]);

  // Auto-generate response curves in background if missing
  const [autoGeneratingRc, setAutoGeneratingRc] = useState(false);
  useEffect(() => {
    if (Object.keys(effectiveMergedRc).length === 0 && finalizedModel?.coefficients?.length) {
      setAutoGeneratingRc(true);
      const channelPayload = finalizedModel.coefficients
        .filter((r) => r.Note !== "Intercept" && r.Variable !== "const")
        .map((r) => {
          const rawName = r.Variable.replace("_transformed", "");
          const spend = Number(currentSpendMap[rawName]) || Number(r.Spend) || 50000;
          const impact = Number(r["Impactable Sales"]) || 90000;
          return {
            name: rawName,
            impactable_sales_nation: impact,
            beta_coeff: Number(r.Coefficient) || 0.005,
            spend_nation: spend,
            start: 0,
            stop: Math.round(spend * 3.0) || 300000,
            step: Math.round(Math.max(1000, (spend * 3.0) / 50)),
            price: 1,
            saturation_function: "log",
            power_value: 0.5,
          };
        });

      if (channelPayload.length > 0) {
        generateResponseCurves({ channels: channelPayload, num_time: 12, num_geo: 100 })
          .then((res) => {
            const curves = res.curves || {};
            setField("responseCurves", curves);
            const built = {};
            Object.entries(curves).forEach(([ch, rows]) => {
              built[`${ch}_spend`] = rows.map((r) => r.spend);
              built[`${ch}_impactable_nation`] = rows.map((r) => r.impactable_nation);
              built[`${ch}_roi`] = rows.map((r) => r.roi);
              built[`${ch}_mroi`] = rows.map((r) => r.mroi);
            });
            setField("mergedRc", built);
          })
          .catch(() => {})
          .finally(() => setAutoGeneratingRc(false));
      } else {
        setAutoGeneratingRc(false);
      }
    }
  }, [effectiveMergedRc, finalizedModel, currentSpendMap, setField]);

  // ─── 2. Scenario Creation State ──────────────────────────────────────────
  const [scenarioName, setScenarioName] = useState("Q1 Budget Optimization");
  const [scenarioType, setScenarioType] = useState("fixed_budget"); // "fixed_budget" | "fixed_goal"
  const [targetValue, setTargetValue] = useState(100000);

  // ─── 3. Channel Constraints (Completely User Editable) ───────────────────
  const [channelBounds, setChannelBounds] = useState([]);

  // Initialize constraints ONLY ONCE when channels arrive (No overwrite loops)
  useEffect(() => {
    if (!channels.length) return;
    setChannelBounds((prev) => {
      if (prev.length === channels.length) return prev; // Preserve existing user edits!
      return channels.map((ch) => {
        const curSpend = Number(currentSpendMap[ch]) || 50000;
        return {
          channel: ch,
          min: 0, // Default to $0 so optimizer is free unless user raises it
          max: Math.round(curSpend * 2.0) || 150000,
          currentSpend: curSpend,
        };
      });
    });
  }, [channels, currentSpendMap]);

  // User manual editing of Min and Max inputs
  const updateBound = (idx, field, value) => {
    const num = value === "" ? "" : Math.max(0, parseInt(value, 10) || 0);
    setChannelBounds((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: num };
      return next;
    });
  };

  const setAllMinToZero = () => {
    setChannelBounds((prev) => prev.map((b) => ({ ...b, min: 0 })));
    toast.success("Set all Min constraints to $0 (Channels can be optimized to zero if inefficient).");
  };

  const applyConstraintPreset = (multiplierMin, multiplierMax) => {
    setChannelBounds((prev) =>
      prev.map((b) => ({
        ...b,
        min: Math.round(b.currentSpend * multiplierMin),
        max: Math.round(b.currentSpend * multiplierMax),
      }))
    );
    toast.success(`Set bounds to [${Math.round(multiplierMin * 100)}% – ${Math.round(multiplierMax * 100)}%] of current spend.`);
  };

  // ─── 4. Current Baseline Metrics Calculation ──────────────────────────────
  const currentBaselineSummary = useMemo(() => {
    if (!channelBounds.length) return { totalSpend: 0, estimatedSales: 0, baselineRoi: 0 };
    let totalSpend = 0;
    let estimatedSales = 0;

    channelBounds.forEach((b) => {
      const spend = b.currentSpend || 0;
      totalSpend += spend;
      const chCurve = storedRcData[b.channel] || [];
      if (chCurve.length > 0) {
        let closest = chCurve[0];
        let minDiff = Infinity;
        chCurve.forEach((pt) => {
          const diff = Math.abs(pt.spend - spend);
          if (diff < minDiff) {
            minDiff = diff;
            closest = pt;
          }
        });
        estimatedSales += (closest?.impactable_nation || (spend * 1.8));
      } else {
        estimatedSales += (spend * 1.8);
      }
    });

    const baselineRoi = totalSpend > 0 ? (estimatedSales / totalSpend) : 0;
    return {
      totalSpend,
      estimatedSales: Math.round(estimatedSales),
      baselineRoi: Number(baselineRoi.toFixed(3)),
    };
  }, [channelBounds, storedRcData]);

  // ─── 5. Optimizer Execution State ─────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [optResult, setOptResult] = useState(() => state.optimizationResult || null);
  const [savedScenarios, setSavedScenarios] = useState(() => state.savedOptimizationScenarios || []);

  const handleRunOptimizer = async () => {
    if (!channels.length) return toast.error("No channels available. Complete Module 7 first.");
    if (!targetValue || targetValue <= 0) return toast.error("Enter a valid target value.");

    // Validate bounds
    for (let i = 0; i < channelBounds.length; i++) {
      const b = channelBounds[i];
      const minVal = Number(b.min) || 0;
      const maxVal = Number(b.max) || 0;
      if (minVal > maxVal) {
        return toast.error(`Constraint error for ${b.channel}: Min spend ($${minVal.toLocaleString()}) exceeds Max spend ($${maxVal.toLocaleString()}).`);
      }
    }

    setLoading(true);
    setOptResult(null);

    // Build user-defined optimizer constraints
    const optimizerDict = {};
    channelBounds.forEach((b) => {
      optimizerDict[b.channel] = {
        min: Number(b.min) || 0,
        max: Number(b.max) || 500000,
        currentSpend: b.currentSpend,
      };
    });

    try {
      const data = await runOptimization({
        merged_rc: effectiveMergedRc,
        optimizer_dict: optimizerDict,
        target: parseFloat(targetValue),
        opt_type: scenarioType === "fixed_budget" ? "Budget Goal" : "Sales Goal",
        k: 1,
        scenario_name: scenarioName.trim() || "Optimization Scenario",
      });

      setOptResult(data);
      setField("optimizationResult", data);

      if (data.feasible === false) {
        toast.error(`Goal Unreachable: ${data.message || "Target outcome exceeds maximum bound capacity."}`, { duration: 6000 });
      } else if (data.converged) {
        toast.success("✅ Optimization converged! Optimal allocation found.");
      } else {
        toast("⚠️ Optimization completed at boundary limit.", { icon: "ℹ️" });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || "Optimization calculation failed.");
    } finally {
      setLoading(false);
    }
  };

  // ─── 6. Save Scenario to History ──────────────────────────────────────────
  const handleSaveScenario = async () => {
    if (!optResult) return toast.error("Run optimization before saving scenario.");

    const newScenario = {
      id: `scen_${Date.now()}`,
      scenarioName: scenarioName.trim() || `Scenario v${savedScenarios.length + 1}`,
      scenarioType: scenarioType === "fixed_budget" ? "Fixed Budget" : "Fixed Goal",
      targetValue,
      modelUsed: finalizedModel?.modelName || finalizedModel?.name || "Finalized Model",
      createdAt: new Date().toISOString(),
      currentPlan: { ...currentBaselineSummary },
      optimizedPlan: {
        totalSpend: optResult.total_spend || optResult.final_value,
        totalSales: optResult.total_sales || optResult.final_sales,
        roi: optResult.optimized_roi || (optResult.total_sales / optResult.total_spend),
      },
      allocation: optResult.allocation || {},
      status: optResult.feasible !== false ? "Optimal" : "Infeasible Target",
    };

    const updatedScenarios = [newScenario, ...savedScenarios.filter((s) => s.scenarioName !== newScenario.scenarioName)];
    setSavedScenarios(updatedScenarios);
    setField("savedOptimizationScenarios", updatedScenarios);

    await saveWorkflowSnapshot("Optimization", "/optimization", {
      optimization: "completed",
    });

    toast.success(`Scenario "${newScenario.scenarioName}" saved to Scenario History!`);
  };

  const handleLoadScenarioFromHistory = (scen) => {
    setScenarioName(scen.scenarioName);
    setScenarioType(scen.scenarioType === "Fixed Budget" ? "fixed_budget" : "fixed_goal");
    setTargetValue(scen.targetValue);
    if (scen.allocation) {
      setOptResult({
        allocation: scen.allocation,
        total_spend: scen.optimizedPlan?.totalSpend,
        total_sales: scen.optimizedPlan?.totalSales,
        optimized_roi: scen.optimizedPlan?.roi,
        converged: true,
        feasible: scen.status === "Optimal",
      });
    }
    toast.success(`Loaded scenario "${scen.scenarioName}"`);
  };

  // ─── 7. Side-by-Side Comparison Dataset ───────────────────────────────────
  const comparisonData = useMemo(() => {
    if (!optResult || !optResult.allocation) return [];
    return Object.entries(optResult.allocation).map(([ch, vals]) => {
      const curSpend = Number(currentSpendMap[ch]) || 50000;
      const optSpend = Math.round(Number(vals.spend) || 0);
      const optImpact = Math.round(Number(vals.impactable_nation) || 0);
      const deltaSpend = optSpend - curSpend;
      const deltaPct = curSpend > 0 ? Math.round((deltaSpend / curSpend) * 100) : 0;
      const optRoi = optSpend > 0 ? Number((optImpact / optSpend).toFixed(2)) : 0;

      return {
        channel: ch.replace("_transformed", ""),
        currentSpend: curSpend,
        optimizedSpend: optSpend,
        deltaSpend,
        deltaPct,
        optimizedImpact: optImpact,
        optimizedRoi: optRoi,
      };
    });
  }, [optResult, currentSpendMap]);

  const totalOptimizedSpend = useMemo(() => {
    return comparisonData.reduce((s, r) => s + r.optimizedSpend, 0);
  }, [comparisonData]);

  const totalOptimizedSales = useMemo(() => {
    return comparisonData.reduce((s, r) => s + r.optimizedImpact, 0);
  }, [comparisonData]);

  const salesUplift = totalOptimizedSales - currentBaselineSummary.estimatedSales;
  const salesUpliftPct = currentBaselineSummary.estimatedSales > 0
    ? Number(((salesUplift / currentBaselineSummary.estimatedSales) * 100).toFixed(1))
    : 0;

  const hasCurves = Object.keys(effectiveMergedRc).length > 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Module 8: Scenario Planning &amp; Budget Optimization"
        subtitle="Allocate marketing budgets to maximize commercial impact, determine required spending for sales targets, customize channel constraints freely, and simulate scenarios"
        icon="🎯"
      />

      {/* ─── 1. Finalized Model Linkage ─────────────────────────────────── */}
      <Card title="1. Finalized Model Linkage">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center text-xl">
              🏆
            </div>
            <div>
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
                Active Source Model for Optimization:
              </span>
              <strong className="text-base text-slate-900 font-black">
                {finalizedModel?.modelName || finalizedModel?.name || "HCP Finalized Model"}
              </strong>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <span className="bg-purple-100 text-purple-800 font-bold px-3 py-1 rounded-full">
              Level: {finalizedModel?.modelLevel || "HCP"}
            </span>
            <span className="bg-blue-100 text-blue-800 font-bold px-3 py-1 rounded-full">
              Type: {finalizedModel?.modelType || "RIDGE"}
            </span>
            <span className="bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded-full flex items-center gap-1 border border-emerald-300">
              ✓ Model Finalized
            </span>
          </div>
        </div>

        {autoGeneratingRc && (
          <div className="mt-3 text-xs text-brand-600 font-bold animate-pulse">
            ⚡ Calibrating response curves from finalized model coefficients...
          </div>
        )}

        {!hasCurves && !autoGeneratingRc && (
          <div className="mt-4">
            <Alert type="warning">
              No response curve saturation schedules found for this model. Verify response curves in Module 7.
            </Alert>
          </div>
        )}
      </Card>

      {/* ─── 2. Create Scenario & Scenario Type ────────────────────────────── */}
      <Card title="2. Create Optimization Scenario">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Scenario Name *
            </label>
            <input
              type="text"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              placeholder="e.g. Q1 Budget Optimization or TRx Growth Plan"
              className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3.5 py-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Scenario Objective Type *
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setScenarioType("fixed_budget")}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  scenarioType === "fixed_budget"
                    ? "border-[#001E96] bg-brand-50/60 shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <span className="text-sm font-bold text-slate-900 block">💰 Fixed Budget</span>
                <span className="text-[10px] text-slate-500">Maximize sales given a total budget limit</span>
              </button>

              <button
                type="button"
                onClick={() => setScenarioType("fixed_goal")}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  scenarioType === "fixed_goal"
                    ? "border-[#001E96] bg-brand-50/60 shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <span className="text-sm font-bold text-slate-900 block">🎯 Fixed Goal</span>
                <span className="text-[10px] text-slate-500">Minimize spend to reach a target sales volume</span>
              </button>
            </div>
          </div>
        </div>

        {/* Target Input */}
        <div className="mt-5 pt-4 border-t border-slate-100 max-w-md">
          <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
            {scenarioType === "fixed_budget" ? "Total Available Budget ($) *" : "Target Sales / Outcome Lift (Units) *"}
          </label>
          <input
            type="number"
            step={scenarioType === "fixed_budget" ? "5000" : "1000"}
            min="1"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
            className="w-full text-sm font-black border-2 border-brand-500 rounded-xl px-4 py-2.5 bg-white text-slate-900 focus:outline-none"
          />
          <span className="text-[11px] text-slate-400 mt-1 block">
            {scenarioType === "fixed_budget"
              ? "The optimizer will allocate this dollar budget across channels to maximize prescription volume."
              : "The optimizer will find the lowest possible budget required to generate this sales volume."}
          </span>
        </div>
      </Card>

      {/* ─── 3. Channel Constraints (Completely User-Editable) ─────────────── */}
      <Card title="3. Channel Constraints &amp; Bounds (Fully Customizable)">
        <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
          <p className="text-xs text-slate-500">
            Edit the <strong>Min ($)</strong> and <strong>Max ($)</strong> constraints freely for any channel. Setting Min to $0 allows the optimizer to cut underperforming channels completely.
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={setAllMinToZero}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200"
            >
              Set All Min to $0
            </button>
            <button
              type="button"
              onClick={() => applyConstraintPreset(0.8, 1.2)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700"
            >
              ±20% Bounds
            </button>
            <button
              type="button"
              onClick={() => applyConstraintPreset(0.5, 2.0)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700"
            >
              ±50% Bounds
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
              <tr>
                <th className="px-4 py-3">Promotional Channel</th>
                <th className="px-4 py-3">Current Plan Spend ($)</th>
                <th className="px-4 py-3">Min Constraint ($) [Editable]</th>
                <th className="px-4 py-3">Max Constraint ($) [Editable]</th>
                <th className="px-4 py-3 text-right">Allowed Boundary Range</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {channelBounds.map((b, idx) => (
                <tr key={b.channel} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-800">
                    {b.channel.replace("_transformed", "")}
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-600">
                    ${Number(b.currentSpend || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <span className="text-slate-400 font-bold">$</span>
                      <input
                        type="number"
                        step="1000"
                        min="0"
                        value={b.min}
                        onChange={(e) => updateBound(idx, "min", e.target.value)}
                        placeholder="0"
                        className="w-36 border-2 border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white focus:border-brand-500 focus:outline-none"
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <span className="text-slate-400 font-bold">$</span>
                      <input
                        type="number"
                        step="1000"
                        min="0"
                        value={b.max}
                        onChange={(e) => updateBound(idx, "max", e.target.value)}
                        placeholder="500000"
                        className="w-36 border-2 border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white focus:border-brand-500 focus:outline-none"
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] font-bold text-slate-700">
                    ${Number(b.min || 0).toLocaleString()} ➔ ${Number(b.max || 0).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Run Button */}
        <div className="mt-6 flex justify-end">
          <Btn
            onClick={handleRunOptimizer}
            disabled={loading || !channels.length}
            className="py-3 px-8 text-xs font-bold uppercase tracking-wider bg-[#001E96] hover:bg-[#0028B8] shadow-md"
          >
            {loading ? "Running Optimizer Engine…" : "▶ Run Optimization Optimizer"}
          </Btn>
        </div>
      </Card>

      {loading && <Spinner label="Solving non-linear marginal ROI optimization with custom constraints..." />}

      {/* ─── 4. Projected Results & Recommendations ───────────────────────── */}
      {optResult && (
        <div className="space-y-8">
          {/* Feasibility Alert */}
          {optResult.feasible === false && (
            <Alert type="error">
              <span className="font-bold block mb-1">❌ Goal Unreachable within Current Bounds</span>
              {optResult.message || `Given your maximum channel spend constraints, the highest achievable sales volume is ${optResult.max_possible_sales?.toLocaleString() || "lower than your target"}. Increase Max Spend constraints on high-ROI channels to reach this target.`}
            </Alert>
          )}

          {/* Scenario Summary Cards */}
          <Card title="4. Projected Scenario Performance &amp; Lift">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <Metric
                label="Scenario Status"
                value={optResult.feasible !== false ? "✅ Optimal Plan" : "⚠️ Infeasible Target"}
              />
              <Metric
                label={scenarioType === "fixed_budget" ? "Total Allocated Budget" : "Required Investment"}
                value={`$${Number(totalOptimizedSpend || 0).toLocaleString()}`}
              />
              <Metric
                label="Projected Total Sales Lift"
                value={`${Math.round(totalOptimizedSales || 0).toLocaleString()} Units`}
              />
              <div className="bg-emerald-50 rounded-xl px-5 py-4 text-center border border-emerald-200">
                <div className="text-2xl font-black text-emerald-700">
                  {salesUplift >= 0 ? `+${salesUplift.toLocaleString()}` : salesUplift.toLocaleString()}
                </div>
                <div className="text-xs text-emerald-600 mt-0.5 font-bold uppercase">
                  Sales Lift ({salesUpliftPct >= 0 ? `+${salesUpliftPct}%` : `${salesUpliftPct}%`})
                </div>
              </div>
            </div>

            {/* Current vs Optimized Allocation Comparison */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 mb-6">
              <span className="text-xs font-bold text-slate-700 block mb-4 uppercase tracking-wider">
                Spend Allocation Comparison: Current Plan (Blue) vs. Optimized Plan (Emerald)
              </span>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={comparisonData} margin={{ left: 20, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="channel" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <Legend />
                  <Bar dataKey="currentSpend" fill="#001E96" name="Current Plan Spend ($)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="optimizedSpend" fill="#1ABC9C" name="Optimized Spend ($)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Channel Recommendations Working Table */}
            <div>
              <span className="text-xs font-bold text-slate-700 block mb-3 uppercase tracking-wider">
                5. Channel Recommendations &amp; Spend Shift Working Table
              </span>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs text-left bg-white">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                    <tr>
                      <th className="px-4 py-3">Channel</th>
                      <th className="px-4 py-3">Current Spend</th>
                      <th className="px-4 py-3">Optimized Spend</th>
                      <th className="px-4 py-3">Budget Shift (Δ)</th>
                      <th className="px-4 py-3">Projected Impact</th>
                      <th className="px-4 py-3">Optimized ROI</th>
                      <th className="px-4 py-3 text-right">Budget Share (%)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {comparisonData.map((r) => (
                      <tr key={r.channel} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-bold text-slate-800">{r.channel}</td>
                        <td className="px-3 py-3 text-slate-500">${r.currentSpend.toLocaleString()}</td>
                        <td className="px-3 py-3 font-black text-brand-700">${r.optimizedSpend.toLocaleString()}</td>
                        <td className="px-3 py-3">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                            r.deltaSpend > 0
                              ? "bg-emerald-100 text-emerald-800"
                              : r.deltaSpend < 0
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-600"
                          }`}>
                            {r.deltaSpend > 0 ? `+$${r.deltaSpend.toLocaleString()} (+${r.deltaPct}%)` : r.deltaSpend < 0 ? `-$${Math.abs(r.deltaSpend).toLocaleString()} (${r.deltaPct}%)` : "No Change"}
                          </span>
                        </td>
                        <td className="px-3 py-3 font-semibold text-slate-700">{r.optimizedImpact.toLocaleString()} Units</td>
                        <td className="px-3 py-3 font-bold text-emerald-700">{r.optimizedRoi.toFixed(2)}x</td>
                        <td className="px-3 py-3 text-right font-mono text-slate-600">
                          {totalOptimizedSpend > 0 ? `${((r.optimizedSpend / totalOptimizedSpend) * 100).toFixed(1)}%` : "0%"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Save Scenario Bar */}
            <div className="mt-6 pt-4 border-t border-slate-200 flex justify-between items-center flex-wrap gap-4">
              <span className="text-xs text-slate-500">
                Save this plan to your workflow’s Scenario History for executive presentations and budget sign-off.
              </span>
              <div className="flex gap-3">
                <Btn
                  variant="outline"
                  onClick={() => {
                    const csvRows = [
                      "Channel,Current Spend,Optimized Spend,Delta Spend,Projected Impact,Optimized ROI",
                      ...comparisonData.map((r) => `${r.channel},${r.currentSpend},${r.optimizedSpend},${r.deltaSpend},${r.optimizedImpact},${r.optimizedRoi}`),
                    ].join("\n");
                    const blob = new Blob([csvRows], { type: "text/csv" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `${scenarioName.replace(/\s+/g, "_")}_plan.csv`;
                    a.click();
                  }}
                >
                  📥 Export Plan CSV
                </Btn>

                <Btn onClick={handleSaveScenario} className="bg-emerald-600 hover:bg-emerald-700 text-xs py-2 px-6">
                  💾 Save Scenario
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ─── 5. Scenario History Table ────────────────────────────────────── */}
      <Card title="5. Scenario History &amp; Saved Planning Runs">
        <p className="text-xs text-slate-500 mb-4">
          Compare saved planning scenarios against each other. Click any scenario to load its parameters back onto the screen.
        </p>

        {savedScenarios.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No scenarios saved yet. Run an optimization and click Save Scenario.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs text-left bg-white">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                <tr>
                  <th className="px-4 py-3">Scenario Name</th>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Target / Budget</th>
                  <th className="px-3 py-3">Projected Sales</th>
                  <th className="px-3 py-3">Projected Spend</th>
                  <th className="px-3 py-3">Model Used</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {savedScenarios.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => handleLoadScenarioFromHistory(s)}>
                    <td className="px-4 py-3 font-bold text-brand-700 underline">
                      {s.scenarioName}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        s.scenarioType === "Fixed Budget" ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"
                      }`}>
                        {s.scenarioType}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-semibold text-slate-800">
                      {s.scenarioType === "Fixed Budget" ? `$${Number(s.targetValue).toLocaleString()}` : `${Number(s.targetValue).toLocaleString()} Units`}
                    </td>
                    <td className="px-3 py-3 font-bold text-emerald-700">
                      {Math.round(s.optimizedPlan?.totalSales || 0).toLocaleString()} Units
                    </td>
                    <td className="px-3 py-3 text-slate-600">
                      ${Math.round(s.optimizedPlan?.totalSpend || 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-slate-500 truncate max-w-xs">{s.modelUsed}</td>
                    <td className="px-3 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleLoadScenarioFromHistory(s); }}
                        className="px-2.5 py-1 rounded-lg bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold text-xs"
                      >
                        Load
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}