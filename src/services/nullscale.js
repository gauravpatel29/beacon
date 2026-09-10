/**
 * The colour scale behind the control-totals ribbon.
 *
 * Its own module so the ingestion page exports only components (Vite's fast
 * refresh needs that), and so the scale can be tested without rendering.
 */

/**
 * 0% -> green, 100% -> red, continuous in between.
 *
 * A continuous scale rather than banded thresholds: banding invents a cliff
 * between 9% and 11% that does not exist in the data, and the eye reads a
 * gradient perfectly well without one.
 *
 * Returns both a solid colour for the filled portion of the bar and a faint
 * tint for its track, so a column's severity is legible from the empty part
 * of the row too.
 */
export function nullPctColor(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const hue = 140 - (140 * clamped) / 100; // 140 = green, 0 = red
  return {
    bar: `hsl(${hue}, 65%, 45%)`,
    tint: `hsla(${hue}, 65%, 45%, 0.12)`,
  };
}
