/**
 * Weighted impactable share, used by the coefficient table on Model
 * Configuration and by Impact Share (%) on Model Output so the two screens
 * cannot disagree about the same number.
 *
 * The engine returns each variable's raw Impactable (%) against total sales.
 * Those do not add to 100 - the fit does not reconstruct the dependent
 * variable exactly - and they take no account of the prior weight a variable
 * was modelled under. The share shown is therefore:
 *
 *     weighted_i = max(0, pct_i / 100) * weight_i
 *     share_i    = weighted_i / sum(weighted) * 100
 *
 * Worked through on the reference figures: Carryover 55.30% at weight 0.6
 * gives 0.3318, Calls 32.40% at 0.3 gives 0.0972, and so on to a total of
 * 0.47198, so Carryover reads 0.3318 / 0.47198 = 70.3%.
 *
 * Two rules carried over from the unweighted version:
 *  - a negative share floors at zero, since a tier cannot contribute a
 *    negative fraction of volume;
 *  - the displayed one-decimal figures sum to exactly 100.0, by
 *    largest-remainder rounding in tenths, rather than to 99.9 or 100.1.
 */

/** Reads "12.40%", "12.4" or 12.4 alike; null for anything that is not a number. */
/**
 * Reads signed percentage numbers directly.
 */
export function parsePercent(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(String(raw).replace('%', ''));
  return Number.isFinite(num) ? num : null;
}

export function weightFor(weights, variable) {
  if (!weights) return 1;
  const name = String(variable ?? '');
  const bare = name.replace(/_transformed$/, '');
  const raw = weights[name] ?? weights[bare];
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : 1;
}

/**
 * Normalizes positive contributions into a 100.0% Commercial Share of Voice.
 */
export function weightedShareTenths(values, weights) {
  const weighted = values.map((v, i) => {
    if (v === null) return null;
    return (Math.max(0, v) / 100) * (weights[i] ?? 1);
  });

  const total = weighted.reduce((sum, v) => sum + (v || 0), 0);
  if (!(total > 0)) return weighted.map((v) => (v === null ? null : 0));

  const exact = weighted.map((v) => (v === null ? null : (v / total) * 1000));
  const floors = exact.map((v) => (v === null ? null : Math.floor(v)));
  const assigned = floors.reduce((sum, v) => sum + (v || 0), 0);

  const order = exact
    .map((v, i) => ({ i, frac: v === null ? -1 : v - Math.floor(v) }))
    .filter((e) => e.frac >= 0)
    .sort((a, b) => b.frac - a.frac);

  const tenths = [...floors];
  let left = 1000 - assigned;
  for (let n = 0; n < order.length && left > 0; n += 1, left -= 1) {
    tenths[order[n].i] += 1;
  }
  return tenths;
}

export function weightedShareColumn(rows, column, weightOf) {
  const list = Array.isArray(rows) ? rows : [];
  const values = list.map((r) => parsePercent(r[column]));
  const weights = list.map((r) => (weightOf ? weightOf(r) : 1));
  return weightedShareTenths(values, weights)
    .map((v) => (v === null ? null : `${(v / 10).toFixed(1)}%`));
}

/** The same shares as plain numbers, for callers that format them themselves. */
export function weightedSharePercents(rows, column, weightOf) {
  const list = Array.isArray(rows) ? rows : [];
  const values = list.map((r) => parsePercent(r[column]));
  const weights = list.map((r) => (weightOf ? weightOf(r) : 1));
  return weightedShareTenths(values, weights).map((v) => (v === null ? null : v / 10));
}
