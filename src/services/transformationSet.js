// Turning a saved transformation set back into a POST /transformation/apply body.
//
// The Data Transformation screen deliberately does not store the transformed
// frame - it is tens of thousands of rows of derived data, and a stored copy
// would outlive the ARD it came from. What it stores is the recipe.
//
// Model Configuration needs that frame: every modelling endpoint takes a
// `transformed_csv` alongside the raw `granular_csv`. So it replays the recipe
// rather than reaching for a cached result, and these builders are shared so
// the two screens cannot drift into producing different frames from the same
// saved set - which would be a model fitted on something other than what the
// Transformation screen showed.

/** What an unconfigured channel gets. Mirrors the engine's own defaults. */
export const DEFAULT_CONFIG = {
  normalization: 'none',
  decay: 0.5,
  horizon: 2,
  saturation: 'log',
  // Pure shift, in periods, sent alongside the horizon exactly as the
  // reference app sends it.
  lag: 0,
  param: 1,
  source: 'manual',
};

export function configFor(configs, name) {
  return (configs && configs[name]) || { ...DEFAULT_CONFIG };
}

/**
 * One channel's config in the engine's vocabulary.
 *
 * `param` is one control in the UI but two fields on the wire, because log and
 * power take different constants; the one the chosen curve does not use keeps
 * its default rather than being overwritten with the other curve's value.
 */
export function toTransformation(configs, name) {
  const c = configFor(configs, name);
  const sat = c.saturation === 'log' ? 'Log' : c.saturation === 'power' ? 'Power' : 'none';
  return {
    'Channel Name': name,
    'Normalization': c.normalization || 'none',
    'Adstock': Number(c.decay),
    // 'Lags' is the adstock HORIZON - the span the geometric decay sums over -
    // and 'Lag' is the pure shift beside it. Two keys, two meanings, named the
    // way the engine's callers name them.
    'Lags': Number(c.horizon),
    'Lag': Number(c.lag ?? 0),
    'Saturation Function': sat,
    'Power (k)': c.saturation === 'power' ? Number(c.param) : 0.5,
    'Log (k)': c.saturation === 'log' ? Number(c.param) : 1.0,
  };
}

// Weights are left empty: the builder offers an operator across whole columns,
// not per-column coefficients, and the engine defaults each to 1.
export function toDerivedVariables(derivedVars) {
  return (derivedVars || []).map((d) => ({
    name: d.name, operator: d.operator || '+', variables: d.parts, weights: {},
  }));
}

/**
 * The apply body for a saved transformation set.
 *
 * `saved` is the `transformation` slice of the workflow state, exactly as the
 * Transformation screen wrote it. Returns null when the set is not complete
 * enough to run - no date, geo or dependent column, or nothing selected -
 * rather than posting a request the engine will reject.
 */
export function buildApplyPayload(csvData, saved) {
  if (!csvData || !saved) return null;
  const dateColumn = (saved.dateKeys || [])[0];
  const geoColumn = (saved.geoKeys || [])[0];
  const dependent = (saved.dependentVars || [])[0];
  const channels = saved.selectedVars || [];
  const derived = saved.derivedVars || [];
  if (!dateColumn || !geoColumn || !dependent) return null;
  if (!channels.length && !derived.length) return null;

  return {
    csv_data: csvData,
    geo_column: geoColumn,
    date_column: dateColumn,
    dependent_variable: dependent,
    transformations: channels.map((name) => toTransformation(saved.configs, name)),
    derived_variables: toDerivedVariables(derived),
    pop_column: (saved.popKeys || [])[0] || null,
    add_carryover: Boolean(saved.carryover),
  };
}

/**
 * What the modelling endpoints call the dependent variable.
 *
 * Two names, and mixing them up is the kind of error that produces a model
 * rather than an exception: `dependent_variable` is the column in the RAW ARD,
 * used for the sales totals that ROI is divided by, while
 * `dependent_variable_user_input` is the column in the TRANSFORMED frame that
 * is actually regressed. They are the same name unless the dependent variable
 * was itself normalised, in which case the transformed frame carries the
 * suffixed one.
 */
export function dependentNames(saved, transformedColumns = []) {
  const raw = (saved?.dependentVars || [])[0] || '';
  const suffixed = `${raw}_transformed`;
  return {
    dependent_variable: raw,
    dependent_variable_user_input: transformedColumns.includes(suffixed) ? suffixed : raw,
  };
}
