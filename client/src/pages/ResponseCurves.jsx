import React, { useState } from "react";
import toast from "react-hot-toast";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { generateResponseCurves } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, Metric } from "../components/UI";

const COLORS = ["#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4"];

const defaultChannelConfig = (name) => ({
  name,
  impactable_sales_nation: 0,
  beta_coeff: 0,
  spend_nation: 0,
  start: 0,
  stop: 1000000,
  step: 10000,
  price: 1,
  saturation_function: "log",
  power_value: 0.5,
});

function NumInput({ label, value, onChange, step = 1, min, max }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type="number" value={value} onChange={(e) => onChange(parseFloat(e.target.value))}
        step={step} min={min} max={max}
        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </div>
  );
}

export default function ResponseCurves() {
  const { state, setField } = useAppState();

  // Pre-populate from modelling results
  const regressionOutputs = state.regressionOutputs || [];
  const latestModel = regressionOutputs[state.selectedModelIdx ?? regressionOutputs.length - 1];

  const [numTime, setNumTime] = useState(12);
  const [numGeo, setNumGeo] = useState(2614);
  const [channelConfigs, setChannelConfigs] = useState(() => {
    if (latestModel?.coefficients) {
      return latestModel.coefficients
        .filter((r) => !r.Note && r.Variable !== "const")
        .map((r) => ({
          ...defaultChannelConfig(r.Variable),
          beta_coeff: parseFloat(r.Coefficient) || 0,
          impactable_sales_nation: parseFloat(r["Impactable Sales"]) || 0,
          spend_nation: parseFloat(r.Spend) || 0,
        }));
    }
    return [];
  });
  const [channelInput, setChannelInput] = useState("");
  const [curves, setCurves] = useState(state.responseCurves || {});
  const [loading, setLoading] = useState(false);
  const [activeChannel, setActiveChannel] = useState(null);

  const addChannel = () => {
    const names = channelInput.split(",").map((c) => c.trim()).filter(Boolean);
    const newConfigs = names.filter((n) => !channelConfigs.find((c) => c.name === n))
      .map(defaultChannelConfig);
    if (newConfigs.length) {
      setChannelConfigs([...channelConfigs, ...newConfigs]);
      setChannelInput("");
    }
  };

  const updateConfig = (idx, field, value) => {
    setChannelConfigs((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const removeChannel = (idx) => {
    setChannelConfigs((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleGenerate = async () => {
    if (!channelConfigs.length) return toast.error("Add at least one channel");
    setLoading(true);
    try {
      const data = await generateResponseCurves({ channels: channelConfigs, num_time: numTime, num_geo: numGeo });
      setCurves(data.curves);
      setField("responseCurves", data.curves);

      // Build merged_rc for optimization page
      const mergedRc = {};
      Object.entries(data.curves).forEach(([ch, rows]) => {
        mergedRc[`${ch}_spend`] = rows.map((r) => r.spend);
        mergedRc[`${ch}_impactable_nation`] = rows.map((r) => r.impactable_nation);
        mergedRc[`${ch}_roi`] = rows.map((r) => r.roi);
        mergedRc[`${ch}_mroi`] = rows.map((r) => r.mroi);
      });
      setField("mergedRc", mergedRc);
      setField("responseCurveConfig", channelConfigs);
      setActiveChannel(Object.keys(data.curves)[0] || null);
      toast.success("Response curves generated");
    } catch (err) {
      toast.error(err.response?.data?.error || "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  const activeData = activeChannel ? curves[activeChannel] : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Response Curves"
        subtitle="Visualize the relationship between channel spend and sales impact"
        icon="📈"
      />

      {/* Global config */}
      <Card title="Model Parameters">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <NumInput label="Number of Time Periods" value={numTime} onChange={setNumTime} min={1} />
          <NumInput label="Number of Geographies" value={numGeo} onChange={setNumGeo} min={1} />
        </div>
      </Card>

      {/* Add channels */}
      <Card title="Add Channels">
        {!channelConfigs.length && latestModel && (
          <Alert type="info">Channels pre-populated from your latest model iteration.</Alert>
        )}
        {!latestModel && (
          <Alert type="warning">No model results found. Enter channels manually or run modelling first.</Alert>
        )}
        <div className="flex gap-3 mt-3 mb-4 items-end">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Add channel names (comma-separated)</label>
            <input type="text" value={channelInput} onChange={(e) => setChannelInput(e.target.value)}
              placeholder="TV_transformed, Digital_transformed, …"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <Btn variant="outline" onClick={addChannel}>+ Add</Btn>
        </div>

        {/* Per-channel config table */}
        {channelConfigs.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {["Channel", "β Coeff", "Impactable Sales", "Spend Nation", "Start", "Stop", "Step", "Price", "Saturation", "Power (k)", ""].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-600 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {channelConfigs.map((cfg, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/50">
                    <td className="px-3 py-2 font-medium text-slate-700 whitespace-nowrap">{cfg.name.replace("_transformed", "")}</td>
                    {[
                      ["beta_coeff", 0.0001],
                      ["impactable_sales_nation", 1],
                      ["spend_nation", 1],
                      ["start", 1],
                      ["stop", 1000],
                      ["step", 100],
                      ["price", 0.01],
                    ].map(([field, step]) => (
                      <td key={field} className="px-2 py-2">
                        <input type="number" value={cfg[field]} step={step}
                          onChange={(e) => updateConfig(idx, field, parseFloat(e.target.value))}
                          className="w-24 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500" />
                      </td>
                    ))}
                    <td className="px-2 py-2">
                      <select value={cfg.saturation_function} onChange={(e) => updateConfig(idx, "saturation_function", e.target.value)}
                        className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none">
                        <option value="log">Log</option>
                        <option value="power">Power</option>
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <input type="number" value={cfg.power_value} step={0.1} min={0} max={1}
                        onChange={(e) => updateConfig(idx, "power_value", parseFloat(e.target.value))}
                        disabled={cfg.saturation_function !== "power"}
                        className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none disabled:opacity-40" />
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={() => removeChannel(idx)}
                        className="text-red-400 hover:text-red-600 font-bold text-base">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <Btn onClick={handleGenerate} disabled={loading || !channelConfigs.length}>
            {loading ? "Generating…" : "Generate Response Curves"}
          </Btn>
        </div>
      </Card>

      {loading && <Spinner label="Generating response curves…" />}

      {/* Channel selector */}
      {Object.keys(curves).length > 0 && (
        <>
          <Card title="Select Channel to Visualize">
            <div className="flex flex-wrap gap-2">
              {Object.keys(curves).map((ch) => (
                <button key={ch} onClick={() => setActiveChannel(ch)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    activeChannel === ch
                      ? "bg-brand-600 text-white border-brand-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-brand-300"
                  }`}>
                  {ch.replace("_transformed", "")}
                </button>
              ))}
            </div>
          </Card>

          {/* Spend vs Sales */}
          {activeData?.length > 0 && (
            <>
              <Card title={`${(activeChannel || "").replace("_transformed", "")} — Spend vs Impactable Sales`}>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={activeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="spend" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10 }} />
                    <YAxis tickFormatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })} tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(v, n) => [
                        n === "spend" ? `$${v.toLocaleString()}` : v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                        n === "impactable_nation" ? "Impactable Sales" : n,
                      ]}
                    />
                    <Line type="monotone" dataKey="impactable_nation" stroke="#001E96" strokeWidth={2.5} dot={false} name="Impactable Sales" />
                  </LineChart>
                </ResponsiveContainer>
              </Card>

              {/* ROI vs mROI */}
              <Card title={`${(activeChannel || "").replace("_transformed", "")} — ROI & mROI`}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={activeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="spend" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toFixed(2)} />
                    <Tooltip formatter={(v) => v.toFixed(4)} />
                    <Legend />
                    <Line type="monotone" dataKey="roi" stroke="#001E96" strokeWidth={2} dot={false} name="ROI" />
                    <Line type="monotone" dataKey="mroi" stroke="#1ABC9C" strokeWidth={2} dot={false} name="mROI" />
                  </LineChart>
                </ResponsiveContainer>
              </Card>

              {/* Summary metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Metric label="Max Spend" value={`$${activeData[activeData.length - 1]?.spend.toLocaleString()}`} />
                <Metric label="Max Impactable Sales"
                  value={activeData[activeData.length - 1]?.impactable_nation.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
                <Metric label="Initial ROI" value={activeData[0]?.roi?.toFixed(4) ?? "—"} />
                <Metric label="Final ROI" value={activeData[activeData.length - 1]?.roi?.toFixed(4) ?? "—"} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
