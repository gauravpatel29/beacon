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
        k_step = max(1, int(payload.get("k", 1)))
        is_budget_goal = opt_type in ("Budget Goal", "Fixed Budget")

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

            # Evaluate each channel by looking ahead k index steps
            for ch in active_channels:
                idx_now = current_idx[ch]
                idx_limit = max_idx[ch]
                if idx_now >= idx_limit:
                    continue

                idx_next = min(idx_limit, idx_now + k_step)
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

            if best_channel is None or best_marginal_roi <= 0:
                # No channel can take more spend or marginal return is non-positive
                break

            # Advance best channel by k steps
            current_idx[best_channel] = min(max_idx[best_channel], current_idx[best_channel] + k_step)
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
