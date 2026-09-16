from fastapi import APIRouter, HTTPException
import pandas as pd
import numpy as np
from typing import Dict, Any, List

router = APIRouter()

# ─── Reference Industry Benchmarks Knowledge Base ────────────────────────────
BENCHMARK_DATABASE = {
    "Chronic": {
        "Launch (<1 Year)": {
            "High Competition": {"promo_share": 42.0, "baseline_share": 38.0, "portfolio_roi": 1.90, "base_multiplier": 0.80},
            "Medium Competition": {"promo_share": 38.0, "baseline_share": 42.0, "portfolio_roi": 2.20, "base_multiplier": 0.90},
            "Low / Niche Competition": {"promo_share": 32.0, "baseline_share": 48.0, "portfolio_roi": 2.60, "base_multiplier": 1.10},
        },
        "Growth (1–3 Years)": {
            "High Competition": {"promo_share": 36.0, "baseline_share": 44.0, "portfolio_roi": 2.40, "base_multiplier": 0.95},
            "Medium Competition": {"promo_share": 31.0, "baseline_share": 49.0, "portfolio_roi": 2.80, "base_multiplier": 1.05},
            "Low / Niche Competition": {"promo_share": 25.0, "baseline_share": 55.0, "portfolio_roi": 3.20, "base_multiplier": 1.25},
        },
        "Mature (3–7 Years)": {
            "High Competition": {"promo_share": 26.0, "baseline_share": 54.0, "portfolio_roi": 2.10, "base_multiplier": 0.85},
            "Medium Competition": {"promo_share": 20.0, "baseline_share": 60.0, "portfolio_roi": 2.40, "base_multiplier": 0.95},
            "Low / Niche Competition": {"promo_share": 15.0, "baseline_share": 65.0, "portfolio_roi": 2.90, "base_multiplier": 1.15},
        },
        "Late Lifecycle (7+ Years)": {
            "High Competition": {"promo_share": 15.0, "baseline_share": 65.0, "portfolio_roi": 1.40, "base_multiplier": 0.70},
            "Medium Competition": {"promo_share": 12.0, "baseline_share": 68.0, "portfolio_roi": 1.70, "base_multiplier": 0.80},
            "Low / Niche Competition": {"promo_share": 10.0, "baseline_share": 70.0, "portfolio_roi": 2.00, "base_multiplier": 0.95},
        },
    },
    "Acute": {
        "Launch (<1 Year)": {
            "High Competition": {"promo_share": 48.0, "baseline_share": 32.0, "portfolio_roi": 2.10, "base_multiplier": 0.85},
            "Medium Competition": {"promo_share": 44.0, "baseline_share": 36.0, "portfolio_roi": 2.50, "base_multiplier": 0.95},
            "Low / Niche Competition": {"promo_share": 38.0, "baseline_share": 42.0, "portfolio_roi": 3.00, "base_multiplier": 1.15},
        },
        "Growth (1–3 Years)": {
            "High Competition": {"promo_share": 39.0, "baseline_share": 41.0, "portfolio_roi": 2.70, "base_multiplier": 1.00},
            "Medium Competition": {"promo_share": 34.0, "baseline_share": 46.0, "portfolio_roi": 3.10, "base_multiplier": 1.10},
            "Low / Niche Competition": {"promo_share": 28.0, "baseline_share": 52.0, "portfolio_roi": 3.60, "base_multiplier": 1.30},
        },
        "Mature (3–7 Years)": {
            "High Competition": {"promo_share": 28.0, "baseline_share": 52.0, "portfolio_roi": 2.30, "base_multiplier": 0.90},
            "Medium Competition": {"promo_share": 22.0, "baseline_share": 58.0, "portfolio_roi": 2.70, "base_multiplier": 1.00},
            "Low / Niche Competition": {"promo_share": 16.0, "baseline_share": 64.0, "portfolio_roi": 3.20, "base_multiplier": 1.20},
        },
        "Late Lifecycle (7+ Years)": {
            "High Competition": {"promo_share": 16.0, "baseline_share": 64.0, "portfolio_roi": 1.50, "base_multiplier": 0.75},
            "Medium Competition": {"promo_share": 13.0, "baseline_share": 67.0, "portfolio_roi": 1.80, "base_multiplier": 0.85},
            "Low / Niche Competition": {"promo_share": 10.0, "baseline_share": 70.0, "portfolio_roi": 2.20, "base_multiplier": 1.00},
        },
    },
    "Rare / Specialty": {
        "Launch (<1 Year)": {
            "High Competition": {"promo_share": 35.0, "baseline_share": 45.0, "portfolio_roi": 2.80, "base_multiplier": 1.05},
            "Medium Competition": {"promo_share": 30.0, "baseline_share": 50.0, "portfolio_roi": 3.40, "base_multiplier": 1.20},
            "Low / Niche Competition": {"promo_share": 24.0, "baseline_share": 56.0, "portfolio_roi": 4.10, "base_multiplier": 1.45},
        },
        "Growth (1–3 Years)": {
            "High Competition": {"promo_share": 28.0, "baseline_share": 52.0, "portfolio_roi": 3.50, "base_multiplier": 1.20},
            "Medium Competition": {"promo_share": 23.0, "baseline_share": 57.0, "portfolio_roi": 4.20, "base_multiplier": 1.40},
            "Low / Niche Competition": {"promo_share": 18.0, "baseline_share": 62.0, "portfolio_roi": 5.00, "base_multiplier": 1.65},
        },
        "Mature (3–7 Years)": {
            "High Competition": {"promo_share": 20.0, "baseline_share": 60.0, "portfolio_roi": 2.90, "base_multiplier": 1.05},
            "Medium Competition": {"promo_share": 16.0, "baseline_share": 64.0, "portfolio_roi": 3.60, "base_multiplier": 1.25},
            "Low / Niche Competition": {"promo_share": 12.0, "baseline_share": 68.0, "portfolio_roi": 4.30, "base_multiplier": 1.45},
        },
        "Late Lifecycle (7+ Years)": {
            "High Competition": {"promo_share": 12.0, "baseline_share": 68.0, "portfolio_roi": 2.00, "base_multiplier": 0.85},
            "Medium Competition": {"promo_share": 10.0, "baseline_share": 70.0, "portfolio_roi": 2.50, "base_multiplier": 0.95},
            "Low / Niche Competition": {"promo_share": 8.0, "baseline_share": 72.0, "portfolio_roi": 3.00, "base_multiplier": 1.10},
        },
    },
    "Oncology / Recurring": {
        "Launch (<1 Year)": {
            "High Competition": {"promo_share": 40.0, "baseline_share": 40.0, "portfolio_roi": 2.50, "base_multiplier": 0.95},
            "Medium Competition": {"promo_share": 34.0, "baseline_share": 46.0, "portfolio_roi": 3.10, "base_multiplier": 1.10},
            "Low / Niche Competition": {"promo_share": 27.0, "baseline_share": 53.0, "portfolio_roi": 3.80, "base_multiplier": 1.35},
        },
        "Growth (1–3 Years)": {
            "High Competition": {"promo_share": 32.0, "baseline_share": 48.0, "portfolio_roi": 3.20, "base_multiplier": 1.15},
            "Medium Competition": {"promo_share": 26.0, "baseline_share": 54.0, "portfolio_roi": 3.80, "base_multiplier": 1.30},
            "Low / Niche Competition": {"promo_share": 20.0, "baseline_share": 60.0, "portfolio_roi": 4.60, "base_multiplier": 1.55},
        },
        "Mature (3–7 Years)": {
            "High Competition": {"promo_share": 22.0, "baseline_share": 58.0, "portfolio_roi": 2.60, "base_multiplier": 0.95},
            "Medium Competition": {"promo_share": 18.0, "baseline_share": 62.0, "portfolio_roi": 3.20, "base_multiplier": 1.15},
            "Low / Niche Competition": {"promo_share": 13.0, "baseline_share": 67.0, "portfolio_roi": 3.90, "base_multiplier": 1.35},
        },
        "Late Lifecycle (7+ Years)": {
            "High Competition": {"promo_share": 14.0, "baseline_share": 66.0, "portfolio_roi": 1.80, "base_multiplier": 0.80},
            "Medium Competition": {"promo_share": 11.0, "baseline_share": 69.0, "portfolio_roi": 2.20, "base_multiplier": 0.90},
            "Low / Niche Competition": {"promo_share": 9.0, "baseline_share": 71.0, "portfolio_roi": 2.70, "base_multiplier": 1.05},
        },
    },
}


@router.post("/summary")
async def results_summary(payload: dict):
    try:
        iterations = payload.get("iterations", [])
        return {"iterations": iterations, "count": len(iterations)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/benchmarks")
async def benchmark_comparison(payload: dict):
    try:
        therapy = payload.get("therapy_type", "Chronic")
        maturity = payload.get("maturity_stage", "Growth (1–3 Years)")
        competition = payload.get("competition_level", "High Competition")
        channels = payload.get("channels", [])

        # Query benchmark matrix
        therapy_data = BENCHMARK_DATABASE.get(therapy, BENCHMARK_DATABASE["Chronic"])
        maturity_data = therapy_data.get(maturity, therapy_data["Growth (1–3 Years)"])
        benchmark_spec = maturity_data.get(competition, maturity_data["High Competition"])

        bench_promo_pct = benchmark_spec["promo_share"]
        bench_base_pct = benchmark_spec["baseline_share"]
        bench_roi = benchmark_spec["portfolio_roi"]
        multiplier = benchmark_spec["base_multiplier"]

        # Channel specific benchmarks
        channel_benchmarks = []
        for ch in channels:
            ch_name = ch.get("channel", "")
            user_roi = float(ch.get("roi", 2.0))
            
            # Archetype baseline heuristic
            l = ch_name.lower()
            if "call" in l or "rep" in l:
                base_ref = 2.40
            elif "samp" in l:
                base_ref = 1.60
            elif "rte" in l or "email" in l:
                base_ref = 3.20
            elif "speaker" in l:
                base_ref = 2.80
            elif "tv" in l or "dtc" in l:
                base_ref = 1.80
            elif "dig" in l or "search" in l:
                base_ref = 2.50
            else:
                base_ref = 2.10

            bench_ch_roi = round(base_ref * multiplier, 2)
            delta = user_roi - bench_ch_roi

            if delta >= 0.2:
                status = "🟢 Above Benchmark"
            elif delta >= -0.2:
                status = "🟡 Near Benchmark"
            else:
                status = "🔴 Below Benchmark"

            channel_benchmarks.append({
                "channel": ch_name,
                "yours": f"{user_roi:.2f}x",
                "benchmark": f"{bench_ch_roi:.2f}x",
                "status": status,
            })

        overall_comparison = [
            {"metric": "Promotional Lift Share (%)", "yours": "Calculated from Model", "benchmark": f"{bench_promo_pct:.1f}%", "status": "Benchmarked"},
            {"metric": "Baseline Organic Share (%)", "yours": "Calculated from Model", "benchmark": f"{bench_base_pct:.1f}%", "status": "Benchmarked"},
            {"metric": "Average Portfolio ROI", "yours": "Calculated from Model", "benchmark": f"{bench_roi:.2f}x", "status": "Benchmarked"},
        ]

        return {
            "benchmark_group": f"{therapy} • {maturity} • {competition}",
            "overall_comparison": overall_comparison,
            "channel_benchmarks": channel_benchmarks,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Benchmark query failed: {str(e)}")