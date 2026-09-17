from fastapi import APIRouter, HTTPException
import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional

router = APIRouter()


def evaluate_curve_at_spend(channel: str, spend: float, merged_rc: dict) -> float:
    """
    Interpolates or evaluates the response curve saturation value for a given spend.
    """
    spend_key = f"{channel}_spend"
    impact_key = f"{channel}_impactable_nation"

    if spend_key not in merged_rc or impact_key not in merged_rc:
        return 0.0

    sp_arr = np.array(merged_rc[spend_key], dtype=float)
    imp_arr = np.array(merged_rc[impact_key], dtype=float)

    if len(sp_arr) == 0:
        return 0.0

    if spend <= sp_arr[0]:
        return float(imp_arr[0] * (spend / sp_arr[0])) if sp_arr[0] > 0 else 0.0

    if spend >= sp_arr[-1]:
        # Logarithmic saturation continuation beyond curve max
        last_sp = sp_arr[-1]
        last_imp = imp_arr[-1]
        if last_sp > 0 and spend > last_sp:
            return float(last_imp * (1.0 + 0.15 * np.log(1.0 + (spend - last_sp) / last_sp)))
        return float(last_imp)

    # Linear interpolation between nearest curve points
    return float(np.interp(spend, sp_arr, imp_arr))


@router.post("/run")
async def run_optimization(payload: dict):
    """
    Non-Linear Budget & Scenario Optimization Engine.
    - Fixed Budget: Maximizes total sales lift subject to sum(spend) <= budget target and custom channel min/max bounds.
    - Fixed Goal: Minimizes required investment subject to sum(sales) >= target outcome and custom channel min/max bounds.
    - Full Support for completely user-defined Min ($) and Max ($) constraints.
    """
    try:
        merged_rc = payload.get("merged_rc", {})
        optimizer_dict = {ch: dict(info) for ch, info in payload.get("optimizer_dict", {}).items()}
        target = float(payload.get("target", 0.0))
        opt_type = payload.get("opt_type", "Budget Goal")
        is_fixed_budget = opt_type in ("Budget Goal", "Fixed Budget")

        if not optimizer_dict:
            raise HTTPException(status_code=400, detail="No channel constraints or response curves provided.")

        channels = list(optimizer_dict.keys())

        # 1. Read User's Exact Min and Max Constraints
        current_spends = {}
        min_constraints = {}
        max_constraints = {}

        for ch in channels:
            info = optimizer_dict[ch]
            min_constraints[ch] = max(0.0, float(info.get("min", 0.0)))
            max_constraints[ch] = max(min_constraints[ch], float(info.get("max", 500000.0)))
            current_spends[ch] = min_constraints[ch] # Start at user's Min Constraint

        min_possible_budget = sum(min_constraints.values())
        max_possible_budget = sum(max_constraints.values())

        # Compute max possible sales outcome at all max constraints
        max_possible_sales = sum(evaluate_curve_at_spend(ch, max_constraints[ch], merged_rc) for ch in channels)

        # 2. Feasibility Validation
        feasible = True
        feasibility_message = ""

        if not is_fixed_budget: # Fixed Goal mode
            if target > max_possible_sales:
                feasible = False
                feasibility_message = f"Target goal of {target:,.0f} units exceeds maximum possible outcome of {max_possible_sales:,.0f} units achievable with current Max Spend constraints."

        # 3. Dynamic Optimization Step Loop
        # Step increment per allocation
        total_budget_span = target if is_fixed_budget else (min_possible_budget * 2.0 or 200000.0)
        step_size = max(500.0, total_budget_span / 200.0)

        max_iterations = 20000
        iteration = 0
        history = []

        if is_fixed_budget:
            # ─── CASE 1: FIXED BUDGET (Maximize Sales s.t. Spend == Budget) ───
            allocated_spend = sum(current_spends.values())

            while allocated_spend < target and iteration < max_iterations:
                iteration += 1
                best_channel = None
                best_marginal_gain = -1.0
                actual_step = min(step_size, target - allocated_spend)

                for ch in channels:
                    cur_s = current_spends[ch]
                    if cur_s + actual_step > max_constraints[ch]:
                        continue # Cannot exceed user's Max constraint

                    cur_impact = evaluate_curve_at_spend(ch, cur_s, merged_rc)
                    next_impact = evaluate_curve_at_spend(ch, cur_s + actual_step, merged_rc)
                    marginal_gain = (next_impact - cur_impact) / actual_step

                    if marginal_gain > best_marginal_gain:
                        best_marginal_gain = marginal_gain
                        best_channel = ch

                # If no channel can take more budget or marginal return is zero
                if best_channel is None or best_marginal_gain <= 0:
                    break

                current_spends[best_channel] += actual_step
                allocated_spend = sum(current_spends.values())

                if iteration % 20 == 0:
                    tot_sales = sum(evaluate_curve_at_spend(c, current_spends[c], merged_rc) for c in channels)
                    history.append({"step": iteration, "spend": allocated_spend, "sales": tot_sales})

        else:
            # ─── CASE 2: FIXED GOAL (Minimize Spend s.t. Sales >= Target) ─────
            current_sales = sum(evaluate_curve_at_spend(c, current_spends[c], merged_rc) for c in channels)

            while current_sales < target and iteration < max_iterations:
                iteration += 1
                best_channel = None
                best_marginal_gain = -1.0

                for ch in channels:
                    cur_s = current_spends[ch]
                    if cur_s + step_size > max_constraints[ch]:
                        continue

                    cur_impact = evaluate_curve_at_spend(ch, cur_s, merged_rc)
                    next_impact = evaluate_curve_at_spend(ch, cur_s + step_size, merged_rc)
                    marginal_gain = (next_impact - cur_impact) / step_size

                    if marginal_gain > best_marginal_gain:
                        best_marginal_gain = marginal_gain
                        best_channel = ch

                if best_channel is None or best_marginal_gain <= 0:
                    break

                current_spends[best_channel] += step_size
                current_sales = sum(evaluate_curve_at_spend(c, current_spends[c], merged_rc) for c in channels)

                if iteration % 20 == 0:
                    tot_sp = sum(current_spends.values())
                    history.append({"step": iteration, "spend": tot_sp, "sales": current_sales})

        # 4. Compile Final Channel Allocation
        final_allocation = {}
        total_final_spend = 0.0
        total_final_sales = 0.0

        for ch in channels:
            ch_sp = round(current_spends[ch], 2)
            ch_imp = round(evaluate_curve_at_spend(ch, ch_sp, merged_rc), 2)
            ch_roi = round(ch_imp / ch_sp, 3) if ch_sp > 0 else 0.0

            total_final_spend += ch_sp
            total_final_sales += ch_imp

            final_allocation[ch] = {
                "spend": ch_sp,
                "impactable_nation": ch_imp,
                "roi": ch_roi,
            }

        converged = (total_final_spend >= (target - step_size)) if is_fixed_budget else (total_final_sales >= (target - 1.0))

        return {
            "converged": bool(converged and feasible),
            "feasible": feasible,
            "message": feasibility_message,
            "final_value": round(total_final_spend if is_fixed_budget else total_final_sales, 2),
            "total_spend": round(total_final_spend, 2),
            "total_sales": round(total_final_sales, 2),
            "optimized_roi": round(total_final_sales / total_final_spend, 3) if total_final_spend > 0 else 0.0,
            "min_possible_spend": min_possible_budget,
            "max_possible_sales": max_possible_sales,
            "allocation": final_allocation,
            "history": history[-30:],
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Optimization failed: {str(e)}")