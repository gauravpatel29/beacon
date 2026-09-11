import io
import json
import numpy as np
import pandas as pd
from typing import Optional, List
from fastapi import APIRouter, HTTPException
from core.processing import (
    compute_eda_stats,
    compute_sparsity_stats,
    compute_poor_mans_curve_data,
    detect_outliers_engine,
    remove_outliers_engine,
    compute_trend_rollup,
    compute_cross_correlation_lags,
)

router = APIRouter()


def _parse_csv(csv_data: str) -> pd.DataFrame:
    """UTF-8 first, then latin-1.

    Encoding a string as latin-1 raises on any character outside that range, so
    a file carrying a non-Latin-1 name or value failed outright rather than
    falling back.
    """
    try:
        return pd.read_csv(io.StringIO(csv_data), low_memory=False)
    except Exception:
        try:
            return pd.read_csv(io.BytesIO(csv_data.encode("utf-8")), low_memory=False)
        except Exception:
            return pd.read_csv(
                io.BytesIO(csv_data.encode("latin-1", errors="replace")), low_memory=False
            )


@router.post("/stats")
async def eda_stats_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        date_col = payload["date_column"]
        geo_col = payload["geo_column"]
        dep_var = payload["dependent_variable"]
        return compute_eda_stats(df, date_col, geo_col, dep_var)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/histogram")
async def eda_histogram_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        col = payload["column"]
        vals = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(vals) == 0:
            return {"counts": [], "bin_edges": [], "bin_labels": [], "mean": 0, "median": 0, "min": 0, "max": 0, "column": col}

        min_val = float(vals.min())
        max_val = float(vals.max())
        is_integer = (vals % 1 == 0).all()
        val_range = max_val - min_val

        if is_integer and 0 < val_range <= 25:
            bin_edges = np.arange(min_val, max_val + 2) - 0.5
            counts, _ = np.histogram(vals, bins=bin_edges)
            bin_labels = [str(int(x)) for x in np.arange(min_val, max_val + 1)]
        else:
            num_bins = min(25, max(5, int(len(vals) ** 0.5)))
            counts, bin_edges = np.histogram(vals, bins=num_bins)
            bin_labels = [f"{bin_edges[i]:.1f} - {bin_edges[i+1]:.1f}" for i in range(len(counts))]

        return {
            "counts": counts.tolist(),
            "bin_labels": bin_labels,
            "bin_edges": bin_edges.tolist(),
            "mean": float(vals.mean()),
            "median": float(vals.median()),
            "min": min_val,
            "max": max_val,
            "column": col,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/scatter")
async def eda_scatter_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        x_col, y_col = payload["x_column"], payload["y_column"]
        sub = df[[x_col, y_col]].dropna().copy()
        sub[x_col] = pd.to_numeric(sub[x_col], errors="coerce")
        sub[y_col] = pd.to_numeric(sub[y_col], errors="coerce")
        sub = sub.dropna()

        if len(sub) < 2:
            return {"x": [], "y": [], "r": 0, "trendline": [], "x_column": x_col, "y_column": y_col, "slope": 0, "intercept": 0}

        r_val = float(sub[x_col].corr(sub[y_col]))
        x_vals = sub[x_col].values
        y_vals = sub[y_col].values
        m, c = np.polyfit(x_vals, y_vals, 1)

        trendline = [
            {"x": float(np.min(x_vals)), "y": float(m * np.min(x_vals) + c)},
            {"x": float(np.max(x_vals)), "y": float(m * np.max(x_vals) + c)},
        ]

        if len(sub) > 600:
            sub = sub.sample(600, random_state=42).sort_values(x_col)

        return {
            "x": sub[x_col].tolist(),
            "y": sub[y_col].tolist(),
            "r": round(r_val, 4) if not np.isnan(r_val) else 0.0,
            "slope": float(m),
            "intercept": float(c),
            "trendline": trendline,
            "x_column": x_col,
            "y_column": y_col,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/sparsity")
async def eda_sparsity_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        metrics = payload.get("metric_columns")
        return {"sparsity_table": compute_sparsity_stats(df, metrics)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/poor-mans-curve")
async def poor_mans_curve_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        x_col = payload["x_column"]
        y_col = payload["y_column"]
        n_bins = int(payload.get("n_bins", 12))
        return compute_poor_mans_curve_data(df, x_col, y_col, n_bins)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/detect-outliers")
async def detect_outliers_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        col = payload["column"]
        method = payload.get("method", "iqr")
        threshold = float(payload.get("threshold", 1.5))
        return detect_outliers_engine(df, col, method, threshold)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remove-outliers")
async def remove_outliers_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        col = payload["column"]
        method = payload.get("method", "iqr")
        threshold = float(payload.get("threshold", 1.5))
        return remove_outliers_engine(df, col, method, threshold)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/trend-rollup")
async def trend_rollup_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        date_col = payload["date_column"]
        metrics = payload.get("metric_columns", [])
        period = payload.get("period", "week")
        return {"trend_data": compute_trend_rollup(df, date_col, metrics, period)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/lag-correlation")
async def lag_correlation_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        date_col = payload["date_column"]
        x_col = payload["x_column"]
        y_col = payload["y_column"]
        lags = int(payload.get("max_lags", 6))
        return {"lag_results": compute_cross_correlation_lags(df, date_col, x_col, y_col, lags)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))