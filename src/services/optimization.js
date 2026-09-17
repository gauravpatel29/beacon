// Optimization module — thin wrapper around the real, confirmed
// POST /api/optimization/run endpoint (services/api.js's `runOptimization`).
// Every field name and default below is read directly from optimization.py,
// not inferred — see OPTIMIZATION_API.md for the full contract.
import { runOptimization as apiRunOptimization } from './api.js';

/**
 * Run the budget/goal optimizer.
 *
 * @param {object} params
 * @param {object} params.mergedRc - Flattened response-curve arrays, one set
 *   per channel: `${channel}_spend`, `${channel}_impactable_nation` (both
 *   required per channel — evaluate_curve_at_spend returns 0.0 for any
 *   channel missing either key, silently, not an error).
 * @param {object} params.optimizerDict - `{ [channel]: { min, max } }`.
 *   `min` defaults to 0 server-side if omitted/negative; `max` defaults to
 *   500000 if omitted, and is floored to `min` if sent lower than it.
 *   A `currentSpend` field is fine to include (harmless) but the backend
 *   never reads it — allocation always starts AT `min`, not at current spend.
 * @param {number} params.target - Budget ceiling (Fixed Budget) or sales
 *   floor (Fixed Goal), depending on optType.
 * @param {'Budget Goal'|'Fixed Budget'|'Sales Goal'} params.optType - Only
 *   "Budget Goal" and "Fixed Budget" are treated as fixed-budget mode
 *   server-side; anything else (including "Sales Goal") runs Fixed Goal mode.
 * @param {string} [params.scenarioName] - Not read by the backend at all;
 *   purely a label for the caller's own bookkeeping (e.g. scenario history).
 */
export async function runOptimization({ mergedRc, optimizerDict, target, optType, scenarioName }) {
  const data = await apiRunOptimization({
    merged_rc: mergedRc,
    optimizer_dict: optimizerDict,
    target,
    opt_type: optType,
    scenario_name: scenarioName,
  });
  return data;
  // Response shape (all fields real, confirmed from optimization.py):
  // {
  //   converged: bool,           // reached target within max_iterations/step constraints
  //   feasible: bool,            // ONLY ever false in Fixed Goal mode when target > max_possible_sales
  //   message: string,           // populated only when feasible === false
  //   final_value: number,       // total_spend (Fixed Budget) or total_sales (Fixed Goal)
  //   total_spend: number,
  //   total_sales: number,
  //   optimized_roi: number,     // total_sales / total_spend, 0 if total_spend is 0
  //   min_possible_spend: number,// sum of every channel's min constraint
  //   max_possible_sales: number,// sum of every channel's curve value at its max constraint
  //   allocation: {
  //     [channel]: { spend: number, impactable_nation: number, roi: number }
  //   },
  //   history: [{ step, spend, sales }, ...]  // last 30 optimizer iterations, for a convergence chart if ever needed
  // }
}