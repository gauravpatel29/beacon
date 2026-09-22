from fastapi import APIRouter, HTTPException
import numpy as np
from typing import Dict, Any, List, Optional

router = APIRouter()


@router.post("/run")
async def run_optimization(payload: dict):
    try:
        merged_rc = payload.get("merged_rc", {})
        optimizer_dict = payload.get("optimizer_dict", {})
        target = float(payload.get("target", 0.0))
        opt_type = str(payload.get("opt_type", "Budget Goal")).strip()
        is_budget_goal = opt_type in ("Budget Goal", "Fixed Budget")

        # The step is a budget increment in dollars, not a number of points on
        # the response curve. Curves are generated per channel with their own
        # step (stop/50), so "advance 2 points" meant a different amount of
        # money for every channel, and the same setting meant different things
        # for the same channel once its spend changed. A dollar step is the
        # unit the person allocating a budget actually thinks in, and it is
        # comparable across channels - which is the whole basis of picking the
        # best marginal ROI.
        #
        # An older client sending the index-based `k` is not rejected; it is
        # ignored, and that request runs on the default dollar step.
        #
        # The floor matters: at a step of 0 every look-ahead would land on the
        # index it started from, the optimizer would find no move to make, and
        # it would stop at the first iteration reporting no allocation.
        dollar_step = float(payload.get("step_dollars", 0.0) or 0.0)
        if dollar_step <= 0:
            dollar_step = 1000.0

        if not merged_rc:
            raise HTTPException(status_code=400, detail="No response curves provided in merged_rc.")
        if not optimizer_dict:
            raise HTTPException(status_code=400, detail="No channel constraints or optimizer dictionary provided.")

        channels = list(optimizer_dict.keys())
        parsed_curves = {}

        # 1. Parse and validate response curves per channel
        for ch in channels:
            spend_key = f"{ch}_spend"
            impact_key = f"{ch}_impactable_nation"

            # Fallback if un-suffixed key used
            if spend_key not in merged_rc and ch in merged_rc:
                # Array of records shape
                records = merged_rc[ch]
                sp_arr = [r.get("spend", 0.0) for r in records]
                imp_arr = [r.get("impactable_nation", 0.0) for r in records]
            elif spend_key in merged_rc and impact_key in merged_rc:
                sp_arr = merged_rc[spend_key]
                imp_arr = merged_rc[impact_key]
            else:
                # Find matching channel prefix in merged_rc
                sp_key_match = next((k for k in merged_rc if k.startswith(ch) and k.endswith("_spend")), None)
                imp_key_match = next((k for k in merged_rc if k.startswith(ch) and k.endswith("_impactable_nation")), None)
                if sp_key_match and imp_key_match:
                    sp_arr = merged_rc[sp_key_match]
                    imp_arr = merged_rc[imp_key_match]
                else:
                    continue

            parsed_curves[ch] = {
                "spend": np.array(sp_arr, dtype=float),
                "impactable": np.array(imp_arr, dtype=float),
            }

        if not parsed_curves:
            raise HTTPException(status_code=400, detail="Could not resolve response curves for specified channels.")

        # 2. Initialize Starting Indices based on bounds and starting iteration (iter)
        current_idx = {}
        max_idx = {}
        active_channels = list(parsed_curves.keys())

        for ch in active_channels:
            curve = parsed_curves[ch]
            sp_arr = curve["spend"]
            n_points = len(sp_arr)
            cfg = optimizer_dict.get(ch, {})

            min_spend = float(cfg.get("min", 0.0))
            max_spend = float(cfg.get("max", 1e9))
            start_iter = max(1, int(cfg.get("iter", 1))) - 1

            # Find starting index satisfying min_spend and starting iteration
            idx_start = max(0, min(start_iter, n_points - 1))
            while idx_start < n_points - 1 and sp_arr[idx_start] < min_spend:
                idx_start += 1

            # Find max allowable index satisfying max_spend
            idx_max = n_points - 1
            while idx_max > 0 and sp_arr[idx_max] > max_spend:
                idx_max -= 1

            current_idx[ch] = idx_start
            max_idx[ch] = max(idx_start, idx_max)

        # 3. Discrete Greedy Marginal-ROI Hill-Climbing Algorithm
        max_iterations = 25000
        iteration = 0
        history = []

        def next_index(ch: str, idx_now: int) -> int:
            """The first index at least `dollar_step` of spend beyond idx_now.

            Walks forward rather than jumping, because the curve's own points
            are not evenly spaced in spend for every channel. Returns idx_now
            unchanged when the channel is already at its ceiling, which the
            caller reads as "this channel cannot take more".
            """
            sp = parsed_curves[ch]["spend"]
            limit = max_idx[ch]
            target_next_spend = sp[idx_now] + dollar_step
            idx_next = idx_now
            while idx_next < limit and sp[idx_next] < target_next_spend:
                idx_next += 1
            return idx_next

        def get_total_spend():
            return sum(parsed_curves[c]["spend"][current_idx[c]] for c in active_channels)

        def get_total_sales():
            return sum(parsed_curves[c]["impactable"][current_idx[c]] for c in active_channels)

        cur_spend = get_total_spend()
        cur_sales = get_total_sales()
        history.append({
            "step": 0,
            "value": round(cur_spend if is_budget_goal else cur_sales, 2),
            "spend": round(cur_spend, 2),
            "sales": round(cur_sales, 2),
        })

        converged = False

        while iteration < max_iterations:
            iteration += 1

            # Check stopping conditions
            if is_budget_goal:
                if cur_spend >= target:
                    converged = True
                    break
            else:
                if cur_sales >= target:
                    converged = True
                    break

            best_channel = None
            best_marginal_roi = -1e9
            # The index the winner will actually move to, kept from the same
            # look-ahead that scored it. Recomputing it after the choice would
            # risk applying a different move from the one evaluated.
            best_idx_next = None

            # Evaluate each channel over the same dollar increment
            for ch in active_channels:
                idx_now = current_idx[ch]
                idx_limit = max_idx[ch]
                if idx_now >= idx_limit:
                    continue

                idx_next = next_index(ch, idx_now)
                if idx_next == idx_now:
                    continue

                sp_now = parsed_curves[ch]["spend"][idx_now]
                sp_next = parsed_curves[ch]["spend"][idx_next]
                imp_now = parsed_curves[ch]["impactable"][idx_now]
                imp_next = parsed_curves[ch]["impactable"][idx_next]

                delta_spend = sp_next - sp_now
                delta_sales = imp_next - imp_now

                if delta_spend > 0:
                    marginal_roi = delta_sales / delta_spend
                else:
                    marginal_roi = delta_sales if delta_sales > 0 else 0.0

                if marginal_roi > best_marginal_roi:
                    best_marginal_roi = marginal_roi
                    best_channel = ch
                    best_idx_next = idx_next

            if best_channel is None or best_marginal_roi <= 0:
                # No channel can take more spend or marginal return is non-positive
                break

            # Advance the winner by one dollar step, to the index its own
            # look-ahead scored.
            current_idx[best_channel] = min(max_idx[best_channel], best_idx_next)
            cur_spend = get_total_spend()
            cur_sales = get_total_sales()

            if iteration % 5 == 0 or cur_spend >= target or cur_sales >= target:
                history.append({
                    "step": iteration,
                    "value": round(cur_spend if is_budget_goal else cur_sales, 2),
                    "spend": round(cur_spend, 2),
                    "sales": round(cur_sales, 2),
                })

        # Final check if target condition satisfied
        if is_budget_goal:
            if cur_spend >= (target - 1.0):
                converged = True
        else:
            if cur_sales >= (target - 0.5):
                converged = True

        # 4. Compile Final Channel Allocations
        final_allocation = {}
        for ch in active_channels:
            fin_idx = current_idx[ch]
            fin_spend = round(float(parsed_curves[ch]["spend"][fin_idx]), 2)
            fin_sales = round(float(parsed_curves[ch]["impactable"][fin_idx]), 2)
            fin_roi = round(fin_sales / fin_spend, 3) if fin_spend > 0 else 0.0

            # Calculate point marginal ROI
            if fin_idx > 0:
                prev_sp = float(parsed_curves[ch]["spend"][fin_idx - 1])
                prev_imp = float(parsed_curves[ch]["impactable"][fin_idx - 1])
                dsp = fin_spend - prev_sp
                fin_mroi = round((fin_sales - prev_imp) / dsp, 3) if dsp > 0 else fin_roi
            else:
                fin_mroi = fin_roi

            final_allocation[ch] = {
                "spend": fin_spend,
                "impactable_nation": fin_sales,
                "roi": fin_roi,
                "mroi": fin_mroi,
            }

        final_total_spend = round(get_total_spend(), 2)
        final_total_sales = round(get_total_sales(), 2)
        final_val = final_total_spend if is_budget_goal else final_total_sales

        return {
            "converged": bool(converged),
            "final_value": final_val,
            "total_spend": final_total_spend,
            "total_sales": final_total_sales,
            "allocation": final_allocation,
            "history": history[-40:],
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Optimization failed: {str(e)}")
