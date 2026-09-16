import { useEffect, useRef, useState, useMemo } from 'react';
import Papa from 'papaparse';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, LineChart, Line } from 'recharts';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import { AXIS_TICK, CHART_COLORS, GRID, LINE_TYPE, X_LABEL, Y_LABEL } from '../../components/charts/chartTheme.js';
import cloud from '../../assets/sidebar_icon/cloud.png';
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
  numericColumns,
  renamedName,
  toIsoDate,
} from '../../services/manifest.js';
import { nullPctColor } from '../../services/nullscale.js';
import './DataIngestion.css';

// ─── Category model ──────────────────────────────────────────────────────
// Each category carries its expected grain, a description shown once
// selected, and whether it's required before the workflow can proceed.
export const FILE_CATEGORIES = [
  {
    id: 'sales',
    label: 'Sales File',
    grain: 'HCP × Period',
    desc: 'HCP × Month Week grain; used as allocation base',
    required: true,
  },
  {
    id: 'hcp_promo',
    label: 'HCP-level Marketing Promo File',
    grain: 'HCP × Period',
    desc: 'Calls, Samples, Details, Speaker programs',
    required: false,
  },
  {
    id: 'dma_promo',
    label: 'DMA-level Marketing Activity File',
    grain: 'DMA × Period',
    desc: 'TV, Radio, Print, Digital spend impressions',
    required: false,
  },
  {
    id: 'dma_hcp_map',
    label: 'DMA HCP Mapping File',
    grain: 'HCP ↔ DMA Bridge',
    desc: 'Crosswalk bridge between HCP IDs ZIPs and DMA IDs',
    required: false,
  },
  {
    id: 'dma_pop',
    label: 'DMA Population File',
    grain: 'DMA Grain',
    desc: 'DMA target population or universe sizing',
    required: false,
  },
  {
  id: 'other',
  label: 'Other File',
  grain: 'Varies',
  desc: 'Supplementary or reference data that doesn\'t fit the standard categories above.',
  required: false,
},
];

const DATA_TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Float' },
  { value: 'date', label: 'Date' },
];

// `value` is the strftime pattern the API needs; `label` is what the user sees.
const DATE_FORMATS = [
  { value: '%d/%m/%Y', label: 'DD/MM/YYYY (24/05/2026)' },
  { value: '%m/%d/%Y', label: 'MM/DD/YYYY (05/24/2026)' },
  { value: '%Y-%m-%d', label: 'YYYY-MM-DD (2026-05-24)' },
];

const NUM_OPS = ['sum', 'average', 'min', 'max', 'product'];
const GRAN_OPTIONS = {
  Daily: ['Weekly', 'Monthly'],
  Weekly: ['Monthly'],
  Monthly: ['Yearly'],
};

const TAB_ORDER = ['mapping', 'standardize', 'filter', 'granularity', 'review'];

/**
 * Has this dataset ever been applied?
 *
 * A freshly uploaded file carries an empty spec. Anything in `live_updates`,
 * `filters` or `granularity` means someone configured it and pressed Apply.
 */
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

// Guess a category from the filename the user can always override it
// via the dropdown, this just saves them a click for the common cases.
function suggestCategory(filename) {
  const name = filename.toLowerCase();
  if (name.includes('sale') || name.includes('trx') || name.includes('nrx')) return 'sales';
  if (name.includes('call') || name.includes('sample') || name.includes('hcp') || name.includes('rep')) return 'hcp_promo';
  if (name.includes('tv') || (name.includes('dma') && name.includes('spend'))) return 'dma_promo';
  if (name.includes('map') || name.includes('bridge') || name.includes('crosswalk')) return 'dma_hcp_map';
  if (name.includes('pop') || name.includes('universe')) return 'dma_pop';
  return null;
}

// ─── Control totals ribbon ────────────────────────────────────────────────
// Collapsed it answers "is this the file I think it is?" - row count and
// duplicates. Expanded it answers "can I trust these columns?" - null share
// per column, which is the thing that actually sinks a model downstream.

// Rows past this many scroll rather than pushing the preview table off screen.
const NULL_ROWS_BEFORE_SCROLL = 5;
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
          {/* Full per-column detail now lives on the Data Review tab - this
              bar just confirms row count/duplicates at a glance. */}
          {error ? 'Unavailable' : isLoading ? 'Loading…' : 'See Data Review tab for full column detail'}
        </span>
      </div>

      {error && <p className="control-totals-error">{error}</p>}
    </div>
  );
}

// ─── Filter: one column at a time, control chosen by that column's type ───
// The type comes from /stats, which reads it off the committed manifest. A
// column the user has not typed yet is a string, and gets the value picker -
// which is the honest default, since an unconfirmed profile guess is not a
// fact about the data.

// ─── Summary stats helpers ──────────────────────────────────────────────────
// Builds per-column summary rows from real fields confirmed on this project:
//   /profile → column, non_null, null_count, unique_count, suggested_dtype, id_like
//   /stats   → column, null_pct, control_total, (min/max if present)
// mean/median/std_dev/p75/p95 do not exist anywhere yet - shown as "-" until
// the backend adds them.
/**
 * One summary cell. Numbers get thousands separators; date bounds arrive as
 * ISO strings and pass through as they are; a column with no such statistic
 * reads "NA" rather than an empty cell that looks like a loading state.
 */
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
    // `numeric` is what /stats determined by reading the values, which is the
    // better signal than the upload-time guess: a column nobody has typed yet
    // still has a sum and a mean, and would otherwise sit under "Dimension"
    // with a control total beside it.
    const isMetric = !p.id_like && !isDate
      && (dtype === 'integer' || dtype === 'float' || statEntry.numeric === true);
    const role = p.id_like ? 'Dimension' : isDate ? 'Date' : isMetric ? 'Metric' : 'Dimension';

    return {
      column: p.column,
      role,
      distinct: statEntry.distinct_count ?? p.unique_count ?? null,
      controlTotal: statEntry.control_total ?? null,
      // Share of rows that are NON-ZERO, not non-null - the same definition the
      // Data Review sparsity panel uses. A tactic present but zero for fifty
      // weeks is sparse, and non-null would report it as perfectly healthy.
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

// ─── Time Trends (Data Review tab) ──────────────────────────────────────────
// Rolled up from the file's COMPLETE content, fetched once per file through
// GET /v2/workflows/{id}/files/{name}/csv - the same endpoint the Data Review
// page uses for an ARD. It works for an upload too, and returns the resolved
// frame, so renames, drops and filters are already applied to what arrives.
//
// This used to chart `file.previewRows`, the first hundred rows, and say so.
// A hundred rows of a weekly file is under two years for one geography: the
// shape was whatever the top of the CSV happened to hold.
//
// Because the frame is resolved, its column names are the RENAMED ones. The
// pills still show the original names, as the rest of this screen does, so
// every row lookup goes through `renamedName`.
// The rollup itself lives in services/trendRollup.js so it can be checked
// directly - see trendrollup.check.mjs.

function TimeTrendsSection({ file, statsFor, aggregation, setAggregation, selectedMetrics, setSelectedMetrics, xAxisKey, setXAxisKey, startDate, setStartDate, endDate, setEndDate }) {
  const previewRows = file.previewRows || [];
  const [fullRows, setFullRows] = useState(null); // null until the fetch lands
  const [isLoadingFull, setIsLoadingFull] = useState(false);
  const [fullError, setFullError] = useState(null);

  // Column names as they exist in the fetched frame.
  const derived = (col) => renamedName(file, col);

  // Anything that changes the resolved frame changes this, so the rollup is
  // refetched: a different file, a filter that drops rows, a rename or a drop
  // that changes the columns.
  const frameSignature = `${file.filename}|${file.totalRows || 0}|`
    + `${(file.previewColumns || []).join(',')}`;

  useEffect(() => {
    if (!file.workflowId || !file.filename) return undefined;
    let cancelled = false;
    // Inside the async body, not the effect's: setting state straight out of
    // an effect is a cascading render, and the linter says so.
    const load = async () => {
      setIsLoadingFull(true);
      setFullError(null);
      return getCsv(file.workflowId, file.filename);
    };
    load()
      .then((text) => {
        if (cancelled) return;
        // `dynamicTyping` is off on purpose: it turns an ID like 0123 into 123
        // and a date into a Date object, and every consumer below wants the
        // text as written.
        const parsed = Papa.parse(String(text || '').trim(), {
          header: true, skipEmptyLines: true,
        });
        setFullRows(parsed.data || []);
      })
      .catch((err) => {
        if (cancelled) return;
        // The preview rows are still there, so the chart falls back to them
        // rather than disappearing - but it says which it is drawing.
        setFullRows(null);
        setFullError(problemMessage(err, 'Could not load the full file.'));
      })
      .finally(() => { if (!cancelled) setIsLoadingFull(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSignature, file.workflowId]);

  const usingFullFile = Array.isArray(fullRows);
  const sourceRows = usingFullFile ? fullRows : previewRows;

  // X axis is date columns only. Plotting a total against a geography or a
  // product code produced a line joining categories in alphabetical order,
  // which looks like a trend and is not one.
  //
  // "Date" means the column is typed as one, or /stats read it as one. Name
  // matching is a fallback for a file nobody has typed yet, where it is the
  // only signal available - it is not consulted when a real date column
  // exists, so a `week_number` integer cannot displace one.
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

  // A stored choice that is no longer a date column - the user retyped it, or
  // it came from a saved state written before this was restricted - must not
  // strand the chart on a column that is not offered any more.
  const effectiveXAxis = (xAxisKey && dateColumns.includes(xAxisKey))
    ? xAxisKey
    : (dateColumns[0] || '');
  const xAxisIsDateLike = Boolean(effectiveXAxis);

  // Bounds across every row, so the pickers span the file rather than the
  // first hundred rows of it. Normalised, because a DD/MM/YYYY column sorted
  // as text puts the 1st of every month first.
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

  // Same "is this a Metric?" logic as buildSummaryRows above, so a column
  // shown as "Metric" in that table always appears here too. Using only
  // typeCastMap (the initial suggested_dtype guess) missed columns the
  // /stats endpoint has since confirmed are numeric.
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

  // Default to the first two metrics once they're known, without fighting
  // the user's own pill selections on every re-render.
  useEffect(() => {
    if (selectedMetrics.length === 0 && metricColumns.length > 0) {
      setSelectedMetrics(metricColumns.slice(0, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricColumns]);

  // If the user picks a column as X Axis that was already a selected Y
  // metric, drop it from the Y selection - the same column can't be both.
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
      // Compared as ISO, so the bounds mean the same thing whatever format the
      // column is stored in.
      const v = toIsoDate(String(r[xCol] ?? ''));
      if (!v) return false;
      if (effectiveStart && v < effectiveStart) return false;
      if (effectiveEnd && v > effectiveEnd) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRows, effectiveXAxis, xAxisIsDateLike, effectiveStart, effectiveEnd]);

  // What this file's rows actually are. `target` wins when a rollup has been
  // configured on the Granularity tab: after rolling daily rows up to monthly,
  // the file is monthly, whatever detection said about the original.
  const fileGrain = file.granularityConfig?.target || file.granularityConfig?.detected || '';
  const aggOptions = aggregationsFor(fileGrain);

  // A stored aggregation that this granularity does not support - saved before
  // the rollup was configured, or before this was restricted - would otherwise
  // leave the chart on a period none of the buttons is showing as active.
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
  // Roughly a year of weeks. Past this the markers touch and become a band.
  const showVertices = chartData.length <= 60;

  if (!effectiveXAxis) {
    return (
      <p className="tab-placeholder-note">
        No date column in this file yet. Type one as a date on the Standardize tab
        and it will appear here as an X Axis option.
      </p>
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
            {/* Why there may be only one button to press. */}
            {fileGrain && <> This file is {String(fileGrain).toLowerCase()}.</>}
            {(startDate || endDate) && (
              <> {rowsInRange.length.toLocaleString()} fall within the selected range.</>
            )}
            {/* Said out loud: a bad date is a row missing from the totals, not
                a row plotted in the wrong place. */}
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
          // Only the periods this file's granularity can actually be rolled
          // up to. A monthly file offered Week-on-Week before, which drew one
          // point per month under a weekly label.
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

        {/* Was a stack of inline styles, which is why the inputs ended up a
            different height from the toggle beside them. */}
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
            {/* Date columns only. A trend against anything else is a line
                joining categories in whatever order they sort in. */}
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
              {/* A marker at each period, while there is room for them. The
                  line is straight between points - `type` is 'linear', never a
                  spline - but with the vertices hidden a dense series reads as
                  a smooth curve, because the only thing that shows a segment
                  is straight is seeing where it starts and ends. Past the
                  threshold the dots merge into a band and hide the line, so
                  they come off. */}
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

/**
 * What each column in this file IS, for the screens downstream.
 *
 * Every column starts on a guess from its name, so the table is answerable by
 * exception rather than one dropdown at a time. The roles ride along in the
 * manifest's `config_metadata`, which the engine stores without interpreting.
 */
function ColumnRoleTable({ file, onChange, onBulk }) {
  const columns = file.columns || [];
  const roles = rolesFor(columns, file.columnRoles);
  const dropped = new Set(columns.filter((c) => !(file.selectedCols || columns).includes(c)));

  // A count per role, so a file with no Dependent Variable is visible without
  // reading every row.
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
        {/* Resetting is one click rather than re-picking every row, for the
            case where a rename or a retype has moved things on. */}
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
              <th>Sample values</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col) => {
              const meta = roleMeta(roles[col]);
              return (
                <tr key={col} className={dropped.has(col) ? 'is-dropped' : ''}>
                  <td className="role-col-name">
                    {col}
                    {/* A dropped column keeps its row so the role is not lost
                        by an accidental untick, but it says it is going. */}
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

/** Debounced server-side search over one column's distinct values. */
function ValuePicker({ workflowId, filename, column, selected, onChange }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);



  useEffect(() => {
    if (!column) return undefined;
    let cancelled = false;
    // Debounced: typing "california" should not be nine round trips. The
    // searching flag is set inside the timer, not synchronously here.
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
          // Most often this is a rename that has not been applied yet: /values
          // reads the resolved dataset, so it only knows the committed name.
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

/**
 * Which control a column gets.
 *
 * Server first: /stats reports the type off the committed manifest, which is
 * what the filter will actually run against. Before anything is committed
 * there is no manifest to read, so fall back to what the user has chosen on
 * the Standardize tab - that is their stated intent even if unsaved.
 */
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
  // Per-file configuration lives in each dataset's manifest on the server and
  // is read back by the resume effect below - it is NOT duplicated into the
  // workflow's state_data, which would be a second copy free to disagree with
  // the one that actually derives the frame. What is kept there is the screen
  // position: which file is open, which tab, and a category picked but not yet
  // applied.
  const pendingScreen = useRef(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState('mapping'); // mapping | standardize | filter | granularity
  const [visitedTabs, setVisitedTabs] = useState(new Set(['mapping']));

  // Remember where the user got to, so Resume reopens this screen instead
  // of always returning to Data Ingestion.
  useEffect(() => { recordStage('ingestion'); }, []);

  // Files are keyed by filename, not by the in-memory id: ids are regenerated
  // on every load, so one stored from a previous session would match nothing.
  const stateRestored = useScreenState('ingestion', {
    ready: uploadedFiles.length > 0,
    deps: [activeTab, selectedFileId, uploadedFiles, visitedTabs],
    snapshot: () => ({
      activeTab,
      openFile: uploadedFiles.find((f) => f.id === selectedFileId)?.filename || null,
      visitedTabs: Array.from(visitedTabs),
      // A category chosen but not yet applied. The committed spec wins over
      // this on restore, so it can only ever fill a gap, never contradict.
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
  const [isDetectingGranularity, setIsDetectingGranularity] = useState(false);
  const [isModifyingGranularity, setIsModifyingGranularity] = useState(false);
  const [isRestoringFiles, setIsRestoringFiles] = useState(() => Boolean(storedWorkflowId()));
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState(null);
  const [applyMessage, setApplyMessage] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  // Only RESOLVED control totals: { filename, data, error }. "Loading" is
  // derived during render from whether this holds the selected file yet, which
  // keeps the effect free of synchronous setState. Keyed by filename so a slow
  // response for a file the user has switched away from is never shown against
  // the wrong file.
  const [stats, setStats] = useState(null);
  const [statsVersion, setStatsVersion] = useState(0);
  const fileInputRef = useRef(null);

  // ── Data Review tab: Time Trends chart state ──────────────────────────
  // Built from `selectedFile.previewRows` only - there is no endpoint yet
  // that returns a raw uploaded file's FULL content, so this is a
  // preview-sample rollup, not a full-dataset one (see note rendered below).
  const [trendAggregation, setTrendAggregation] = useState('wow'); // 'wow' | 'mom'
  const [trendMetrics, setTrendMetrics] = useState([]);
  const [trendXAxis, setTrendXAxis] = useState('');
  const [trendStartDate, setTrendStartDate] = useState('');
  const [trendEndDate, setTrendEndDate] = useState('');

  // Fix: without this, switching files kept whatever metric names were
  // selected for the PREVIOUS file - those columns don't exist on the new
  // file, so the chart silently plotted flat 0-lines under the old names
  // instead of showing the new file's actual columns.
  useEffect(() => {
    setTrendMetrics([]);
    setTrendXAxis(''); // '' means "use the auto-detected date column"
    setTrendStartDate('');
    setTrendEndDate('');
  }, [selectedFileId]);

  const unmappedCount = useMemo(
    () => uploadedFiles.filter((f) => !f.category).length,
    [uploadedFiles]
  );

  // At least one file must be tagged with every `required: true` category
  // (currently just "Sales File") before Proceed is allowed.
  const hasRequiredCategories = useMemo(() => {
    const requiredIds = FILE_CATEGORIES.filter((c) => c.required).map((c) => c.id);
    return requiredIds.every((id) => uploadedFiles.some((f) => f.category === id));
  }, [uploadedFiles]);

  const missingRequiredLabels = useMemo(() => {
    const requiredCats = FILE_CATEGORIES.filter((c) => c.required);
    return requiredCats
      .filter((cat) => !uploadedFiles.some((f) => f.category === cat.id))
      .map((cat) => cat.label);
  }, [uploadedFiles]);

  const canProceed = unmappedCount === 0 && hasRequiredCategories && uploadedFiles.length > 0;

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

  // Resume the server-side datasets for the selected workflow. The browser
  // holds only metadata; bytes remain in object storage and are never
  // re-uploaded just to resume this screen.
  useEffect(() => {
    // Waits for the restore: the stored open file and any uncommitted
    // category must be known before this builds the list.
    if (!stateRestored) return undefined;
    const workflowId = storedWorkflowId();
    if (!workflowId) return undefined;
    let cancelled = false;

    const hydrate = async () => {
      setIsRestoringFiles(true);
      try {
        // Uploads only. ARDs built on the stitching screen are datasets in the
        // same workflow, so they were appearing here as files to categorise
        // and re-map - and every one of them cost a profile and a preview
        // request on resume.
        const response = await listFiles(workflowId, { kind: 'upload' });
        const files = await Promise.all((response.items || []).map(async (dataset) => {
          // Listing metadata is enough to render a resumed file. Profile and
          // preview failures must not hide every file in the workflow.
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
            id: `file-${++fileIdCounter}`, filename: dataset.filename, name: dataset.filename, workflowId,
            category: spec.config_metadata?.category || suggestCategory(dataset.filename),
            // Roles are stored under the renamed column name, which is what the
            // rest of the app sees; this screen works in original names, so
            // they are mapped back on the way in.
            columnRoles: restoreColumnRoles(spec.config_metadata?.column_roles, renameMap),
            columns: rawColumns,
            previewRows: currentDataset.preview || [],
            // `dataset.columns` is the DERIVED column list. The preview rows are
            // derived too, so using rawColumns here rendered a table of empty
            // cells for any file with a rename or a drop.
            previewColumns: dataset.columns || rawColumns,
            previewRowCount: dataset.row_count,
            totalRows: dataset.row_count || 0,
            isParsing: false, parseError: null, selectedCols: rawColumns.filter((column) => !dropped.has(column)),
            renameMap,
            profile,
            typeCastMap,
            // Fall back to the detected dates when nothing has been committed
            // yet, so resuming before the first Apply still offers the format
            // controls rather than an empty box.
            dateConfigs: (updates.date_formats || []).length
              ? updates.date_formats.map((item) => ({ col: item.column, format: item.to }))
              : profile.filter((p) => p.suggested_date_from)
                  .map((p) => ({ col: p.column, format: '%Y-%m-%d' })),
            dateSourceFormats: (updates.date_formats || []).length
              ? Object.fromEntries(updates.date_formats.map((item) => [item.column, item.from]))
              : Object.fromEntries(profile.filter((p) => p.suggested_date_from)
                  .map((p) => [p.column, p.suggested_date_from])),
            // Read back from the committed spec, not reset to empty. These two
            // were the only parts of the manifest that did not survive a
            // refresh: the tabs came up blank, and the next Apply then sent an
            // empty `filters`/`granularity` and wiped what was stored.
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
          // A category the user picked but never applied. The spec already
          // read above takes precedence, so this only fills a blank.
          const withCategories = files.map((f) => (
            f.category ? f : { ...f, category: screen.pendingCategories?.[f.filename] || null }
          ));
          setUploadedFiles(withCategories);
          const reopened = withCategories.find((f) => f.filename === screen.openFile);
          setSelectedFileId((reopened || withCategories[0])?.id || null);
          // The four tabs are a first-run walkthrough: Apply only appears once
          // they have all been seen. That walk already happened in the session
          // that configured these files, and `visitedTabs` does not survive a
          // refresh - so on resume the Apply button simply disappeared from a
          // file that was already fully configured.
          if ((response.items || []).some(hasCommittedSpec)) {
            setVisitedTabs(new Set(TAB_ORDER));
          }
        }
      } catch (err) {
        if (!cancelled) window.alert(err instanceof ApiError ? err.text : 'Could not load workflow files.');
      } finally {
        if (!cancelled) setIsRestoringFiles(false);
      }
    };
    hydrate();
    return () => { cancelled = true; };
    // Re-runs once the restore lands, which is what makes the stored open file
    // and any uncommitted category available to it.
  }, [stateRestored]);

  // ─── File upload + parsing ───────────────────────────────────────────
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
      // overwrite:false so the server refuses a collision too. The check above
      // only sees what this screen has loaded; this is what stops a name that
      // is in the workflow but not on screen from being overwritten.
      const result = await uploadFiles(workflowId, accepted, { overwrite: false });
      const newEntries = await Promise.all(result.files.map(async (dataset) => {
        const profileResponse = dataset.profile ? dataset : await getProfile(workflowId, dataset.filename);
        const profile = profileResponse.profile || [];
        const columns = dataset.columns || profileResponse.columns || [];
        return {
          id: `file-${++fileIdCounter}`, filename: dataset.filename, name: dataset.filename, workflowId,
          category: suggestCategory(dataset.filename), columns, previewRows: dataset.preview || [],
          columnRoles: rolesFor(columns),
          totalRows: dataset.row_count || 0, isParsing: false, parseError: null, selectedCols: columns,
          renameMap: {},
          profile,
          typeCastMap: Object.fromEntries(profile.map((p) => [p.column, clampDtype(p.suggested_dtype)])),
          // Every detected date column gets a Target Date Format row. Excluding
          // the ambiguous ones hid the control precisely where the user most
          // needs it - a file whose dates are all day <= 12 showed no date
          // options at all.
          dateConfigs: profile.filter((p) => p.suggested_date_from)
            .map((p) => ({ col: p.column, format: '%Y-%m-%d' })),
          dateSourceFormats: Object.fromEntries(profile.filter((p) => p.suggested_date_from)
            .map((p) => [p.column, p.suggested_date_from])),
          // The Filter tab edits one column at a time (`activeColumn`) but keeps a
          // rule per column, so switching the dropdown never discards a filter.
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

    // The dataset is gone, so nothing saved should still point at it: the
    // joins built on it, the files ticked for an ARD, a category never
    // applied. Only after the delete succeeded - a failed one leaves the file
    // in place, and its state with it.
    if (file?.filename) forgetFile(file.filename);
  };

  const handleCategoryChange = (fileId, category) => {
    setUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, category } : f))
    );
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

  // Assign Category tab: one column's modelling role.
  const setColumnRole = (file, column, role) =>
    updateFileConfig(file.id, {
      columnRoles: { ...rolesFor(file.columns, file.columnRoles), [column]: role },
    });

  // Standardize tab
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
    // The API needs the format the file actually uses, not just the target, and
    // it never guesses. Seed it from the server profile so marking a column as
    // Date by hand still produces a usable conversion.
    const dateSourceFormats = { ...(file.dateSourceFormats || {}) };
    if (type === 'date' && !dateConfigs.find((d) => d.col === col)) {
      dateConfigs = [...dateConfigs, { col, format: '%d/%m/%Y' }];
      const detected = (file.profile || []).find((p) => p.column === col);
      if (detected?.suggested_date_from) {
        dateSourceFormats[col] = detected.suggested_date_from;
      }
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

  // ── Filter chain ────────────────────────────────────────────────────────
  // The tab builds an ordered chain of cards with an operator in every gap.
  // A draft is the card being composed; it only joins the chain on Add, so a
  // half-typed filter never changes what Apply would send.
  const setFilterConfig = (file, updates) =>
    updateFileConfig(file.id, { filterConfig: { ...file.filterConfig, ...updates } });

  const startDraft = (file) =>
    setFilterConfig(file, { draft: emptyChainEntry('', 'string') });

  const cancelDraft = (file) => setFilterConfig(file, { draft: null });

  const setDraftColumn = (file, column) => {
    // The kind decides which controls render, so it is resolved once here
    // rather than re-derived at every keystroke.
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
    // Every gap needs an operator, and a new card creates one gap. AND is the
    // default because it narrows, which is the safer thing to do silently.
    if (chain.length > 1) operators.push('and');
    setFilterConfig(file, { chain, operators, draft: null });
  };

  const removeChainEntry = (file, index) => {
    const chain = (file.filterConfig.chain || []).filter((_, i) => i !== index);
    const operators = [...(file.filterConfig.operators || [])];
    // Drop the gap the removed card sat in: the one before it, or - when it was
    // the first card - the one after. Otherwise later operators shift onto the
    // wrong pairs.
    if (operators.length) operators.splice(index ? index - 1 : 0, 1);
    setFilterConfig(file, { chain, operators });
  };

  const setChainOperator = (file, gap, value) => {
    const operators = [...(file.filterConfig.operators || [])];
    operators[gap] = value;
    setFilterConfig(file, { operators });
  };

  // Granularity tab
  const setGranularityField = (file, key, value) =>
    updateFileConfig(file.id, {
      granularityConfig: { ...file.granularityConfig, [key]: value },
    });

  // PLACEHOLDER: no backend endpoint yet - just marks a granularity as
  // "detected" locally so the UI flow can be reviewed. Replace with a real
  // API call once available.
  const handleDetectGranularity = async (file) => {
    if (!file.granularityConfig.dateCol || isDetectingGranularity) return;
    setIsDetectingGranularity(true);
    try {
      const detail = await detectGranularity(file.workflowId, file.filename, {
        date_column: renamedName(file, file.granularityConfig.dateCol),
        live_updates: buildLiveUpdates(file),
        filters: buildFilters(file),
      });
      setGranularityField(file, 'detected', detail.granularity);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Granularity detection failed.');
    } finally {
      setIsDetectingGranularity(false);
    }
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
      // The resolved frame just changed, so the control totals describe the
      // previous version until they are re-read.
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

  const modifyGranularity = async (file) => {
    const problems = localProblems(file);
    if (problems.length) {
      setApplyMessage(problems.join(' '));
      return;
    }
    setIsModifyingGranularity(true);
    setApplyMessage('Modifying granularity… Nothing is being saved.');
    try {
      const preview = await previewSpec(file.workflowId, file.filename, buildSpec(file));
      updateFileConfig(file.id, {
        previewRows: preview.preview || [],
        previewColumns: preview.columns || file.columns,
        previewRowCount: preview.row_count,
      });
      setPreviewResult({ fileId: file.id, applied: preview.applied || {} });
      const dropped = preview.applied?.unhandled_columns || [];
      setApplyMessage(
        dropped.length
          ? `Granularity preview ready. These columns had no aggregation and were dropped: ${dropped.join(', ')}. Nothing has been saved.`
          : 'Granularity preview ready. These changes have not been saved.'
      );
    } catch (err) {
      setApplyMessage(err instanceof ApiError ? err.text : 'Granularity could not be modified.');
    } finally {
      setIsModifyingGranularity(false);
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

  // Control totals for whichever file is selected. Read from the server rather
  // than computed from `previewRows`, because the preview is only the first
  // 100 rows - a null percentage derived from it would look authoritative and
  // be wrong.
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
    // eslint-disable-next-line
  }, [statsKey, statsVersion]);

  useEffect(() => {
  if (selectedFile?.profile?.[0]) {
    console.log('PROFILE SHAPE:', JSON.stringify(selectedFile.profile[0], null, 2));
  }
}, [selectedFile]);
  // Anything not yet resolved for THIS file reads as loading, including the
  // window between selecting a file and its request coming back.
  const statsFor = selectedFile
    ? (stats && stats.filename === selectedFile.filename
        ? { ...stats, isLoading: false }
        : { filename: selectedFile.filename, data: null, error: null, isLoading: true })
    : null;

  // Post-rename column -> stats entry, because /stats describes the resolved
  // frame while the tab still works in original column names.
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
  // Only numeric, kept columns can be aggregated, and never the two grouping
  // keys. The rollup drops anything else, so offering them would be misleading.
  const aggregatableColumns = selectedFile ? numericColumns(selectedFile) : [];

  return (
    <div className="data-ingestion-page">
      {/* ---- Shared header ---- */}
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
        /* ============ DEFAULT VIEW (no files yet) ============ */
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
        </div>
      ) : (
        /* ============ MAPPING VIEW (files uploaded) ============ */
        <div className="mapping-layout">
          {/* ---- Left: file list ---- */}
          <div className="file-list-panel">
            <button className="upload-files-btn" onClick={handleBrowseClick} disabled={isUploadingFiles}>
              {isUploadingFiles ? 'Uploading files…' : 'Upload files'}
            </button>
            {isUploadingFiles && <p className="file-operation-status" role="status"><span className="loading-spinner" aria-hidden="true" /> Uploading and preparing files…</p>}
            <p className="file-list-count">
              Uploaded {uploadedFiles.length} of {uploadedFiles.length}
            </p>

            <div className="file-list">
              {uploadedFiles.map((f, index) => {
                const categoryInfo = FILE_CATEGORIES.find((c) => c.id === f.category);
                return (
                  <div
                    key={f.id}
                    className={`file-list-item${
                      f.id === selectedFileId ? ' selected' : ''
                    }${!f.category ? ' unmapped' : ''}${deletingFileId === f.id ? ' deleting' : ''}`}
                    onClick={() => deletingFileId !== f.id && setSelectedFileId(f.id)}
                  >
                    <div className="file-item-text">
                      <p className="file-item-name" title={f.name}>{f.name}</p>
                      {/* <p className="file-item-filename">{f.name}</p> */}
                      <p className={`file-item-status${!f.category ? ' unmapped-label' : ''}`}>
                        {categoryInfo ? categoryInfo.label : 'Unmapped'}
                        {categoryInfo?.required && <span className="file-item-required-badge">Required</span>}
                      </p>
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

            {/* The status belongs beside the list it describes: it counts the
                files in this panel, and each one that needs a category is
                already flagged in its own row above. One line, either the work
                left or the all-clear - never both. */}
            {unmappedCount > 0 && (
              <p className="file-list-status" role="status">
                {unmappedCount} file{unmappedCount > 1 ? 's' : ''} still
                need{unmappedCount === 1 ? 's' : ''} a category
              </p>
            )}
            {canProceed && (
              <p className="file-list-status is-ready" role="status">
                All files mapped, ready to proceed
              </p>
            )}
          </div>

          {/* ---- Right: mapping configuration ---- */}
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
                      className={`tab-btn${activeTab === 'granularity' ? ' active' : ''}`}
                      onClick={() => {
                        setActiveTab('granularity');
                        setVisitedTabs((prev) => new Set(prev).add('granularity'));
                      }}
                    >
                      Granularity
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

                    {/* Position in the walkthrough, not "have you pressed Next
                        this session" - which did not survive a refresh. */}
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

                    {/* Shown alongside Next, not instead of it: once every tab
                        has been seen the configuration can be applied from any
                        of them, and the user can still move between tabs. */}
                    {hasVisitedAllTabs && (
                      <button className="mapping-btn primary" disabled={!selectedFile || isApplying || isPreviewing || isFiltering} onClick={() => applyFile(selectedFile)}>
                        {isApplying ? 'Applying configurations…' : 'Apply configuration'}
                      </button>
                    )}
                  </div>
                </div>

                {activeTab === 'mapping' && (
                  <>
                <hr className="mapping-divider" />

                <p className="mapping-section-label">Assign category</p>
                <select
                  className="category-select"
                  value={selectedFile.category || ''}
                  onChange={(e) =>
                    handleCategoryChange(selectedFile.id, e.target.value)
                  }
                >
                  <option value="">Select a category...</option>
                  {FILE_CATEGORIES.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.label}
                      {cat.required ? ' (required)' : ''}
                    </option>
                  ))}
                </select>

                {selectedFile.category && (
                  <div className="category-info-box">
                    <p className="category-info-title">
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.label}
                    </p>
                    <p className="category-info-desc">
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.desc}
                    </p>
                    <p className="category-info-grain">
                      Expected grain:{' '}
                      {FILE_CATEGORIES.find((c) => c.id === selectedFile.category)?.grain}
                    </p>
                  </div>
                )}

                {/* The "still needs a category" count now lives in the file
                    list panel, next to the rows it is counting. */}
                {unmappedCount === 0 && !hasRequiredCategories && (
                  <div className="mapping-warning-banner">
                    Please assign at least one file to:{' '}
                    {missingRequiredLabels.join(', ')}
                  </div>
                )}

                {/* The all-clear now sits with the file list, next to the rows
                    it is reporting on, alongside the "still needs a category"
                    count it replaces. */}

                {/* Column-level roles. The file category says what the FILE is;
                    this says what each column in it is, which is what every
                    screen downstream needs and was previously guessing for
                    itself - three heuristics with three chances to disagree
                    about the same column, and no way to correct any of them
                    except per screen, every time. */}
                <ColumnRoleTable
                  file={selectedFile}
                  onChange={(column, role) => setColumnRole(selectedFile, column, role)}
                  onBulk={(next) => updateFileConfig(selectedFile.id, { columnRoles: next })}
                />
                  </>
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
                          // Read-only: the source format is detected from the
                          // file itself, so it is shown rather than chosen.
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
                    {/* The chain, in the order it is evaluated. */}
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

                    {/* The card being composed. It joins the chain on Add, so a
                        half-typed filter never changes what Apply sends. */}
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

                {activeTab === 'granularity' && (
                  <>
                    <div className="filter-grid">
                      <div>
                        <p className="filter-field-label">Date</p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.dateCol}
                          onChange={(e) => setGranularityField(selectedFile, 'dateCol', e.target.value)}
                        >
                          <option value="">Select date column</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <p className="filter-field-label">Grouping (Geo/NPI/DMA)</p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.geoCol}
                          onChange={(e) => setGranularityField(selectedFile, 'geoCol', e.target.value)}
                        >
                          <option value="">Select geo/ID column</option>
                          {selectedFile.columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <button
                      className="granularity-detect-btn"
                      onClick={() => handleDetectGranularity(selectedFile)}
                      disabled={!selectedFile.granularityConfig.dateCol || isDetectingGranularity}
                    >
                      {isDetectingGranularity ? 'Detecting granularity…' : 'Detect Granularity'}
                    </button>
                    {selectedFile.granularityConfig.detected && (
                      <span className="granularity-detected-badge">
                        Detected: {selectedFile.granularityConfig.detected}
                      </span>
                    )}

                    {selectedFile.granularityConfig.detected && (
                      <>
                        {aggregatableColumns.map((col) => (
                          <div key={col} className="agg-op-row">
                            <span>{col}</span>
                            <select
                              className="filter-select"
                              value={selectedFile.granularityConfig.numOps[col] || 'sum'}
                              onChange={(e) =>
                                setGranularityField(selectedFile, 'numOps', {
                                  ...selectedFile.granularityConfig.numOps,
                                  [col]: e.target.value,
                                })
                              }
                            >
                              {NUM_OPS.map((op) => (
                                <option key={op} value={op}>{op}</option>
                              ))}
                            </select>
                          </div>
                        ))}

                        <p className="filter-field-label" style={{ marginTop: '1rem' }}>
                          Target Granularity
                        </p>
                        <select
                          className="filter-select"
                          value={selectedFile.granularityConfig.target}
                          onChange={(e) => setGranularityField(selectedFile, 'target', e.target.value)}
                        >
                          <option value="">Select target granularity</option>
                          {(GRAN_OPTIONS[selectedFile.granularityConfig.detected] || []).map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                        </select>

                        <div className="filter-actions">
                          {previewResult?.fileId === selectedFile.id
                            && previewResult.applied.granularity_applied && (
                            <p className="preview-filter-result" role="status">
                              {previewResult.applied.rows_out} rows after rolling up to{' '}
                              {selectedFile.granularityConfig.target}
                              {previewResult.applied.unhandled_columns?.length > 0
                                && ` · not aggregated: ${previewResult.applied.unhandled_columns.join(', ')}`}.
                            </p>
                          )}
                          <button
                            className="mapping-btn primary"
                            disabled={
                              !selectedFile.granularityConfig.target
                              || isPreviewing || isApplying || isFiltering || isModifyingGranularity
                            }
                            onClick={() => modifyGranularity(selectedFile)}
                          >
                            {isModifyingGranularity ? 'Modifying granularity…' : 'Modify Granularity'}
                          </button>
                        </div>
                      </>
                    )}
                    <p className="tab-placeholder-note">
                      Only numeric columns can be aggregated. Modifying granularity previews the
                      rolled-up rows without saving changes.
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

                {/* Shared across every tab: previewing from Standardize, Filter or
                    Granularity should show its result in place, not send the user
                    back to Assign Category. */}

                <hr className="mapping-divider" />

                <div className="mapping-preview-section">
                  <p className="mapping-section-label">Preview</p>

                  {/* Control totals sit directly above the table they describe,
                      on Assign Category only - that is where the user is still
                      deciding whether the file is the right one. */}
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
    </div>
  );
}

export default DataIngestion;