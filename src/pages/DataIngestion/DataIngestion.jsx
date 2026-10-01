import { useEffect, useRef, useState, useMemo } from 'react';
import Papa from 'papaparse';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, LineChart, Line } from 'recharts';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import { AXIS_TICK, CHART_COLORS, GRID, LINE_TYPE, X_LABEL, Y_LABEL } from '../../components/charts/chartTheme.js';
import cloud from '../../assets/sidebar_icon/cloud.png';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import {
  ApiError,
  commitSpec,
  deleteFile,
  detectGranularity,
  ensureWorkflow,
  forgetWorkflow,
  getFile,
  getColumnValues,
  getCsv,
  getProfile,
  getStats,
  listFiles,
  previewSpec,
  problemMessage,
  storedWorkflowId,
  uploadFiles,
} from '../../services/api.js';
import {
  COLUMN_ROLES,
  ROLE_IDS,
  restoreColumnRoles,
  roleMeta,
  rolesFor,
} from '../../services/columnRoles.js';
import {
  AGGREGATIONS,
  aggregateTrend,
  aggregationsFor,
  isDateLikeName,
} from '../../services/trendRollup.js';
import { forgetFile, recordStage } from '../../services/workflowState.js';
import { useScreenState } from '../../services/useScreenState.js';
import {
  buildFilters,
  buildLiveUpdates,
  buildSpec,
  clampDtype,
  conditionIsSet,
  describeChainEntry,
  emptyChainEntry,
  emptyCondition,
  looksLikeNpi,
  partitionNewFiles,
  restoreFilterChain,
  restoreGranularity,
  humanFormat,
  localProblems,
  localWarnings,
  renamedName,
  toIsoDate,
} from '../../services/manifest.js';
import { nullPctColor } from '../../services/nullscale.js';
import './DataIngestion.css';

export const FILE_CATEGORIES = [
  {
    id: 'sales',
    label: 'Sales File',
    grain: 'HCP/DMA × Month/Week',
    desc: 'HCP/DMA × Month/Week grain; used as allocation base',
    required: true,
  },
  {
    id: 'hcp_promo',
    label: 'HCP Promotions',
    grain: 'HCP × Period',
    desc: 'Calls, Samples, Details, Speaker programs',
    required: false,
  },
  {
    id: 'dma_promo',
    label: 'DTC Promotions',
    grain: 'DMA × Period',
    desc: 'TV, Radio, Print, Digital spend impressions',
    required: false,
  },
  {
    id: 'dma_hcp_map',
    label: 'Mapping Files',
    grain: 'HCP ↔ DMA Bridge',
    desc: 'Crosswalk bridge between HCP IDs ZIPs and DMA IDs',
    required: false,
  },
  {
    id: 'other',
    label: 'Other Misceleneous Files',
    grain: 'Varies',
    desc: 'Supplementary or reference data that doesn\'t fit the standard categories above.',
    required: false,
  },
];

export const PROMO_SUB_TIERS = [
  { id: "Personal Promotion", label: "Personal Promotion (Rep Calls, Detailing, Samples, Events)", badge: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  { id: "Non Personal Promotion", label: "Non Personal Promotion (RTE, Emails, Portal, HCP Web)", badge: "bg-amber-100 text-amber-800 border-amber-300" },
  { id: "DTC Promotion", label: "DTC Promotion (TV, Digital Ads, Search, Social, Print)", badge: "bg-purple-100 text-purple-800 border-purple-300" },
];

const PLATFORM_TYPES = [
  { id: 'databricks', label: 'Databricks', short: 'DB' },
  { id: 'snowflake', label: 'Snowflake', short: 'SF' },
  { id: 'fabric', label: 'Fabric', short: 'FAB' },
];

const DATA_TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'date', label: 'Date' },
];

const DATE_FORMATS = [
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY (24/05/2026)' },
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY (05/24/2026)' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD (2026-05-24)' },
  { value: '%Y-%m', label: 'YYYY-MM (2026-05) - month grain' },
];

const isMonthGrainFormat = (fmt) => /^%Y[-/]%m$/.test(fmt || '');
const TAB_ORDER = ['mapping', 'standardize', 'filter', 'review'];

function hasCommittedSpec(dataset) {
  const spec = dataset?.spec || {};
  const lu = spec.live_updates || {};
  return Boolean(
    (lu.column_drops || []).length ||
    (lu.column_renames || []).length ||
    (lu.dtype_changes || []).length ||
    (lu.date_formats || []).length ||
    (spec.filters || []).length ||
    spec.granularity
  );
}

function ControlTotalsRibbon({ stats }) {
  const { data, isLoading, error } = stats || {};
  const rowCount = data?.row_count ?? 0;
  const duplicates = data?.duplicate_rows ?? 0;

  return (
    <div className="control-totals">
      <div className="control-totals-bar" aria-live="polite">
        <span className="control-totals-kpis">
          <span className="control-kpi">
            <span className="control-kpi-label">Total Row Count</span>
            <span className="control-kpi-value">
              {isLoading ? '…' : rowCount.toLocaleString()}
            </span>
          </span>
          <span className="control-kpi">
            <span className="control-kpi-label">Duplicate Rows</span>
            <span className={`control-kpi-value${duplicates > 0 ? ' is-warn' : ''}`}>
              {isLoading ? '…' : duplicates.toLocaleString()}
            </span>
          </span>
        </span>
        <span className="control-totals-toggle">
          {error ? 'Unavailable' : isLoading ? 'Loading…' : 'See Data Review tab for full column detail'}
        </span>
      </div>

      {error && <p className="control-totals-error">{error}</p>}
    </div>
  );
}

function num(value) {
  if (value === null || value === undefined) return 'NA';
  return typeof value === 'number' ? value.toLocaleString() : String(value);
}

function buildSummaryRows(file, statsFor) {
  const statsByColumn = Object.fromEntries((statsFor?.data?.columns || []).map((c) => [c.column, c]));

  return (file.profile || []).map((p) => {
    const statEntry = statsByColumn[renamedName(file, p.column)] || {};

    const dtype = p.suggested_dtype || 'string';
    const isDate = dtype === 'date' || statEntry.kind === 'date';
    const isMetric = !p.id_like && !isDate
      && (dtype === 'integer' || dtype === 'float' || statEntry.numeric === true);
    const role = p.id_like ? 'Dimension' : isDate ? 'Date' : isMetric ? 'Metric' : 'Dimension';

    return {
      column: p.column,
      role,
      distinct: statEntry.distinct_count ?? p.unique_count ?? null,
      controlTotal: statEntry.control_total ?? null,
      activePct: statEntry.active_pct ?? null,
      mean: statEntry.mean ?? null,
      median: statEntry.median ?? null,
      stdDev: statEntry.std_dev ?? null,
      p75: statEntry.p75 ?? null,
      p95: statEntry.p95 ?? null,
      min: statEntry.min ?? null,
      max: statEntry.max ?? null,
      nullPct: statEntry.null_pct ?? null,
    };
  });
}

function TimeTrendsSection({ file, statsFor, aggregation, setAggregation, selectedMetrics, setSelectedMetrics, xAxisKey, setXAxisKey, startDate, setStartDate, endDate, setEndDate }) {
  const previewRows = file.previewRows || [];
  const [fullRows, setFullRows] = useState(null);
  const [isLoadingFull, setIsLoadingFull] = useState(false);
  const [fullError, setFullError] = useState(null);

  const derived = (col) => renamedName(file, col);

  const frameSignature = `${file.filename}|${file.totalRows || 0}|`
    + `${(file.previewColumns || []).join(',')}`;

  useEffect(() => {
    if (!file.workflowId || !file.filename) return undefined;
    let cancelled = false;
    const load = async () => {
      setIsLoadingFull(true);
      setFullError(null);
      return getCsv(file.workflowId, file.filename);
    };
    load()
      .then((text) => {
        if (cancelled) return;
        const parsed = Papa.parse(String(text || '').trim(), {
          header: true, skipEmptyLines: true,
        });
        setFullRows(parsed.data || []);
      })
      .catch((err) => {
        if (cancelled) return;
        setFullRows(null);
        setFullError(problemMessage(err, 'Could not load the full file.'));
      })
      .finally(() => { if (!cancelled) setIsLoadingFull(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSignature, file.workflowId]);

  const usingFullFile = Array.isArray(fullRows);
  const sourceRows = usingFullFile ? fullRows : previewRows;

  const dateColumns = useMemo(() => {
    const statsByColumn = Object.fromEntries((statsFor?.data?.columns || []).map((c) => [c.column, c]));
    const all = (file.profile || []).map((p) => p.column);
    const typed = all.filter((col) => {
      const p = (file.profile || []).find((x) => x.column === col) || {};
      const dtype = file.typeCastMap?.[col] || p.suggested_dtype || 'string';
      return dtype === 'date' || statsByColumn[derived(col)]?.kind === 'date';
    });
    if (typed.length) return typed;
    return (all.length ? all : (file.columns || [])).filter(isDateLikeName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, statsFor]);

  const effectiveXAxis = (xAxisKey && dateColumns.includes(xAxisKey))
    ? xAxisKey
    : (dateColumns[0] || '');
  const xAxisIsDateLike = Boolean(effectiveXAxis);

  const availableDateBounds = useMemo(() => {
    if (!xAxisIsDateLike) return null;
    const values = sourceRows
      .map((r) => toIsoDate(String(r[derived(effectiveXAxis)] ?? '')))
      .filter(Boolean)
      .sort();
    return values.length ? { min: values[0], max: values[values.length - 1] } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRows, effectiveXAxis, xAxisIsDateLike]);

  const effectiveStart = startDate || availableDateBounds?.min || '';
  const effectiveEnd = endDate || availableDateBounds?.max || '';

  const metricColumns = useMemo(() => {
    const statsByColumn = Object.fromEntries((statsFor?.data?.columns || []).map((c) => [c.column, c]));
    return (file.profile || [])
      .filter((p) => {
        if (p.column === effectiveXAxis) return false;
        const statEntry = statsByColumn[renamedName(file, p.column)] || {};
        const dtype = file.typeCastMap?.[p.column] || p.suggested_dtype || 'string';
        const isDate = dtype === 'date' || statEntry.kind === 'date';
        return !p.id_like && !isDate
          && (dtype === 'integer' || dtype === 'float' || statEntry.numeric === true);
      })
      .map((p) => p.column);
  }, [file, statsFor, effectiveXAxis]);

  useEffect(() => {
    if (selectedMetrics.length === 0 && metricColumns.length > 0) {
      setSelectedMetrics(metricColumns.slice(0, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricColumns]);

  useEffect(() => {
    if (selectedMetrics.includes(effectiveXAxis)) {
      setSelectedMetrics(selectedMetrics.filter((m) => m !== effectiveXAxis));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveXAxis]);

  const toggleMetric = (m) => {
    setSelectedMetrics(selectedMetrics.includes(m)
      ? selectedMetrics.filter((x) => x !== m)
      : [...selectedMetrics, m]);
  };

  const rowsInRange = useMemo(() => {
    if (!xAxisIsDateLike || (!effectiveStart && !effectiveEnd)) return sourceRows;
    const xCol = derived(effectiveXAxis);
    return sourceRows.filter((r) => {
      const v = toIsoDate(String(r[xCol] ?? ''));
      if (!v) return false;
      if (effectiveStart && v < effectiveStart) return false;
      if (effectiveEnd && v > effectiveEnd) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRows, effectiveXAxis, xAxisIsDateLike, effectiveStart, effectiveEnd]);

  const [autoGrain, setAutoGrain] = useState('');
  const [isDetectingGrain, setIsDetectingGrain] = useState(true);
  const detectKey = `${file.filename}|${effectiveXAxis}`;
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      if (!file.workflowId || !effectiveXAxis || !xAxisIsDateLike) {
        setIsDetectingGrain(false);
        return;
      }
      setIsDetectingGrain(true);
      try {
        const detail = await detectGranularity(file.workflowId, file.filename, {
          date_column: renamedName(file, effectiveXAxis),
          live_updates: buildLiveUpdates(file),
          filters: buildFilters(file),
        });
        if (!cancelled) setAutoGrain(detail.granularity || '');
      } catch {
        if (!cancelled) setAutoGrain('');
      } finally {
        if (!cancelled) setIsDetectingGrain(false);
      }
    };
    detect();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectKey, file.workflowId]);

  const fileGrain = file.granularityConfig?.target
    || file.granularityConfig?.detected
    || autoGrain
    || '';
  const aggOptions = aggregationsFor(fileGrain);

  useEffect(() => {
    if (!aggOptions.includes(aggregation)) setAggregation(aggOptions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileGrain]);

  const activeAgg = aggOptions.includes(aggregation) ? aggregation : aggOptions[0];

  const trend = useMemo(() => {
    if (!effectiveXAxis || selectedMetrics.length === 0) return { points: [], unparseable: 0 };
    return aggregateTrend(
      rowsInRange, derived(effectiveXAxis), selectedMetrics,
      AGGREGATIONS[activeAgg].period, xAxisIsDateLike, derived,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsInRange, effectiveXAxis, selectedMetrics, activeAgg, xAxisIsDateLike]);

  const chartData = trend.points;
  const showVertices = chartData.length <= 60;

  if (!effectiveXAxis) {
    return (
      <p className="tab-placeholder-note">
        No date column in this file yet. Type one as a date on the Standardize tab
        and it will appear here as an X Axis option.
      </p>
    );
  }

  if (isDetectingGrain || (isLoadingFull && !usingFullFile)) {
    return (
      <div style={{ marginTop: '1.5rem' }}>
        <p className="mapping-section-label">Time-Series Trend</p>
        <div className="trend-loading">
          <span className="trend-spinner" aria-hidden="true" />
          <span>
            {isDetectingGrain
              ? 'Detecting the time grain of this file…'
              : 'Loading the full file…'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <p className="mapping-section-label">
        Time-Series Trend{usingFullFile ? '' : ' (Preview Sample)'}
      </p>
      <p className="tab-placeholder-note" style={{ marginBottom: '0.75rem' }}>
        {isLoadingFull && !usingFullFile && <>Loading the full file…</>}
        {usingFullFile && (
          <>
            All {sourceRows.length.toLocaleString()} rows in this file, summed per
            {` ${AGGREGATIONS[activeAgg].period}`}.
            {fileGrain && <> This file is {String(fileGrain).toLowerCase()}.</>}
            {(startDate || endDate) && (
              <> {rowsInRange.length.toLocaleString()} fall within the selected range.</>
            )}
            {trend.unparseable > 0 && (
              <> {trend.unparseable.toLocaleString()} rows have a date that could not be
                read and are not included.</>
            )}
          </>
        )}
        {!usingFullFile && !isLoadingFull && (
          <>
            {fullError ? `${fullError} ` : ''}
            Showing the first {previewRows.length.toLocaleString()} preview rows instead.
          </>
        )}
      </p>

      <div className="trend-controls-row">
        {xAxisIsDateLike && (
          <div className="agg-toggle">
            {aggOptions.map((key) => (
              <button
                key={key}
                className={activeAgg === key ? 'active' : ''}
                onClick={() => setAggregation(key)}
              >
                {AGGREGATIONS[key].label}
              </button>
            ))}
          </div>
        )}

        {xAxisIsDateLike && (
          <div className="trend-date-range">
            <label htmlFor="trend-from">From:</label>
            <input
              id="trend-from"
              type="date"
              value={effectiveStart}
              min={availableDateBounds?.min}
              max={effectiveEnd || availableDateBounds?.max}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <label htmlFor="trend-to">To:</label>
            <input
              id="trend-to"
              type="date"
              value={effectiveEnd}
              min={effectiveStart || availableDateBounds?.min}
              max={availableDateBounds?.max}
              onChange={(e) => setEndDate(e.target.value)}
            />
            {(startDate || endDate) && (
              <button type="button" className="trend-range-reset"
                      onClick={() => { setStartDate(''); setEndDate(''); }}>
                Reset range
              </button>
            )}
          </div>
        )}

        <p className="metric-select-links trend-metric-links">
          <span onClick={() => setSelectedMetrics(metricColumns)}>Select All</span>{' | '}
          <span onClick={() => setSelectedMetrics(metricColumns.slice(0, 1))}>Clear to 1</span>
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '0.75rem' }}>
        <div>
          <p className="mapping-section-label" style={{ marginBottom: '0.5rem' }}>
            X Axis - Select Date Column (1 selected):
          </p>
          <div className="metric-pills">
            {dateColumns.map((c) => (
              <span
                key={c}
                className={`metric-pill${effectiveXAxis === c ? ' selected' : ''}`}
                onClick={() => setXAxisKey(c)}
              >
                {c}
              </span>
            ))}
          </div>
        </div>

        <div>
          <p className="mapping-section-label" style={{ marginBottom: '0.5rem' }}>
            Y Axis - Select Metrics to Display on Trend Line ({selectedMetrics.length} selected):
          </p>
          <div className="metric-pills">
            {metricColumns.map((m) => (
              <span key={m} className={`metric-pill${selectedMetrics.includes(m) ? ' selected' : ''}`} onClick={() => toggleMetric(m)}>{m}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="trend-chart-wrapper">
        {chartData.length === 0 ? (
          <p className="tab-placeholder-note">No data to plot for the selected metrics.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                     minTickGap={24}
                     label={{ value: xAxisIsDateLike ? AGGREGATIONS[activeAgg].xLabel : effectiveXAxis, ...X_LABEL }} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                     tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                     label={{ value: 'Value', ...Y_LABEL }} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }} />
              {selectedMetrics.map((key, i) => (
                <Line key={key} type={LINE_TYPE} dataKey={key} stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={showVertices ? { r: 2.5, strokeWidth: 0, fill: CHART_COLORS[i % CHART_COLORS.length] } : false}
                      activeDot={{ r: 4, strokeWidth: 1.5, stroke: '#fff' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <div className="trend-legend">
          {selectedMetrics.map((m, i) => (
            <div key={m} className="trend-legend-item">
              <span className="trend-legend-swatch" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />{m}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function isPromoRole(roleId) {
  const meta = roleMeta(roleId);
  const label = `${meta?.short || ''} ${meta?.hint || ''}`.toLowerCase();
  return label.includes('promo');
}

function restorePromoSubTiers(saved, renameMap) {
  if (!saved) return {};
  const reverse = Object.fromEntries(Object.entries(renameMap).map(([from, to]) => [to, from]));
  return Object.fromEntries(
    Object.entries(saved).map(([renamedCol, tier]) => [reverse[renamedCol] || renamedCol, tier])
  );
}

function ColumnRoleTable({ file, onChange, onSubTierChange, onBulk }) {
  const columns = file.columns || [];
  const roles = rolesFor(columns, file.columnRoles);
  const dropped = new Set(columns.filter((c) => !(file.selectedCols || columns).includes(c)));

  const counts = Object.fromEntries(
    ROLE_IDS.map((id) => [id, columns.filter((c) => !dropped.has(c) && roles[c] === id).length])
  );

  const sampleFor = (col) => (file.previewRows || [])
    .slice(0, 3)
    .map((r) => r[renamedName(file, col)] ?? r[col])
    .filter((v) => v !== undefined && v !== null && v !== '')
    .join(' · ');

  if (!columns.length) return null;

  return (
    <>
      <hr className="mapping-divider" />
      <p className="mapping-section-label">
        Column categories ({columns.length} columns)
      </p>
      <p className="tab-placeholder-note" style={{ marginBottom: '0.6rem' }}>
        What each column is used for when modelling. Data Transformation, Data Review and
        Model Configuration all read these instead of guessing from column names.
      </p>

      <div className="role-summary">
        {COLUMN_ROLES.map((role) => (
          <span key={role.id} className={`role-chip tone-${role.tone}`}>
            {role.short}: <strong>{counts[role.id]}</strong>
          </span>
        ))}
        <button
          type="button"
          className="role-reset"
          onClick={() => onBulk(rolesFor(columns))}
          title="Re-apply the name-based guess to every column"
        >
          Reset to suggested
        </button>
      </div>

      <div className="role-table-wrap">
        <table className="role-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Category</th>
              <th>Promotional Sub-Tier</th>
              <th>Sample values</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col) => {
              const meta = roleMeta(roles[col]);
              const isPromo = isPromoRole(roles[col]);
              return (
                <tr key={col} className={dropped.has(col) ? 'is-dropped' : ''}>
                  <td className="role-col-name">
                    {col}
                    {dropped.has(col) && <span className="role-dropped-tag">dropped</span>}
                    {renamedName(file, col) !== col && (
                      <span className="role-renamed-tag">→ {renamedName(file, col)}</span>
                    )}
                  </td>
                  <td>
                    <select
                      className={`role-select tone-${meta?.tone || 'neutral'}`}
                      value={roles[col]}
                      disabled={dropped.has(col)}
                      onChange={(e) => onChange(col, e.target.value)}
                      aria-label={`Category for ${col}`}
                    >
                      {COLUMN_ROLES.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.short} - {role.hint}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {isPromo ? (
                      <select
                        className="role-select tone-emerald"
                        value={file.promoSubTiers?.[col] || ''}
                        disabled={dropped.has(col)}
                        onChange={(e) => onSubTierChange(col, e.target.value)}
                        aria-label={`Promotional sub-tier for ${col}`}
                      >
                        <option value="">Select sub-tier…</option>
                        {PROMO_SUB_TIERS.map((tier) => (
                          <option key={tier.id} value={tier.id}>{tier.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="role-samples">NA</span>
                    )}
                  </td>
                  <td className="role-samples">{sampleFor(col) || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ValuePicker({ workflowId, filename, column, selected, onChange }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!column) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setIsSearching(true);
      getColumnValues(workflowId, filename, column, query, 50)
        .then((data) => {
          if (cancelled) return;
          setOptions(data.values || []);
          setResult(data);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setOptions([]);
          setError(err instanceof ApiError ? err.text : 'Could not read this column.');
        })
        .finally(() => { if (!cancelled) setIsSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workflowId, filename, column, query]);

  const toggle = (value) => {
    onChange(selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value]);
  };

  return (
    <div className="value-picker">
      <input
        type="text"
        className="filter-input"
        placeholder="Type to search values…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {selected.length > 0 && (
        <div className="value-chips">
          {selected.map((v) => (
            <button type="button" className="value-chip" key={v} onClick={() => toggle(v)}>
              {v}<span aria-hidden="true"> ×</span>
            </button>
          ))}
          <button type="button" className="value-chip is-clear" onClick={() => onChange([])}>
            Clear all
          </button>
        </div>
      )}

      <div className="value-options">
        {isSearching && <p className="value-hint">Searching…</p>}
        {!isSearching && error && <p className="value-hint">{error}</p>}
        {!isSearching && !error && !options.length && (
          <p className="value-hint">{query ? `No value matches "${query}".` : 'No values in this column.'}</p>
        )}
        {!isSearching && options.map((opt) => (
          <button
            type="button"
            key={opt.value}
            className={`value-option${selected.includes(opt.value) ? ' is-selected' : ''}`}
            onClick={() => toggle(opt.value)}
          >
            <span className="value-option-text">{opt.value}</span>
            <span className="value-option-count">{opt.count.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {result?.truncated && (
        <p className="value-hint">
          Showing {options.length} of {result.match_count.toLocaleString()} matching values. Keep typing to narrow.
        </p>
      )}
    </div>
  );
}

function filterKindOf(file, stats, column) {
  const entry = (stats?.data?.columns || []).find((c) => c.column === renamedName(file, column));
  if (entry && entry.kind !== 'string') return entry.kind;

  const cast = file.typeCastMap?.[column];
  if (cast === 'integer' || cast === 'bigint' || cast === 'float' || cast === 'decimal') return 'number';
  if (cast === 'date' || cast === 'timestamp') return 'date';
  return entry?.kind || 'string';
}

let fileIdCounter = 0;

function DataIngestion() {
  const pendingScreen = useRef(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState('mapping');
  const [visitedTabs, setVisitedTabs] = useState(new Set(['mapping']));

  useEffect(() => { recordStage('ingestion'); }, []);

  const stateRestored = useScreenState('ingestion', {
    ready: uploadedFiles.length > 0,
    deps: [activeTab, selectedFileId, uploadedFiles, visitedTabs],
    snapshot: () => ({
      activeTab,
      openFile: uploadedFiles.find((f) => f.id === selectedFileId)?.filename || null,
      visitedTabs: Array.from(visitedTabs),
      pendingCategories: Object.fromEntries(
        uploadedFiles.filter((f) => f.category).map((f) => [f.filename, f.category])
      ),
    }),
    restore: (v) => {
      if (typeof v.activeTab === 'string') setActiveTab(v.activeTab);
      if (Array.isArray(v.visitedTabs) && v.visitedTabs.length) {
        setVisitedTabs(new Set(v.visitedTabs));
      }
      pendingScreen.current = {
        openFile: v.openFile || null,
        pendingCategories: v.pendingCategories || {},
      };
    },
  });

  const [isApplying, setIsApplying] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);
  const [isRestoringFiles, setIsRestoringFiles] = useState(() => Boolean(storedWorkflowId()));
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState(null);
  const [applyMessage, setApplyMessage] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsVersion, setStatsVersion] = useState(0);
  const fileInputRef = useRef(null);

  const [platformConnections, setPlatformConnections] = useState([]);
  const [isPlatformModalOpen, setIsPlatformModalOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState(null);
  const [platformForm, setPlatformForm] = useState({ name: '', type: 'databricks', host: '', credential: '' });
  const [testingConnectionId, setTestingConnectionId] = useState(null);

  const openAddPlatformModal = () => {
    setEditingConnectionId(null);
    setPlatformForm({ name: '', type: 'databricks', host: '', credential: '' });
    setIsPlatformModalOpen(true);
  };

  const openConfigurePlatformModal = (conn) => {
    setEditingConnectionId(conn.id);
    setPlatformForm({ name: conn.name, type: conn.type, host: conn.host, credential: conn.credential || '' });
    setIsPlatformModalOpen(true);
  };

  const closePlatformModal = () => setIsPlatformModalOpen(false);

  const handleSubmitPlatformForm = () => {
    if (!platformForm.name.trim() || !platformForm.host.trim()) return;
    if (editingConnectionId) {
      setPlatformConnections((prev) => prev.map((c) => (
        c.id === editingConnectionId
          ? { ...c, name: platformForm.name.trim(), type: platformForm.type, host: platformForm.host.trim(), credential: platformForm.credential }
          : c
      )));
    } else {
      setPlatformConnections((prev) => [...prev, {
        id: `conn-${Date.now()}`,
        name: platformForm.name.trim(),
        type: platformForm.type,
        host: platformForm.host.trim(),
        credential: platformForm.credential,
        status: 'untested',
        monitored: 'Auto',
      }]);
    }
    setIsPlatformModalOpen(false);
  };

  const handleTestConnection = (conn) => {
    setTestingConnectionId(conn.id);
    window.alert(
      `Testing "${conn.name}" isn't wired to a real backend endpoint yet, so this can't ` +
      'confirm actual connectivity. Status is left as-is until a real test endpoint exists.'
    );
    setTestingConnectionId(null);
  };

  const [trendAggregation, setTrendAggregation] = useState('wow');
  const [trendMetrics, setTrendMetrics] = useState([]);
  const [trendXAxis, setTrendXAxis] = useState('');
  const [trendStartDate, setTrendStartDate] = useState('');
  const [trendEndDate, setTrendEndDate] = useState('');

  useEffect(() => {
    setTrendMetrics([]);
    setTrendXAxis('');
    setTrendStartDate('');
    setTrendEndDate('');
  }, [selectedFileId]);

  const hasVisitedAllTabs = TAB_ORDER.every((t) => visitedTabs.has(t));

  const handleNext = () => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    const nextTab = TAB_ORDER[Math.min(currentIndex + 1, TAB_ORDER.length - 1)];
    setActiveTab(nextTab);
    setVisitedTabs((prev) => new Set(prev).add(nextTab));
  };

  const handleBack = () => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    const prevTab = TAB_ORDER[Math.max(currentIndex - 1, 0)];
    setActiveTab(prevTab);
  };

  useEffect(() => {
    const workflowId = storedWorkflowId();
    if (!workflowId) {
      setIsRestoringFiles(false);
      return undefined;
    }
    if (!stateRestored) return undefined;

    let cancelled = false;

    const hydrate = async () => {
      setIsRestoringFiles(true);
      try {
        const response = await listFiles(workflowId, { kind: 'upload' });
        const items = response?.items || [];
        
        const files = await Promise.all(items.map(async (dataset) => {
          const [profileResult, fileResult] = await Promise.allSettled([
            getProfile(workflowId, dataset.filename),
            getFile(workflowId, dataset.filename),
          ]);
          const profileResponse = profileResult.status === 'fulfilled' ? profileResult.value : {};
          const currentDataset = fileResult.status === 'fulfilled' ? fileResult.value : {};
          const profile = profileResponse.profile || [];
          const rawColumns = profileResponse.columns || dataset.columns || [];
          const spec = dataset.spec || {};
          const updates = spec.live_updates || {};
          const dropped = new Set(updates.column_drops || []);
          const renameMap = Object.fromEntries(
            (updates.column_renames || []).map((item) => [item.from, item.to])
          );
          const typeCastMap = Object.fromEntries(profile.map((p) => [p.column, clampDtype(p.suggested_dtype)]));
          for (const change of updates.dtype_changes || []) typeCastMap[change.column] = change.to;

          return {
            id: `file-${++fileIdCounter}`,
            filename: dataset.filename,
            name: dataset.filename,
            workflowId,
            category: spec.config_metadata?.category || null,
            columnRoles: restoreColumnRoles(spec.config_metadata?.column_roles, renameMap),
            promoSubTiers: restorePromoSubTiers(spec.config_metadata?.promo_sub_tiers, renameMap),
            columns: rawColumns,
            previewRows: currentDataset.preview || [],
            previewColumns: dataset.columns || rawColumns,
            previewRowCount: dataset.row_count,
            totalRows: dataset.row_count || 0,
            isParsing: false,
            parseError: null,
            selectedCols: rawColumns.filter((column) => !dropped.has(column)),
            renameMap,
            profile,
            typeCastMap,
            dateConfigs: (updates.date_formats || []).length
              ? updates.date_formats.map((item) => ({ col: item.column, format: item.to }))
              : profile.filter((p) => p.suggested_date_from)
                  .map((p) => ({ col: p.column, format: '%Y-%m-%d' })),
            dateSourceFormats: (updates.date_formats || []).length
              ? Object.fromEntries(updates.date_formats.map((item) => [item.column, item.from]))
              : Object.fromEntries(profile.filter((p) => p.suggested_date_from)
                  .map((p) => [p.column, p.suggested_date_from])),
            filterConfig: {
              ...restoreFilterChain(spec, renameMap),
              draft: null,
            },
            granularityConfig: restoreGranularity(spec.granularity, renameMap),
          };
        }));

        if (!cancelled) {
          const screen = pendingScreen.current || {};
          pendingScreen.current = null;
          const withCategories = files.map((f) => (
            f.category ? f : { ...f, category: screen.pendingCategories?.[f.filename] || null }
          ));
          setUploadedFiles(withCategories);
          const reopened = withCategories.find((f) => f.filename === screen.openFile);
          setSelectedFileId((reopened || withCategories[0])?.id || null);
          if (items.some(hasCommittedSpec)) {
            setVisitedTabs(new Set(TAB_ORDER));
          }
        }
      } catch (err) {
        console.error('Workflow hydration error:', err);
      } finally {
        if (!cancelled) setIsRestoringFiles(false);
      }
    };

    hydrate();
    return () => { cancelled = true; };
  }, [stateRestored]);

  const addFiles = async (fileList) => {
    if (isUploadingFiles) return;
    const csvFiles = Array.from(fileList).filter((file) =>
      /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i.test(file.name)
    );
    if (!csvFiles.length) return;

    const { accepted, duplicates } = partitionNewFiles(
      uploadedFiles.map((f) => f.filename), csvFiles
    );

    if (duplicates.length) {
      window.alert(
        `Already uploaded: ${duplicates.join(', ')}.\n\n`
        + 'Filenames have to be unique within a workflow. Remove the existing '
        + 'file first, or rename the new one before uploading.'
      );
    }
    if (!accepted.length) return;

    setIsUploadingFiles(true);
    try {
      const workflowId = await ensureWorkflow();
      const result = await uploadFiles(workflowId, accepted, { overwrite: false });
      const newEntries = await Promise.all(result.files.map(async (dataset) => {
        const profileResponse = dataset.profile ? dataset : await getProfile(workflowId, dataset.filename);
        const profile = profileResponse.profile || [];
        const columns = dataset.columns || profileResponse.columns || [];
        return {
          id: `file-${++fileIdCounter}`, filename: dataset.filename, name: dataset.filename, workflowId,
          category: null, columns, previewRows: dataset.preview || [],
          columnRoles: rolesFor(columns),
          promoSubTiers: {},
          totalRows: dataset.row_count || 0, isParsing: false, parseError: null, selectedCols: columns,
          renameMap: {},
          profile,
          typeCastMap: Object.fromEntries(profile.map((p) => [p.column, clampDtype(p.suggested_dtype)])),
          dateConfigs: profile.filter((p) => p.suggested_date_from)
            .map((p) => ({
              col: p.column,
              format: isMonthGrainFormat(p.suggested_date_from) ? '%Y-%m' : '%Y-%m-%d',
            })),
          dateSourceFormats: Object.fromEntries(profile.filter((p) => p.suggested_date_from)
            .map((p) => [p.column, p.suggested_date_from])),
          filterConfig: { chain: [], operators: [], draft: null },
          granularityConfig: { dateCol: '', geoCol: '', detected: null, target: '', numOps: {} },
        };
      }));
      setUploadedFiles((prev) => [...prev, ...newEntries]);
      setSelectedFileId(newEntries[0]?.id || null);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Upload failed.');
    } finally {
      setIsUploadingFiles(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };
  const handleBrowseClick = () => {
    if (!isUploadingFiles) fileInputRef.current?.click();
  };
  const handleFileInputChange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const handleRemoveFile = async (fileId, e) => {
    e.stopPropagation();
    if (deletingFileId) return;
    const file = uploadedFiles.find((item) => item.id === fileId);
    setDeletingFileId(fileId);
    try {
      if (file?.workflowId) await deleteFile(file.workflowId, file.filename);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not remove this file.');
      return;
    } finally {
      setDeletingFileId(null);
    }
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
    if (selectedFileId === fileId) setSelectedFileId(null);

    if (file?.filename) forgetFile(file.filename);
  };

  const handleResetWorkflow = () => {
    setUploadedFiles([]);
    setSelectedFileId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    forgetWorkflow();
  };

  const updateFileConfig = (fileId, updates) => {
    setUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, ...updates } : f))
    );
  };

  const setColumnRole = (file, column, role) => {
    const updates = { columnRoles: { ...rolesFor(file.columns, file.columnRoles), [column]: role } };
    if (!isPromoRole(role) && file.promoSubTiers?.[column]) {
      updates.promoSubTiers = { ...file.promoSubTiers };
      delete updates.promoSubTiers[column];
    }
    updateFileConfig(file.id, updates);
  };

  const setPromoSubTier = (file, column, subTier) =>
    updateFileConfig(file.id, {
      promoSubTiers: { ...(file.promoSubTiers || {}), [column]: subTier },
    });

  const toggleKeepColumn = (file, col, keep) => {
    const selectedCols = keep
      ? [...file.selectedCols, col]
      : file.selectedCols.filter((c) => c !== col);
    updateFileConfig(file.id, { selectedCols });
  };
  const setRename = (file, col, value) =>
    updateFileConfig(file.id, { renameMap: { ...file.renameMap, [col]: value } });
  const setColType = (file, col, type) => {
    const typeCastMap = { ...file.typeCastMap, [col]: type };
    let dateConfigs = file.dateConfigs;
    const dateSourceFormats = { ...(file.dateSourceFormats || {}) };
    if (type === 'date' && !dateConfigs.find((d) => d.col === col)) {
      const detected = (file.profile || []).find((p) => p.column === col);
      const source = detected?.suggested_date_from;
      dateConfigs = [...dateConfigs, {
        col,
        format: isMonthGrainFormat(source) ? '%Y-%m' : '%d/%m/%Y',
      }];
      if (source) dateSourceFormats[col] = source;
    } else if (type !== 'date') {
      dateConfigs = dateConfigs.filter((d) => d.col !== col);
      delete dateSourceFormats[col];
    }
    updateFileConfig(file.id, { typeCastMap, dateConfigs, dateSourceFormats });
  };
  const setDateFormat = (file, col, format) =>
    updateFileConfig(file.id, {
      dateConfigs: file.dateConfigs.map((d) => (d.col === col ? { ...d, format } : d)),
    });

  const setFilterConfig = (file, updates) =>
    updateFileConfig(file.id, { filterConfig: { ...file.filterConfig, ...updates } });

  const startDraft = (file) =>
    setFilterConfig(file, { draft: emptyChainEntry('', 'string') });

  const cancelDraft = (file) => setFilterConfig(file, { draft: null });

  const setDraftColumn = (file, column) => {
    const kind = column ? filterKindOf(file, statsFor, column) : 'string';
    setFilterConfig(file, { draft: { column, kind, cond: emptyCondition() } });
  };

  const setDraftField = (file, key, value) => {
    const draft = file.filterConfig.draft;
    if (!draft) return;
    setFilterConfig(file, { draft: { ...draft, cond: { ...draft.cond, [key]: value } } });
  };

  const commitDraft = (file) => {
    const draft = file.filterConfig.draft;
    if (!draft || !draft.column) return;
    if (!conditionIsSet(draft.cond, draft.kind)) return;
    const chain = [...(file.filterConfig.chain || []), draft];
    const operators = [...(file.filterConfig.operators || [])];
    if (chain.length > 1) operators.push('and');
    setFilterConfig(file, { chain, operators, draft: null });
  };

  const removeChainEntry = (file, index) => {
    const chain = (file.filterConfig.chain || []).filter((_, i) => i !== index);
    const operators = [...(file.filterConfig.operators || [])];
    if (operators.length) operators.splice(index ? index - 1 : 0, 1);
    setFilterConfig(file, { chain, operators });
  };

  const setChainOperator = (file, gap, value) => {
    const operators = [...(file.filterConfig.operators || [])];
    operators[gap] = value;
    setFilterConfig(file, { operators });
  };

  const applyFile = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsApplying(true);
    setApplyMessage('Validating configuration…');
    try {
      const spec = buildSpec(file);
      setApplyMessage('Previewing transformations…');
      await previewSpec(file.workflowId, file.filename, spec);
      setApplyMessage('Saving transformed dataset…');
      const committed = await commitSpec(file.workflowId, file.filename, spec);
      updateFileConfig(file.id, {
        previewRows: committed.preview || [],
        previewColumns: committed.columns || file.columns,
        totalRows: committed.row_count,
      });
      setStatsVersion((v) => v + 1);
      setApplyMessage(['Configuration applied successfully. The preview now shows the transformed dataset.', ...localWarnings(file)].join(' '));
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Configuration could not be applied.');
    } finally {
      setIsApplying(false);
    }
  };

  const previewFile = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsPreviewing(true);
    setApplyMessage('Previewing changes… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      setApplyMessage(['Preview ready. These changes have not been saved.', ...localWarnings(file)].join(' '));
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Changes could not be previewed.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const applyFilter = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsFiltering(true);
    setApplyMessage('Applying filter… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      setApplyMessage('Filter preview ready. These changes have not been saved.');
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Filter could not be applied.');
    } finally {
      setIsFiltering(false);
    }
  };

  const selectedFile = uploadedFiles.find((f) => f.id === selectedFileId);

  const statsKey = selectedFile ? `${selectedFile.workflowId}/${selectedFile.filename}` : null;
  useEffect(() => {
    if (!selectedFile?.workflowId) return undefined;
    let cancelled = false;
    const { workflowId, filename } = selectedFile;
    getStats(workflowId, filename)
      .then((data) => { if (!cancelled) setStats({ filename, data, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        setStats({ filename, data: null,
                   error: err instanceof ApiError ? err.text : 'Could not read control totals.' });
      });
    return () => { cancelled = true; };
  }, [statsKey, statsVersion]);

  const statsFor = selectedFile
    ? (stats && stats.filename === selectedFile.filename
        ? { ...stats, isLoading: false }
        : { filename: selectedFile.filename, data: null, error: null, isLoading: true })
    : null;

  const statsByColumn = Object.fromEntries((statsFor?.data?.columns || []).map((c) => [c.column, c]));

  const filterChain = selectedFile?.filterConfig?.chain || [];
  const filterOperators = selectedFile?.filterConfig?.operators || [];
  const filterDraft = selectedFile?.filterConfig?.draft || null;

  const draftColumn = filterDraft?.column || '';
  const draftKind = filterDraft?.kind || 'string';
  const draftIsNpi = Boolean(draftColumn) && looksLikeNpi(selectedFile, draftColumn);
  const draftBounds = draftColumn
    ? statsByColumn[renamedName(selectedFile, draftColumn)] || null
    : null;
  const draftIsUsable = Boolean(draftColumn)
    && conditionIsSet(filterDraft?.cond, draftKind);

  const previewColumns = selectedFile?.previewColumns || selectedFile?.columns || [];
  const hasFiles = uploadedFiles.length > 0;

  return (
    <div className="data-ingestion-page">
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-header-icon icon-placeholder">
            <img src={cloud} alt="Data Ingestion" />
          </div>
          <div>
            <p className="page-header-title">Data Ingestion</p>
            <p className="page-header-subtitle">
              Upload, standardize, merge, and filter your marketing data
            </p>
          </div>
        </div>

        <button className="page-header-reset-btn" onClick={handleResetWorkflow}>
          <span aria-hidden="true">&#8635;</span> Reset Workflow
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
        multiple
        className="upload-input-hidden"
        onChange={handleFileInputChange}
      />

      {isRestoringFiles ? (
        <div className="operation-loader" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          <span>Loading files from storage…</span>
        </div>
      ) : !hasFiles ? (
        <div className="upload-card">
          <p className="upload-card-title">Upload CSV Files</p>

          <div
            className={`upload-dropzone${isDragging ? ' dragging' : ''}${isUploadingFiles ? ' loading' : ''}`}
            onClick={handleBrowseClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
          >
            {isUploadingFiles ? <span className="loading-spinner" aria-hidden="true" /> : <img src={cloud} alt="Upload" className="icon-placeholder" />}
            <p className="upload-dropzone-text">
              {isUploadingFiles ? 'Uploading files…' : 'Drag & drop CSV files here, or click to browse'}
            </p>
            <p className="upload-dropzone-subtext">
              Supports CSV, TSV, and Excel files
            </p>
          </div>

          <div className="upload-or-divider"><span>OR</span></div>

          <div className="platform-connections-section">
            <div className="platform-connections-header">
              <div>
                <p className="platform-connections-title">Platform Connections</p>
                <p className="platform-connections-subtitle">Manage data platform integrations across your estate</p>
              </div>
              <button type="button" className="add-platform-btn" onClick={openAddPlatformModal}>
                <span aria-hidden="true">+</span> Add Platform
              </button>
            </div>

            <div className="platform-cards-grid">
              {platformConnections.map((conn) => {
                const typeInfo = PLATFORM_TYPES.find((t) => t.id === conn.type) || PLATFORM_TYPES[0];
                return (
                  <div key={conn.id} className="platform-card">
                    <div className="platform-card-top">
                      <p className="platform-card-name">{conn.name}</p>
                      <span className="platform-card-badge">{typeInfo.label} &bull; {typeInfo.short}</span>
                    </div>
                    <div className="platform-card-row">
                      <span>Status</span>
                      <span className={`platform-status-dot ${conn.status}`} />
                      <span className="platform-status-label">{conn.status === 'untested' ? 'Untested' : conn.status === 'connected' ? 'Connected' : 'Failed'}</span>
                    </div>
                    <div className="platform-card-row"><span>Monitored</span><strong>{conn.monitored}</strong></div>
                    <div className="platform-card-row"><span>Host</span><strong className="platform-card-host" title={conn.host}>{conn.host}</strong></div>
                    <div className="platform-card-actions">
                      <button type="button" className="platform-action-btn" onClick={() => handleTestConnection(conn)} disabled={testingConnectionId === conn.id}>
                        &#8635; {testingConnectionId === conn.id ? 'Testing…' : 'Test'}
                      </button>
                      <button type="button" className="platform-action-btn" onClick={() => openConfigurePlatformModal(conn)}>
                        &#9881; Configure
                      </button>
                    </div>
                  </div>
                );
              })}

              <button type="button" className="platform-add-card" onClick={openAddPlatformModal}>
                <span className="platform-add-icon" aria-hidden="true">+</span>
                <span className="platform-add-label">Add Platform</span>
                <span className="platform-add-caption">
                  {PLATFORM_TYPES.map((t) => t.label.toUpperCase()).join(' \u00b7 ')}
                </span>
              </button>
            </div>
          </div>

          {isPlatformModalOpen && (
            <div className="platform-modal-overlay" onClick={closePlatformModal}>
              <div className="platform-modal" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="platform-modal-close" onClick={closePlatformModal} aria-label="Close">&times;</button>
                <p className="platform-modal-title">{editingConnectionId ? 'Configure Platform' : 'Add New Platform'}</p>
                <p className="platform-modal-subtitle">
                  {editingConnectionId ? 'Update this platform connection.' : 'Connect a new data platform to monitor.'}
                </p>

                <label className="platform-field-label">Connection Name</label>
                <input
                  type="text" className="platform-field-input" placeholder="e.g. Prod Snowflake"
                  value={platformForm.name}
                  onChange={(e) => setPlatformForm((f) => ({ ...f, name: e.target.value }))}
                />

                <label className="platform-field-label">Platform Type</label>
                <select
                  className="platform-field-input"
                  value={platformForm.type}
                  onChange={(e) => setPlatformForm((f) => ({ ...f, type: e.target.value }))}
                >
                  {PLATFORM_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>

                <label className="platform-field-label">Workspace / Host URL</label>
                <input
                  type="text" className="platform-field-input" placeholder="https://..."
                  value={platformForm.host}
                  onChange={(e) => setPlatformForm((f) => ({ ...f, host: e.target.value }))}
                />

                <label className="platform-field-label">Access Token / Credentials</label>
                <input
                  type="password" className="platform-field-input" placeholder="••••••••••••"
                  value={platformForm.credential}
                  onChange={(e) => setPlatformForm((f) => ({ ...f, credential: e.target.value }))}
                />

                <div className="platform-modal-actions">
                  <button type="button" className="mapping-btn secondary" onClick={closePlatformModal}>Cancel</button>
                  <button
                    type="button"
                    className="platform-connect-btn"
                    disabled={!platformForm.name.trim() || !platformForm.host.trim()}
                    onClick={handleSubmitPlatformForm}
                  >
                    {editingConnectionId ? 'Save Changes' : 'Connect Platform'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mapping-layout">
          <div className="file-list-panel">
            <button className="upload-files-btn" onClick={handleBrowseClick} disabled={isUploadingFiles}>
              {isUploadingFiles ? 'Uploading files…' : 'Upload files'}
            </button>
            {isUploadingFiles && <p className="file-operation-status" role="status"><span className="loading-spinner" aria-hidden="true" /> Uploading and preparing files…</p>}
            <p className="file-list-count">
              Uploaded {uploadedFiles.length} of {uploadedFiles.length}
            </p>

            <div className="file-list">
              {uploadedFiles.map((f) => {
                const categoryInfo = FILE_CATEGORIES.find((c) => c.id === f.category);
                return (
                  <div
                    key={f.id}
                    className={`file-list-item${
                      f.id === selectedFileId ? ' selected' : ''
                    }${deletingFileId === f.id ? ' deleting' : ''}`}
                    onClick={() => deletingFileId !== f.id && setSelectedFileId(f.id)}
                  >
                    <div className="file-item-text">
                      <p className="file-item-name" title={f.name}>{f.name}</p>
                      {categoryInfo && (
                        <p className="file-item-status">
                          {categoryInfo.label}
                          {categoryInfo.required && (
                            <span className="file-item-required-badge">Required</span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="file-item-actions">
                      <button
                        className="file-item-icon-btn"
                        onClick={(e) => handleRemoveFile(f.id, e)}
                        aria-label={`Remove ${f.name}`}
                        disabled={Boolean(deletingFileId)}
                      >
                        {deletingFileId === f.id ? <span className="loading-spinner" aria-hidden="true" /> : '×'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mapping-config-panel">
            {selectedFile ? (
              <>
                <div className="mapping-panel-header">
                  <div className="tab-group">
                    <button
                      className={`tab-btn${activeTab === 'mapping' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('mapping');
                        setVisitedTabs((prev) => new Set(prev).add('mapping'));
                      }}
                    >
                      Assign Category
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'standardize' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('standardize');
                        setVisitedTabs((prev) => new Set(prev).add('standardize'));
                      }}
                    >
                      Standardize
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'filter' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('filter');
                        setVisitedTabs((prev) => new Set(prev).add('filter'));
                      }}
                    >
                      Filter
                    </button>
                    <button
                      className={`tab-btn${activeTab === 'review' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('review');
                        setVisitedTabs((prev) => new Set(prev).add('review'));
                      }}
                    >
                      Data Review
                    </button>
                  </div>
                  <div className="mapping-top-actions">
                    {applyMessage && <p className="apply-config-message" role="status">{applyMessage}</p>}

                    {activeTab !== TAB_ORDER[0] && (
                      <button className="mapping-btn secondary" onClick={handleBack}>
                        Back
                      </button>
                    )}

                    <button className="mapping-btn secondary" disabled={!selectedFile || isApplying || isPreviewing || isFiltering} onClick={() => previewFile(selectedFile)}>
                      {isPreviewing ? 'Previewing changes…' : 'Preview changes'}
                    </button>

                    {activeTab !== TAB_ORDER[TAB_ORDER.length - 1] && (
                      <button
                        className={`mapping-btn ${hasVisitedAllTabs ? 'secondary' : 'primary'}`}
                        onClick={handleNext}
                      >
                        Next
                      </button>
                    )}

                    {hasVisitedAllTabs && (
                      <button className="mapping-btn primary" disabled={!selectedFile || isApplying || isPreviewing || isFiltering} onClick={() => applyFile(selectedFile)}>
                        {isApplying ? 'Applying configurations…' : 'Apply configuration'}
                      </button>
                    )}
                  </div>
                </div>

                {activeTab === 'mapping' && (
                  <ColumnRoleTable
                    file={selectedFile}
                    onChange={(column, role) => setColumnRole(selectedFile, column, role)}
                    onSubTierChange={(column, tier) => setPromoSubTier(selectedFile, column, tier)}
                    onBulk={(next) => updateFileConfig(selectedFile.id, { columnRoles: next })}
                  />
                )}

                {activeTab === 'standardize' && (
                  <>
                    <p className="mapping-section-label">
                      Column Schema &amp; Data Type Configuration
                    </p>
                    <div className="schema-table-wrapper">
                      <table className="schema-table">
                        <thead>
                          <tr>
                            <th style={{ width: 50 }}>Keep</th>
                            <th>Original Column</th>
                            <th>Rename To</th>
                            <th>Data Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedFile.columns.map((col) => {
                            const isKept = selectedFile.selectedCols.includes(col);
                            const currentType = selectedFile.typeCastMap[col] || 'string';
                            return (
                              <tr key={col} className={!isKept ? 'dropped' : ''}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={isKept}
                                    onChange={(e) =>
                                      toggleKeepColumn(selectedFile, col, e.target.checked)
                                    }
                                  />
                                </td>
                                <td className="schema-col-name">{col}</td>
                                <td>
                                  <input
                                    type="text"
                                    className="schema-rename-input"
                                    disabled={!isKept}
                                    placeholder={col}
                                    value={selectedFile.renameMap[col] || ''}
                                    onChange={(e) => setRename(selectedFile, col, e.target.value)}
                                  />
                                </td>
                                <td>
                                  <select
                                    className="schema-type-select"
                                    disabled={!isKept}
                                    value={currentType}
                                    onChange={(e) => setColType(selectedFile, col, e.target.value)}
                                  >
                                    {DATA_TYPE_OPTIONS.map((opt) => (
                                      <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {selectedFile.dateConfigs.length > 0 && (
                      <div className="date-format-box">
                        <p className="mapping-section-label" style={{ marginBottom: 0 }}>
                          Date Format (source &rarr; target)
                        </p>
                        {selectedFile.dateConfigs.map((dc) => {
                          const source = selectedFile.dateSourceFormats?.[dc.col];
                          return (
                            <div key={dc.col} className="date-format-row">
                              <span>{dc.col}</span>
                              <span>{humanFormat(source) || 'not detected'}</span>
                              <span>&rarr;</span>
                              <select
                                value={dc.format}
                                onChange={(e) => setDateFormat(selectedFile, dc.col, e.target.value)}
                              >
                                {DATE_FORMATS.map((f) => (
                                  <option key={f.value} value={f.value}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="tab-placeholder-note">
                      The source format is the one your file already uses. It is detected per
                      column and never guessed at conversion time, which is what stops day and
                      month being swapped for days of the month up to 12.
                    </p>
                  </>
                )}

                {activeTab === 'filter' && (
                  <>
                    {filterChain.map((entry, index) => (
                      <div key={index}>
                        {index > 0 && (
                          <div className="chain-gap">
                            <span className="chain-gap-line" aria-hidden="true" />
                            <select
                              className="chain-operator"
                              value={filterOperators[index - 1] === 'or' ? 'or' : 'and'}
                              onChange={(e) => setChainOperator(selectedFile, index - 1, e.target.value)}
                              aria-label={`How filter ${index} combines with filter ${index + 1}`}
                            >
                              <option value="and">AND</option>
                              <option value="or">OR</option>
                            </select>
                            <span className="chain-gap-line" aria-hidden="true" />
                          </div>
                        )}

                        <div className="chain-card">
                          <span className="chain-card-index">{index + 1}</span>
                          <span className="chain-card-text">
                            {describeChainEntry(selectedFile, entry)}
                          </span>
                          <button
                            type="button"
                            className="chain-card-remove"
                            aria-label={`Remove filter ${index + 1}`}
                            onClick={() => removeChainEntry(selectedFile, index)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}

                    {filterChain.length > 1 && (
                      <p className="chain-precedence-note">
                        Read top to bottom: each step applies to the result of the one above it,
                        so mixing AND and OR follows this order rather than AND binding tighter.
                      </p>
                    )}

                    {filterDraft && (
                      <div className="chain-draft">
                        {filterChain.length > 0 && (
                          <p className="chain-draft-heading">
                            New filter, joined with{' '}
                            <strong>{(filterOperators[filterChain.length - 1] || 'and').toUpperCase()}</strong>
                            {' '}once added
                          </p>
                        )}

                        <div className="filter-picker">
                          <p className="filter-field-label">Column</p>
                          <select
                            className="filter-select"
                            value={draftColumn}
                            onChange={(e) => setDraftColumn(selectedFile, e.target.value)}
                          >
                            <option value="">Select a column to filter</option>
                            {selectedFile.selectedCols.map((c) => (
                              <option key={c} value={c}>{renamedName(selectedFile, c)}</option>
                            ))}
                          </select>
                        </div>

                        {!draftColumn && (
                          <p className="tab-placeholder-note">
                            Pick a column. The controls shown depend on its type: a range for
                            numbers, a start and end for dates, and a searchable value list for
                            text. The same column can appear more than once in the chain.
                          </p>
                        )}

                        {draftColumn && (
                          <div className="filter-rule">
                            {draftKind === 'number' && (
                              <>
                                <div className="filter-grid">
                                  <div>
                                    <p className="filter-field-label">Minimum</p>
                                    <input
                                      type="number"
                                      className="filter-input"
                                      placeholder={draftBounds?.min ?? 'No lower bound'}
                                      value={filterDraft.cond.min}
                                      onChange={(e) => setDraftField(selectedFile, 'min', e.target.value)}
                                    />
                                  </div>
                                  <div>
                                    <p className="filter-field-label">Maximum</p>
                                    <input
                                      type="number"
                                      className="filter-input"
                                      placeholder={draftBounds?.max ?? 'No upper bound'}
                                      value={filterDraft.cond.max}
                                      onChange={(e) => setDraftField(selectedFile, 'max', e.target.value)}
                                    />
                                  </div>
                                </div>
                                {draftBounds && draftBounds.min !== null && draftBounds.max !== null && (
                                  <p className="filter-bounds-hint">
                                    This column runs {Number(draftBounds.min).toLocaleString()} to{' '}
                                    {Number(draftBounds.max).toLocaleString()}. Leave a box empty for no bound.
                                  </p>
                                )}
                              </>
                            )}

                            {draftKind === 'date' && (
                              <>
                                <div className="filter-grid">
                                  <div>
                                    <p className="filter-field-label">Start Date</p>
                                    <input
                                      type="date"
                                      className="filter-input"
                                      value={filterDraft.cond.start}
                                      onChange={(e) => setDraftField(selectedFile, 'start', e.target.value)}
                                    />
                                  </div>
                                  <div>
                                    <p className="filter-field-label">End Date</p>
                                    <input
                                      type="date"
                                      className="filter-input"
                                      value={filterDraft.cond.end}
                                      onChange={(e) => setDraftField(selectedFile, 'end', e.target.value)}
                                    />
                                  </div>
                                </div>
                                {draftBounds && draftBounds.min && draftBounds.max && (
                                  <p className="filter-bounds-hint">
                                    This column runs {draftBounds.min} to {draftBounds.max}.
                                    Both bounds are inclusive.
                                  </p>
                                )}
                              </>
                            )}

                            {draftKind === 'string' && (
                              <ValuePicker
                                workflowId={selectedFile.workflowId}
                                filename={selectedFile.filename}
                                column={renamedName(selectedFile, draftColumn)}
                                selected={filterDraft.cond.values}
                                onChange={(values) => setDraftField(selectedFile, 'values', values)}
                              />
                            )}

                            <label className="filter-checkbox-row">
                              <input
                                type="checkbox"
                                checked={filterDraft.cond.notNull}
                                onChange={(e) => setDraftField(selectedFile, 'notNull', e.target.checked)}
                              />
                              Drop rows where this column is empty
                            </label>

                            {draftIsNpi && (
                              <label className="filter-checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={filterDraft.cond.luhn}
                                  onChange={(e) => setDraftField(selectedFile, 'luhn', e.target.checked)}
                                />
                                Apply Luhn algorithm validation (checks 10-digit US NPI numbers)
                              </label>
                            )}
                          </div>
                        )}

                        <div className="chain-draft-actions">
                          <button
                            type="button"
                            className="mapping-btn primary"
                            disabled={!draftIsUsable}
                            onClick={() => commitDraft(selectedFile)}
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            className="mapping-btn"
                            onClick={() => cancelDraft(selectedFile)}
                          >
                            Cancel
                          </button>
                          {draftColumn && !draftIsUsable && (
                            <span className="chain-draft-hint">
                              Set a value above before adding this filter.
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {!filterDraft && (
                      <button
                        type="button"
                        className="chain-add-btn"
                        onClick={() => startDraft(selectedFile)}
                      >
                        {filterChain.length ? 'Add another filter' : 'Add filter'}
                      </button>
                    )}

                    {!filterChain.length && !filterDraft && (
                      <p className="tab-placeholder-note">
                        No filters yet. Every row is kept.
                      </p>
                    )}

                    <div className="filter-actions">
                      {previewResult?.fileId === selectedFile.id && previewResult.applied.filters_applied > 0 && (
                        <p className="preview-filter-result" role="status">
                          {previewResult.applied.rows_out} of {previewResult.applied.rows_in} rows match
                          {previewResult.applied.rows_removed > 0 && ` (${previewResult.applied.rows_removed} removed)`}.
                        </p>
                      )}
                      <button
                        className="mapping-btn primary"
                        disabled={isPreviewing || isApplying || isFiltering}
                        onClick={() => applyFilter(selectedFile)}
                      >
                        {isFiltering ? 'Applying filter…' : 'Apply Filter'}
                      </button>
                    </div>
                    <p className="tab-placeholder-note">
                      Applying the filter previews the matching rows without saving changes.
                    </p>
                  </>
                )}

                {activeTab === 'review' && (
                  <>
                    <p className="mapping-section-label">Variable Health, Sparsity &amp; Distributions</p>
                    <div className="summary-stats-table-wrapper">
                      <table className="summary-stats-table">
                        <thead>
                          <tr>
                            <th>Variable</th><th>Role</th><th>Distinct (N)</th><th>Control Totals (Sum)</th>
                            <th>Active Sparsity Health</th><th>Mean</th><th>Median</th><th>Std Dev</th>
                            <th>Min</th><th>Max</th><th>75th %ile</th><th>95th %ile</th><th>% Missing</th>
                          </tr>
                        </thead>
                        <tbody>
                          {buildSummaryRows(selectedFile, statsFor).map((r) => (
                            <tr key={r.column}>
                              <td><strong>{r.column}</strong></td>
                              <td><span className={`role-badge ${r.role.toLowerCase()}`}>{r.role}</span></td>
                              <td>{r.distinct !== null ? r.distinct.toLocaleString() : 'NA'}</td>
                              <td>{r.controlTotal !== null ? r.controlTotal.toLocaleString() : 'NA'}</td>
                              <td>
                                {r.activePct !== null ? (
                                  <span className={`health-badge ${r.activePct >= 40 ? 'good' : r.activePct >= 15 ? 'warn' : 'bad'}`}>
                                    {r.activePct.toFixed(2)}% active
                                  </span>
                                ) : 'NA'}
                              </td>
                              <td>{num(r.mean)}</td>
                              <td>{num(r.median)}</td>
                              <td>{num(r.stdDev)}</td>
                              <td>{num(r.min)}</td>
                              <td>{num(r.max)}</td>
                              <td>{num(r.p75)}</td>
                              <td>{num(r.p95)}</td>
                              <td>
                                {r.nullPct !== null ? (
                                  <span className={`health-badge ${r.nullPct <= 5 ? 'good' : r.nullPct <= 20 ? 'warn' : 'bad'}`}>
                                    {r.nullPct.toFixed(2)}%
                                  </span>
                                ) : 'NA'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <TimeTrendsSection
                      file={selectedFile}
                      statsFor={statsFor}
                      aggregation={trendAggregation}
                      setAggregation={setTrendAggregation}
                      selectedMetrics={trendMetrics}
                      setSelectedMetrics={setTrendMetrics}
                      xAxisKey={trendXAxis}
                      setXAxisKey={setTrendXAxis}
                      startDate={trendStartDate}
                      setStartDate={setTrendStartDate}
                      endDate={trendEndDate}
                      setEndDate={setTrendEndDate}
                    />
                  </>
                )}

                <hr className="mapping-divider" />

                <div className="mapping-preview-section">
                  <p className="mapping-section-label">Preview</p>

                  {activeTab === 'mapping' && statsFor && (
                    <ControlTotalsRibbon stats={statsFor} />
                  )}

                  {isPreviewing && (
                    <p className="mapping-config-subtitle" role="status">
                      <span className="loading-spinner" aria-hidden="true" /> Previewing changes…
                    </p>
                  )}

                  {selectedFile.isParsing && (
                    <p className="mapping-config-subtitle">Parsing file...</p>
                  )}

                  {selectedFile.parseError && (
                    <p className="mapping-config-subtitle">
                      Couldn't read this file: {selectedFile.parseError}
                    </p>
                  )}

                  {!selectedFile.isParsing &&
                    !selectedFile.parseError &&
                    previewColumns.length > 0 && (
                      <div className="preview-table-wrapper">
                        <div className="preview-table-scroll">
                            <table className="preview-table">
                            <thead>
                                <tr>
                                {previewColumns.map((col) => (
                                    <th key={col}>{col}</th>
                                ))}
                                </tr>
                            </thead>
                            <tbody>
                                {selectedFile.previewRows.map((row, i) => (
                                <tr key={i}>
                                    {previewColumns.map((col) => (
                                    <td key={col}>{row[col]}</td>
                                    ))}
                                </tr>
                                ))}
                            </tbody>
                            </table>
                        </div>
                        <p className="preview-row-count">
                          {(selectedFile.previewRowCount ?? selectedFile.totalRows).toLocaleString()} rows
                        </p>
                      </div>
                    )}
                </div>
              </>
            ) : (
              <p className="mapping-config-subtitle">
                Select a file on the left to configure its mapping.
              </p>
            )}
          </div>
        </div>
      )}
      <PageFooterNav currentStepId="data-ingestion" />
    </div>
  );
}

export default DataIngestion;
