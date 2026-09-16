// Chart styling and number formatting, shared by every recharts chart.
//
// Separate from ChartTooltip.jsx deliberately: a module that exports both a
// component and plain constants breaks fast refresh, and the linter says so.
// Keeping the constants here also means a chart can use the styling without
// pulling in the tooltip.

export const CHART_COLORS = ['#1d4ed8', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0891b2'];
export const GRID = '#eef1f6';
export const AXIS_TICK = { fontSize: 10, fill: '#8a94a3' };

/**
 * How every line in the app is drawn: straight segments between the points.
 *
 * recharts' 'monotone' fits a spline through the points, which invents curve
 * between them - a smooth rise where the data steps, and a bulge past a local
 * maximum that no observation supports. These are diagnostic charts, read for
 * shape, so the line has to join what was measured and nothing else.
 */
export const LINE_TYPE = 'linear';

// Axis titles sit in the margin the chart reserves for them, so adding one
// never lands on top of the tick labels underneath.
export const X_LABEL = { position: 'insideBottom', offset: -12, fontSize: 10, fill: '#8a94a3' };
export const Y_LABEL = { angle: -90, position: 'insideLeft', fontSize: 10, fill: '#8a94a3' };

/**
 * Thousands get rounded; everything else keeps two decimals at most.
 *
 * One implementation on purpose: two screens formatting the same number
 * differently is the kind of thing nobody notices until the numbers are being
 * compared in a meeting.
 */
export const fmt = (v) => (Number.isFinite(v)
  ? (Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString()
      : Number(Number(v).toFixed(2)).toLocaleString())
  : '-');
