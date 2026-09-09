import React from "react";

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ label = "Processing…" }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────
export function Card({ title, children, className = "" }) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border border-slate-100 p-6 ${className}`}>
      {title && <h3 className="text-sm font-semibold text-slate-700 mb-4 uppercase tracking-wider">{title}</h3>}
      {children}
    </div>
  );
}

// ─── PageHeader ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, icon }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-1">
        {icon && <span className="text-2xl">{icon}</span>}
        <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
      </div>
      {subtitle && <p className="text-slate-500 text-sm">{subtitle}</p>}
    </div>
  );
}

// ─── Button ───────────────────────────────────────────────────────────────────
export function Btn({ children, onClick, variant = "primary", disabled = false, className = "", type = "button" }) {
  const base = "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm",
    secondary: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    danger: "bg-red-500 text-white hover:bg-red-600",
    outline: "border border-brand-600 text-brand-600 hover:bg-brand-50",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

// ─── Select ───────────────────────────────────────────────────────────────────
export function Select({ label, value, onChange, options = [], placeholder = "Select…", className = "" }) {
  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>}
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

// ─── MultiSelect ──────────────────────────────────────────────────────────────
export function MultiSelect({ label, value = [], onChange, options = [] }) {
  const toggle = (opt) => {
    const next = value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt];
    onChange(next);
  };
  return (
    <div>
      {label && <label className="block text-xs font-medium text-slate-600 mb-2">{label}</label>}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
              value.includes(opt)
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand-300"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── DataTable ────────────────────────────────────────────────────────────────
export function DataTable({ data = [], maxRows = 100 }) {
  if (!data.length) return <p className="text-sm text-slate-400 italic">No data to display.</p>;
  const cols = Object.keys(data[0]);
  const rows = data.slice(0, maxRows);
  return (
    <div className="overflow-auto rounded-xl border border-slate-100">
      <table className="w-full text-xs text-left">
        <thead className="bg-slate-50 border-b border-slate-100">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-3 py-2.5 font-semibold text-slate-600 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-slate-50/50">
              {cols.map((c) => (
                <td key={c} className="px-3 py-2 whitespace-nowrap text-slate-700">{row[c] != null ? String(row[c]) : "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > maxRows && (
        <div className="px-4 py-2 text-xs text-slate-400 bg-slate-50 border-t border-slate-100">
          Showing {maxRows} of {data.length} rows
        </div>
      )}
    </div>
  );
}

// ─── Alert ────────────────────────────────────────────────────────────────────
export function Alert({ type = "info", children }) {
  const styles = {
    info: "bg-blue-50 border-blue-200 text-blue-800",
    success: "bg-green-50 border-green-200 text-green-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    error: "bg-red-50 border-red-200 text-red-800",
  };
  const icons = { info: "ℹ️", success: "✅", warning: "⚠️", error: "❌" };
  return (
    <div className={`flex gap-3 p-4 rounded-xl border text-sm ${styles[type]}`}>
      <span className="flex-shrink-0">{icons[type]}</span>
      <div>{children}</div>
    </div>
  );
}

// ─── Metric ───────────────────────────────────────────────────────────────────
export function Metric({ label, value }) {
  return (
    <div className="bg-brand-50 rounded-xl px-5 py-4 text-center">
      <div className="text-2xl font-bold text-brand-700">{value}</div>
      <div className="text-xs text-brand-500 mt-0.5">{label}</div>
    </div>
  );
}
