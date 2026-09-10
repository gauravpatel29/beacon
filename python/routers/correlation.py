import io
import json
import pandas as pd
import polars as pl
import numpy as np
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
import statsmodels.api as sm
from core.processing import (
    compute_correlation_matrix,
    run_pca,
    get_candidate_features,
    compute_corr_pairs,
    preview_removal_reasons,
    remove_correlated_features,
    find_corr_clusters,
    preview_combination_details,
    combine_clusters,
    apply_weighted_sum_columns,
    apply_pca_treatment,
)

router = APIRouter()


def _parse_csv_to_df(content: str) -> pd.DataFrame:
    try:
        return pd.read_csv(io.StringIO(content), low_memory=False)
    except Exception:
        return pd.read_csv(io.BytesIO(content.encode("latin-1")), low_memory=False)


def _csv_response(df: pd.DataFrame) -> dict:
    preview = json.loads(df.head(50).to_json(orient="records", date_format="iso"))
    return {
        "preview": preview,
        "columns": df.columns.tolist(),
        "rows": len(df),
        "csv_data": df.to_csv(index=False),
    }


@router.post("/matrix")
async def correlation_matrix(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()
        matrix = compute_correlation_matrix(df, cols, method=payload.get("method", "pearson"))
        return {"matrix": matrix, "columns": cols}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/pca")
async def pca_analysis(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()
        result = run_pca(df, cols, n_components=payload.get("n_components", 2))
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vif")
async def compute_vif(payload: dict):
    """
    Computes VIF using OLS R^2 (VIF = 1 / (1 - R^2)).
    Numerically stable against singular matrices and perfect collinearity.
    """
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        raw_cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()

        # Filter strictly numeric columns with positive variance
        valid_cols = []
        for c in raw_cols:
            if c in df.columns:
                s = pd.to_numeric(df[c], errors="coerce").dropna()
                if len(s) > 5 and s.std() > 0:
                    valid_cols.append(c)

        if len(valid_cols) < 2:
            return {"vif": [{"variable": c, "VIF": 1.0, "status": "✅ OK (<5)"} for c in raw_cols if c in df.columns]}

        sub = df[valid_cols].apply(pd.to_numeric, errors="coerce").fillna(0)

        vif_data = []
        for col in valid_cols:
            y = sub[col]
            X_other = sub.drop(columns=[col])
            try:
                X_with_const = sm.add_constant(X_other)
                model = sm.OLS(y, X_with_const).fit()
                r2 = float(model.rsquared)
                if r2 >= 0.9999:
                    vif_val = 999.99
                else:
                    vif_val = round(float(1.0 / (1.0 - r2)), 2)
            except Exception:
                vif_val = 1.0

            status_str = "🔴 High (>10)" if vif_val > 10 else ("⚠️ Moderate (5-10)" if vif_val > 5 else "✅ OK (<5)")
            vif_data.append({
                "variable": col,
                "VIF": vif_val,
                "status": status_str,
            })

        return {"vif": vif_data}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=f"VIF computation error: {str(e)}")


@router.post("/candidate-features")
async def candidate_features(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        feature_cols, non_feature_cols = get_candidate_features(
            df,
            payload.get("geo_column"),
            payload.get("date_column"),
            payload.get("zip_column"),
            payload.get("dma_column"),
            payload.get("dependent_variable"),
        )
        return {"feature_cols": feature_cols, "non_feature_cols": non_feature_cols}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/high-pairs")
async def high_pairs(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.7))
        pairs, _ = compute_corr_pairs(df, cols, threshold)
        return {"pairs": [{"feature1": p[0], "feature2": p[1], "corr": round(p[2], 4)} for p in pairs]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/preview-removal")
async def preview_removal_route(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        feature_cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.75))
        dep = payload.get("dependent_variable")
        preview = preview_removal_reasons(df, feature_cols, dep, threshold)
        return preview
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/apply-removal")
async def apply_removal(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        feature_cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.75))
        dep = payload.get("dependent_variable")
        df_reduced, kept, dropped = remove_correlated_features(df, feature_cols, dep, threshold)
        result = _csv_response(df_reduced)
        result.update({"kept": kept, "dropped": dropped})
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/find-clusters")
async def find_clusters_route(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.75))
        clusters = find_corr_clusters(df, cols, threshold)
        return {"clusters": clusters}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/preview-combination")
async def preview_combination_route(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        clusters = payload["clusters"]
        new_names = payload["new_names"]
        method = payload.get("method", "sum").lower().replace(" ", "_")
        weights = payload.get("weights_per_cluster")
        preview = preview_combination_details(df, clusters, new_names, method, weights)
        return preview
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/apply-combination")
async def apply_combination(payload: dict):
    try:
        df = _parse_csv_to_df(payload["csv_data"])
        feature_cols = payload["columns"]
        clusters = payload["clusters"]
        new_names = payload["new_names"]
        method = payload.get("method", "sum").lower().replace(" ", "_")
        drop_original = payload.get("drop_original", True)
        weights_per_cluster = payload.get("weights_per_cluster")

        df_combined, combos_info = combine_clusters(
            df, feature_cols, clusters, new_names, method, drop_original, weights_per_cluster
        )
        result = _csv_response(df_combined)
        result["combination_info"] = combos_info.to_dict(orient="records")
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))