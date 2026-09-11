"""Data Review (EDA) - LEGACY csv_data route.

Kept for the pre-v2 screens that still post a CSV string. New work should use
`routers/v2_review.py`, which resolves a dataset by filename from storage: the
browser never holds the file, and the date format comes from the manifest
instead of being guessed.

Correlation is deliberately not part of this module.
"""

import io

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from core.processing import (
    compute_eda_stats,
    compute_poor_mans_curve_data,
    compute_sparsity_stats,
    compute_trend_rollup,
    detect_outliers_engine,
    remove_outliers_engine,
)
from core.review import histogram_of, scatter_of

router = APIRouter()


def _parse_csv(csv_data: str) -> pd.DataFrame:
    """UTF-8 first, then latin-1.

    The upstream version reversed this. Encoding a string as latin-1 raises on
    any character outside that range, so a file with a non-Latin-1 name or value
    failed outright rather than falling back.
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
    """Summary table (with control totals), multi-series trends, geo breakdown.

    payload: { csv_data, date_column, geo_column, dependent_variable }
    """
    try:
        df = _parse_csv(payload["csv_data"])
        return compute_eda_stats(
            df, payload["date_column"], payload["geo_column"], payload["dependent_variable"]
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/histogram")
async def eda_histogram_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        col = payload["column"]
        if col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Column '{col}' not found")
        return histogram_of(df, col)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/scatter")
async def eda_scatter_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return scatter_of(df, payload["x_column"], payload["y_column"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/sparsity")
async def eda_sparsity_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return {"sparsity_table": compute_sparsity_stats(df, payload.get("metric_columns"))}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/poor-mans-curve")
async def poor_mans_curve_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return compute_poor_mans_curve_data(
            df, payload["x_column"], payload["y_column"], int(payload.get("n_bins", 12))
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/detect-outliers")
async def detect_outliers_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return detect_outliers_engine(
            df, payload["column"], payload.get("method", "iqr"),
            float(payload.get("threshold", 1.5)),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remove-outliers")
async def remove_outliers_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return remove_outliers_engine(
            df, payload["column"], payload.get("method", "iqr"),
            float(payload.get("threshold", 1.5)),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/trend-rollup")
async def trend_rollup_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        return {
            "trend_data": compute_trend_rollup(
                df, payload["date_column"], payload.get("metric_columns", []),
                payload.get("period", "week"),
                # This route has no manifest, so there is no stated format to
                # pass. v2_review does, and passes it.
                date_format=payload.get("date_format"),
            )
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
