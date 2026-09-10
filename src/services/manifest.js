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

// strftime is what the API speaks, but "%d/%m/%Y" is not something to put in
// front of a user. Tokens are replaced longest-first so "%Y" cannot be matched
// inside a longer directive.
const FORMAT_TOKENS = [
  ['%Y', 'YYYY'], ['%y', 'YY'],
  ['%B', 'Month'], ['%b', 'Mon'], ['%m', 'MM'],
  ['%d', 'DD'], ['%j', 'DDD'],
  ['%H', 'HH'], ['%I', 'hh'], ['%M', 'mm'], ['%S', 'ss'], ['%p', 'AM/PM'],
];

/**
 * A strftime pattern rewritten for display: "%d/%m/%Y" -> "DD/MM/YYYY".
 *
 * Generic rather than a lookup table, so any format the server detects renders
 * readably instead of falling back to raw percent codes.
 */
export function humanFormat(pattern) {
  if (!pattern) return '';
  let out = pattern;
  for (const [token, label] of FORMAT_TOKENS) {
    out = out.split(token).join(label);
  }
  return out;
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

/**
 * Is this an NPI column?
 *
 * The Luhn check is specific to 10-digit US NPI numbers - run against anything
 * else it does not validate, it just deletes rows - so it is offered, and sent,
 * only where it means something. Matched on the name against both the original
 * and the renamed form, so a rename in either direction cannot leave a Luhn
 * filter stranded on a column that is no longer an NPI.
 *
 * Lives here rather than in the page so the control that offers it and the
 * builder that sends it can never disagree.
 */
export function looksLikeNpi(file, column) {
  return [column, renamedName(file, column)].some((name) =>
    /(^|[^a-z])npi([^a-z]|$)/i.test(String(name || '')));
}

/**
 * An empty rule for one column. `kind` decides which fields are meaningful and
 * which control the Filter tab renders; the rest stay inert so switching a
 * column's type never silently drops what the user typed.
 */
export function emptyRule(kind = 'string') {
  return { kind, min: '', max: '', start: '', end: '', values: [], luhn: false, notNull: false };
}

/**
 * Does this rule actually constrain anything?
 *
 * A column picked in the dropdown but left blank is a browse, not a filter -
 * sending it would be a no-op the API still has to validate, and `range` with
 * neither bound is a 422.
 */
export function ruleIsSet(rule) {
  if (!rule) return false;
  if (rule.luhn || rule.notNull) return true;
  if (rule.kind === 'number') return rule.min !== '' || rule.max !== '';
  if (rule.kind === 'date') return Boolean(rule.start || rule.end);
  return (rule.values || []).length > 0;
}

/**
 * Build `filters` from the Filter tab. Columns are post-rename, because
 * filters run after `live_updates`.
 *
 * Every configured rule is sent, not just the one currently selected in the
 * dropdown: the dropdown chooses what you are *editing*, and a filter you set
 * on another column is still a filter you asked for.
 */
export function buildFilters(file) {
  const cfg = file.filterConfig || {};
  const rules = cfg.rules || {};
  const filters = [];

  for (const col of Object.keys(rules)) {
    const rule = rules[col];
    if (!ruleIsSet(rule)) continue;
    const column = renamedName(file, col);

    if (rule.notNull) filters.push({ type: 'not_null', column });
    // Guarded, not just hidden in the UI: a column renamed away from NPI after
    // the box was ticked would otherwise still be Luhn-filtered.
    if (rule.luhn && looksLikeNpi(file, col)) filters.push({ type: 'npi_luhn', column });

    if (rule.kind === 'number' && (rule.min !== '' || rule.max !== '')) {
      const f = { type: 'range', column };
      if (rule.min !== '') f.min = Number(rule.min);
      if (rule.max !== '') f.max = Number(rule.max);
      filters.push(f);
    } else if (rule.kind === 'date') {
      const start = toIsoDate(rule.start);
      const end = toIsoDate(rule.end);
      if (start || end) {
        const f = { type: 'date_range', column };
        if (start) f.start = start;
        if (end) f.end = end;
        filters.push(f);
      }
    } else if ((rule.values || []).length) {
      filters.push({ type: 'value_in', column, values: rule.values });
    }
  }

  return filters;
}

/** Build `granularity` from the Granularity tab, or null when incomplete. */
/**
 * Columns a rollup can actually aggregate: kept, numeric, and not one of the
 * two grouping keys.
 *
 * The Granularity tab renders exactly this list, and `buildGranularity` sends
 * exactly this list, so what the user sees is what gets aggregated. Anything
 * outside it is dropped by the rollup, which the API reports back as
 * `applied.unhandled_columns`.
 *
 * Type comes from `typeCastMap`, so a column the user re-typed on the
 * Standardize tab is honoured over the server's original guess.
 */
export function numericColumns(file) {
  const g = file.granularityConfig || {};
  const kept = new Set(file.selectedCols || file.columns || []);
  return (file.columns || []).filter((col) => {
    if (!kept.has(col)) return false;
    if (col === g.dateCol || col === g.geoCol) return false;
    const type = file.typeCastMap?.[col];
    return type === 'integer' || type === 'float';
  });
}

export function buildGranularity(file) {
  const g = file.granularityConfig || {};
  if (!g.detected || !g.target || !g.dateCol || !g.geoCol) return null;
  // The dropdown offers the current grain as a target (Weekly -> Weekly); the
  // API only accepts a coarser one, and a same-grain rollup is a no-op anyway.
  if (g.target === g.detected) return null;

  // Every aggregatable column is sent, defaulting to the "sum" the dropdown
  // already shows. Sending only the ones the user happened to touch would
  // silently drop the rest, even though the UI showed an operation for them.
  const numeric = {};
  for (const col of numericColumns(file)) {
    numeric[renamedName(file, col)] = g.numOps?.[col] || 'sum';
  }

  return {
    from: g.detected,
    to: g.target,
    date_column: renamedName(file, g.dateCol),
    geo_column: renamedName(file, g.geoCol),
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

  return problems;
}

/**
 * Non-blocking notices worth telling the user after a successful run.
 *
 * Kept separate from `localProblems` so an undetectable date format does not
 * stop the whole file being processed - the column simply stays as text.
 */
export function localWarnings(file) {
  const warnings = [];
  const profileFor = (col) => (file.profile || []).find((p) => p.column === col);

  const missingFormat = (file.dateConfigs || [])
    .filter((d) => !file.dateSourceFormats?.[d.col])
    .map((d) => d.col);
  if (missingFormat.length) {
    warnings.push(
      `No source date format could be detected for ${missingFormat.join(', ')}, ` +
        `so ${missingFormat.length > 1 ? 'those columns are' : 'that column is'} left as text.`
    );
  }

  // Two formats fit these values equally well (every day-of-month <= 12), so
  // the highest-ranked candidate is assumed. Say which, because reading it the
  // other way round silently swaps day and month.
  const ambiguous = (file.dateConfigs || [])
    .map((d) => ({ col: d.col, info: profileFor(d.col), from: file.dateSourceFormats?.[d.col] }))
    .filter((d) => d.info?.ambiguous_date && d.from);
  for (const { col, info, from } of ambiguous) {
    warnings.push(
      `${col} could be ${(info.ambiguous_between || []).map(humanFormat).join(' or ')}; ` +
        `read as ${humanFormat(from)}. Check this is right for your file.`
    );
  }

  return warnings;
}
