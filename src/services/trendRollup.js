// Rolling raw rows up into a time series.
//
// Lives here rather than inside DataIngestion.jsx so it can be run directly by
// a check: the bucketing is the part that can quietly produce a plausible but
// wrong line, and asserting on it through a rendered component would test the
// rendering instead.
//
// No React and no api import, for the same reason workflowStages.js has none.

import { toIsoDate } from './manifest.js';

/** A column whose NAME suggests a date. Only a fallback - see dateColumnsOf. */
export function isDateLikeName(col) {
  return /date|week|month|period/i.test(col);
}

/**
 * Monday of the week containing an ISO date. Returns ISO, or null.
 *
 * Weekly buckets have to start on a fixed weekday or consecutive weeks hold
 * different numbers of days, and the line steps up and down on the bucketing
 * rather than on the data.
 */
export function weekStartOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // getUTCDay is 0 for Sunday, which belongs to the week that began six days
  // earlier rather than starting one of its own.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/**
 * The aggregations on offer, in order, and what each one draws.
 *
 * `period` is what aggregateTrend buckets by; `xLabel` names the axis. Weeks
 * are labelled "Week starting" because weekStartOf returns the Monday - the
 * label used to say "ending", which named the wrong end of the bucket.
 */
export const AGGREGATIONS = {
  dod: { period: 'day', label: 'Day-on-Day (DoD)', xLabel: 'Date' },
  wow: { period: 'week', label: 'Week-on-Week (WoW)', xLabel: 'Week starting' },
  mom: { period: 'month', label: 'Month-on-Month (MoM)', xLabel: 'Month' },
  yoy: { period: 'year', label: 'Year-on-Year (YoY)', xLabel: 'Year' },
};

/**
 * Which aggregations make sense for a file at this granularity.
 *
 * A rollup can only ever go coarser. Offering Week-on-Week on monthly data
 * drew one point per month under a weekly label - each month's single row
 * landed in the week of whatever day it carried - which is a chart that reads
 * as weekly and is not.
 *
 * `grain` is the vocabulary the manifest uses: Daily, Weekly, Monthly, Yearly.
 * Anything unrecognised - including a file whose granularity has not been
 * detected yet - keeps both of the options that were there before, since
 * guessing wrong would take away a view the user can currently reach.
 */
export function aggregationsFor(grain) {
  switch (String(grain || '').toLowerCase()) {
    case 'daily': return ['dod', 'wow', 'mom'];
    case 'weekly': return ['wow', 'mom'];
    case 'monthly': return ['mom'];
    case 'yearly': return ['yoy'];
    default: return ['wow', 'mom'];
  }
}

/**
 * Sum each metric per period.
 *
 * `toIsoDate` first, rather than slicing the string: a column stored as
 * DD/MM/YYYY month-bucketed by `slice(0, 7)` gives "01/04" - the day and the
 * month - so April and the 4th of January landed in the same bucket. Over a
 * hundred preview rows that was easy to miss; over a whole file it is not.
 *
 * `keyFor` maps a column name as shown on screen to its name in the rows,
 * because the rows come from the resolved frame and carry renamed columns.
 *
 * Rows whose date will not parse are counted and returned rather than being
 * dropped silently or bucketed under their raw text.
 */
export function aggregateTrend(rows, xKey, metrics, period, xIsDate, keyFor = (c) => c) {
  const grouped = {};
  let unparseable = 0;

  for (const r of rows || []) {
    const raw = r?.[xKey];
    if (raw === null || raw === undefined || raw === '') continue;

    let key;
    if (xIsDate) {
      const iso = toIsoDate(String(raw));
      if (!iso) { unparseable += 1; continue; }
      if (period === 'year') key = iso.slice(0, 4);
      else if (period === 'month') key = iso.slice(0, 7);
      else if (period === 'day') key = iso;
      else key = weekStartOf(iso) || iso;
    } else {
      key = String(raw);
    }

    if (!grouped[key]) grouped[key] = {};
    for (const m of metrics) {
      // A blank or non-numeric cell contributes nothing rather than NaN, which
      // would take the whole bucket with it.
      grouped[key][m] = (grouped[key][m] || 0) + (Number(r[keyFor(m)]) || 0);
    }
  }

  // ISO dates sort correctly as strings, which is the whole reason for
  // normalising them above.
  const labels = Object.keys(grouped).sort();
  return { points: labels.map((l) => ({ date: l, ...grouped[l] })), unparseable };
}
