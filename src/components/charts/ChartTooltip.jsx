import { fmt } from './chartTheme.js';
import './ChartTooltip.css';

/**
 * The hover box shown by every recharts chart in the app.
 *
 * Extracted from Data Review so the Transformation inspector can use the same
 * one. Those charts were hand-drawn SVGs with no hover at all, and copying the
 * design across would have left two boxes to keep in step - which is how two
 * screens end up formatting the same number differently.
 *
 * recharts does the hit-testing; what is ours is turning its `payload` into
 * the rows shown, which is the part that can quietly present a
 * correct-looking wrong number.
 *
 * `title` and `rows` let a chart describe its own data - a histogram bar means
 * a count and a share, a curve point means an average - without this component
 * knowing anything about either screen.
 */
export function ChartTooltip({ active, payload, label, title, rows, indexed = false }) {
  if (!active || !payload || !payload.length) return null;

  const heading = title ? title(label, payload) : label;
  const lines = rows
    ? rows(label, payload)
    : payload.map((p) => ({
        label: p.name ?? p.dataKey,
        // An indexed view reads as a rebased index, not as a count.
        value: indexed ? `${Number(p.value).toFixed(1)} (Index)` : fmt(p.value),
        color: p.color || p.stroke || p.fill,
      }));

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-title">{heading}</p>
      {lines.map((r) => (
        <p key={r.label} className="chart-tooltip-row">
          {r.color && <span className="chart-tooltip-swatch" style={{ backgroundColor: r.color }} />}
          <span className="chart-tooltip-label">{r.label}</span>
          <span className="chart-tooltip-value">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export default ChartTooltip;
