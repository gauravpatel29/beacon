from fastapi import APIRouter, HTTPException
import pandas as pd
import numpy as np

router = APIRouter()


def calc_rc_kpi(merged_rc: dict, optimizer_dict: dict, kpi: str, k: int) -> float:
    total = 0.0
    for channel, info in optimizer_dict.items():
        iterator = info["iter"] - k
        if iterator >= 0:
            key = f"{channel}_{kpi}"
            if key in merged_rc and iterator < len(merged_rc[key]):
                total += merged_rc[key][iterator]
    return total


def total_iter(optimizer_dict: dict) -> int:
    return sum(info["iter"] for info in optimizer_dict.values()) - 11


@router.post("/run")
async def run_optimization(payload: dict):
    """
    Run budget/sales optimizer across response curves.
    payload: {
        merged_rc: { channel_spend: [...], channel_impactable_nation: [...], ... },
        optimizer_dict: { channel: { iter, min, max, step } },
        target: float,
        opt_type: 'Budget Goal' | 'Sales Goal',
        k: int
    }
    """
    try:
        merged_rc = payload["merged_rc"]
        optimizer_dict = {ch: dict(info) for ch, info in payload["optimizer_dict"].items()}
        target = float(payload["target"])
        opt_type = payload["opt_type"]
        k = payload.get("k", 1)

        criteria = "spend" if opt_type == "Budget Goal" else "impactable_nation"

        # Ensure min criteria
        for channel, info in optimizer_dict.items():
            iterator = info["iter"]
            spend_key = f"{channel}_spend"
            while spend_key in merged_rc and iterator < len(merged_rc[spend_key]) and merged_rc[spend_key][iterator] <= info["min"]:
                optimizer_dict[channel]["iter"] += k
                iterator = optimizer_dict[channel]["iter"]

        current_val = calc_rc_kpi(merged_rc, optimizer_dict, criteria, k)
        history = [{"step": 0, "value": current_val, "iters": {ch: info["iter"] for ch, info in optimizer_dict.items()}}]

        max_steps = 10000
        step_count = 0
        while current_val < target and step_count < max_steps:
            step_count += 1
            best_channel = None
            best_delta = -1
            for channel, info in optimizer_dict.items():
                iterator = info["iter"]
                kpi_key = f"{channel}_{criteria}"
                if kpi_key not in merged_rc:
                    continue
                cur = merged_rc[kpi_key][max(0, iterator - k)] if iterator - k >= 0 else 0
                nxt = merged_rc[kpi_key][iterator] if iterator < len(merged_rc[kpi_key]) else cur
                max_key = f"{channel}_spend"
                if max_key in merged_rc and iterator < len(merged_rc[max_key]) and merged_rc[max_key][iterator] >= info.get("max", float("inf")):
                    continue
                delta = nxt - cur
                if delta > best_delta:
                    best_delta = delta
                    best_channel = channel

            if best_channel is None:
                break
            optimizer_dict[best_channel]["iter"] += k
            current_val = calc_rc_kpi(merged_rc, optimizer_dict, criteria, k)
            history.append({"step": step_count, "value": current_val,
                            "iters": {ch: info["iter"] for ch, info in optimizer_dict.items()}})

        final_allocation = {}
        for channel, info in optimizer_dict.items():
            spend_key = f"{channel}_spend"
            kpi_key = f"{channel}_impactable_nation"
            idx = min(info["iter"], len(merged_rc.get(spend_key, [0])) - 1)
            final_allocation[channel] = {
                "spend": merged_rc[spend_key][idx] if spend_key in merged_rc else 0,
                "impactable_nation": merged_rc[kpi_key][idx] if kpi_key in merged_rc else 0,
            }

        return {
            "converged": current_val >= target,
            "final_value": current_val,
            "allocation": final_allocation,
            "history": history[-50:],  # last 50 steps
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
