import io
import json
import pandas as pd
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
from core.processing import (
    apply_full_transformations_pipeline,
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


@router.post("/apply")
async def apply_transformations(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        geo_col = payload.get("geo_column", "")
        date_col = payload.get("date_column", "")
        dep_var = payload.get("dependent_variable", "")
        transformations = payload.get("transformations", [])
        derived_variables = payload.get("derived_variables", [])
        pop_col = payload.get("pop_column")
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
        geo_col = payload.get("geo_column", "")
        date_col = payload.get("date_column", "")
        dep_var = payload.get("dependent_variable", "")
        channels = payload.get("channels", [])
        pop_col = payload.get("pop_column")

        # Exclude sales variable strictly
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
        channel = payload["channel"]
        geo_col = payload.get("geo_column", "")
        date_col = payload.get("date_column", "")
        dep_var = payload.get("dependent_variable", "")
        config = payload.get("config", {})
        pop_col = payload.get("pop_column")

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

        df_preview = pd.DataFrame({
            "raw": pd.to_numeric(df[channel], errors="coerce").fillna(0.0),
            "transformed": transformed_s,
        })
        if dep_var and dep_var in df.columns:
            df_preview[dep_var] = pd.to_numeric(df[dep_var], errors="coerce").fillna(0.0)

        # Before & After Poor Man's Curves
        raw_curve = compute_poor_mans_curve_data(df, channel, dep_var) if (dep_var and dep_var in df.columns) else None
        trans_curve = compute_poor_mans_curve_data(df_preview, "transformed", dep_var) if (dep_var and dep_var in df.columns) else None

        raw_s = df_preview["raw"]
        trans_s = df_preview["transformed"]

        stats = {
            "raw_mean": round(float(raw_s.mean()), 2),
            "raw_std": round(float(raw_s.std()), 2),
            "raw_max": round(float(raw_s.max()), 2),
            "trans_mean": round(float(trans_s.mean()), 2),
            "trans_std": round(float(trans_s.std()), 2),
            "trans_max": round(float(trans_s.max()), 2),
            "correlation_with_kpi_raw": round(float(raw_s.corr(df_preview[dep_var])), 4) if (dep_var and dep_var in df_preview) else None,
            "correlation_with_kpi_trans": round(float(trans_s.corr(df_preview[dep_var])), 4) if (dep_var and dep_var in df_preview) else None,
        }

        # Time series sample
        time_trend = []
        if date_col and date_col in df.columns:
            df_time = pd.DataFrame({
                "date": df[date_col].astype(str),
                "raw": raw_s,
                "transformed": trans_s,
            })
            time_agg = df_time.groupby("date")[["raw", "transformed"]].mean().reset_index().sort_values("date")
            time_trend = time_agg.to_dict(orient="records")

        return {
            "channel": channel,
            "stats": stats,
            "raw_curve": raw_curve,
            "trans_curve": trans_curve,
            "time_trend": time_trend,
        }
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
        df[payload["date_column"]] = pd.to_datetime(df[payload["date_column"]])

        channels_cfg = payload["channels_cfg"]
        channel_feature_names = payload.get("channel_feature_names") or [
            f"{c['name']}_transformed" if c.get("has_adstock") or c.get("sat_method") else c["name"]
            for c in channels_cfg
        ]

        negative_channels = set(payload.get("negative_channels", []))

        result = run_optuna_optimization(
            df=df,
            geo_column=payload["geo_column"],
            dependent_variable=payload["dependent_variable"],
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
