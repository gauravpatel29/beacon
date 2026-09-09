// Translates this screen's per-file config into the backend manifest.
//
// The UI state shape is left exactly as it was; everything here is a pure
// mapping, so no component had to change to accommodate the API.
//
// Order matters on the server: column_drops -> date_formats -> dtype_changes
// -> column_renames, then filters, then granularity. Anything inside
// `live_updates` names columns as they appear in the UPLOADED file; filters
// and granularity name them as they are AFTER renames. This module handles
// that translation so the UI can keep showing original column names
// throughout.

/** The dropdown offers string | integer | float | date. Map to API dtypes. */
const DTYPE_MAP = {
  string: 'string',
  integer: 'integer',
  float: 'float',
  date: 'date',
};

/** Profile dtypes the UI has no option for fall back to its nearest choice. */
export function clampDtype(suggested) {
  if (suggested === 'boolean' || suggested === 'timestamp') return 'string';
  if (suggested === 'bigint') return 'integer';
  if (suggested === 'decimal') return 'float';
  return DTYPE_MAP[suggested] ? suggested : 'string';
}

/** Original column name -> name after renames. */
export function renamedName(file, col) {
  const to = (file.renameMap?.[col] || '').trim();
  return to && to !== col ? to : col;
}

/** Accepts DD/MM/YYYY or YYYY-MM-DD. Returns ISO, or undefined if unparseable. */
export function toIsoDate(text) {
  const s = (text || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Build `live_updates` from the Standardize tab.
 *
 * `file.dateSourceFormats` is a non-rendered map of column -> the format the
 * file actually uses, filled in from the server profile at upload. The visible
 * `dateConfigs[].format` stays the TARGET format, exactly as before.
 */
export function buildLiveUpdates(file) {
  const all = file.columns || [];
  const kept = new Set(file.selectedCols || all);

  const column_drops = all.filter((c) => !kept.has(c));

  const column_renames = all
    .filter((c) => kept.has(c))
    .filter((c) => {
      const to = (file.renameMap?.[c] || '').trim();
      return to && to !== c;
    })
    .map((c) => ({ from: c, to: file.renameMap[c].trim() }));

  const dateCols = new Set((file.dateConfigs || []).map((d) => d.col));

  // "string" is the resting state (files are read as text), so casting to it
  // is a no-op. `date` is never sent as a cast either: that would make the
  // server infer the format per value, which is what `date_formats` exists to
  // avoid.
  const dtype_changes = all
    .filter((c) => kept.has(c) && !dateCols.has(c))
    .map((c) => ({ column: c, to: clampDtype(file.typeCastMap?.[c] || 'string') }))
    .filter((d) => d.to !== 'string' && d.to !== 'date');

  const date_formats = (file.dateConfigs || [])
    .filter((d) => kept.has(d.col))
    .map((d) => ({
      column: d.col,
      from: file.dateSourceFormats?.[d.col],
      to: d.format,
    }))
    // A column with no detected source format is skipped rather than guessed.
    .filter((d) => d.from && d.to);

  return { column_drops, date_formats, dtype_changes, column_renames };
}

/** Build `filters` from the Filter tab. Columns are post-rename. */
export function buildFilters(file) {
  const cfg = file.filterConfig || {};
  const filters = [];

  if (cfg.useLuhn && cfg.npiCol) {
    filters.push({ type: 'npi_luhn', column: renamedName(file, cfg.npiCol) });
  }

  const start = toIsoDate(cfg.startDate);
  const end = toIsoDate(cfg.endDate);
  if (cfg.dateCol && (start || end)) {
    const f = { type: 'date_range', column: renamedName(file, cfg.dateCol) };
    if (start) f.start = start;
    if (end) f.end = end;
    filters.push(f);
  }

  return filters;
}

/** Build `granularity` from the Granularity tab, or null when incomplete. */
export function buildGranularity(file) {
  const g = file.granularityConfig || {};
  if (!g.detected || !g.target || !g.dateCol || !g.geoCol) return null;
  // The dropdown offers the current grain as a target (Weekly -> Weekly); the
  // API only accepts a coarser one, and a same-grain rollup is a no-op anyway.
  if (g.target === g.detected) return null;

  const dateCol = renamedName(file, g.dateCol);
  const geoCol = renamedName(file, g.geoCol);
  const kept = new Set(file.selectedCols || file.columns || []);

  // Only columns the user gave an operation to, excluding the two keys.
  const numeric = {};
  for (const [col, op] of Object.entries(g.numOps || {})) {
    if (col === g.dateCol || col === g.geoCol) continue;
    if (!kept.has(col)) continue;
    numeric[renamedName(file, col)] = op;
  }

  return {
    from: g.detected,
    to: g.target,
    date_column: dateCol,
    geo_column: geoCol,
    numeric,
    categorical: {},
  };
}

/** The complete manifest for one file. */
export function buildSpec(file) {
  const spec = {
    config_metadata: file.category ? { category: file.category } : {},
    live_updates: buildLiveUpdates(file),
    filters: buildFilters(file),
  };
  const granularity = buildGranularity(file);
  if (granularity) spec.granularity = granularity;
  return spec;
}

/** Validation errors the API would reject, caught before the round trip. */
export function localProblems(file) {
  const problems = [];
  const cfg = file.filterConfig || {};

  if (toIsoDate(cfg.startDate) === undefined) {
    problems.push('Start Date must be DD/MM/YYYY or YYYY-MM-DD.');
  }
  if (toIsoDate(cfg.endDate) === undefined) {
    problems.push('End Date must be DD/MM/YYYY or YYYY-MM-DD.');
  }
  const start = toIsoDate(cfg.startDate);
  const end = toIsoDate(cfg.endDate);
  if (start && end && start > end) {
    problems.push('Start Date must not be after End Date.');
  }
  if ((file.selectedCols || []).length === 0 && (file.columns || []).length > 0) {
    problems.push('Keep at least one column.');
  }

  const missingFormat = (file.dateConfigs || [])
    .filter((d) => !file.dateSourceFormats?.[d.col])
    .map((d) => d.col);
  if (missingFormat.length) {
    problems.push(
      `Could not detect the source date format for: ${missingFormat.join(', ')}. ` +
        `That column will be left as text.`
    );
  }

  return problems;
}
