import React, { useState, useEffect } from "react";
import toast from "react-hot-toast";
import Plot from "react-plotly.js";
import {
  getAvailableChannels, runRegression, runOlsStage2, runRidge, getCombinedDecomposition,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable, Metric, MultiSelect } from "../components/UI";

const ALPHA_GRID = "0.001  0.01  0.1  1  2  4  8  10  20  50  100";

function RidgePriorWeights({ channels, weights, onChange }) {
  return (
    <div className="space-y-2 mt-3">
      <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-slate-500 px-1">
        <span>Channel</span><span>Weight</span><span>Scale factor</span><span>Effect</span>
      </div>
      {channels.map((ch) => {
        const w = weights[ch] ?? 1.0;
        return (
          <div key={ch} className="grid grid-cols-4 gap-2 items-center text-sm">
            <span className="truncate text-slate-700" title={ch}>{ch.replace("_transformed", "")}</span>
            <input type="number" step="0.5" min="0.01" max="100"
              value={w}
              onChange={(e) => onChange(ch, parseFloat(e.target.value) || 1)}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs" />
            <span className="text-xs text-slate-500">× {(1 / w).toFixed(4)}</span>
            <span className="text-xs text-slate-500">
              {w > 1 ? "More shrinkage" : w < 1 ? "Less shrinkage" : "Uniform"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WaterfallChart({ waterfall }) {
  if (!waterfall) return null;
  return (
    <Plot
      data={[{
        type: "waterfall",
        orientation: "v",
        measure: waterfall.measure,
        x: waterfall.labels,
        y: waterfall.values,
        text: waterfall.values.map((v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })),
        textposition: "outside",
        connector: { line: { color: "rgba(0,0,0,0.15)", width: 1, dash: "dot" } },
        increasing: { marker: { color: "#1ABC9C" } },
        decreasing: { marker: { color: "#e74c3c" } },
        totals: { marker: { color: "#2c3e50" } },
      }]}
      layout={{
        title: { text: "Combined Stage 1 + Stage 2 Contribution Waterfall", font: { size: 16, color: "#001E96" } },
        plot_bgcolor: "#f8faff",
        paper_bgcolor: "#ffffff",
        height: 520,
        margin: { l: 40, r: 40, t: 70, b: 120 },
        xaxis: { tickangle: -35, showgrid: false },
        yaxis: { title: `Impactable Sales (${waterfall.dep_var_label})`, tickformat: ",.0f", gridcolor: "rgba(0,0,0,0.07)" },
        showlegend: false,
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: "100%" }}
    />
  );
}

export default function Modelling() {
  const { state, setField } = useAppState();

  const transformedCsv = state.transformedCsvData;
  const granularCsv = state.granularCsvData || state.filteredCsvData;
  const dateCol = state.dateColumn || "";
  const geoCol = state.geoColumn || "";
  const depVar = state.dependentVariable || "";

  const [modelType, setModelType] = useState("ols");
  const [activeStage, setActiveStage] = useState(1);
  const [depVarUserInput, setDepVarUserInput] = useState(depVar);
  const [startDate, setStartDate] = useState(state.modellingStartDate || "");
  const [endDate, setEndDate] = useState(state.modellingEndDate || "");
  const [availableChannels, setAvailableChannels] = useState([]);
  const [selectedChannels, setSelectedChannels] = useState(state.selectedChannels || []);
  const [loading, setLoading] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [stage1Result, setStage1Result] = useState(null);
  const [stage2Result, setStage2Result] = useState(null);
  const [combinedResult, setCombinedResult] = useState(null);
  const [iterationName, setIterationName] = useState("Iteration 1");

  // Stage 2 config
  const [parentChannel, setParentChannel] = useState("");
  const [s2Channels, setS2Channels] = useState([]);

  // Ridge config
  const [alphaMode, setAlphaMode] = useState("auto");
  const [manualAlpha, setManualAlpha] = useState(1.0);
  const [cvSplits, setCvSplits] = useState(3);
  const [positiveCoef, setPositiveCoef] = useState(false);
  const [useCustomPenalties, setUseCustomPenalties] = useState(false);
  const [priorWeights, setPriorWeights] = useState({});

  const basePayload = () => ({
    transformed_csv: transformedCsv,
    granular_csv: granularCsv,
    date_column: dateCol,
    geo_column: geoCol,
    dependent_variable: depVar,
    dependent_variable_user_input: depVarUserInput,
    selected_channels: selectedChannels,
    start_date: startDate,
    end_date: endDate,
  });

  const handleFetchChannels = async () => {
    if (!transformedCsv) return toast.error("No transformed data — complete Data Transformation first");
    if (!startDate || !endDate) return toast.error("Set start and end dates");
    setChannelsLoading(true);
    try {
      const data = await getAvailableChannels({
        csv_data: transformedCsv,
        date_column: dateCol,
        geo_column: geoCol,
        dependent_variable: depVar,
        dependent_variable_user_input: depVarUserInput,
        start_date: startDate,
        end_date: endDate,
      });
      setAvailableChannels(data.channels);
      const initWeights = {};
      data.channels.forEach((ch) => { initWeights[ch] = 1.0; });
      setPriorWeights(initWeights);
      toast.success(`${data.channels.length} channels available`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Failed to fetch channels");
    } finally {
      setChannelsLoading(false);
    }
  };

  const saveToOutputs = (data, name) => {
    const newOutput = { ...data, name: name || iterationName };
    setField("regressionOutputs", [...(state.regressionOutputs || []), newOutput]);
    setField("selectedChannels", selectedChannels);
    setField("modellingStartDate", startDate);
    setField("modellingEndDate", endDate);
  };

  const handleRunStage1 = async () => {
    if (!transformedCsv || !granularCsv) return toast.error("Need both transformed and granular data");
    if (!selectedChannels.length) return toast.error("Select at least one channel");
    setLoading(true);
    setStage2Result(null);
    setCombinedResult(null);
    try {
      let data;
      if (modelType === "ols") {
        data = await runRegression(basePayload());
      } else {
        data = await runRidge({
          ...basePayload(),
          stage: 1,
          alpha_mode: alphaMode,
          manual_alpha: manualAlpha,
          cv_splits: cvSplits,
          positive_coef: positiveCoef,
          use_custom_penalties: useCustomPenalties,
          prior_weights: priorWeights,
        });
      }
      setStage1Result(data);
      saveToOutputs(data, `${iterationName} — Stage 1`);
      toast.success(`Stage 1 complete — R² = ${data.r_squared?.toFixed(4)}`);
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Stage 1 failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRunStage2 = async () => {
    if (!stage1Result) return toast.error("Run Stage 1 first");
    if (!parentChannel || !s2Channels.length) return toast.error("Select parent channel and Stage-2 sub-channels");
    setLoading(true);
    try {
      let data;
      if (modelType === "ols") {
        data = await runOlsStage2({
          ...basePayload(),
          parent_channel: parentChannel,
          s2_channels: s2Channels,
          stage1_coefficients: stage1Result.coefficients,
        });
      } else {
        data = await runRidge({
          ...basePayload(),
          stage: 2,
          parent_channel: parentChannel,
          s2_channels: s2Channels,
          stage1_coefficients: stage1Result.coefficients,
          alpha_mode: alphaMode,
          manual_alpha: manualAlpha,
          cv_splits: cvSplits,
          positive_coef: positiveCoef,
          use_custom_penalties: useCustomPenalties,
          prior_weights: priorWeights,
        });
      }
      setStage2Result(data);
      saveToOutputs(data, `${iterationName} — Stage 2`);

      const combined = await getCombinedDecomposition({
        stage1_coefficients: stage1Result.coefficients,
        stage2_coefficients: data.coefficients,
        parent_channel: parentChannel,
        dep_var_label: depVarUserInput,
      });
      setCombinedResult(combined);
      toast.success("Stage 2 and combined decomposition complete");
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Stage 2 failed");
    } finally {
      setLoading(false);
    }
  };

  const stage1ChannelOptions = stage1Result
    ? stage1Result.coefficients.filter((r) => r.Variable !== "const").map((r) => r.Variable)
    : selectedChannels;

  const s2Available = availableChannels.filter(
    (c) => !selectedChannels.includes(c) && c !== parentChannel
  );

  const updatePriorWeight = (ch, val) => {
    setPriorWeights((prev) => ({ ...prev, [ch]: val }));
  };

  const renderCoeffTable = (result, title) => result && (
    <Card title={title}>
      <DataTable data={result.coefficients?.map((row) => ({
        Variable: row.Variable,
        Coefficient: typeof row.Coefficient === "number" ? row.Coefficient.toFixed(6) : row.Coefficient,
        "Impactable (%)": row["Impactable (%)"],
        "Impactable Sales": typeof row["Impactable Sales"] === "number"
          ? row["Impactable Sales"].toLocaleString(undefined, { maximumFractionDigits: 0 })
          : row["Impactable Sales"],
        Note: row.Note,
      }))} />
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing Mix Modelling"
        subtitle="Run OLS or Ridge regression with optional two-stage channel decomposition"
        icon="🤖"
      />

      {!transformedCsv && (
        <Alert type="warning">No transformed data found. Complete Data Transformation first.</Alert>
      )}

      <Card title="Regression Method">
        <div className="flex gap-4 mb-4">
          {[
            { id: "ols", label: "OLS (Ordinary Least Squares)" },
            { id: "ridge", label: "Ridge Regression" },
          ].map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="modelType" checked={modelType === opt.id}
                onChange={() => { setModelType(opt.id); setStage1Result(null); setStage2Result(null); setCombinedResult(null); }} />
              {opt.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Run Stage 1 first, then optionally decompose a parent channel further in Stage 2.
        </p>
      </Card>

      <Card title="Step 1: Modelling Configuration">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
          {[
            ["Date Column", dateCol], ["Geo Column", geoCol], ["Dependent Variable (raw)", depVar],
          ].map(([label, val]) => (
            <div key={label}>
              <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
              <input value={val} readOnly className="w-full border border-slate-100 bg-slate-50 rounded-xl px-3 py-2.5 text-sm text-slate-500" />
            </div>
          ))}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Dependent Variable (transformed column)</label>
            <input type="text" value={depVarUserInput} onChange={(e) => setDepVarUserInput(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Modelling Start Date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Modelling End Date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
        </div>
        <Btn variant="outline" onClick={handleFetchChannels} disabled={channelsLoading || !transformedCsv}>
          {channelsLoading ? "Loading…" : "Load Available Channels"}
        </Btn>
      </Card>

      {modelType === "ridge" && availableChannels.length > 0 && (
        <Card title="Ridge Configuration">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Alpha selection</label>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1"><input type="radio" checked={alphaMode === "auto"} onChange={() => setAlphaMode("auto")} /> Auto (CV)</label>
                <label className="flex items-center gap-1"><input type="radio" checked={alphaMode === "manual"} onChange={() => setAlphaMode("manual")} /> Manual</label>
              </div>
              {alphaMode === "manual" ? (
                <input type="number" step="0.5" min="0.0001" value={manualAlpha} onChange={(e) => setManualAlpha(parseFloat(e.target.value))}
                  className="mt-2 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              ) : (
                <div className="mt-2">
                  <label className="text-xs text-slate-500">CV folds: {cvSplits}</label>
                  <input type="range" min="2" max="10" value={cvSplits} onChange={(e) => setCvSplits(parseInt(e.target.value))} className="w-full" />
                  <p className="text-xs text-slate-400 mt-1">Alpha grid: {ALPHA_GRID}</p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={positiveCoef} onChange={(e) => setPositiveCoef(e.target.checked)} />
                Enforce positive coefficients
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useCustomPenalties} onChange={(e) => setUseCustomPenalties(e.target.checked)} />
                Enable custom prior weights per channel
              </label>
            </div>
          </div>
          {useCustomPenalties && selectedChannels.length > 0 && (
            <RidgePriorWeights channels={selectedChannels} weights={priorWeights} onChange={updatePriorWeight} />
          )}
        </Card>
      )}

      {availableChannels.length > 0 && (
        <>
          <div className="flex gap-2 border-b border-slate-200">
            {[1, 2].map((s) => (
              <button key={s} type="button"
                onClick={() => setActiveStage(s)}
                disabled={s === 2 && !stage1Result}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeStage === s ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500"
                } ${s === 2 && !stage1Result ? "opacity-40 cursor-not-allowed" : ""}`}>
                Stage {s}
              </button>
            ))}
          </div>

          {activeStage === 1 && (
            <Card title="Stage 1 — Primary Model">
              <MultiSelect label="Toggle channels to include" value={selectedChannels}
                onChange={setSelectedChannels} options={availableChannels} />
              <div className="mt-4 flex gap-3 items-end flex-wrap">
                <div className="flex-1 min-w-48">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Iteration Name</label>
                  <input type="text" value={iterationName} onChange={(e) => setIterationName(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
                </div>
                <Btn onClick={handleRunStage1} disabled={loading || !selectedChannels.length}>
                  {loading ? "Running…" : `▶ Run ${modelType === "ols" ? "OLS" : "Ridge"} Stage 1`}
                </Btn>
              </div>
            </Card>
          )}

          {activeStage === 2 && stage1Result && (
            <Card title="Stage 2 — Sub-channel Decomposition">
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Parent channel (from Stage 1)</label>
                  <select value={parentChannel} onChange={(e) => setParentChannel(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm">
                    <option value="">Select parent channel…</option>
                    {stage1ChannelOptions.filter((c) => c !== "const").map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                {parentChannel && (
                  <MultiSelect label="Stage-2 sub-channels" value={s2Channels}
                    onChange={setS2Channels} options={s2Available.length ? s2Available : availableChannels.filter((c) => c !== parentChannel)} />
                )}
                {modelType === "ridge" && useCustomPenalties && s2Channels.length > 0 && (
                  <RidgePriorWeights channels={s2Channels} weights={priorWeights} onChange={updatePriorWeight} />
                )}
                <Btn onClick={handleRunStage2} disabled={loading || !parentChannel || !s2Channels.length}>
                  {loading ? "Running…" : `▶ Run ${modelType === "ols" ? "OLS" : "Ridge"} Stage 2`}
                </Btn>
              </div>
            </Card>
          )}
        </>
      )}

      {loading && <Spinner label="Running regression…" />}

      {stage1Result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric label="R²" value={stage1Result.r_squared?.toFixed(4)} />
            <Metric label="Adj. R²" value={stage1Result.adj_r_squared?.toFixed(4)} />
            {stage1Result.alpha != null && <Metric label="Alpha" value={String(stage1Result.alpha)} />}
            <Metric label="RMSE" value={stage1Result.rmse?.toFixed(4)} />
          </div>
          {renderCoeffTable(stage1Result, "Stage 1 — Coefficients & Attribution")}
          {stage1Result.cv_results?.length > 0 && (
            <Card title="Cross-Validation Results">
              <DataTable data={stage1Result.cv_results} />
            </Card>
          )}
        </>
      )}

      {stage2Result && renderCoeffTable(stage2Result, "Stage 2 — Coefficients & Attribution")}

      {combinedResult && (
        <>
          <Card title="Combined Stage 1 + Stage 2 Decomposition">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <Metric label="Net Impactable Sales" value={combinedResult.metrics.net_impactable_sales?.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
              <Metric label="Positive Contributions" value={combinedResult.metrics.positive_contributions?.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
              <Metric label="Negative Contributions" value={combinedResult.metrics.negative_contributions?.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
              <Metric label="Stage-2 Sub-channels" value={String(combinedResult.metrics.stage2_subchannels)} />
            </div>
            <DataTable data={combinedResult.combined_table?.map((row) => ({
              Variable: row.Variable,
              Source: row.Source,
              "Impactable (%)": row["Impactable (%)"],
              "Impactable Sales": typeof row["Impactable Sales"] === "number"
                ? row["Impactable Sales"].toLocaleString(undefined, { maximumFractionDigits: 0 })
                : row["Impactable Sales"],
            }))} />
          </Card>
          <Card title="Waterfall Chart — Combined Contribution">
            <WaterfallChart waterfall={combinedResult.waterfall} />
          </Card>
        </>
      )}
    </div>
  );
}
