import React, { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from "recharts";
import { useAppState } from "../context/AppContext";
import { PageHeader, Card, Alert, Metric, DataTable, Btn } from "../components/UI";

const COLORS = ["#001E96", "#1ABC9C", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4", "#84CC16"];

export default function ModelResults() {
  const { state, setField } = useAppState();
  const outputs = state.regressionOutputs || [];
  const [selectedIdx, setSelectedIdx] = useState(state.selectedModelIdx ?? outputs.length - 1);

  if (!outputs.length) {
    return (
      <div className="space-y-6">
        <PageHeader title="Model Results" subtitle="Compare regression iterations and review attribution" icon="📋" />
        <Alert type="warning">No model iterations found. Run a regression in the Modelling page first.</Alert>
      </div>
    );
  }

  const selected = outputs[selectedIdx] || outputs[outputs.length - 1];
  const coefficients = selected?.coefficients || [];

  // Prepare chart data — impactable % for non-intercept rows
  const chartData = coefficients
    .filter((r) => r.Note !== "Intercept" && r["Impactable (%)"])
    .map((r) => ({
      name: r.Variable?.replace("_transformed", ""),
      impactable: parseFloat(r["Impactable (%)"]?.toString().replace("%", "") || 0),
      roi: parseFloat(r.ROI) || 0,
      ltRoi: parseFloat(r["Long Term ROI"]) || 0,
    }))
    .sort((a, b) => b.impactable - a.impactable);

  const handleSelectModel = (idx) => {
    setSelectedIdx(idx);
    setField("selectedModelIdx", idx);
  };

  const downloadCoefficients = () => {
    if (!coefficients.length) return;
    const keys = Object.keys(coefficients[0]);
    const csv = [keys.join(","), ...coefficients.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${selected.name || "model"}_results.csv`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Model Results" subtitle="Review and compare regression iterations" icon="📋" />

      {/* Iteration selector */}
      <Card title="Select Iteration">
        <div className="flex flex-wrap gap-2">
          {outputs.map((out, idx) => (
            <button
              key={idx}
              onClick={() => handleSelectModel(idx)}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                selectedIdx === idx
                  ? "bg-brand-600 text-white border-brand-600"
                  : "bg-white text-slate-600 border-slate-200 hover:border-brand-300"
              }`}
            >
              {out.name || `Iteration ${idx + 1}`}
            </button>
          ))}
        </div>
      </Card>

      {/* KPI metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric label="R²" value={selected.r_squared?.toFixed(4) ?? "—"} />
        <Metric label="Adj. R²" value={selected.adj_r_squared?.toFixed(4) ?? "—"} />
        <Metric label="Modelling Period" value={`${selected.start_date} → ${selected.end_date}`} />
        <Metric label="Channels" value={coefficients.filter((r) => !r.Note).length} />
      </div>

      {/* Impactable % chart */}
      {chartData.length > 0 && (
        <Card title="Impactable Sales Attribution (%)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(1)}%`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
              <Tooltip formatter={(v) => `${v.toFixed(2)}%`} />
              <Bar dataKey="impactable" radius={[0, 4, 4, 0]} name="Impactable %">
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* ROI chart */}
      {chartData.length > 0 && (
        <Card title="ROI vs Long Term ROI by Channel">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toFixed(2)} />
              <Tooltip formatter={(v) => v.toFixed(4)} />
              <Legend />
              <Bar dataKey="roi" fill="#001E96" name="ROI" radius={[4, 4, 0, 0]} />
              <Bar dataKey="ltRoi" fill="#1ABC9C" name="Long Term ROI" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Full coefficients table */}
      <Card title="Full Coefficients Table">
        <div className="mb-3">
          <Btn variant="outline" onClick={downloadCoefficients}>📥 Download CSV</Btn>
        </div>
        <DataTable
          data={coefficients.map((row) => ({
            Variable: row.Variable,
            Coefficient: typeof row.Coefficient === "number" ? row.Coefficient.toFixed(6) : row.Coefficient,
            "Impactable (%)": row["Impactable (%)"],
            "Impactable Sales": typeof row["Impactable Sales"] === "number"
              ? row["Impactable Sales"].toLocaleString(undefined, { maximumFractionDigits: 0 })
              : row["Impactable Sales"],
            Spend: typeof row.Spend === "number"
              ? row.Spend.toLocaleString(undefined, { maximumFractionDigits: 0 })
              : row.Spend,
            ROI: typeof row.ROI === "number" ? row.ROI.toFixed(4) : row.ROI,
            "Long Term ROI": typeof row["Long Term ROI"] === "number" ? row["Long Term ROI"].toFixed(4) : row["Long Term ROI"],
            Note: row.Note || "",
          }))}
        />
      </Card>

      {/* OLS summary text */}
      <Card title="OLS Regression Summary">
        <pre className="text-xs text-slate-600 bg-slate-50 rounded-xl p-4 overflow-auto whitespace-pre-wrap font-mono leading-relaxed max-h-96">
          {selected.summary || "No summary available."}
        </pre>
      </Card>

      {/* Iteration comparison table */}
      {outputs.length > 1 && (
        <Card title="Iteration Comparison">
          <DataTable
            data={outputs.map((out, idx) => ({
              "#": idx + 1,
              Name: out.name || `Iteration ${idx + 1}`,
              "R²": out.r_squared?.toFixed(4) ?? "—",
              "Adj. R²": out.adj_r_squared?.toFixed(4) ?? "—",
              "Start": out.start_date,
              "End": out.end_date,
            }))}
          />
        </Card>
      )}
    </div>
  );
}
