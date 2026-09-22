from fastapi import APIRouter, HTTPException
import pandas as pd
import numpy as np
from typing import Dict, Any, List

router = APIRouter()

# ─── Exact Industry Benchmark Reference Matrix ──────────────────────────────
DERMATOLOGY_BENCHMARK_MATRIX = {
    "Launch (<1 Year)": {
        "Low Competition": {
            "baseline_impact": "30–45%",
            "salesforce_impact": "25–35%",
            "hcp_pp_impact": "5–9%",
            "access_impact": "10–18%",
            "hcp_npp_impact": "4–9%",
            "consumer_npp_impact": "6–12%",
            "salesforce_roi": "1.0–2.5x",
            "hcp_pp_roi": "0.8–1.6x",
            "access_roi": "0.9–1.5x",
            "hcp_npp_roi": "1.5–3.0x",
            "consumer_npp_roi": "1.5–3.5x",
        },
        "Medium Competition": {
            "baseline_impact": "25–40%",
            "salesforce_impact": "22–32%",
            "hcp_pp_impact": "4–8%",
            "access_impact": "9–17%",
            "hcp_npp_impact": "3–8%",
            "consumer_npp_impact": "5–11%",
            "salesforce_roi": "0.7–2.2x",
            "hcp_pp_roi": "0.6–1.4x",
            "access_roi": "0.8–1.4x",
            "hcp_npp_roi": "1.2–2.7x",
            "consumer_npp_roi": "1.2–3.0x",
        },
        "High Competition": {
            "baseline_impact": "40–55%",
            "salesforce_impact": "22–30%",
            "hcp_pp_impact": "4–8%",
            "access_impact": "12–19%",
            "hcp_npp_impact": "5–10%",
            "consumer_npp_impact": "6–12%",
            "salesforce_roi": "2.5–3.8x",
            "hcp_pp_roi": "1.5–2.4x",
            "access_roi": "1.0–1.5x",
            "hcp_npp_roi": "3.2–5.0x",
            "consumer_npp_roi": "4.0–6.5x",
        },
    },
    "Growth (1–3 Years)": {
        "Low Competition": {
            "baseline_impact": "45–60%",
            "salesforce_impact": "25–33%",
            "hcp_pp_impact": "5–9%",
            "access_impact": "14–21%",
            "hcp_npp_impact": "6–11%",
            "consumer_npp_impact": "7–13%",
            "salesforce_roi": "3.0–4.3x",
            "hcp_pp_roi": "1.8–2.7x",
            "access_roi": "1.1–1.7x",
            "hcp_npp_roi": "4.0–5.8x",
            "consumer_npp_roi": "5.0–7.0x",
        },
        "Medium Competition": {
            "baseline_impact": "40–55%",
            "salesforce_impact": "22–30%",
            "hcp_pp_impact": "4–8%",
            "access_impact": "12–19%",
            "hcp_npp_impact": "5–10%",
            "consumer_npp_impact": "6–12%",
            "salesforce_roi": "2.5–3.8x",
            "hcp_pp_roi": "1.5–2.4x",
            "access_roi": "1.0–1.5x",
            "hcp_npp_roi": "3.2–5.0x",
            "consumer_npp_roi": "4.0–6.5x",
        },
        "High Competition": {
            "baseline_impact": "35–50%",
            "salesforce_impact": "20–27%",
            "hcp_pp_impact": "4–7%",
            "access_impact": "10–17%",
            "hcp_npp_impact": "4–9%",
            "consumer_npp_impact": "5–10%",
            "salesforce_roi": "2.0–3.3x",
            "hcp_pp_roi": "1.2–2.1x",
            "access_roi": "0.9–1.4x",
            "hcp_npp_roi": "2.8–4.5x",
            "consumer_npp_roi": "3.5–5.8x",
        },
    },
    "Maturity (3–7 Years)": {
        "Low Competition": {
            "baseline_impact": "60–75%",
            "salesforce_impact": "25–32%",
            "hcp_pp_impact": "6–10%",
            "access_impact": "16–23%",
            "hcp_npp_impact": "8–13%",
            "consumer_npp_impact": "9–15%",
            "salesforce_roi": "3.5–4.8x",
            "hcp_pp_roi": "2.0–3.0x",
            "access_roi": "1.2–1.8x",
            "hcp_npp_roi": "4.5–6.5x",
            "consumer_npp_roi": "5.5–7.8x",
        },
        "Medium Competition": {
            "baseline_impact": "55–70%",
            "salesforce_impact": "22–29%",
            "hcp_pp_impact": "5–9%",
            "access_impact": "14–21%",
            "hcp_npp_impact": "7–12%",
            "consumer_npp_impact": "8–14%",
            "salesforce_roi": "3.0–4.3x",
            "hcp_pp_roi": "1.8–2.7x",
            "access_roi": "1.0–1.6x",
            "hcp_npp_roi": "4.0–5.8x",
            "consumer_npp_roi": "5.0–7.2x",
        },
        "High Competition": {
            "baseline_impact": "50–65%",
            "salesforce_impact": "19–26%",
            "hcp_pp_impact": "4–8%",
            "access_impact": "12–19%",
            "hcp_npp_impact": "6–10%",
            "consumer_npp_impact": "7–12%",
            "salesforce_roi": "2.5–3.8x",
            "hcp_pp_roi": "1.5–2.4x",
            "access_roi": "0.9–1.5x",
            "hcp_npp_roi": "3.3–5.0x",
            "consumer_npp_roi": "4.0–6.2x",
        },
    },
    "Late Lifecycle (7+ Years)": {
        "Low Competition": {
            "baseline_impact": "75–90%",
            "salesforce_impact": "22–29%",
            "hcp_pp_impact": "5–8%",
            "access_impact": "14–20%",
            "hcp_npp_impact": "6–11%",
            "consumer_npp_impact": "7–12%",
            "salesforce_roi": "3.2–4.5x",
            "hcp_pp_roi": "1.8–2.6x",
            "access_roi": "1.0–1.6x",
            "hcp_npp_roi": "4.0–5.8x",
            "consumer_npp_roi": "5.0–7.0x",
        },
        "Medium Competition": {
            "baseline_impact": "70–85%",
            "salesforce_impact": "19–26%",
            "hcp_pp_impact": "4–7%",
            "access_impact": "12–18%",
            "hcp_npp_impact": "5–9%",
            "consumer_npp_impact": "6–11%",
            "salesforce_roi": "2.8–4.0x",
            "hcp_pp_roi": "1.5–2.3x",
            "access_roi": "0.9–1.5x",
            "hcp_npp_roi": "3.5–5.2x",
            "consumer_npp_roi": "4.5–6.5x",
        },
        "High Competition": {
            "baseline_impact": "60–80%",
            "salesforce_impact": "17–24%",
            "hcp_pp_impact": "3–7%",
            "access_impact": "10–17%",
            "hcp_npp_impact": "4–8%",
            "consumer_npp_impact": "5–10%",
            "salesforce_roi": "2.3–3.5x",
            "hcp_pp_roi": "1.2–2.0x",
            "access_roi": "0.8–1.3x",
            "hcp_npp_roi": "3.0–4.5x",
            "consumer_npp_roi": "3.8–5.8x",
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
        disease_area = payload.get("disease_area", "Dermatology (Specialty)")
        maturity = payload.get("maturity_stage", "Launch (<1 Year)")
        competition = payload.get("competition_level", "High Competition")
        channels = payload.get("channels", [])
        user_impact_shares = payload.get("user_impact_shares", {})

        maturity_key = maturity if maturity in DERMATOLOGY_BENCHMARK_MATRIX else "Launch (<1 Year)"
        comp_key = competition if competition in DERMATOLOGY_BENCHMARK_MATRIX[maturity_key] else "High Competition"
        bench_row = DERMATOLOGY_BENCHMARK_MATRIX[maturity_key][comp_key]

        def get_status(user_pct_val, bench_str):
            try:
                parts = bench_str.replace("%", "").split("–")
                lo, hi = float(parts[0]), float(parts[1])
                if user_pct_val >= lo and user_pct_val <= hi:
                    return "Within Benchmark"
                elif user_pct_val > hi:
                    return "Above Benchmark"
                else:
                    return "Below Benchmark"
            except Exception:
                return "Within Benchmark"

        impact_benchmarks = [
            {
                "category": "Baseline Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('baseline', 48.5)):.1f}%",
                "benchmark": bench_row["baseline_impact"],
                "status": get_status(float(user_impact_shares.get('baseline', 48.5)), bench_row["baseline_impact"])
            },
            {
                "category": "Salesforce Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('salesforce', 26.2)):.1f}%",
                "benchmark": bench_row["salesforce_impact"],
                "status": get_status(float(user_impact_shares.get('salesforce', 26.2)), bench_row["salesforce_impact"])
            },
            {
                "category": "HCP PP (Personal Promo) Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('hcp_pp', 6.4)):.1f}%",
                "benchmark": bench_row["hcp_pp_impact"],
                "status": get_status(float(user_impact_shares.get('hcp_pp', 6.4)), bench_row["hcp_pp_impact"])
            },
            {
                "category": "Access Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('access', 14.1)):.1f}%",
                "benchmark": bench_row["access_impact"],
                "status": get_status(float(user_impact_shares.get('access', 14.1)), bench_row["access_impact"])
            },
            {
                "category": "HCP NPP (Non-Personal Promo) Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('hcp_npp', 7.5)):.1f}%",
                "benchmark": bench_row["hcp_npp_impact"],
                "status": get_status(float(user_impact_shares.get('hcp_npp', 7.5)), bench_row["hcp_npp_impact"])
            },
            {
                "category": "Consumer NPP / DTC Impact %",
                "your_impact_pct": f"{float(user_impact_shares.get('consumer_npp', 8.3)):.1f}%",
                "benchmark": bench_row["consumer_npp_impact"],
                "status": get_status(float(user_impact_shares.get('consumer_npp', 8.3)), bench_row["consumer_npp_impact"])
            },
        ]

        channel_benchmarks = []
        for ch in channels:
            ch_name = ch.get("channel", "")
            user_roi = float(ch.get("roi", 2.0))
            l = ch_name.lower()

            if "call" in l or "rep" in l or "detail" in l:
                bench_roi_str = bench_row["salesforce_roi"]
                category_label = "Personal Promotion"
            elif "samp" in l or "speaker" in l or "spk" in l or "event" in l:
                bench_roi_str = bench_row["hcp_pp_roi"]
                category_label = "Personal Promotion"
            elif "access" in l or "copay" in l or "voucher" in l:
                bench_roi_str = bench_row["access_roi"]
                category_label = "Access / Co-Pay"
            elif "rte" in l or "email" in l or "portal" in l or "web" in l or "npp" in l:
                bench_roi_str = bench_row["hcp_npp_roi"]
                category_label = "Non-Personal Promotion"
            else:
                bench_roi_str = bench_row["consumer_npp_roi"]
                category_label = "DTC Promotion"

            try:
                parts = bench_roi_str.replace("x", "").split("–")
                min_roi = float(parts[0])
                max_roi = float(parts[1]) if len(parts) > 1 else min_roi
            except Exception:
                min_roi, max_roi = 1.0, 3.0

            if user_roi >= min_roi:
                status = "Within/Above Benchmark"
            elif user_roi >= (min_roi * 0.75):
                status = "Near Benchmark"
            else:
                status = "Below Benchmark"

            channel_benchmarks.append({
                "channel": ch_name,
                "category": category_label,
                "yours": f"{user_roi:.2f}x",
                "benchmark": bench_roi_str,
                "status": status,
            })

        return {
            "benchmark_group": f"Disease Area: {disease_area} • Maturity: {maturity_key} • Competition: {comp_key}",
            "impact_benchmarks": impact_benchmarks,
            "channel_benchmarks": channel_benchmarks,
            "raw_benchmark_row": bench_row,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Benchmark calculation failed: {str(e)}")