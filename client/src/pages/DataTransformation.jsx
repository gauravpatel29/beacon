import React, { useState } from "react";
import toast from "react-hot-toast";
import { applyTransformations, runOptuna } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Alert, Spinner, DataTable } from "../components/UI";

export default function DataTransformation() {
  const { state, setField } = useAppState();
  const csvData = state.granularCsvData || state.filteredCsvData;

  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [zipCol, setZipCol] = useState(state.zipColumn || "");
  const [dmaCol, setDmaCol] = useState(state.dmaColumn || "");
  const [depVar, setDepVar] = useState(state.dependentVariable || "");
  const [addCarryover, setAddCarryover] = useState(false);
  const [transformConfig, setTransformConfig] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [columnsInput, setColumnsInput] = useState("");

  // Optuna panel
  const [optunaOpen, setOptunaOpen] = useState(false);
  const [optunaLoading, setOptunaLoading] = useState(false);
  const [optunaChannels, setOptunaChannels] = useState([]);
  const [optunaResult, setOptunaResult] = useState(null);
  const [nTrials, setNTrials] = useState(50);
  const [cvSplits, setCvSplits] = useState(3);
  const [useSignPen, setUseSignPen] = useState(true);
  const [useMagPen, setUseMagPen] = useState(true);
  const [useStabPen, setUseStabPen] = useState(true);
  const [lambdaSign, setLambdaSign] = useState(10);
  const [lambdaMag, setLambdaMag] = useState(1);
  const [lambdaStab, setLambdaStab] = useState(5);

  const channelNames = columnsInput.split(",").map((c) => c.trim()).filter(Boolean);

  const buildConfig = () => {
    const config = channelNames.map((col) => ({
      "Channel Name": col,
      "Saturation Function": null,
      "Power (k)": 0.5,
      "Lags": 1,
      "Adstock": 0.5,
    }));
    setTransformConfig(config);
    setOptunaChannels(channelNames.map((name) => ({
      name, has_adstock: true, sat_method: "Power", neg_sign: false,
    })));
  };

  const updateRow = (idx, field, value) => {
    setTransformConfig((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const updateOptunaChannel = (idx, field, value) => {
    setOptunaChannels((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      if (field === "has_power") {
        next[idx].sat_method = value ? "Power" : null;
      }
      return next;
    });
  };

  const handleRunOptuna = async () => {
    if (!csvData) return toast.error("No data");
    if (!dateCol || !geoCol || !depVar) return toast.error("Set Date, Geo and Dependent Variable");
    if (!optunaChannels.length) return toast.error("Build config table first");
    setOptunaLoading(true);
    try {
      const negative_channels = optunaChannels
        .filter((c) => c.neg_sign)
        .flatMap((c) => [c.name, `${c.name}_transformed`]);

      const data = await runOptuna({
        csv_data: csvData,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        channels_cfg: optunaChannels.map((c) => ({
          name: c.name,
          has_adstock: c.has_adstock,
          sat_method: c.sat_method,
        })),
        negative_channels,
        n_trials: nTrials,
        cv_splits: cvSplits,
        use_sign_pen: useSignPen,
        use_mag_pen: useMagPen,
        use_stab_pen: useStabPen,
        lambda_sign: lambdaSign,
        lambda_mag: lambdaMag,
        lambda_stab: lambdaStab,
      });
      setOptunaResult(data);
      toast.success(`Optuna finished — best loss: ${data.best_value?.toFixed(4) ?? "N/A"}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Optuna failed");
    } finally {
      setOptunaLoading(false);
    }
  };

  const applyOptunaSuggestions = () => {
    if (!optunaResult?.suggested_transformations) return;
    setTransformConfig(optunaResult.suggested_transformations.map((row) => ({
      "Channel Name": row["Channel Name"],
      "Saturation Function": row["Saturation Function"],
      "Power (k)": row["Power (k)"] ?? 0.5,
      "Lags": row["Lags"] ?? 1,
      "Adstock": row["Adstock"] ?? 0.5,
    })));
    toast.success("Optuna suggestions applied to transformation table");
  };

  const handleTransform = async () => {
    if (!csvData) return toast.error("No data — complete ingestion first");
    if (!dateCol || !geoCol || !depVar) return toast.error("Set Date, Geo and Dependent Variable columns");
    if (!transformConfig.length) return toast.error("Add channel columns and build config first");
    setLoading(true);
    try {
      const data = await applyTransformations({
        csv_data: csvData,
        geo_column: geoCol,
        date_column: dateCol,
        dependent_variable: depVar,
        add_carryover: addCarryover,
        transformations: transformConfig,
      });
      setResult(data);
      setField("transformedCsvData", data.csv_data);
      setField("geoColumn", geoCol);
      setField("dateColumn", dateCol);
      setField("dependentVariable", depVar);
      setField("zipColumn", zipCol);
      setField("dmaColumn", dmaCol);
      toast.success("Transformations applied");
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Transformation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Data Transformation" subtitle="Apply Adstock, Saturation, and Lag transformations to channel variables" icon="⚙️" />
      {!csvData && <Alert type="warning">No data available. Complete Data Ingestion first.</Alert>}

      <Card title="Step 1: Set Key Columns">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[
            ["Date Column", dateCol, setDateCol],
            ["Geo Column (NPI/HCP/Region)", geoCol, setGeoCol],
            ["Dependent Variable (KPI)", depVar, setDepVar],
            ["ZIP Column (optional)", zipCol, setZipCol],
            ["DMA Column (optional)", dmaCol, setDmaCol],
          ].map(([label, val, setter]) => (
            <div key={label}>
              <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
              <input type="text" value={val} onChange={(e) => setter(e.target.value)} placeholder={label}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          ))}
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={addCarryover} onChange={(e) => setAddCarryover(e.target.checked)} className="rounded" />
            Add lagged dependent variable as "Carryover"
          </label>
        </div>
      </Card>

      <Card title="Step 2: Specify Channel Columns">
        <div className="flex gap-3 items-end mb-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Channel columns (comma-separated)</label>
            <input type="text" value={columnsInput} onChange={(e) => setColumnsInput(e.target.value)}
              placeholder="e.g. TV, Digital, Print, Radio"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <Btn variant="outline" onClick={buildConfig}>Build Config Table</Btn>
        </div>
      </Card>

      {transformConfig.length > 0 && (
        <>
          <Card>
            <button type="button" onClick={() => setOptunaOpen(!optunaOpen)}
              className="w-full flex items-center justify-between text-left font-semibold text-brand-800">
              <span>🔬 Optuna — Auto-suggest Transformation Parameters</span>
              <span className="text-slate-400">{optunaOpen ? "▲" : "▼"}</span>
            </button>
            {optunaOpen && (
              <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
                <p className="text-xs text-slate-500">
                  Optuna searches for the best Power, Adstock, and Lag per channel by minimising OLS cross-validation RMSE.
                </p>
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        {["Channel", "Adstock", "Power sat.", "Neg. coeff?"].map((h) => (
                          <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-slate-600">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {optunaChannels.map((ch, idx) => (
                        <tr key={ch.name} className="border-t border-slate-50">
                          <td className="px-3 py-2 font-medium">{ch.name}</td>
                          <td className="px-3 py-2"><input type="checkbox" checked={ch.has_adstock} onChange={(e) => updateOptunaChannel(idx, "has_adstock", e.target.checked)} /></td>
                          <td className="px-3 py-2"><input type="checkbox" checked={ch.sat_method === "Power"} onChange={(e) => updateOptunaChannel(idx, "sat_method", e.target.checked ? "Power" : null)} /></td>
                          <td className="px-3 py-2"><input type="checkbox" checked={ch.neg_sign} onChange={(e) => updateOptunaChannel(idx, "neg_sign", e.target.checked)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-slate-500">Trials: {nTrials}</label>
                    <input type="range" min="10" max="300" step="10" value={nTrials} onChange={(e) => setNTrials(parseInt(e.target.value))} className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">CV folds: {cvSplits}</label>
                    <input type="range" min="2" max="8" value={cvSplits} onChange={(e) => setCvSplits(parseInt(e.target.value))} className="w-full" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={useSignPen} onChange={(e) => setUseSignPen(e.target.checked)} /> Sign penalty (λ={lambdaSign})</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={useMagPen} onChange={(e) => setUseMagPen(e.target.checked)} /> Magnitude (λ={lambdaMag})</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={useStabPen} onChange={(e) => setUseStabPen(e.target.checked)} /> Stability (λ={lambdaStab})</label>
                </div>
                <Btn onClick={handleRunOptuna} disabled={optunaLoading}>
                  {optunaLoading ? "Running Optuna…" : "🚀 Run Optuna"}
                </Btn>
                {optunaLoading && <Spinner label="Optuna optimisation in progress…" />}
                {optunaResult && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
                    <p className="text-sm text-green-800 font-medium">Optuna suggested parameters</p>
                    <DataTable data={optunaResult.suggested_transformations?.map((r) => ({
                      Channel: r["Channel Name"],
                      Adstock: r["Adstock"],
                      Lag: r["Lags"],
                      "Power (k)": r["Power (k)"],
                    }))} />
                    <Btn onClick={applyOptunaSuggestions}>✅ Apply Optuna suggestions to transformation table</Btn>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title="Step 3: Transformation Parameters">
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    {["Channel Name", "Saturation Function", "Power (k)", "Lags", "Adstock"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-600">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {transformConfig.map((row, idx) => {
                    const isDepVar = row["Channel Name"] === depVar;
                    const isCarryover = row["Channel Name"] === "Carryover";
                    return (
                      <tr key={idx}>
                        <td className="px-4 py-2 font-medium">{row["Channel Name"]}</td>
                        <td className="px-4 py-2">
                          <select value={row["Saturation Function"] || ""} onChange={(e) => updateRow(idx, "Saturation Function", e.target.value || null)}
                            disabled={isDepVar} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 disabled:opacity-50">
                            <option value="">None</option>
                            <option value="Log">Log</option>
                            <option value="Power">Power</option>
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <input type="number" step="0.1" value={row["Power (k)"]}
                            onChange={(e) => updateRow(idx, "Power (k)", parseFloat(e.target.value))}
                            disabled={isDepVar || row["Saturation Function"] !== "Power"}
                            className="w-20 text-xs border border-slate-200 rounded-lg px-2 py-1.5 disabled:opacity-40" />
                        </td>
                        <td className="px-4 py-2">
                          <input type="number" step="1" value={row["Lags"]}
                            onChange={(e) => updateRow(idx, "Lags", parseInt(e.target.value))}
                            disabled={isDepVar} className="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1.5 disabled:opacity-40" />
                        </td>
                        <td className="px-4 py-2">
                          <input type="number" step="0.1" value={row["Adstock"]}
                            onChange={(e) => updateRow(idx, "Adstock", parseFloat(e.target.value))}
                            disabled={isDepVar || isCarryover}
                            className="w-20 text-xs border border-slate-200 rounded-lg px-2 py-1.5 disabled:opacity-40" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4">
              <Btn onClick={handleTransform} disabled={loading || !csvData}>
                {loading ? "Transforming…" : "Apply Transformations"}
              </Btn>
            </div>
          </Card>
        </>
      )}

      {loading && <Spinner label="Applying transformations…" />}

      {result && (
        <Card title="Transformed Data Preview">
          <p className="text-xs text-slate-500 mb-3">{result.rows.toLocaleString()} rows × {result.columns.length} columns</p>
          <DataTable data={result.preview} />
          <div className="mt-4">
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(result.csv_data)}`}
              download="transformed_data.csv"
              className="inline-flex items-center gap-2 bg-brand-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-700">
              📥 Download Transformed CSV
            </a>
          </div>
        </Card>
      )}
    </div>
  );
}
