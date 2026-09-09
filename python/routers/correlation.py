import io
import json
import pandas as pd
import polars as pl
import numpy as np
from fastapi import APIRouter, HTTPException
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


def _parse_csv_to_polars(content: bytes) -> pl.DataFrame:
    try:
        return pl.read_csv(io.BytesIO(content), infer_schema_length=10000, ignore_errors=True)
    except Exception:
        pdf = pd.read_csv(io.BytesIO(content), encoding="latin-1", on_bad_lines="skip")
        return pl.from_pandas(pdf)


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
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()
        matrix = compute_correlation_matrix(df, cols, method=payload.get("method", "pearson"))
        return {"matrix": matrix, "columns": cols}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/pca")
async def pca_analysis(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()
        result = run_pca(df, cols, n_components=payload.get("n_components", 2))
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vif")
async def compute_vif(payload: dict):
    try:
        from statsmodels.stats.outliers_influence import variance_inflation_factor
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        cols = payload.get("columns") or df.select_dtypes(include="number").columns.tolist()
        sub = df[cols].dropna()
        vif_data = []
        for i, col in enumerate(cols):
            try:
                vif = variance_inflation_factor(sub.values, i)
            except Exception:
                vif = float("nan")
            vif_data.append({
                "variable": col,
                "VIF": round(float(vif), 4) if not np.isnan(vif) else None
            })
        return {"vif": vif_data}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/candidate-features")
async def candidate_features(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
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
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.8))
        pairs, _ = compute_corr_pairs(df, cols, threshold)
        return {"pairs": [{"feature1": p[0], "feature2": p[1], "corr": round(p[2], 4)} for p in pairs]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/preview-removal")
async def preview_removal_route(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        feature_cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.85))
        dep = payload.get("dependent_variable")
        preview = preview_removal_reasons(df, feature_cols, dep, threshold)
        return preview
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/apply-removal")
async def apply_removal(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        feature_cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.85))
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
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        cols = payload["columns"]
        threshold = float(payload.get("threshold", 0.85))
        clusters = find_corr_clusters(df, cols, threshold)
        return {"clusters": clusters}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/preview-combination")
async def preview_combination_route(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
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
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
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


@router.post("/apply-weighted-sum")
async def apply_weighted_sum(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        configs = payload["configs"]
        drop_original = payload.get("drop_original", False)
        df_out, applied_info = apply_weighted_sum_columns(df, configs, drop_original)
        result = _csv_response(df_out)
        result["applied_info"] = applied_info
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/apply-pca-treatment")
async def apply_pca_treatment_route(payload: dict):
    try:
        df = _parse_csv_to_polars(payload["csv_data"].encode("latin-1")).to_pandas()
        feature_cols = payload["columns"]
        variance_threshold = float(payload.get("variance_threshold", 0.9))
        pca_result = apply_pca_treatment(df, feature_cols, variance_threshold)
        result = _csv_response(pca_result["df_pca"])
        result.update({
            "explained_variance": pca_result["explained_variance"],
            "n_components": pca_result["n_components"],
            "contributions": pca_result["contributions"],
            "top3": pca_result["top3"],
        })
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))