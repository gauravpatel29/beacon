import React, { useState, useEffect } from "react";
import toast from "react-hot-toast";
import {
  correlationMatrix, computeVIF, pcaAnalysis,
  getCandidateFeatures, getHighCorrPairs, applyRemoval,
  findClusters, applyCombination, applyWeightedSum, applyPcaTreatment,
} from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, DataTable, Alert, Spinner, Select } from "../components/UI";

function CorrelationHeatmap({ matrix, columns }) {
  if (!matrix || !columns.length) return null;
  const getColor = (val) => {
    const v = parseFloat(val) || 0;
    if (v > 0.7) return "#001E96";
    if (v > 0.4) return "#4060CC";
    if (v > 0.1) return "#8090EE";
    if (v < -0.7) return "#CC2020";
    if (v < -0.4) return "#EE5555";
    if (v < -0.1) return "#FFB3B3";
    return "#F0F0F5";
  };
  return (
    <div className="overflow-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-2 text-slate-500" />
            {columns.map((c) => <th key={c} className="p-2 text-slate-600 font-medium whitespace-nowrap">{c.slice(0, 12)}</th>)}
          </tr>
        </thead>
        <tbody>
          {columns.map((row) => (
            <tr key={row}>
              <td className="p-2 font-medium text-slate-600 whitespace-nowrap pr-4">{row.slice(0, 14)}</td>
              {columns.map((col) => {
                const val = matrix[row]?.[col] ?? 0;
                return (
                  <td key={col} style={{ backgroundColor: getColor(val) }} title={`${row} / ${col}: ${val?.toFixed(3)}`}
                    className="w-12 h-10 text-center font-mono text-white font-bold">
                    {val?.toFixed ? val.toFixed(2) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function applyTreatedData(setField, data) {
  setField("granularCsvData", data.csv_data);
  setField("filteredCsvData", data.csv_data);
}

export default function CorrelationAnalysis() {
  const { state, setField } = useAppState();
  const csvData = state.granularCsvData || state.filteredCsvData;

  const [activeTab, setActiveTab] = useState("analysis");
  const [featureCols, setFeatureCols] = useState([]);
  const [method, setMethod] = useState("pearson");
  const [corrResult, setCorrResult] = useState(null);
  const [vifResult, setVifResult] = useState(null);
  const [pcaResult, setPcaResult] = useState(null);
  const [loading, setLoading] = useState(false);

  // Treatment state
  const [overviewThreshold, setOverviewThreshold] = useState(0.8);
  const [highPairs, setHighPairs] = useState([]);
  const [removalThreshold, setRemovalThreshold] = useState(0.85);
  const [comboThreshold, setComboThreshold] = useState(0.85);
  const [comboMethod, setComboMethod] = useState("Sum");
  const [dropOriginal, setDropOriginal] = useState(true);
  const [clusters, setClusters] = useState([]);
  const [clusterNames, setClusterNames] = useState([]);
  const [pcaVarianceThreshold, setPcaVarianceThreshold] = useState(0.9);
  const [pcaTreatmentResult, setPcaTreatmentResult] = useState(null);

  // Weighted sum builders
  const [wsbCount, setWsbCount] = useState(1);
  const [wsbConfigs, setWsbConfigs] = useState([{ column_name: "WEIGHTED_SUM_1", columns: [], weights: {} }]);
  const [dropWsbOriginals, setDropWsbOriginals] = useState(false);

  const keyColsPayload = () => ({
    geo_column: state.geoColumn,
    date_column: state.dateColumn,
    zip_column: state.zipColumn,
    dma_column: state.dmaColumn,
    dependent_variable: state.dependentVariable,
  });

  useEffect(() => {
    if (!csvData) return;
    getCandidateFeatures({ csv_data: csvData, ...keyColsPayload() })
      .then((data) => setFeatureCols(data.feature_cols || []))
      .catch(() => {});
  }, [csvData]);

  const handleCorrelation = async () => {
    if (!csvData) return toast.error("No data — complete ingestion first");
    setLoading(true);
    try {
      const data = await correlationMatrix({
        csv_data: csvData,
        columns: featureCols.length ? featureCols : undefined,
        method,
      });
      setCorrResult(data);
      toast.success("Correlation matrix computed");
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleOverviewPairs = async () => {
    if (!csvData || !featureCols.length) return;
    setLoading(true);
    try {
      const data = await getHighCorrPairs({ csv_data: csvData, columns: featureCols, threshold: overviewThreshold });
      setHighPairs(data.pairs || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVIF = async () => {
    if (!csvData) return toast.error("No data");
    setLoading(true);
    try {
      const data = await computeVIF({ csv_data: csvData, columns: featureCols.length ? featureCols : undefined });
      setVifResult(data.vif);
      toast.success("VIF computed");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePCA = async () => {
    if (!csvData) return toast.error("No data");
    setLoading(true);
    try {
      const data = await pcaAnalysis({ csv_data: csvData, columns: featureCols.length ? featureCols : undefined, n_components: 2 });
      setPcaResult(data);
      toast.success("PCA complete");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyRemoval = async () => {
    if (!csvData) return;
    setLoading(true);
    try {
      const data = await applyRemoval({
        csv_data: csvData,
        columns: featureCols,
        threshold: removalThreshold,
        dependent_variable: state.dependentVariable,
      });
      applyTreatedData(setField, data);
      setFeatureCols(data.kept);
      toast.success(`Removed ${data.dropped.length} feature(s)`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Removal failed");
    } finally {
      setLoading(false);
    }
  };

  const handleFindClusters = async () => {
    setLoading(true);
    try {
      const data = await findClusters({ csv_data: csvData, columns: featureCols, threshold: comboThreshold });
      setClusters(data.clusters || []);
      setClusterNames((data.clusters || []).map((_, i) => `COMBO_${i + 1}`));
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyCombination = async () => {
    if (!clusters.length) return toast.error("Find clusters first");
    setLoading(true);
    try {
      const methodMap = { Sum: "sum", Mean: "mean", "Weighted Sum": "weighted_sum" };
      const data = await applyCombination({
        csv_data: csvData,
        columns: featureCols,
        clusters,
        new_names: clusterNames,
        method: methodMap[comboMethod] || "sum",
        drop_original: dropOriginal,
      });
      applyTreatedData(setField, data);
      toast.success("Combination applied to dataset");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Combination failed");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyWeightedSum = async () => {
    const valid = wsbConfigs.filter((c) => c.column_name && c.columns.length);
    if (!valid.length) return toast.error("Configure at least one weighted column");
    setLoading(true);
    try {
      const data = await applyWeightedSum({
        csv_data: csvData,
        configs: valid,
        drop_original: dropWsbOriginals,
      });
      applyTreatedData(setField, data);
      toast.success(`${valid.length} weighted column(s) added`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Weighted sum failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePcaTreatment = async () => {
    setLoading(true);
    try {
      const data = await applyPcaTreatment({
        csv_data: csvData,
        columns: featureCols,
        variance_threshold: pcaVarianceThreshold,
      });
      applyTreatedData(setField, data);
      setPcaTreatmentResult(data);
      toast.success(`PCA complete — ${data.n_components} component(s) selected`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "PCA treatment failed");
    } finally {
      setLoading(false);
    }
  };

  const tabs = [
    { id: "analysis", label: "Analysis" },
    { id: "removal", label: "Removal" },
    { id: "combination", label: "Combination" },
    { id: "pca", label: "PCA Treatment" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Correlation & Multicollinearity Analysis" subtitle="Detect correlations and treat multicollinearity" icon="📊" />
      {!csvData && <Alert type="warning">No data available. Complete Data Ingestion first.</Alert>}

      {featureCols.length > 0 && (
        <Alert type="info">{featureCols.length} candidate feature columns detected for multicollinearity analysis.</Alert>
      )}

      <div className="flex gap-2 border-b border-slate-200 flex-wrap">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              activeTab === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <Spinner />}

      {activeTab === "analysis" && (
        <>
          <Card title="Correlation Overview">
            <Select label="Correlation Method" value={method} onChange={setMethod} options={["pearson", "spearman", "kendall"]} />
            <div className="flex gap-3 flex-wrap mt-3">
              <Btn onClick={handleCorrelation} disabled={loading || !csvData}>Correlation Matrix</Btn>
              <Btn onClick={handleVIF} variant="outline" disabled={loading || !csvData}>Compute VIF</Btn>
              <Btn onClick={handlePCA} variant="secondary" disabled={loading || !csvData}>Run PCA (preview)</Btn>
            </div>
            <div className="mt-4">
              <label className="text-xs text-slate-500">Highlight threshold: {overviewThreshold}</label>
              <input type="range" min="0" max="1" step="0.05" value={overviewThreshold}
                onChange={(e) => setOverviewThreshold(parseFloat(e.target.value))} className="w-full max-w-xs" />
              <Btn variant="outline" onClick={handleOverviewPairs} disabled={!featureCols.length} className="mt-2">
                Show High Correlation Pairs
              </Btn>
            </div>
          </Card>
          {corrResult && (
            <Card title="Correlation Heatmap">
              <CorrelationHeatmap matrix={corrResult.matrix} columns={corrResult.columns} />
            </Card>
          )}
          {highPairs.length > 0 && (
            <Card title={`Pairs with |corr| ≥ ${overviewThreshold}`}>
              <DataTable data={highPairs.map((p) => ({ "Feature 1": p.feature1, "Feature 2": p.feature2, "Abs Corr": p.corr }))} />
            </Card>
          )}
          {vifResult && (
            <Card title="Variance Inflation Factor (VIF)">
              <DataTable data={vifResult.map((r) => ({
                Variable: r.variable, VIF: r.VIF?.toFixed(4) ?? "—",
                Flag: r.VIF > 10 ? "⚠️ High" : r.VIF > 5 ? "⚠️ Moderate" : "✅ OK",
              }))} />
            </Card>
          )}
          {pcaResult && (
            <Card title="PCA Preview">
              <p className="text-xs text-slate-500 mb-3">
                Explained variance: {pcaResult.explained_variance_ratio.map((v, i) => `PC${i + 1}: ${(v * 100).toFixed(1)}%`).join(" | ")}
              </p>
              <DataTable data={pcaResult.loadings.map((row, i) => ({ Component: `PC${i + 1}`, ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.toFixed(4)])) }))} />
            </Card>
          )}
        </>
      )}

      {activeTab === "removal" && (
        <Card title="Removal Approach">
          <p className="text-xs text-slate-500 mb-3">Drop one of each highly correlated pair (keeps feature most correlated with dependent variable).</p>
          <label className="text-xs text-slate-500">Removal threshold: {removalThreshold}</label>
          <input type="range" min="0" max="1" step="0.01" value={removalThreshold}
            onChange={(e) => setRemovalThreshold(parseFloat(e.target.value))} className="w-full max-w-xs mb-4" />
          <Btn onClick={handleApplyRemoval} disabled={loading || !csvData}>Apply Removal</Btn>
        </Card>
      )}

      {activeTab === "combination" && (
        <Card title="Combination Approach">
          <div className="flex gap-4 mb-4 text-sm">
            {["Sum", "Mean", "Weighted Sum"].map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input type="radio" checked={comboMethod === m} onChange={() => setComboMethod(m)} /> {m}
              </label>
            ))}
          </div>

          {comboMethod === "Weighted Sum" ? (
            <>
              <p className="text-xs text-slate-500 mb-3">Create new columns from any combination with custom weights.</p>
              {wsbConfigs.map((cfg, i) => (
                <div key={i} className="border border-slate-100 rounded-xl p-4 mb-3 space-y-2">
                  <input type="text" value={cfg.column_name} placeholder="New column name"
                    onChange={(e) => {
                      const next = [...wsbConfigs];
                      next[i] = { ...next[i], column_name: e.target.value };
                      setWsbConfigs(next);
                    }}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                  <select multiple value={cfg.columns}
                    onChange={(e) => {
                      const next = [...wsbConfigs];
                      next[i] = { ...next[i], columns: Array.from(e.target.selectedOptions, (o) => o.value) };
                      setWsbConfigs(next);
                    }}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm h-24">
                    {featureCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {cfg.columns.map((col) => (
                    <div key={col} className="flex items-center gap-2 text-sm">
                      <span className="w-40 truncate">{col}</span>
                      <input type="number" step="0.5" value={cfg.weights[col] ?? 1}
                        onChange={(e) => {
                          const next = [...wsbConfigs];
                          next[i] = { ...next[i], weights: { ...next[i].weights, [col]: parseFloat(e.target.value) } };
                          setWsbConfigs(next);
                        }}
                        className="w-20 border border-slate-200 rounded px-2 py-1 text-xs" />
                    </div>
                  ))}
                </div>
              ))}
              <div className="flex gap-2 mb-3">
                <Btn variant="outline" onClick={() => setWsbConfigs([...wsbConfigs, { column_name: `WEIGHTED_SUM_${wsbCount + 1}`, columns: [], weights: {} }])}>+ Add column</Btn>
                {wsbConfigs.length > 1 && (
                  <Btn variant="outline" onClick={() => setWsbConfigs(wsbConfigs.slice(0, -1))}>− Remove last</Btn>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm mb-3">
                <input type="checkbox" checked={dropWsbOriginals} onChange={(e) => setDropWsbOriginals(e.target.checked)} />
                Drop original source columns
              </label>
              <Btn onClick={handleApplyWeightedSum} disabled={loading}>Apply Weighted Sum</Btn>
            </>
          ) : (
            <>
              <label className="text-xs text-slate-500">Combination threshold: {comboThreshold}</label>
              <input type="range" min="0" max="1" step="0.01" value={comboThreshold}
                onChange={(e) => setComboThreshold(parseFloat(e.target.value))} className="w-full max-w-xs mb-2" />
              <label className="flex items-center gap-2 text-sm mb-3">
                <input type="checkbox" checked={dropOriginal} onChange={(e) => setDropOriginal(e.target.checked)} />
                Drop original correlated features after combining
              </label>
              <Btn variant="outline" onClick={handleFindClusters} disabled={loading} className="mb-3">Find Clusters</Btn>
              {clusters.map((cluster, i) => (
                <div key={i} className="mb-2 text-sm">
                  <span className="text-slate-500">Cluster {i + 1}: {cluster.join(", ")}</span>
                  <input type="text" value={clusterNames[i] || ""}
                    onChange={(e) => {
                      const next = [...clusterNames];
                      next[i] = e.target.value;
                      setClusterNames(next);
                    }}
                    className="ml-2 border border-slate-200 rounded px-2 py-1 text-xs" />
                </div>
              ))}
              {clusters.length > 0 && (
                <Btn onClick={handleApplyCombination} disabled={loading}>Apply Combination</Btn>
              )}
            </>
          )}
        </Card>
      )}

      {activeTab === "pca" && (
        <Card title="PCA Treatment">
          <p className="text-xs text-slate-500 mb-3">Replace correlated features with principal components and update the dataset.</p>
          <label className="text-xs text-slate-500">Target cumulative variance: {pcaVarianceThreshold}</label>
          <input type="range" min="0.5" max="0.99" step="0.01" value={pcaVarianceThreshold}
            onChange={(e) => setPcaVarianceThreshold(parseFloat(e.target.value))} className="w-full max-w-xs mb-4" />
          <Btn onClick={handlePcaTreatment} disabled={loading || !csvData}>Run PCA & Apply to Dataset</Btn>
          {pcaTreatmentResult && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-green-700">Selected {pcaTreatmentResult.n_components} component(s).</p>
              <DataTable data={pcaTreatmentResult.explained_variance?.map((r) => ({
                Component: r.Component,
                "Explained Variance": (r.Explained_Variance_Ratio * 100).toFixed(2) + "%",
                Cumulative: (r.Cumulative_Variance * 100).toFixed(2) + "%",
              }))} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
