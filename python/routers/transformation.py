import io
import json
import pandas as pd
from fastapi import APIRouter, HTTPException
from core.processing import transform_edited_df, run_optuna_optimization, optuna_params_to_transform_rows

router = APIRouter()


def _parse_csv(csv_data: str) -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(csv_data.encode("latin-1")))


@router.post("/apply")
async def apply_transformations(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        df[payload["date_column"]] = pd.to_datetime(df[payload["date_column"]])

        dependent_variable = payload["dependent_variable"]
        add_carryover = payload.get("add_carryover", False)

        if add_carryover:
            df["Carryover"] = df[dependent_variable]

        edited_df = pd.DataFrame(payload["transformations"])
        for col in ["Lags"]:
            if col in edited_df.columns:
                edited_df[col] = pd.to_numeric(edited_df[col], errors="coerce")
        for col in ["Adstock", "Power (k)"]:
            if col in edited_df.columns:
                edited_df[col] = pd.to_numeric(edited_df[col], errors="coerce")

        transformed_df = transform_edited_df(df, edited_df, payload["geo_column"], dependent_variable)
        if transformed_df is None:
            raise HTTPException(status_code=400, detail="Transformation failed - check Lag is set when Adstock is used")

        col_list = [c for c in df.columns if c not in [payload["geo_column"], payload["date_column"]]]
        ordered_cols = [c for c in transformed_df.columns if c not in col_list] + col_list
        ordered_cols = [c for c in ordered_cols if c in transformed_df.columns]
        transformed_df = transformed_df[ordered_cols]

        preview_records = json.loads(transformed_df.head(50).to_json(orient="records", date_format="iso"))
        return {
            "preview": preview_records,
            "columns": transformed_df.columns.tolist(),
            "rows": len(transformed_df),
            "csv_data": transformed_df.to_csv(index=False),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


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
