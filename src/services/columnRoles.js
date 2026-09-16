// What each column IS, declared once at ingestion and used everywhere after.
//
// The file-level category says what a file is - sales, calls, a crosswalk. It
// says nothing about the columns inside it, so every screen downstream was
// guessing its own way: Data Transformation matched names to decide which
// columns were the date and the KPI, Data Review guessed which were metrics,
// and Model Configuration guessed again. Three heuristics, three chances to
// disagree about the same column, and no way for the user to correct any of
// them except per screen, every time.
//
// A role is assigned once here and travels in the manifest
// (`config_metadata.column_roles`), which the backend already stores as
// free-form metadata - so this needs no schema change, and a file's roles
// survive a reload with the rest of its spec.

/**
 * The five modelling roles. `id` is what goes on the wire, and matches the
 * reference application exactly so specs written by either app are readable by
 * the other.
 */
export const COLUMN_ROLES = [
  {
    id: 'Cross-sectional Variable',
    short: 'Cross-sectional',
    hint: 'HCP, DMA, geography, ZIP',
    tone: 'violet',
  },
  {
    id: 'Dependent Variable',
    short: 'Dependent',
    hint: 'the KPI being modelled - TRx, NRx, sales',
    tone: 'red',
  },
  {
    id: 'Time Variable',
    short: 'Time',
    hint: 'date, week, month',
    tone: 'blue',
  },
  {
    id: 'Independent Promotions',
    short: 'Promotion',
    hint: 'marketing activity - calls, spend, impressions',
    tone: 'green',
  },
  {
    id: 'Baseline Variables',
    short: 'Baseline',
    hint: 'population, macro factors, trend',
    tone: 'amber',
  },
];

export const ROLE_IDS = COLUMN_ROLES.map((r) => r.id);

const ROLE_BY_ID = Object.fromEntries(COLUMN_ROLES.map((r) => [r.id, r]));
export const roleMeta = (id) => ROLE_BY_ID[id] || null;

/**
 * A first guess from the column's name.
 *
 * Only ever a default. The point of the table on the ingestion screen is that a
 * wrong guess is corrected once, there, rather than worked around on every
 * screen after it.
 *
 * Rules and their order match the reference app, with one deliberate
 * difference: it tested for a bare "id" anywhere in the name, which also
 * matches `paid_search` and `video_impressions` - both promotions - and filed
 * them as geography. Here "id" has to be its own word or a suffix, so `npi_id`
 * still matches and `paid_search` no longer does.
 *
 * The first test wins, so `sales_date` is a KPI rather than a date. That is the
 * reference app's behaviour and it is a coin toss either way; it is exactly the
 * kind of call the table exists to let the user overrule.
 */
export function guessColumnRole(colName) {
  const l = String(colName || '').toLowerCase();
  if (/sale|trx|nrx|crx|nbrx|revenue|kpi/.test(l)) return 'Dependent Variable';
  if (/date|week|month|period|year|time/.test(l)) return 'Time Variable';
  if (/npi|hcp|dma|zip|geo|account|(^|_)id($|_)/.test(l)) return 'Cross-sectional Variable';
  if (/pop|universe|macro|trend|base/.test(l)) return 'Baseline Variables';
  return 'Independent Promotions';
}

/**
 * Every column's role: what was assigned, else a guess.
 *
 * Never returns a role for a column that is not in `columns`, so a role left
 * behind by a dropped or renamed column cannot reach a downstream screen and
 * name a column that is no longer there.
 */
export function rolesFor(columns, assigned = {}) {
  const out = {};
  for (const col of columns || []) {
    const chosen = assigned?.[col];
    out[col] = ROLE_BY_ID[chosen] ? chosen : guessColumnRole(col);
  }
  return out;
}

/**
 * Roles as stored, mapped back to the column names this screen works in.
 *
 * `buildConfigMetadata` writes them under the RENAMED name, because that is
 * what every screen downstream sees. The ingestion screen works in original
 * names, so a file with `trx -> scripts` would otherwise come back with a role
 * for `scripts`, which is not a column it knows about, and the table would
 * re-guess every renamed column on every reload.
 */
export function restoreColumnRoles(stored, renameMap) {
  if (!stored || typeof stored !== 'object') return {};
  const originalOf = Object.fromEntries(
    Object.entries(renameMap || {}).map(([from, to]) => [to, from])
  );
  const out = {};
  for (const [column, role] of Object.entries(stored)) {
    out[originalOf[column] || column] = role;
  }
  return out;
}

/** The columns in one role, in the order the columns were given. */
export function columnsInRole(roles, role) {
  return Object.keys(roles || {}).filter((c) => roles[c] === role);
}

/**
 * Roles for every column across several files, merged.
 *
 * Downstream screens work on an ARD - one table joined from several files - so
 * they need one map, not one per file. A column present in two files with two
 * different roles keeps the first: they are the same column after the join,
 * and silently switching its role based on file order would be worse than
 * being stably wrong in a way the ingestion screen can correct.
 */
export function mergeRoles(perFile) {
  const merged = {};
  for (const roles of perFile || []) {
    for (const [col, role] of Object.entries(roles || {})) {
      if (!(col in merged)) merged[col] = role;
    }
  }
  return merged;
}

/**
 * Every role declared across a workflow's uploads.
 *
 * `items` is what GET /files returns. Roles live in each file's
 * `spec.config_metadata.column_roles`, so this is the one place that knows
 * where they are stored - a downstream screen asks for the map, not the path.
 */
export function rolesFromDatasets(items) {
  return mergeRoles(
    (items || []).map((d) => d?.spec?.config_metadata?.column_roles || {})
  );
}

/**
 * How a screen should read an ARD's columns.
 *
 * Returns the declared columns per role, restricted to the columns actually in
 * the frame, with a name-based fallback for anything the roles do not cover -
 * a derived column, or a file ingested before roles existed.
 */
export function rolePartition(columns, assigned = {}) {
  const roles = rolesFor(columns, assigned);
  const partition = {};
  for (const role of ROLE_IDS) partition[role] = columnsInRole(roles, role);
  return { roles, ...partition };
}
