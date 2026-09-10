import io
import json
import pandas as pd
import polars as pl
import numpy as np
from fastapi import APIRouter, HTTPException
from core.processing import compute_eda_stats

router = APIRouter()


def _parse_csv_to_polars(content: bytes) -> pl.DataFrame:
    try:
        return pl.read_csv(io.BytesIO(content), infer_schema_length=10000, ignore_errors=True)
    except Exception:
        pdf = pd.read_csv(io.BytesIO(content), encoding="latin-1", on_bad_lines="skip")
        return pl.from_pandas(pdf)


@router.post("/stats")
async def eda_stats_route(payload: dict):
    """
    Computes full comprehensive stats (summary table with 75th/95th, multi-series trends, geo breakdown).
    payload: { csv_data, date_column, geo_column, dependent_variable }
    """
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        date_col = payload["date_column"]
        geo_col = payload["geo_column"]
        dep_var = payload["dependent_variable"]

        result = compute_eda_stats(df, date_col, geo_col, dep_var)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/histogram")
async def histogram_route(payload: dict):
    """Return histogram bins, counts, mean and median for a column with smart integer binning."""
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1"))
        col = payload["column"]
        if col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Column '{col}' not found")

        vals = pd.to_numeric(df.get_column(col).to_pandas(), errors="coerce").dropna()
        if len(vals) == 0:
            return {"counts": [], "bin_edges": [], "bin_labels": [], "mean": 0, "median": 0, "column": col}

        min_val = float(vals.min())
        max_val = float(vals.max())
        is_integer = (vals % 1 == 0).all()
        val_range = max_val - min_val

        # If discrete whole numbers with small span, use exact integer bins
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
async def scatter_route(payload: dict):
    """Return x/y data and Pearson r with two-point linear regression trendline."""
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1"))
        x_col, y_col = payload["x_column"], payload["y_column"]

        if x_col not in df.columns or y_col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Columns '{x_col}' or '{y_col}' not found")

        sub = df.select([pl.col(x_col), pl.col(y_col)]).to_pandas().dropna().copy()
        sub[x_col] = pd.to_numeric(sub[x_col], errors="coerce")
        sub[y_col] = pd.to_numeric(sub[y_col], errors="coerce")
        sub = sub.dropna()

        if len(sub) < 2:
            return {"x": [], "y": [], "r": 0, "trendline": [], "x_column": x_col, "y_column": y_col, "slope": 0, "intercept": 0}

        r_val = float(sub[x_col].corr(sub[y_col]))

        # Best-fit linear trendline y = mx + c
        x_vals = sub[x_col].values
        y_vals = sub[y_col].values
        m, c = np.polyfit(x_vals, y_vals, 1)

        min_x = float(np.min(x_vals))
        max_x = float(np.max(x_vals))
        trendline = [
            {"x": min_x, "y": float(m * min_x + c)},
            {"x": max_x, "y": float(m * max_x + c)},
        ]

        # Sample for responsive rendering
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