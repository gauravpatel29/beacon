import React, { useState } from "react";
import toast from "react-hot-toast";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, Legend,
} from "recharts";
import { runOptimization } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, Alert, Spinner, Metric, DataTable } from "../components/UI";

const COLORS = ["#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4", "#84CC16"];

export default function Optimization() {
  const { state, setField } = useAppState();
  const mergedRc = state.mergedRc || {};
  const rcConfig = state.responseCurveConfig || [];

  const [optType, setOptType] = useState("Budget Goal");
  const [target, setTarget] = useState(0);
  const [kStep, setKStep] = useState(1);
  const [channelBounds, setChannelBounds] = useState(() => {
    return rcConfig.map((cfg) => ({
      channel: cfg.name,
      min: cfg.start || 0,
      max: cfg.stop || 1000000,
      iter: 1,
    }));
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(state.optimizationResult || null);

  const channels = Object.keys(mergedRc)
    .filter((k) => k.endsWith("_spend"))
    .map((k) => k.replace("_spend", ""));

  // Init bounds when channels available but bounds empty
  const initBoundsFromChannels = () => {
    if (channelBounds.length) return;
    setChannelBounds(channels.map((ch) => ({ channel: ch, min: 0, max: 1000000, iter: 1 })));
  };

  const updateBound = (idx, field, value) => {
    setChannelBounds((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const handleOptimize = async () => {
    if (!Object.keys(mergedRc).length) return toast.error("No response curves found. Generate them first.");
    if (!target) return toast.error("Set a target value");
    const bounds = channelBounds.length ? channelBounds : channels.map((ch) => ({ channel: ch, min: 0, max: 1000000, iter: 1 }));
    const optimizerDict = {};
    bounds.forEach((b) => {
      optimizerDict[b.channel] = { iter: b.iter || 1, min: b.min || 0, max: b.max || 1000000 };
    });

    setLoading(true);
    try {
      const data = await runOptimization({
        merged_rc: mergedRc,
        optimizer_dict: optimizerDict,
        target: parseFloat(target),
        opt_type: optType,
        k: kStep,
      });
      setResult(data);
      setField("optimizationResult", data);
      toast.success(data.converged ? "✅ Target reached!" : "⚠️ Max iterations reached");
    } catch (err) {
      toast.error(err.response?.data?.error || "Optimization failed");
    } finally {
      setLoading(false);
    }
  };

  const allocationData = result
    ? Object.entries(result.allocation).map(([ch, vals]) => ({
        channel: ch.replace("_transformed", ""),
        spend: vals.spend,
        impactable: vals.impactable_nation,
        roi: vals.spend > 0 ? vals.impactable_nation / vals.spend : 0,
      }))
    : [];

  const totalSpend = allocationData.reduce((s, r) => s + r.spend, 0);
  const totalImpactable = allocationData.reduce((s, r) => s + r.impactable, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget & Sales Optimization"
        subtitle="Allocate budget across channels using marginal ROI optimization"
        icon="🎯"
      />

      {!Object.keys(mergedRc).length && (
        <Alert type="warning">No response curves available. Generate them on the Response Curves page first.</Alert>
      )}

      {/* Config */}
      <Card title="Optimization Configuration">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <Select
            label="Optimization Goal"
            value={optType}
            onChange={setOptType}
            options={["Budget Goal", "Sales Goal"]}
          />
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Target {optType === "Budget Goal" ? "Budget ($)" : "Sales (units)"}
            </label>
            <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} min={0} step={1000}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Step Size (k)</label>
            <input type="number" value={kStep} onChange={(e) => setKStep(parseInt(e.target.value))} min={1}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
        </div>

        {/* Channel bounds */}
        {channels.length > 0 && (
          <>
            <p className="text-xs font-medium text-slate-600 mb-2">Channel Constraints</p>
            {channels.length > 0 && !channelBounds.length && (
              <Btn variant="outline" onClick={initBoundsFromChannels} className="mb-3">Initialize Channel Bounds</Btn>
            )}
            {channelBounds.length > 0 && (
              <div className="overflow-auto mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      {["Channel", "Min Spend ($)", "Max Spend ($)", "Starting Iteration"].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {channelBounds.map((b, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 font-medium text-slate-700">{b.channel.replace("_transformed", "")}</td>
                        {[["min", 1000], ["max", 10000], ["iter", 1]].map(([field, step]) => (
                          <td key={field} className="px-2 py-2">
                            <input type="number" value={b[field]} step={step} min={0}
                              onChange={(e) => updateBound(idx, field, parseInt(e.target.value))}
                              className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <Btn onClick={handleOptimize} disabled={loading || !Object.keys(mergedRc).length}>
          {loading ? "Optimizing…" : "▶ Run Optimization"}
        </Btn>
      </Card>

      {loading && <Spinner label="Running marginal ROI optimization…" />}

      {/* Results */}
      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric
              label="Status"
              value={result.converged ? "✅ Converged" : "⚠️ Max Steps"}
            />
            <Metric
              label={optType === "Budget Goal" ? "Total Budget Allocated" : "Total Sales Achieved"}
              value={result.final_value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            />
            <Metric label="Total Spend" value={`$${totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
            <Metric label="Total Impactable Sales"
              value={totalImpactable.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
          </div>

          {/* Allocation bar chart */}
          <Card title="Optimized Budget Allocation by Channel">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={allocationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="channel" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => [
                  n === "spend" ? `$${v.toLocaleString()}` : v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                  n,
                ]} />
                <Legend />
                <Bar dataKey="spend" name="Allocated Spend ($)" radius={[4, 4, 0, 0]}>
                  {allocationData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* ROI by channel */}
          <Card title="Post-Optimization ROI by Channel">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={allocationData} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => v.toFixed(2)} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="channel" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(v) => v.toFixed(4)} />
                <Bar dataKey="roi" name="ROI" radius={[0, 4, 4, 0]}>
                  {allocationData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Allocation table */}
          <Card title="Detailed Allocation Table">
            <DataTable
              data={allocationData.map((r) => ({
                Channel: r.channel,
                "Allocated Spend ($)": r.spend.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                "Impactable Sales": r.impactable.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                ROI: r.roi.toFixed(4),
                "% of Budget": totalSpend > 0 ? `${((r.spend / totalSpend) * 100).toFixed(1)}%` : "—",
              }))}
            />
            <div className="mt-4">
              <Btn variant="outline" onClick={() => {
                const csv = ["Channel,Allocated Spend,Impactable Sales,ROI,% of Budget",
                  ...allocationData.map((r) => `${r.channel},${r.spend},${r.impactable.toFixed(0)},${r.roi.toFixed(4)},${totalSpend > 0 ? ((r.spend / totalSpend) * 100).toFixed(1) : 0}%`)].join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "optimization_result.csv";
                a.click();
              }}>
                📥 Download Allocation CSV
              </Btn>
            </div>
          </Card>

          {/* Convergence history */}
          {result.history?.length > 1 && (
            <Card title="Optimization Convergence">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={result.history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="step" tick={{ fontSize: 11 }} label={{ value: "Step", position: "insideBottom", offset: -2, fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
                  <Line type="monotone" dataKey="value" stroke="#001E96" strokeWidth={2.5} dot={false} name={optType === "Budget Goal" ? "Spend" : "Sales"} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
