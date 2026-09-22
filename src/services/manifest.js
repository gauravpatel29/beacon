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

/**
 * Accepts YYYY-MM-DD, DD/MM/YYYY and YYYY-MM. Returns ISO, or undefined.
 *
 * `YYYY-MM` is how a monthly file usually stores its period - "2023-01", one
 * row per month - and the engine reads it happily: pandas parses it as the
 * first of that month, which is why granularity detection reported Monthly on
 * exactly the files this used to reject. Without it here, every row of such a
 * file was counted as an unparseable date and the trend chart drew nothing at
 * all while the data behind it was fine.
 *
 * A bare year is deliberately NOT accepted: "2023" is far more often an
 * integer column than a date, and reading it as one would put a metric on the
 * time axis.
 */
export function toIsoDate(text) {
  const s = (text || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Year-month, with either separator: the first of the month, as the engine
  // reads it.
  const ym = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const [, y, mo] = ym;
    return `${y}-${mo.padStart(2, '0')}-01`;
  }
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
export function emptyCondition() {
  return { min: '', max: '', start: '', end: '', values: [], luhn: false, notNull: false };
}

export function emptyRule(kind = 'string') {
  return { kind, mode: 'all', conditions: [emptyCondition()] };
}

/**
 * Accept either shape of rule and return the current one.
 *
 * A rule used to be a single flat set of fields; it is now a list of conditions
 * with a mode. Normalising on read means the older shape - held in state from
 * before a reload, or written by an older check script - still works, and the
 * page never has to ask which shape it is holding.
 */
export function normalizeRule(rule, kind = 'string') {
  if (!rule) return emptyRule(kind);
  if (Array.isArray(rule.conditions)) {
    return {
      kind: rule.kind || kind,
      mode: rule.mode === 'any' ? 'any' : 'all',
      conditions: rule.conditions.length ? rule.conditions : [emptyCondition()],
    };
  }
  const { kind: ruleKind, mode, ...fields } = rule;
  return {
    kind: ruleKind || kind,
    mode: mode === 'any' ? 'any' : 'all',
    conditions: [{ ...emptyCondition(), ...fields }],
  };
}

/**
 * Does this condition actually constrain anything?
 *
 * A column picked in the dropdown but left blank is a browse, not a filter -
 * sending it would be a no-op the API still has to validate, and `range` with
 * neither bound is a 422.
 */
export function conditionIsSet(condition, kind) {
  if (!condition) return false;
  if (condition.luhn || condition.notNull) return true;
  if (kind === 'number') return condition.min !== '' || condition.max !== '';
  if (kind === 'date') return Boolean(condition.start || condition.end);
  return (condition.values || []).length > 0;
}

/** Does any condition on this column constrain anything? */
export function ruleIsSet(rule) {
  if (!rule) return false;
  const norm = normalizeRule(rule);
  return norm.conditions.some((c) => conditionIsSet(c, norm.kind));
}

/**
 * Read a committed spec back into the Filter tab's shape.
 *
 * The inverse of `buildFilters`. Without it, reopening a configured file shows
 * an empty Filter tab - and worse, the next Apply sends no filters and wipes
 * the ones already committed.
 *
 * Filters are stored against post-rename names; the tab keys its rules by the
 * ORIGINAL column, so the renames are undone here.
 */
/** How the committed spec combines its filters. Older specs have no mode. */
export function restoreFilterMode(spec) {
  return spec?.filter_mode === 'any' ? 'any' : 'all';
}

/** Read one condition's filters back into the tab's condition shape. */
function conditionFromFilters(filters) {
  const condition = emptyCondition();
  let kind = 'string';
  for (const f of filters || []) {
    if (f.type === 'range') {
      kind = 'number';
      if (f.min !== undefined && f.min !== null) condition.min = String(f.min);
      if (f.max !== undefined && f.max !== null) condition.max = String(f.max);
    } else if (f.type === 'date_range') {
      kind = 'date';
      if (f.start) condition.start = f.start;
      if (f.end) condition.end = f.end;
    } else if (f.type === 'value_in') {
      condition.values = [...(f.values || [])];
    } else if (f.type === 'npi_luhn') {
      condition.luhn = true;
    } else if (f.type === 'not_null') {
      condition.notNull = true;
    }
  }
  return { condition, kind };
}

export function restoreFilters(specFilters, renameMap) {
  const originalOf = Object.fromEntries(
    Object.entries(renameMap || {}).map(([from, to]) => [to, from])
  );
  const rules = {};

  // A flat list carries no grouping, so one filter per field is assumed and a
  // repeat of a field already set starts a new condition. Every spec written
  // before groups existed has exactly one condition per column, which this
  // reproduces; a hand-written spec with two ranges on a column now round-trips
  // instead of the second silently overwriting the first.
  const occupied = (c, f) =>
    (f.type === 'range' && ((f.min != null && c.min !== '') || (f.max != null && c.max !== '')))
    || (f.type === 'date_range' && ((f.start && c.start) || (f.end && c.end)))
    || (f.type === 'value_in' && (c.values || []).length > 0)
    || (f.type === 'npi_luhn' && c.luhn)
    || (f.type === 'not_null' && c.notNull);

  for (const f of specFilters || []) {
    const col = originalOf[f.column] || f.column;
    if (!rules[col]) rules[col] = { kind: 'string', mode: 'all', conditions: [emptyCondition()] };
    const rule = rules[col];
    let current = rule.conditions[rule.conditions.length - 1];
    if (occupied(current, f)) {
      current = emptyCondition();
      rule.conditions.push(current);
    }
    const { condition: merged, kind } = conditionFromFilters([f]);
    for (const key of Object.keys(merged)) {
      if (key === 'values') {
        if (merged.values.length) current.values = merged.values;
      } else if (merged[key] !== '' && merged[key] !== false) {
        current[key] = merged[key];
      }
    }
    if (kind !== 'string') rule.kind = kind;
  }
  return rules;
}

/**
 * Read a committed spec's filters back into the tab's shape, preferring the
 * nested `filter_groups` when the spec carries them. The flat list is the
 * fallback for specs written before groups existed.
 */
export function restoreFilterGroups(spec, renameMap) {
  const groups = spec?.filter_groups;
  if (!Array.isArray(groups) || !groups.length) {
    return restoreFilters(spec?.filters, renameMap);
  }
  const originalOf = Object.fromEntries(
    Object.entries(renameMap || {}).map(([from, to]) => [to, from])
  );

  const rules = {};
  for (const group of groups) {
    for (const cond of group.conditions || []) {
      const first = (cond.filters || [])[0];
      if (!first) continue;
      const col = originalOf[first.column] || first.column;
      const { condition, kind } = conditionFromFilters(cond.filters);
      if (!rules[col]) {
        rules[col] = {
          kind: 'string',
          mode: group.mode === 'any' ? 'any' : 'all',
          conditions: [],
        };
      }
      if (kind !== 'string') rules[col].kind = kind;
      rules[col].conditions.push(condition);
    }
  }
  for (const rule of Object.values(rules)) {
    if (!rule.conditions.length) rule.conditions.push(emptyCondition());
  }
  return rules;
}

/**
 * Read a committed `granularity` back into the Granularity tab's shape.
 * The inverse of `buildGranularity`; same reasoning as `restoreFilters`.
 */
export function restoreGranularity(granularity, renameMap) {
  const blank = { dateCol: '', geoCol: '', detected: null, target: '', numOps: {} };
  if (!granularity) return blank;
  const originalOf = Object.fromEntries(
    Object.entries(renameMap || {}).map(([from, to]) => [to, from])
  );
  const original = (c) => originalOf[c] || c;

  return {
    dateCol: original(granularity.date_column || ''),
    geoCol: original(granularity.geo_column || ''),
    // `from` is what detection found when this was committed. Restoring it
    // means the tab does not have to re-run detection to show its own state.
    detected: granularity.from || null,
    target: granularity.to || '',
    numOps: Object.fromEntries(
      Object.entries(granularity.numeric || {}).map(([col, op]) => [original(col), op])
    ),
  };
}

/**
 * Build `filters` from the Filter tab. Columns are post-rename, because
 * filters run after `live_updates`.
 *
 * Every configured rule is sent, not just the one currently selected in the
 * dropdown: the dropdown chooses what you are *editing*, and a filter you set
 * on another column is still a filter you asked for.
 */
/** The filters for one condition. They are always ANDed by the engine. */
function conditionFilters(file, col, kind, condition) {
  const column = renamedName(file, col);
  const filters = [];

  if (condition.notNull) filters.push({ type: 'not_null', column });
  // Guarded, not just hidden in the UI: a column renamed away from NPI after
  // the box was ticked would otherwise still be Luhn-filtered.
  if (condition.luhn && looksLikeNpi(file, col)) filters.push({ type: 'npi_luhn', column });

  if (kind === 'number' && (condition.min !== '' || condition.max !== '')) {
    const f = { type: 'range', column };
    if (condition.min !== '') f.min = Number(condition.min);
    if (condition.max !== '') f.max = Number(condition.max);
    filters.push(f);
  } else if (kind === 'date') {
    const start = toIsoDate(condition.start);
    const end = toIsoDate(condition.end);
    if (start || end) {
      const f = { type: 'date_range', column };
      if (start) f.start = start;
      if (end) f.end = end;
      filters.push(f);
    }
  } else if (kind !== 'number' && kind !== 'date' && (condition.values || []).length) {
    filters.push({ type: 'value_in', column, values: condition.values });
  }

  return filters;
}

/**
 * Build `filter_groups`: one group per filtered column, holding that column's
 * conditions and how they combine.
 *
 * Every configured rule is sent, not just the one currently selected in the
 * dropdown: the dropdown chooses what you are *editing*, and a filter you set
 * on another column is still a filter you asked for.
 */
export function buildFilterGroups(file) {
  const rules = (file.filterConfig || {}).rules || {};
  const groups = [];

  for (const col of Object.keys(rules)) {
    const rule = normalizeRule(rules[col]);
    const conditions = rule.conditions
      .filter((c) => conditionIsSet(c, rule.kind))
      .map((c) => ({ filters: conditionFilters(file, col, rule.kind, c) }))
      .filter((c) => c.filters.length);
    if (conditions.length) groups.push({ mode: rule.mode, conditions });
  }

  return groups;
}

/**
 * The flat projection of the groups, which is what the API stores as `filters`.
 * Sent alongside the groups so nothing that reads the flat list has to know
 * about the nesting.
 */
/**
 * Split an incoming selection into what may be uploaded and what collides.
 *
 * A filename is the identity of a dataset in a workflow: its manifest, its
 * derived copy and every ARD that joins it are keyed by that name. Uploading a
 * second file of the same name replaces the stored one and discards the
 * configuration committed against it, so the collision is refused instead.
 *
 * Case-insensitive, because the store treats the two names as one. Collisions
 * inside a single selection count too - picking the same file twice, or two
 * files of the same name from different folders.
 */
export function partitionNewFiles(existingNames, incoming) {
  const taken = new Set((existingNames || []).map((n) => String(n).toLowerCase()));
  const seen = new Set();
  const accepted = [];
  const duplicates = [];

  for (const file of incoming || []) {
    const key = String(file.name).toLowerCase();
    if (taken.has(key) || seen.has(key)) {
      duplicates.push(file.name);
      continue;
    }
    seen.add(key);
    accepted.push(file);
  }

  return { accepted, duplicates };
}

/** One link in the chain: a column, its kind, and the condition on it. */
export function emptyChainEntry(column = '', kind = 'string') {
  return { column, kind, cond: emptyCondition() };
}

/**
 * Build `filter_chain`: the cards in order, with the operator from each gap.
 *
 * `operators` must end up with exactly one fewer entry than `items` or the API
 * rejects it, so a card that is not actually configured takes the operator
 * leading into it out of the chain along with itself.
 */
export function buildFilterChain(file) {
  const cfg = file.filterConfig || {};
  const chain = cfg.chain || [];
  const chosen = cfg.operators || [];

  const items = [];
  const operators = [];

  chain.forEach((entry, index) => {
    if (!entry || !entry.column) return;
    if (!conditionIsSet(entry.cond, entry.kind)) return;
    const filters = conditionFilters(file, entry.column, entry.kind, entry.cond);
    if (!filters.length) return;
    // The operator in the gap before this card. Only needed once something is
    // already in the chain for it to join onto.
    if (items.length) operators.push(chosen[index - 1] === 'or' ? 'or' : 'and');
    items.push({ filters });
  });

  return { items, operators };
}

/**
 * The flat projection of the chain, which is what the API stores as `filters`.
 * Sent alongside it so nothing reading the flat list needs to know the shape.
 */
export function buildFilters(file) {
  return buildFilterChain(file).items.flatMap((item) => item.filters);
}

/** A card's condition in words, for the chain summary. */
export function describeChainEntry(file, entry) {
  const name = renamedName(file, entry.column) || entry.column;
  const c = entry.cond || {};
  const parts = [];

  if (entry.kind === 'number') {
    if (c.min !== '' && c.max !== '') parts.push(`between ${c.min} and ${c.max}`);
    else if (c.min !== '') parts.push(`at least ${c.min}`);
    else if (c.max !== '') parts.push(`at most ${c.max}`);
  } else if (entry.kind === 'date') {
    if (c.start && c.end) parts.push(`from ${c.start} to ${c.end}`);
    else if (c.start) parts.push(`on or after ${c.start}`);
    else if (c.end) parts.push(`on or before ${c.end}`);
  } else if ((c.values || []).length) {
    const shown = c.values.slice(0, 3).join(', ');
    parts.push((c.values.length > 3)
      ? `is one of ${shown} and ${c.values.length - 3} more`
      : `is ${c.values.length > 1 ? 'one of ' : ''}${shown}`);
  }

  if (c.notNull) parts.push('is not empty');
  if (c.luhn) parts.push('passes NPI check');

  return `${name} ${parts.join(' and ') || 'is unfiltered'}`;
}

/**
 * Read a committed spec back into the chain, whichever form it was stored in.
 *
 * Older specs carry `filter_groups` (nested per column) or a bare `filters`
 * list with a single `filter_mode`. Both are flattened into a chain, which is
 * exact whenever the stored filter used one operator throughout - the case
 * every spec the previous UI could produce with its defaults. A stored spec
 * that genuinely mixed AND and OR across groups cannot always be written as a
 * flat chain, and converts to the nearest left-to-right reading.
 */
export function restoreFilterChain(spec, renameMap) {
  const originalOf = Object.fromEntries(
    Object.entries(renameMap || {}).map(([from, to]) => [to, from])
  );
  const entryOf = (filters) => {
    const first = (filters || [])[0];
    if (!first) return null;
    const { condition, kind } = conditionFromFilters(filters);
    return { column: originalOf[first.column] || first.column, kind, cond: condition };
  };

  const stored = spec?.filter_chain;
  if (stored && Array.isArray(stored.items) && stored.items.length) {
    const chain = [];
    const operators = [];
    stored.items.forEach((item, index) => {
      const entry = entryOf(item.filters);
      if (!entry) return;
      if (chain.length) operators.push(stored.operators?.[index - 1] === 'or' ? 'or' : 'and');
      chain.push(entry);
    });
    return { chain, operators };
  }

  // Legacy: groups nested per column.
  if (Array.isArray(spec?.filter_groups) && spec.filter_groups.length) {
    const across = spec.filter_mode === 'any' ? 'or' : 'and';
    const chain = [];
    const operators = [];
    spec.filter_groups.forEach((group) => {
      const within = group.mode === 'any' ? 'or' : 'and';
      (group.conditions || []).forEach((cond, i) => {
        const entry = entryOf(cond.filters);
        if (!entry) return;
        if (chain.length) operators.push(i === 0 ? across : within);
        chain.push(entry);
      });
    });
    return { chain, operators };
  }

  // Legacy: a flat list under one mode.
  const rules = restoreFilters(spec?.filters, renameMap);
  const op = spec?.filter_mode === 'any' ? 'or' : 'and';
  const chain = [];
  const operators = [];
  Object.keys(rules).forEach((col) => {
    const rule = normalizeRule(rules[col]);
    rule.conditions.forEach((cond) => {
      if (!conditionIsSet(cond, rule.kind)) return;
      if (chain.length) operators.push(op);
      chain.push({ column: col, kind: rule.kind, cond });
    });
  });
  return { chain, operators };
}

/**
 * "all" keeps a row only when every filter accepts it; "any" keeps it when at
 * least one does. Defaults to "all", which is what the engine did before the
 * mode existed.
 */
export function buildFilterMode(file) {
  return file.filterConfig?.mode === 'any' ? 'any' : 'all';
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

/**
 * What goes in `config_metadata`: the declarations that describe the data
 * rather than change it.
 *
 * The engine does not read this block - it applies `live_updates`, `filters`
 * and `granularity` - but it stores it, which is what makes the file category
 * and the per-column roles survive a reload and reach the screens downstream.
 *
 * Roles are keyed by the column's name AFTER any rename, because that is the
 * name every later screen sees. Storing the original would leave Data
 * Transformation looking up a column that is not in the frame.
 */
export function buildConfigMetadata(file) {
  const meta = {};
  if (file.category) meta.category = file.category;

  const roles = file.columnRoles || {};
  const kept = new Set(file.selectedCols || file.columns || []);
  const declared = {};
  for (const [column, role] of Object.entries(roles)) {
    // A role for a column the user has since dropped would name a column that
    // does not reach the derived frame.
    if (!kept.has(column)) continue;
    declared[renamedName(file, column)] = role;
  }
  if (Object.keys(declared).length) meta.column_roles = declared;
  return meta;
}

/** The complete manifest for one file. */
export function buildSpec(file) {
  const spec = {
    config_metadata: buildConfigMetadata(file),
    live_updates: buildLiveUpdates(file),
    // The chain drives the engine; the flat list is its projection, sent so a
    // backend that predates the chain still filters - just without the
    // per-gap operators. Always sent, both of them, so clearing every filter
    // is recorded rather than leaving what was committed before in place.
    filters: buildFilters(file),
    filter_chain: buildFilterChain(file),
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
