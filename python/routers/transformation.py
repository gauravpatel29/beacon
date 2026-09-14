import io
import json
import math
import numpy as np
import pandas as pd
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
from core.processing import (
    apply_full_transformations_pipeline,
    transform_edited_df,
    auto_select_channel_params,
    transform_single_channel,
    compute_poor_mans_curve_data,
    compute_correlation_matrix,
    compute_corr_pairs,
    run_optuna_optimization,
    optuna_params_to_transform_rows,
)

router = APIRouter()


def _parse_csv(csv_data: str) -> pd.DataFrame:
    try:
        return pd.read_csv(io.StringIO(csv_data), low_memory=False)
    except Exception:
        return pd.read_csv(io.BytesIO(csv_data.encode("latin-1")), low_memory=False)


def _sanitize_col_param(val: Any) -> str:
    if isinstance(val, list):
        return str(val[0]) if val else ""
    return str(val) if val is not None else ""


def _safe_float(val: Any, default: float = 0.0) -> float:
    if val is None or pd.isna(val):
        return default
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return default
        return round(f, 4)
    except (ValueError, TypeError):
        return default


@router.post("/apply")
async def apply_transformations(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        geo_col = _sanitize_col_param(payload.get("geo_column"))
        date_col = _sanitize_col_param(payload.get("date_column"))
        dep_var = _sanitize_col_param(payload.get("dependent_variable"))
        transformations = payload.get("transformations", [])
        derived_variables = payload.get("derived_variables", [])
        pop_col = _sanitize_col_param(payload.get("pop_column")) or None
        add_carryover = bool(payload.get("add_carryover", False))

        if not transformations and not derived_variables:
            raise HTTPException(status_code=400, detail="No transformations or derived variables provided.")

        transformed_df = apply_full_transformations_pipeline(
            df=df,
            geo_column=geo_col,
            date_column=date_col,
            dependent_variable=dep_var,
            transformations=transformations,
            derived_variables=derived_variables,
            pop_column=pop_col,
            add_carryover=add_carryover,
        )

        preview_records = json.loads(transformed_df.head(60).to_json(orient="records", date_format="iso"))
        transformed_channels = [c for c in transformed_df.columns if c.endswith("_transformed") or c == "Carryover"]

        return {
            "preview": preview_records,
            "columns": transformed_df.columns.tolist(),
            "transformed_channels": transformed_channels,
            "rows": len(transformed_df),
            "cols": len(transformed_df.columns),
            "csv_data": transformed_df.to_csv(index=False),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Transformation execution failed: {str(e)}")


@router.post("/auto-select")
async def auto_select_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        geo_col = _sanitize_col_param(payload.get("geo_column"))
        date_col = _sanitize_col_param(payload.get("date_column"))
        dep_var = _sanitize_col_param(payload.get("dependent_variable"))
        channels = payload.get("channels", [])
        derived_variables = payload.get("derived_variables", [])
        pop_col = _sanitize_col_param(payload.get("pop_column")) or None

        # Compute any derived channels in df first
        if derived_variables:
            for d in derived_variables:
                out_name = d.get("name")
                op = d.get("operator", "+")
                vars_list = [v for v in d.get("variables", []) if v in df.columns]
                if out_name and len(vars_list) >= 2:
                    weights = d.get("weights", {})
                    res_s = pd.to_numeric(df[vars_list[0]], errors="coerce").fillna(0.0) * float(weights.get(vars_list[0], 1.0))
                    for next_v in vars_list[1:]:
                        w = float(weights.get(next_v, 1.0))
                        s_next = pd.to_numeric(df[next_v], errors="coerce").fillna(0.0) * w
                        if op == "+":
                            res_s = res_s + s_next
                        elif op == "-":
                            res_s = res_s - s_next
                        elif op == "*":
                            res_s = res_s * s_next
                        elif op == "/":
                            res_s = (res_s / (s_next.replace(0, pd.NA))).fillna(0.0)
                    df[out_name] = res_s

        # Exclude sales KPI
        channels_to_tune = [c for c in channels if c in df.columns and str(c).strip() != str(dep_var).strip()]

        recommendations = []
        for ch in channels_to_tune:
            rec = auto_select_channel_params(
                df=df,
                channel=ch,
                geo_column=geo_col,
                dependent_variable=dep_var,
                pop_column=pop_col,
            )
            recommendations.append(rec)

        return {"recommendations": recommendations, "count": len(recommendations)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Auto-selection failed: {str(e)}")


@router.post("/preview-single")
async def preview_single_route(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        channel = payload.get("channel", "")
        geo_col = _sanitize_col_param(payload.get("geo_column"))
        date_col = _sanitize_col_param(payload.get("date_column"))
        dep_var = _sanitize_col_param(payload.get("dependent_variable"))
        config = payload.get("config", {})
        derived_variables = payload.get("derived_variables", [])
        pop_col = _sanitize_col_param(payload.get("pop_column")) or None

        # Compute derived channel if this channel is an arithmetic derived variable
        if channel not in df.columns and derived_variables:
            for d in derived_variables:
                if d.get("name") == channel:
                    vars_list = [v for v in d.get("variables", []) if v in df.columns]
                    if len(vars_list) >= 2:
                        weights = d.get("weights", {})
                        op = d.get("operator", "+")
                        res_s = pd.to_numeric(df[vars_list[0]], errors="coerce").fillna(0.0) * float(weights.get(vars_list[0], 1.0))
                        for next_v in vars_list[1:]:
                            w = float(weights.get(next_v, 1.0))
                            s_next = pd.to_numeric(df[next_v], errors="coerce").fillna(0.0) * w
                            if op == "+":
                                res_s = res_s + s_next
                            elif op == "-":
                                res_s = res_s - s_next
                            elif op == "*":
                                res_s = res_s * s_next
                            elif op == "/":
                                res_s = (res_s / (s_next.replace(0, pd.NA))).fillna(0.0)
                        df[channel] = res_s

        if channel not in df.columns:
            raise HTTPException(status_code=400, detail=f"Channel '{channel}' not found in dataset.")

        transformed_s = transform_single_channel(
            df=df,
            channel=channel,
            geo_column=geo_col,
            normalization=config.get("Normalization", "none"),
            pop_column=pop_col,
            adstock_coeff=float(config.get("Adstock", 0.5)) if pd.notna(config.get("Adstock")) else 0.0,
            lags=int(config.get("Lags", 1)) if pd.notna(config.get("Lags")) else 0,
            sat_function=config.get("Saturation Function"),
            power_k=float(config.get("Power (k)", 0.5)) if pd.notna(config.get("Power (k)")) else 0.5,
            log_k=float(config.get("Log (k)", 1.0)) if pd.notna(config.get("Log (k)")) else 1.0,
        )

        raw_s = pd.to_numeric(df[channel], errors="coerce").fillna(0.0)
        trans_s = pd.Series(transformed_s, index=df.index).fillna(0.0)

        df_preview = pd.DataFrame({"raw": raw_s, "transformed": trans_s})
        if dep_var and dep_var in df.columns:
            df_preview[dep_var] = pd.to_numeric(df[dep_var], errors="coerce").fillna(0.0)

        # 1. Summary Statistics with full NaN protection
        stats_table = [
            {"metric": "Mean", "original": _safe_float(raw_s.mean()), "transformed": _safe_float(trans_s.mean())},
            {"metric": "Median", "original": _safe_float(raw_s.median()), "transformed": _safe_float(trans_s.median())},
            {"metric": "Standard Deviation", "original": _safe_float(raw_s.std()), "transformed": _safe_float(trans_s.std())},
            {"metric": "Minimum", "original": _safe_float(raw_s.min()), "transformed": _safe_float(trans_s.min())},
            {"metric": "Maximum", "original": _safe_float(raw_s.max()), "transformed": _safe_float(trans_s.max())},
            {"metric": "25th Percentile", "original": _safe_float(raw_s.quantile(0.25)), "transformed": _safe_float(trans_s.quantile(0.25))},
            {"metric": "75th Percentile", "original": _safe_float(raw_s.quantile(0.75)), "transformed": _safe_float(trans_s.quantile(0.75))},
        ]

        # 2. Side-by-Side Histograms with Zero-Variance protection
        def make_hist(series, num_bins=12):
            vals = pd.to_numeric(series, errors="coerce").dropna().values
            if len(vals) == 0:
                return []
            min_v, max_v = float(np.min(vals)), float(np.max(vals))
            if min_v == max_v:
                return [{"bin": f"{min_v:.2f}", "count": len(vals)}]
            counts, edges = np.histogram(vals, bins=num_bins)
            return [{"bin": f"{edges[i]:.2f}-{edges[i+1]:.2f}", "count": int(counts[i])} for i in range(len(counts))]

        raw_hist = make_hist(raw_s)
        trans_hist = make_hist(trans_s)

        # 3. Before & After Relationships with KPI (Poor Man's Curves)
        raw_curve = compute_poor_mans_curve_data(df, channel, dep_var, n_bins=10) if (dep_var and dep_var in df.columns) else None
        trans_curve = compute_poor_mans_curve_data(df_preview, "transformed", dep_var, n_bins=10) if (dep_var and dep_var in df.columns) else None

        return {
            "channel": channel,
            "stats_table": stats_table,
            "raw_hist": raw_hist,
            "trans_hist": trans_hist,
            "raw_curve": raw_curve,
            "trans_curve": trans_curve,
            "config": config,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Single preview failed: {str(e)}")


@router.post("/correlation")
async def transformation_correlation(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        cols = payload.get("columns", [])
        valid_cols = [c for c in list(dict.fromkeys(cols)) if c in df.columns]
        if len(valid_cols) < 2:
            return {"matrix": {}, "columns": [], "pairs": []}

        matrix = compute_correlation_matrix(df, valid_cols)
        pairs, _ = compute_corr_pairs(df, valid_cols, threshold=float(payload.get("threshold", 0.7)))
        formatted_pairs = [{"feature1": p[0], "feature2": p[1], "corr": round(p[2], 4)} for p in pairs]

        return {
            "matrix": matrix,
            "columns": valid_cols,
            "pairs": formatted_pairs,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Transformed correlation failed: {str(e)}")


@router.post("/optuna")
async def run_optuna(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        date_col = _sanitize_col_param(payload.get("date_column"))
        geo_col = _sanitize_col_param(payload.get("geo_column"))
        dep_var = _sanitize_col_param(payload.get("dependent_variable"))

        df[date_col] = pd.to_datetime(df[date_col])

        channels_cfg = payload["channels_cfg"]
        channel_feature_names = payload.get("channel_feature_names") or [
            f"{c['name']}_transformed" if c.get("has_adstock") or c.get("sat_method") else c["name"]
            for c in channels_cfg
        ]

        negative_channels = set(payload.get("negative_channels", []))

        result = run_optuna_optimization(
            df=df,
            geo_column=geo_col,
            dependent_variable=dep_var,
            channels_cfg=channels_cfg,
            channel_feature_names=channel_feature_names,
            n_trials=int(payload.get("n_trials", 50)),
            cv_splits=int(payload.get("cv_splits", 3)),
            use_sign_pen=payload.get("use_sign_pen", True),
            use_mag_pen=payload.get("use_mag_pen", True),
            use_stab_pen=payload.get("use_stab_pen", True),
            lambda_sign=float(payload.get("lambda_sign", 10.0)),
            lambda_mag=float(payload.get("lambda_mag", 1.0)),
            lambda_stab=float(payload.get("lambda_stab", 5.0)),
            negative_channels=negative_channels,
            power_choices=[float(v) for v in payload.get("power_choices", [0.2, 0.3, 0.4, 0.5, 0.6, 0.7])],
            decay_choices=[float(v) for v in payload.get("decay_choices", [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])],
            lag_choices=[int(v) for v in payload.get("lag_choices", [2, 3, 4, 5, 6, 7])],
        )

        suggested_rows = optuna_params_to_transform_rows(channels_cfg, result["best_params"])
        return {
            "best_params": result["best_params"],
            "best_value": result["best_value"],
            "n_trials": result["n_trials"],
            "suggested_transformations": suggested_rows,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))