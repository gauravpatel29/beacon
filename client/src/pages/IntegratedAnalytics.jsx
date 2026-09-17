import React, { useState } from "react";
import toast from "react-hot-toast";
import { buildAnalytics } from "../services/api";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Btn, Select, DataTable, Alert, Spinner } from "../components/UI";

export default function IntegratedAnalytics() {
  const { state, setField } = useAppState();
  const [geoCol, setGeoCol] = useState(state.geoColumn || "");
  const [dateCol, setDateCol] = useState(state.dateColumn || "");
  const [joinType, setJoinType] = useState("outer");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const csvData = state.granularCsvData;
  const columns = state.fileData?.flatMap((f) => f.columns || []) || [];

  const handleBuild = async () => {
    if (!csvData) return toast.error("No data available. Complete Data Ingestion first.");
    if (!geoCol || !dateCol) return toast.error("Select Geo and Date columns");
    setLoading(true);
    try {
      const data = await buildAnalytics({
        files: [{ csv_data: csvData, label: "main" }],
        geo_col: geoCol,
        date_col: dateCol,
        join_type: joinType,
      });
      setResult(data);
      setField("granularCsvData", data.csv_data);
      setField("geoColumn", geoCol);
      setField("dateColumn", dateCol);
      toast.success(`Analytics dataset built: ${data.rows} rows`);
    } catch (err) {
      toast.error(err.response?.data?.error || "Build failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Integrated Analytics Dataset Builder" subtitle="Join multiple channel files into a unified modeling dataset" icon="🔗" />
      {!csvData && <Alert type="warning">Please complete Data Ingestion first.</Alert>}
      <Card title="Dataset Configuration">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Select label="Geo/Grouping Column" value={geoCol} onChange={setGeoCol} options={columns} />
          <Select label="Date Column" value={dateCol} onChange={setDateCol} options={columns} />
          <Select label="Join Type" value={joinType} onChange={setJoinType} options={["inner", "left", "outer"]} />
        </div>
        <Btn onClick={handleBuild} disabled={loading || !csvData}>
          {loading ? "Building…" : "Build Analytics Dataset"}
        </Btn>
      </Card>
      {loading && <Spinner label="Building integrated dataset…" />}
      {result && (
        <Card title="Preview">
          <p className="text-sm text-slate-500 mb-3">{result.rows.toLocaleString()} rows × {result.cols} columns</p>
          <DataTable data={result.preview} />
        </Card>
      )}
    </div>
  );
}
