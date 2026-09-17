import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line
} from "recharts";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Alert, Metric, DataTable, Btn, Select, Spinner } from "../components/UI";
import { generateResponseCurves, fetchBenchmarkComparison } from "../services/api";

// Categorize raw/transformed channels using user-defined Ingestion promotional tiers
function getChannelTier(variableName, promoTiers = {}) {
  const raw = (variableName || "").replace("_transformed", "").trim();
  const l = raw.toLowerCase();

  if (l.includes("const") || l.includes("baseline") || l.includes("intercept") || l.includes("carryover")) {
    return "Baseline";
  }

  // Sourced directly from user's selection in Ingestion
  if (promoTiers[raw]) {
    const t = promoTiers[raw];
    if (t === "Personal Promotion") return "Personal Promotion";
    if (t === "Non Personal Promotion" || t === "NPP Promotion") return "NPP Promotion";
    if (t === "DTC Promotion") return "DTC Promotion";
  }

  // Fallback heuristic if not explicitly set
  if (l.includes("call") || l.includes("det") || l.includes("sample") || l.includes("speaker") || l.includes("f2f") || l.includes("rep")) {
    return "Personal Promotion";
  }
  if (l.includes("rte") || l.includes("email") || l.includes("portal") || l.includes("npp") || l.includes("hcp_web")) {
    return "NPP Promotion";
  }
  if (l.includes("tv") || l.includes("dtc") || l.includes("digital") || l.includes("search") || l.includes("social") || l.includes("media") || l.includes("disp")) {
    return "DTC Promotion";
  }
  return "Personal Promotion";
}

export default function ModelResults() {
  const { state, setField } = useAppState();
  const outputs = state.regressionOutputs || [];
  const promoTiers = state.columnPromoTiers || {};

  // Selected & Finalized Model State
  const [selectedIdx, setSelectedIdx] = useState(() => state.selectedModelIdx ?? (outputs.length > 0 ? 0 : null));
  const [finalizedModelId, setFinalizedModelId] = useState(() => state.finalizedModelId || (outputs.length > 0 ? outputs[0].id : null));

  const selectedModel = outputs[selectedIdx] || outputs[0] || null;
  const isFinalized = selectedModel && (selectedModel.id === finalizedModelId || selectedModel.isFinalized);

  // Spend Input State (per channel)
  const [channelSpendMap, setChannelSpendMap] = useState(() => state.channelSpendMap || {});

  // Response Curves State
  const [rcLoading, setRcLoading] = useState(false);
  const [responseCurvesData, setResponseCurvesData] = useState(() => state.responseCurves || {});
  const [activeRcChannel, setActiveRcChannel] = useState("");

  // Benchmark Filters State (Exact Matrix Dimensions)
  const [maturityStage, setMaturityStage] = useState("2–5Y");
  const [competitionLevel, setCompetitionLevel] = useState("Medium");
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [benchLoading, setBenchLoading] = useState(false);

  // Initialize spend values from model output or defaults
  useEffect(() => {
    if (!selectedModel || !selectedModel.coefficients) return;
    const initialSpend = { ...channelSpendMap };
    selectedModel.coefficients.forEach((r) => {
      const v = r.Variable?.replace("_transformed", "");
      if (r.Note !== "Intercept" && r.Variable !== "const") {
        if (initialSpend[v] === undefined) {
          initialSpend[v] = r.Spend && Number(r.Spend) > 0 ? Number(r.Spend) : 50000;
        }
      }
    });
    setChannelSpendMap(initialSpend);
  }, [selectedModel]);

  // Handle Model Selection
  const handleSelectModel = (idx) => {
    setSelectedIdx(idx);
    setField("selectedModelIdx", idx);
  };

  // Handle Finalize Model Toggle
  const handleFinalizeModel = () => {
    if (!selectedModel) return;
    const newFinalizedId = selectedModel.id;
    setFinalizedModelId(newFinalizedId);
    setField("finalizedModelId", newFinalizedId);
    
    const updatedOutputs = outputs.map((m) => ({
      ...m,
      isFinalized: m.id === newFinalizedId,
    }));
    setField("regressionOutputs", updatedOutputs);
    toast.success(`Model "${selectedModel.modelName || selectedModel.name}" is now finalized! Unlocking response curves.`);
  };

  // Update spend input
  const handleSpendChange = (ch, val) => {
    const num = Math.max(0, parseFloat(val) || 0);
    const updated = { ...channelSpendMap, [ch]: num };
    setChannelSpendMap(updated);
    setField("channelSpendMap", updated);
  };

  // Channel-level Performance Deep Dive data with dynamic ROI and user-selected Tiers
  const channelPerformanceData = useMemo(() => {
    if (!selectedModel || !selectedModel.coefficients) return [];
    return selectedModel.coefficients
      .filter((r) => r.Note !== "Intercept" && r.Variable !== "const")
      .map((r) => {
        const rawName = r.Variable?.replace("_transformed", "");
        const impactablePct = parseFloat(String(r["Impactable (%)"] || r["Impactable %"] || 0).replace("%", "")) || 0;
        const impactableSales = Number(r["Impactable Sales"]) || 0;
        const spend = Number(channelSpendMap[rawName]) || Number(r.Spend) || 1;
        const roi = spend > 0 ? (impactableSales / spend) : 0;
        const ltRoi = r["Long Term ROI"] ? Number(r["Long Term ROI"]) : (roi * 1.35);

        return {
          channel: rawName,
          tier: getChannelTier(rawName, promoTiers),
          impactablePct,
          impactableSales,
          spend,
          roi: Number(roi.toFixed(3)),
          ltRoi: Number(ltRoi.toFixed(3)),
          coefficient: Number(r.Coefficient) || 0,
        };
      })
      .sort((a, b) => b.impactableSales - a.impactableSales);
  }, [selectedModel, channelSpendMap, promoTiers]);

  // Executive Summary 4-Tier Breakdown Data (Driven directly by Ingestion selection)
  const executiveImpactBreakdown = useMemo(() => {
    if (!selectedModel || !selectedModel.coefficients) return [];
    
    let baselineImpact = 0;
    let baselineSales = 0;
    let personalImpact = 0;
    let personalSales = 0;
    let nppImpact = 0;
    let nppSales = 0;
    let dtcImpact = 0;
    let dtcSales = 0;

    selectedModel.coefficients.forEach((r) => {
      const v = r.Variable;
      const pct = parseFloat(String(r["Impactable (%)"] || r["Impactable %"] || 0).replace("%", "")) || 0;
      const sales = Number(r["Impactable Sales"]) || 0;
      const tier = getChannelTier(v, promoTiers);

      if (tier === "Baseline") {
        baselineImpact += pct;
        baselineSales += sales;
      } else if (tier === "Personal Promotion") {
        personalImpact += pct;
        personalSales += sales;
      } else if (tier === "NPP Promotion") {
        nppImpact += pct;
        nppSales += sales;
      } else if (tier === "DTC Promotion") {
        dtcImpact += pct;
        dtcSales += sales;
      }
    });

    return [
      { category: "Baseline Demand", sharePct: Number(baselineImpact.toFixed(1)), sales: baselineSales, fill: "#001E96" },
      { category: "Personal Promotion", sharePct: Number(personalImpact.toFixed(1)), sales: personalSales, fill: "#1ABC9C" },
      { category: "NPP Promotion", sharePct: Number(nppImpact.toFixed(1)), sales: nppSales, fill: "#F59E0B" },
      { category: "DTC / Media", sharePct: Number(dtcImpact.toFixed(1)), sales: dtcSales, fill: "#8B5CF6" },
    ];
  }, [selectedModel, promoTiers]);

  // Generate Response Curves & Build mergedRc
  useEffect(() => {
    if (!isFinalized || !selectedModel || !channelPerformanceData.length) return;
    setRcLoading(true);

    const channelPayload = channelPerformanceData.map((ch) => ({
      name: ch.channel,
      impactable_sales_nation: ch.impactableSales,
      beta_coeff: ch.coefficient || 0.005,
      spend_nation: ch.spend,
      start: 0,
      stop: Math.round(ch.spend * 2.5) || 200000,
      step: Math.round(Math.max(1000, (ch.spend * 2.5) / 50)),
      price: 1,
      saturation_function: "log",
      power_value: 0.5,
    }));

    generateResponseCurves({ channels: channelPayload, num_time: 12, num_geo: 100 })
      .then((res) => {
        const curves = res.curves || {};
        setResponseCurvesData(curves);
        setField("responseCurves", curves);

        const builtMergedRc = {};
        Object.entries(curves).forEach(([ch, rows]) => {
          builtMergedRc[`${ch}_spend`] = rows.map((r) => r.spend);
          builtMergedRc[`${ch}_impactable_nation`] = rows.map((r) => r.impactable_nation);
          builtMergedRc[`${ch}_roi`] = rows.map((r) => r.roi);
          builtMergedRc[`${ch}_mroi`] = rows.map((r) => r.mroi);
        });
        setField("mergedRc", builtMergedRc);

        const keys = Object.keys(curves);
        if (keys.length > 0 && (!activeRcChannel || !keys.includes(activeRcChannel))) {
          setActiveRcChannel(keys[0]);
        }
      })
      .catch(() => {})
      .finally(() => setRcLoading(false));
  }, [isFinalized, selectedModel, channelPerformanceData, setField]);

  // Active Response Curve Calculations
  const activeCurvePoints = useMemo(() => {
    if (!activeRcChannel || !responseCurvesData[activeRcChannel]) return [];
    return responseCurvesData[activeRcChannel];
  }, [activeRcChannel, responseCurvesData]);

  const activeRcMetrics = useMemo(() => {
    if (!activeCurvePoints.length) return null;
    const currentSpend = channelSpendMap[activeRcChannel] || activeCurvePoints[Math.floor(activeCurvePoints.length / 3)]?.spend || 50000;
    
    let closestPoint = activeCurvePoints[0];
    let minDiff = Infinity;
    activeCurvePoints.forEach((pt) => {
      const diff = Math.abs(pt.spend - currentSpend);
      if (diff < minDiff) {
        minDiff = diff;
        closestPoint = pt;
      }
    });

    const maxImpact = activeCurvePoints[activeCurvePoints.length - 1]?.impactable_nation || 1;
    const currentImpact = closestPoint?.impactable_nation || 0;
    const saturationPct = Math.min(100, Math.round((currentImpact / maxImpact) * 100));
    const optimalPoint = activeCurvePoints.find((p) => (p.impactable_nation / maxImpact) >= 0.80) || activeCurvePoints[Math.floor(activeCurvePoints.length * 0.75)];

    return {
      currentSpend,
      optimalSpend: optimalPoint?.spend || Math.round(currentSpend * 1.3),
      saturationPct,
      currentMroi: closestPoint?.mroi ? Number(closestPoint.mroi.toFixed(3)) : 1.25,
      currentRoi: closestPoint?.roi ? Number(closestPoint.roi.toFixed(3)) : 2.10,
    };
  }, [activeCurvePoints, activeRcChannel, channelSpendMap]);

  // Query Benchmark Store
  useEffect(() => {
    setBenchLoading(true);
    fetchBenchmarkComparison({
      maturity_stage: maturityStage,
      competition_level: competitionLevel,
      channels: channelPerformanceData.map((c) => ({ channel: c.channel, roi: c.roi })),
    })
      .then((res) => {
        setBenchmarkResult(res);
      })
      .catch(() => {})
      .finally(() => setBenchLoading(false));
  }, [maturityStage, competitionLevel, channelPerformanceData]);

  if (!outputs.length) {
    return (
      <div className="space-y-6">
        <PageHeader title="Module 7: Model Output &amp; Response Curves" subtitle="Compare model iterations, review executive impact breakdowns, configure spend ROI, and generate saturation response curves" icon="📋" />
        <Alert type="warning">No model iterations found. Run a model in Module 6 (Modelling) first.</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Module 7: Model Output &amp; Response Curves"
        subtitle="Compare model runs, finalize active model, inspect 4-tier impact breakdown, enter spend for ROI, generate response curves, and benchmark against industry peers"
        icon="📋"
      />

      {/* ─── 1. Model Registry ────────────────────────────────────────────── */}
      <Card title="1. Model Registry (Compare &amp; Select Runs)">
        <p className="text-xs text-slate-500 mb-4">
          Select any model iteration below to review its diagnostics and impact. Click <strong>Finalize Model</strong> to enable Response Curves and Benchmark Comparisons.
        </p>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
              <tr>
                <th className="px-4 py-3">Model Name</th>
                <th className="px-3 py-3">Level</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">R²</th>
                <th className="px-3 py-3">Adj. R²</th>
                <th className="px-3 py-3">RMSE</th>
                <th className="px-3 py-3">Training Window</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {outputs.map((m, idx) => {
                const isSelected = selectedIdx === idx;
                const isModelFinal = m.id === finalizedModelId || m.isFinalized;

                return (
                  <tr
                    key={m.id || idx}
                    onClick={() => handleSelectModel(idx)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-brand-50/70 border-l-4 border-brand-600 font-semibold" : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-4 py-3 font-bold text-slate-800">
                      <div className="flex items-center gap-2">
                        <span>{m.modelName || m.name || `Iteration ${idx + 1}`}</span>
                        {isModelFinal && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300">
                            ★ Finalized
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        m.modelLevel === "HCP" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"
                      }`}>
                        {m.modelLevel || "HCP"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-slate-600">{m.modelType || "OLS"}</td>
                    <td className="px-3 py-3 font-bold text-brand-700">{m.r_squared?.toFixed(4) ?? "—"}</td>
                    <td className="px-3 py-3 text-slate-700">{m.adj_r_squared?.toFixed(4) ?? "—"}</td>
                    <td className="px-3 py-3 text-slate-700">{m.rmse?.toFixed(2) ?? "—"}</td>
                    <td className="px-3 py-3 text-slate-500 font-mono text-[11px]">{m.dateRange || `${m.start_date || ""} → ${m.end_date || ""}`}</td>
                    <td className="px-3 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        ✓ Complete
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSelectModel(idx); }}
                        className="px-3 py-1 rounded-lg bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold text-xs"
                      >
                        {isSelected ? "Active View" : "View"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ─── 2. Selected Model Banner & Finalization ───────────────────────── */}
      <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-xl flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Currently Reviewing:</span>
            <h3 className="text-lg font-black text-white">{selectedModel?.modelName || selectedModel?.name}</h3>
            {isFinalized ? (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-500 text-slate-900">
                ✅ Finalized Model
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Draft Selection
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Level: <strong className="text-slate-200">{selectedModel?.modelLevel || "HCP"}</strong> • Type: <strong className="text-slate-200">{selectedModel?.modelType || "OLS"}</strong> • R²: <strong className="text-emerald-400">{selectedModel?.r_squared?.toFixed(4)}</strong> • RMSE: <strong className="text-slate-200">{selectedModel?.rmse?.toFixed(2)}</strong>
          </p>
        </div>

        <div className="flex gap-3">
          <Btn
            onClick={handleFinalizeModel}
            className={`py-3 px-6 text-xs font-bold uppercase tracking-wider ${
              isFinalized ? "bg-emerald-600 hover:bg-emerald-700" : "bg-[#1ABC9C] hover:bg-[#16a085]"
            }`}
          >
            {isFinalized ? "★ Re-Confirm Finalized" : "★ Finalize This Model"}
          </Btn>
        </div>
      </div>

      {/* ─── 3. Executive Summary: 4-Tier High-Level Impact ────────────────── */}
      <Card title="3. Executive Summary (High-Level Promotional Impact Breakdown)">
        <p className="text-xs text-slate-500 mb-6">
          High-level aggregation of total commercial sales volume decomposed into Baseline unpromoted demand, Personal promotion, Non-Personal promotion (NPP), and Direct-to-Consumer (DTC) media.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          {/* Metric Cards */}
          <div className="lg:col-span-5 grid grid-cols-2 gap-3">
            {executiveImpactBreakdown.map((tier) => (
              <div key={tier.category} className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                  {tier.category}
                </span>
                <div className="text-2xl font-black text-slate-800 mb-0.5">
                  {tier.sharePct}%
                </div>
                <span className="text-xs font-semibold text-slate-500">
                  {tier.sales > 0 ? `${Math.round(tier.sales).toLocaleString()} Units` : "—"}
                </span>
              </div>
            ))}
          </div>

          {/* Stacked Breakdown Bar */}
          <div className="lg:col-span-7 bg-white p-4 rounded-2xl border border-slate-200">
            <span className="text-xs font-bold text-slate-700 block mb-3 uppercase tracking-wider">
              Share of Total Volume (% Distribution)
            </span>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={[{ name: "Portfolio Share", ...Object.fromEntries(executiveImpactBreakdown.map((x) => [x.category, x.sharePct])) }]} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" hide />
                <Tooltip formatter={(v) => `${v}%`} />
                <Legend />
                {executiveImpactBreakdown.map((tier) => (
                  <Bar key={tier.category} dataKey={tier.category} stackId="a" fill={tier.fill} radius={[0, 0, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      {/* ─── 4. Spend Input & Dynamic ROI Management ───────────────────────── */}
      <Card title="4. Channel Spend Management &amp; ROI Engine">
        <p className="text-xs text-slate-500 mb-4">
          Enter or adjust actual budget spend per promotional channel. Spend inputs immediately update channel ROIs, Long-Term ROIs, and downstream response curves.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {channelPerformanceData.map((ch) => (
            <div key={ch.channel} className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-1.5">
              <span className="text-xs font-bold text-slate-800 block truncate">{ch.channel}</span>
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Actual Spend ($):</label>
              <input
                type="number"
                step="1000"
                min="0"
                value={channelSpendMap[ch.channel] ?? ch.spend}
                onChange={(e) => handleSpendChange(ch.channel, e.target.value)}
                className="w-full text-xs font-bold border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <div className="flex justify-between text-[11px] pt-1 text-slate-500">
                <span>Current ROI:</span>
                <strong className="text-brand-700">{ch.roi.toFixed(2)}x</strong>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ─── 5. Channel Performance Deep Dive Table ────────────────────────── */}
      <Card title="5. Channel Performance Deep-Dive Table">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left bg-white">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
              <tr>
                <th className="px-4 py-3">Channel / Tactic</th>
                <th className="px-3 py-3">Tier Role (From Ingestion)</th>
                <th className="px-3 py-3">Impact (Sales Volume)</th>
                <th className="px-3 py-3">Impact Share (%)</th>
                <th className="px-3 py-3">Spend ($)</th>
                <th className="px-3 py-3">ROI</th>
                <th className="px-3 py-3">Long-Term ROI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {channelPerformanceData.map((r) => (
                <tr key={r.channel} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-800">{r.channel}</td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      r.tier === "Personal Promotion" ? "bg-emerald-100 text-emerald-800" :
                      r.tier === "NPP Promotion" ? "bg-amber-100 text-amber-800" :
                      r.tier === "DTC Promotion" ? "bg-purple-100 text-purple-800" :
                      "bg-blue-100 text-blue-800"
                    }`}>
                      {r.tier}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-bold text-brand-700">{Math.round(r.impactableSales).toLocaleString()}</td>
                  <td className="px-3 py-3 font-semibold text-slate-700">{r.impactablePct.toFixed(2)}%</td>
                  <td className="px-3 py-3 text-slate-600">${Math.round(r.spend).toLocaleString()}</td>
                  <td className="px-3 py-3 font-bold text-emerald-700">{r.roi.toFixed(2)}x</td>
                  <td className="px-3 py-3 font-bold text-brand-700">{r.ltRoi.toFixed(2)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ─── 6. Response Curves & Marginal ROI ──────────────────────────────── */}
      <Card title="6. Channel Response Curves &amp; Diminishing Marginal ROI">
        {!isFinalized ? (
          <div className="py-12 text-center text-slate-400 space-y-2">
            <span className="text-4xl block">📈</span>
            <p className="text-sm font-bold text-slate-700">Response Curves Locked</p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Please finalize this model using the <strong>★ Finalize Model</strong> button at the top to generate saturation curves and marginal ROI analytics.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-xs text-slate-500">
              Explore how increasing or decreasing spend affects incremental sales volume and marginal returns. Diminishing returns demonstrate saturation limits per tactic.
            </p>

            {/* Channel Selector */}
            <div className="flex items-center gap-3 flex-wrap bg-slate-50 p-3 rounded-xl border border-slate-200">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Select Channel:</span>
              <div className="flex flex-wrap gap-2">
                {Object.keys(responseCurvesData).map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setActiveRcChannel(ch)}
                    className={`px-3 py-1 rounded-xl text-xs font-bold transition-all border ${
                      activeRcChannel === ch
                        ? "bg-[#001E96] text-white border-[#001E96] shadow-sm"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    {ch.replace("_transformed", "")}
                  </button>
                ))}
              </div>
            </div>

            {rcLoading && <Spinner label="Calculating saturation curves..." />}

            {activeRcMetrics && !rcLoading && (
              <div className="space-y-6">
                {/* Diagnostic KPI Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-center">
                    <div className="text-lg font-bold text-slate-800">${activeRcMetrics.currentSpend.toLocaleString()}</div>
                    <div className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">Current Spend</div>
                  </div>
                  <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200 text-center">
                    <div className="text-lg font-bold text-emerald-700">${activeRcMetrics.optimalSpend.toLocaleString()}</div>
                    <div className="text-[10px] text-emerald-600 font-bold uppercase mt-0.5">Optimal Target Spend</div>
                  </div>
                  <div className="bg-brand-50 p-4 rounded-xl border border-brand-200 text-center">
                    <div className="text-lg font-bold text-brand-700">{activeRcMetrics.saturationPct}%</div>
                    <div className="text-[10px] text-brand-500 font-bold uppercase mt-0.5">Current Saturation</div>
                  </div>
                  <div className="bg-purple-50 p-4 rounded-xl border border-purple-200 text-center">
                    <div className="text-lg font-bold text-purple-700">{activeRcMetrics.currentMroi.toFixed(2)}x</div>
                    <div className="text-[10px] text-purple-600 font-bold uppercase mt-0.5">Marginal ROI (mROI)</div>
                  </div>
                </div>

                {/* Response Curves Side-by-Side Charts */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Saturation Curve */}
                  <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <span className="text-xs font-bold text-slate-700 block mb-2 uppercase tracking-wider">
                      Spend vs. Sales Response Curve ({activeRcChannel})
                    </span>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={activeCurvePoints}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="spend" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
                        <YAxis tickFormatter={(v) => Number(v).toLocaleString()} tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                        <Line type="monotone" dataKey="impactable_nation" stroke="#001E96" strokeWidth={2.5} dot={false} name="Impactable Sales" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* ROI vs Marginal ROI Curve */}
                  <div className="bg-white p-4 rounded-2xl border border-slate-200">
                    <span className="text-xs font-bold text-slate-700 block mb-2 uppercase tracking-wider">
                      Average ROI vs. Marginal ROI (mROI) Curve
                    </span>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={activeCurvePoints}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="spend" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
                        <YAxis tickFormatter={(v) => Number(v).toFixed(2)} tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v) => Number(v).toFixed(3)} />
                        <Legend />
                        <Line type="monotone" dataKey="roi" stroke="#001E96" strokeWidth={2} dot={false} name="Average ROI" />
                        <Line type="monotone" dataKey="mroi" stroke="#1ABC9C" strokeWidth={2} dot={false} name="Marginal ROI" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ─── 7. Benchmark Comparison Panel (New Matrix Format) ─────────────── */}
      <Card title="7. Industry Benchmark Comparisons (Maturity Stage × Competition Level)">
        <p className="text-xs text-slate-500 mb-4">
          Compare your model results against the standard pharma commercial benchmark matrix segmented by lifecycle stage and competition level.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 max-w-xl">
          <Select
            label="Maturity Stage"
            value={maturityStage}
            onChange={setMaturityStage}
            options={["0–2Y", "2–5Y", "5–8Y", "8Y+"]}
          />
          <Select
            label="Competition Level"
            value={competitionLevel}
            onChange={setCompetitionLevel}
            options={["Low", "Medium", "High"]}
          />
        </div>

        {benchLoading && <Spinner label="Querying benchmark matrix..." />}

        {benchmarkResult && !benchLoading && (
          <div className="space-y-6">
            <div className="bg-brand-50/60 p-3 rounded-xl border border-brand-200 text-xs text-brand-900 font-bold">
              Benchmark Cohort: {benchmarkResult.benchmark_group}
            </div>

            {/* Impact % Breakdown Comparison */}
            <div>
              <span className="text-xs font-bold text-slate-700 block mb-2 uppercase tracking-wider">
                1. Promotional Impact % Share Benchmarks:
              </span>
              <DataTable data={benchmarkResult.impact_benchmarks} />
            </div>

            {/* Channel-Level ROI Comparison Table */}
            <div>
              <span className="text-xs font-bold text-slate-700 block mb-2 uppercase tracking-wider">
                2. Channel-Level ROI vs. Industry Peer Benchmarks:
              </span>
              <DataTable data={benchmarkResult.channel_benchmarks} />
            </div>
          </div>
        )}
      </Card>

      {/* ─── 8. Diagnostics & Full Statistical Summary ─────────────────────── */}
      <Card title="8. Model Diagnostics &amp; Statistical Evaluation">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Metric label="R² (Fit)" value={selectedModel?.r_squared?.toFixed(4) ?? "—"} />
          <Metric label="Adjusted R²" value={selectedModel?.adj_r_squared?.toFixed(4) ?? "—"} />
          <Metric label="RMSE" value={selectedModel?.rmse?.toFixed(2) ?? "—"} />
          <Metric label="Alpha (λ)" value={selectedModel?.alpha != null ? String(selectedModel.alpha) : "N/A (OLS)"} />
        </div>

        <details className="bg-slate-50 rounded-xl p-4 border border-slate-200 cursor-pointer">
          <summary className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            View Full Statistical Summary Output
          </summary>
          <pre className="text-xs text-slate-600 bg-white rounded-lg p-4 mt-3 overflow-auto whitespace-pre-wrap font-mono leading-relaxed max-h-80 border border-slate-200">
            {selectedModel?.summary || "No statistical text summary available for this model iteration."}
          </pre>
        </details>
      </Card>
    </div>
  );
}
