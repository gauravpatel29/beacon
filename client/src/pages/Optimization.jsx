import React, { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, Legend,
} from "recharts";
import { runOptimization } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, Alert, Spinner, Metric } from "../components/UI";

const COLORS = ["#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4", "#84CC16"];

export default function Optimization() {
  const { state, setField } = useAppState();

  const storedMergedRc = state.mergedRc || {};
  const storedRcData = state.responseCurves || {};
  const rcConfig = state.responseCurveConfig || [];
  const currentSpendMap = state.channelSpendMap || {};

  // Build effective merged_rc from state
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

  const channels = useMemo(() => {
    const fromRc = Object.keys(effectiveMergedRc)
      .filter((k) => k.endsWith("_spend"))
      .map((k) => k.replace("_spend", ""));
    if (fromRc.length) return fromRc;
    if (Object.keys(storedRcData).length) return Object.keys(storedRcData);
    if (rcConfig.length) return rcConfig.map((c) => c.name);
    return [];
  }, [effectiveMergedRc, storedRcData, rcConfig]);

  // Optimization Configuration State
  const [optType, setOptType] = useState("Budget Goal");
  const [target, setTarget] = useState(100000);
  const [kStep, setKStep] = useState(1);
  const [channelBounds, setChannelBounds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(state.optimizationResult || null);

  // Initialize Channel Bounds
  useEffect(() => {
    if (!channels.length) return;
    setChannelBounds((prev) => {
      if (prev.length === channels.length && prev.every((b) => channels.includes(b.channel))) {
        return prev;
      }
      return channels.map((ch) => {
        const cfg = rcConfig.find((c) => c.name === ch || c.name === `${ch}_transformed`);
        const curSpend = Number(currentSpendMap[ch]) || Number(cfg?.spend_nation) || 50000;
        return {
          channel: ch,
          min: cfg?.start || 0,
          max: cfg?.stop || Math.round(curSpend * 3) || 1000000,
          iter: 1,
        };
      });
    });
  }, [channels, rcConfig, currentSpendMap]);

  const initBoundsFromChannels = () => {
    setChannelBounds(channels.map((ch) => {
      const curSpend = Number(currentSpendMap[ch]) || 50000;
      return { channel: ch, min: 0, max: Math.round(curSpend * 3) || 1000000, iter: 1 };
    }));
    toast.success("Initialized channel bounds.");
  };

  const updateBound = (idx, field, value) => {
    const num = value === "" ? 0 : parseInt(value, 10) || 0;
    setChannelBounds((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: num };
      return next;
    });
  };

  // Helper to evaluate baseline response curve metrics at given baseline spend
  const evaluateBaselineCurve = (ch, spend) => {
    const curve = storedRcData[ch] || storedRcData[`${ch}_transformed`] || [];
    if (curve.length > 0) {
      let closest = curve[0];
      let minDiff = Infinity;
      for (const pt of curve) {
        const diff = Math.abs(pt.spend - spend);
        if (diff < minDiff) {
          minDiff = diff;
          closest = pt;
        }
      }
      return {
        revenue: closest?.impactable_nation || 0,
        roi: closest?.roi || (spend > 0 ? (closest?.impactable_nation || 0) / spend : 0),
        mroi: closest?.mroi || 0,
      };
    }

    const spArr = effectiveMergedRc[`${ch}_spend`] || effectiveMergedRc[`${ch}_transformed_spend`] || [];
    const impArr = effectiveMergedRc[`${ch}_impactable_nation`] || effectiveMergedRc[`${ch}_transformed_impactable_nation`] || [];
    const roiArr = effectiveMergedRc[`${ch}_roi`] || effectiveMergedRc[`${ch}_transformed_roi`] || [];
    const mroiArr = effectiveMergedRc[`${ch}_mroi`] || effectiveMergedRc[`${ch}_transformed_mroi`] || [];

    if (!spArr.length) return { revenue: spend * 1.5, roi: 1.5, mroi: 1.0 };

    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < spArr.length; i++) {
      const diff = Math.abs(spArr[i] - spend);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    return {
      revenue: impArr[closestIdx] || 0,
      roi: roiArr[closestIdx] || (spend > 0 ? impArr[closestIdx] / spend : 0),
      mroi: mroiArr[closestIdx] || 0,
    };
  };

  const handleOptimize = async () => {
    if (!Object.keys(effectiveMergedRc).length) {
      return toast.error("No response curves found. Please finalize model and generate response curves first.");
    }
    if (!target || parseFloat(target) <= 0) {
      return toast.error("Please enter a positive target value.");
    }

    const bounds = channelBounds.length
      ? channelBounds
      : channels.map((ch) => ({ channel: ch, min: 0, max: 1000000, iter: 1 }));

    const optimizerDict = {};
    for (const b of bounds) {
      if (b.min > b.max) {
        return toast.error(`Constraint error: ${b.channel} Min Spend exceeds Max Spend.`);
      }
      optimizerDict[b.channel] = {
        iter: b.iter || 1,
        min: b.min || 0,
        max: b.max || 1000000,
      };
    }

    setLoading(true);
    setResult(null);

    try {
      const data = await runOptimization({
        merged_rc: effectiveMergedRc,
        optimizer_dict: optimizerDict,
        target: parseFloat(target),
        opt_type: optType,
        k: Math.max(1, parseInt(kStep, 10) || 1),
      });

      setResult(data);
      setField("optimizationResult", data);

      if (data.converged) {
        toast.success("✅ Target reached!");
      } else {
        toast("⚠️ Max iterations or boundary reached.", { icon: "ℹ️" });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Optimization failed");
    } finally {
      setLoading(false);
    }
  };

  // Full Pre vs Post Comparison Dataset
  const comparisonTableData = useMemo(() => {
    if (!result || !result.allocation) return [];

    return Object.entries(result.allocation).map(([ch, vals]) => {
      const rawName = ch.replace("_transformed", "");
      const base_spend = Number(currentSpendMap[rawName]) || Number(currentSpendMap[ch]) || 50000;
      const baseMetrics = evaluateBaselineCurve(ch, base_spend);

      const base_revenue = Math.round(baseMetrics.revenue);
      const base_roi = Number(baseMetrics.roi.toFixed(3));
      const base_mroi = Number(baseMetrics.mroi.toFixed(3));

      const opt_spend = Math.round(Number(vals.spend) || 0);
      const opt_revenue = Math.round(Number(vals.impactable_nation) || 0);
      const opt_roi = Number((vals.roi !== undefined ? vals.roi : (opt_spend > 0 ? opt_revenue / opt_spend : 0)).toFixed(3));
      const opt_mroi = Number((vals.mroi !== undefined ? vals.mroi : opt_roi).toFixed(3));

      const spend_diff = opt_spend - base_spend;
      const spend_pct_chg = base_spend > 0 ? Number(((spend_diff / base_spend) * 100).toFixed(1)) : 0;

      const revenue_chg = opt_revenue - base_revenue;
      const revenue_pct_chg = base_revenue > 0 ? Number(((revenue_chg / base_revenue) * 100).toFixed(1)) : 0;

      const mroi_diff = opt_mroi - base_mroi;
      const mroi_pct_chg = base_mroi > 0 ? Number(((mroi_diff / base_mroi) * 100).toFixed(1)) : 0;

      return {
        channel: rawName,
        base_spend,
        base_revenue,
        base_roi,
        base_mroi,
        opt_spend,
        opt_revenue,
        opt_roi,
        opt_mroi,
        "spend_%chg": spend_pct_chg,
        "revenue_%chg": revenue_pct_chg,
        revenue_chg,
        "mroi_%chg": mroi_pct_chg,
      };
    });
  }, [result, currentSpendMap, storedRcData, effectiveMergedRc]);

  const totalBaseSpend = useMemo(() => comparisonTableData.reduce((s, r) => s + r.base_spend, 0), [comparisonTableData]);
  const totalBaseRevenue = useMemo(() => comparisonTableData.reduce((s, r) => s + r.base_revenue, 0), [comparisonTableData]);
  const totalOptSpend = useMemo(() => comparisonTableData.reduce((s, r) => s + r.opt_spend, 0), [comparisonTableData]);
  const totalOptRevenue = useMemo(() => comparisonTableData.reduce((s, r) => s + r.opt_revenue, 0), [comparisonTableData]);

  const totalRevenueChg = totalOptRevenue - totalBaseRevenue;
  const totalSpendPctChg = totalBaseSpend > 0 ? Number((((totalOptSpend - totalBaseSpend) / totalBaseSpend) * 100).toFixed(1)) : 0;
  const totalRevenuePctChg = totalBaseRevenue > 0 ? Number(((totalRevenueChg / totalBaseRevenue) * 100).toFixed(1)) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget & Sales Optimization"
        subtitle="Allocate marketing budgets across promotional channels using discrete greedy marginal ROI optimization"
        icon="🎯"
      />

      {!Object.keys(effectiveMergedRc).length && (
        <Alert type="warning">
          No response curves available. Generate response curves in Module 7 first.
        </Alert>
      )}

      {/* Optimization Configuration */}
      <Card title="Optimization Configuration (Greedy Algorithm)">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <Select
            label="Optimization Goal"
            value={optType}
            onChange={setOptType}
            options={["Budget Goal", "Sales Goal"]}
          />
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Target {optType === "Budget Goal" ? "Budget ($)" : "Sales Lift (Units)"} *
            </label>
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              min={1}
              step={optType === "Budget Goal" ? 5000 : 1000}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Step Size (k) *
            </label>
            <input
              type="number"
              value={kStep}
              onChange={(e) => setKStep(Math.max(1, parseInt(e.target.value, 10) || 1))}
              min={1}
              step={1}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        {/* Channel Constraints Table */}
        {channels.length > 0 && (
          <div className="mt-6 pt-4 border-t border-slate-100">
            <div className="flex justify-between items-center mb-3">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Channel Constraints &amp; Starting Iteration
              </span>
              {channelBounds.length === 0 && (
                <Btn variant="outline" onClick={initBoundsFromChannels} className="text-xs py-1 px-3">
                  Initialize Channel Bounds
                </Btn>
              )}
            </div>

            {channelBounds.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-slate-200 mb-4">
                <table className="w-full text-xs text-left bg-white">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                    <tr>
                      <th className="px-3.5 py-3">Channel</th>
                      <th className="px-3.5 py-3">Min Spend ($)</th>
                      <th className="px-3.5 py-3">Max Spend ($)</th>
                      <th className="px-3.5 py-3">Starting Iteration (iter)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {channelBounds.map((b, idx) => (
                      <tr key={b.channel} className="hover:bg-slate-50">
                        <td className="px-3.5 py-2.5 font-bold text-slate-800">{b.channel.replace("_transformed", "")}</td>
                        <td className="px-3.5 py-2">
                          <input
                            type="number"
                            value={b.min}
                            step={1000}
                            min={0}
                            onChange={(e) => updateBound(idx, "min", e.target.value)}
                            className="w-32 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-semibold bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-3.5 py-2">
                          <input
                            type="number"
                            value={b.max}
                            step={10000}
                            min={0}
                            onChange={(e) => updateBound(idx, "max", e.target.value)}
                            className="w-32 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-semibold bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-3.5 py-2">
                          <input
                            type="number"
                            value={b.iter}
                            step={1}
                            min={1}
                            onChange={(e) => updateBound(idx, "iter", e.target.value)}
                            className="w-24 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-semibold bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Btn onClick={handleOptimize} disabled={loading || !Object.keys(effectiveMergedRc).length} className="px-8 py-3 text-xs uppercase font-bold tracking-wider">
            {loading ? "Optimizing…" : "▶ Run Optimization"}
          </Btn>
        </div>
      </Card>

      {loading && <Spinner label="Running discrete greedy marginal ROI optimization..." />}

      {/* Results View */}
      {result && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Metric
              label="Status"
              value={result.converged ? "✅ Converged" : "⚠️ Max Steps"}
            />
            <Metric
              label={optType === "Budget Goal" ? "Total Budget Allocated" : "Total Sales Achieved"}
              value={result.final_value ? Math.round(result.final_value).toLocaleString() : "—"}
            />
            <Metric
              label="Optimized Spend"
              value={`$${totalOptSpend.toLocaleString()}`}
            />
            <Metric
              label="Optimized Revenue / Lift"
              value={`$${totalOptRevenue.toLocaleString()}`}
            />
          </div>

          {/* Allocation Bar Chart */}
          <Card title="Optimized Budget Allocation by Channel">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={comparisonTableData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="channel" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => [
                  n === "opt_spend" ? `$${Number(v).toLocaleString()}` : `$${Number(v).toLocaleString()}`,
                  n === "opt_spend" ? "Optimized Spend" : "Base Spend",
                ]} />
                <Legend />
                <Bar dataKey="base_spend" fill="#94A3B8" name="Base Spend ($)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="opt_spend" fill="#001E96" name="Optimized Spend ($)" radius={[4, 4, 0, 0]}>
                  {comparisonTableData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Detailed Pre vs Post Optimization Table */}
          <Card title="Comprehensive Pre vs. Post Optimization Performance Table">
            <p className="text-xs text-slate-500 mb-3">
              Full channel comparison of baseline investment versus optimized allocation with marginal returns and percentage shifts.
            </p>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-xs text-left bg-white font-mono">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold font-sans">
                  <tr>
                    <th className="px-3 py-3">channel</th>
                    <th className="px-3 py-3">base_spend</th>
                    <th className="px-3 py-3">base_revenue</th>
                    <th className="px-3 py-3">base_roi</th>
                    <th className="px-3 py-3">base_mroi</th>
                    <th className="px-3 py-3">opt_spend</th>
                    <th className="px-3 py-3">opt_revenue</th>
                    <th className="px-3 py-3">opt_roi</th>
                    <th className="px-3 py-3">opt_mroi</th>
                    <th className="px-3 py-3">spend_%chg</th>
                    <th className="px-3 py-3">revenue_%chg</th>
                    <th className="px-3 py-3">revenue_chg</th>
                    <th className="px-3 py-3">mroi_%chg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {comparisonTableData.map((r) => {
                    const isPositiveRev = r.revenue_chg >= 0;
                    const isPositiveSpend = r["spend_%chg"] >= 0;
                    const isPositiveMroi = r["mroi_%chg"] >= 0;

                    return (
                      <tr key={r.channel} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-bold font-sans text-slate-800">{r.channel}</td>
                        <td className="px-3 py-2 text-slate-600">${r.base_spend.toLocaleString()}</td>
                        <td className="px-3 py-2 text-slate-600">${r.base_revenue.toLocaleString()}</td>
                        <td className="px-3 py-2 text-slate-600">{r.base_roi.toFixed(2)}x</td>
                        <td className="px-3 py-2 text-slate-600">{r.base_mroi.toFixed(2)}x</td>
                        <td className="px-3 py-2 font-bold text-brand-700">${r.opt_spend.toLocaleString()}</td>
                        <td className="px-3 py-2 font-bold text-brand-700">${r.opt_revenue.toLocaleString()}</td>
                        <td className="px-3 py-2 font-bold text-emerald-700">{r.opt_roi.toFixed(2)}x</td>
                        <td className="px-3 py-2 font-bold text-purple-700">{r.opt_mroi.toFixed(2)}x</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            isPositiveSpend ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
                          }`}>
                            {isPositiveSpend ? `+${r["spend_%chg"]}%` : `${r["spend_%chg"]}%`}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            isPositiveRev ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                          }`}>
                            {isPositiveRev ? `+${r["revenue_%chg"]}%` : `${r["revenue_%chg"]}%`}
                          </span>
                        </td>
                        <td className={`px-3 py-2 font-bold ${isPositiveRev ? "text-emerald-700" : "text-red-600"}`}>
                          {isPositiveRev ? `+$${r.revenue_chg.toLocaleString()}` : `-$${Math.abs(r.revenue_chg).toLocaleString()}`}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            isPositiveMroi ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-700"
                          }`}>
                            {isPositiveMroi ? `+${r["mroi_%chg"]}%` : `${r["mroi_%chg"]}%`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-100/80 border-t-2 border-slate-300 font-bold font-sans text-slate-800">
                  <tr>
                    <td className="px-3 py-2.5 uppercase">Total Portfolio</td>
                    <td className="px-3 py-2 font-mono">${totalBaseSpend.toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono">${totalBaseRevenue.toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono">{(totalBaseSpend > 0 ? totalBaseRevenue / totalBaseSpend : 0).toFixed(2)}x</td>
                    <td className="px-3 py-2 font-mono">—</td>
                    <td className="px-3 py-2 font-mono text-brand-700">${totalOptSpend.toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-brand-700">${totalOptRevenue.toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-emerald-700">{(totalOptSpend > 0 ? totalOptRevenue / totalOptSpend : 0).toFixed(2)}x</td>
                    <td className="px-3 py-2 font-mono">—</td>
                    <td className="px-3 py-2 font-mono">{totalSpendPctChg >= 0 ? `+${totalSpendPctChg}%` : `${totalSpendPctChg}%`}</td>
                    <td className="px-3 py-2 font-mono text-emerald-700">{totalRevenuePctChg >= 0 ? `+${totalRevenuePctChg}%` : `${totalRevenuePctChg}%`}</td>
                    <td className="px-3 py-2 font-mono text-emerald-700">{totalRevenueChg >= 0 ? `+$${totalRevenueChg.toLocaleString()}` : `-$${Math.abs(totalRevenueChg).toLocaleString()}`}</td>
                    <td className="px-3 py-2 font-mono">—</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mt-4 flex justify-end">
              <Btn
                variant="outline"
                onClick={() => {
                  const headers = "channel,base_spend,base_revenue,base_roi,base_mroi,opt_spend,opt_revenue,opt_roi,opt_mroi,spend_%chg,revenue_%chg,revenue_chg,mroi_%chg";
                  const csvRows = [
                    headers,
                    ...comparisonTableData.map(
                      (r) =>
                        `${r.channel},${r.base_spend},${r.base_revenue},${r.base_roi},${r.base_mroi},${r.opt_spend},${r.opt_revenue},${r.opt_roi},${r.opt_mroi},${r["spend_%chg"]}%,${r["revenue_%chg"]}%,${r.revenue_chg},${r["mroi_%chg"]}%`
                    ),
                  ].join("\n");
                  const blob = new Blob([csvRows], { type: "text/csv;charset=utf-8;" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `optimization_comparison_${optType.toLowerCase().replace(/\s+/g, "_")}.csv`;
                  a.click();
                }}
              >
                📥 Download Optimization Table CSV
              </Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}