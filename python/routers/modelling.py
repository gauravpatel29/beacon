import io
import pandas as pd
from fastapi import APIRouter, HTTPException
from core.processing import (
    run_ols_regression,
    run_ols_stage2,
    run_ridge_regression,
    build_combined_table,
    build_waterfall_chart_data,
)

router = APIRouter()


def _parse_csv(csv_data: str) -> pd.DataFrame:
    return pd.read_csv(io.BytesIO(csv_data.encode("latin-1")))


@router.post("/available-channels")
async def available_channels(payload: dict):
    try:
        df = _parse_csv(payload["csv_data"])
        df[payload["date_column"]] = pd.to_datetime(df[payload["date_column"]])
        mask = (df[payload["date_column"]] >= pd.to_datetime(payload["start_date"])) & \
               (df[payload["date_column"]] <= pd.to_datetime(payload["end_date"]))
        filtered = df[mask]
        dep = payload["dependent_variable"]
        dep_user = payload.get("dependent_variable_user_input", dep)
        remove = [payload["date_column"], payload["geo_column"], dep, dep_user, f"{dep}_transformed"]
        channels = [c for c in filtered.columns if c not in remove and c.endswith("_transformed")]
        return {"channels": channels, "date_range": {"start": str(filtered[payload["date_column"]].min().date()),
                                                      "end": str(filtered[payload["date_column"]].max().date())}}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/run-regression")
async def run_regression(payload: dict):
    try:
        transformed_df = _parse_csv(payload["transformed_csv"])
        granular_df = _parse_csv(payload["granular_csv"])
        result = run_ols_regression(
            transformed_df=transformed_df,
            granular_df=granular_df,
            date_column=payload["date_column"],
            geo_column=payload["geo_column"],
            dependent_variable=payload["dependent_variable"],
            dependent_variable_user_input=payload.get("dependent_variable_user_input", payload["dependent_variable"]),
            selected_channels=payload["selected_channels"],
            start_date=payload["start_date"],
            end_date=payload["end_date"],
        )
        result["model_type"] = "OLS Stage 1"
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/run-ols-stage2")
async def run_ols_stage2_route(payload: dict):
    try:
        transformed_df = _parse_csv(payload["transformed_csv"])
        granular_df = _parse_csv(payload["granular_csv"])
        result = run_ols_stage2(
            transformed_df=transformed_df,
            granular_df=granular_df,
            date_column=payload["date_column"],
            geo_column=payload["geo_column"],
            dependent_variable=payload["dependent_variable"],
            dependent_variable_user_input=payload.get("dependent_variable_user_input", payload["dependent_variable"]),
            selected_channels=payload["selected_channels"],
            start_date=payload["start_date"],
            end_date=payload["end_date"],
            parent_channel=payload["parent_channel"],
            s2_channels=payload["s2_channels"],
            stage1_coefficients=payload["stage1_coefficients"],
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/run-ridge")
async def run_ridge_route(payload: dict):
    try:
        transformed_df = _parse_csv(payload["transformed_csv"])
        granular_df = _parse_csv(payload["granular_csv"])
        stage = int(payload.get("stage", 1))
        result = run_ridge_regression(
            transformed_df=transformed_df,
            granular_df=granular_df,
            date_column=payload["date_column"],
            geo_column=payload["geo_column"],
            dependent_variable=payload["dependent_variable"],
            dependent_variable_user_input=payload.get("dependent_variable_user_input", payload["dependent_variable"]),
            selected_channels=payload["selected_channels"],
            start_date=payload["start_date"],
            end_date=payload["end_date"],
            alpha_mode=payload.get("alpha_mode", "auto"),
            manual_alpha=float(payload.get("manual_alpha", 1.0)),
            cv_splits=int(payload.get("cv_splits", 3)),
            positive_coef=payload.get("positive_coef", False),
            use_custom_penalties=payload.get("use_custom_penalties", False),
            prior_weights=payload.get("prior_weights", {}),
            stage=stage,
            parent_channel=payload.get("parent_channel"),
            s2_channels=payload.get("s2_channels"),
            stage1_coefficients=payload.get("stage1_coefficients"),
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/combined-decomposition")
async def combined_decomposition(payload: dict):
    try:
        s1_coeff_df = pd.DataFrame(payload["stage1_coefficients"])
        s2_coeff_df = pd.DataFrame(payload["stage2_coefficients"])
        parent_channel = payload["parent_channel"]
        dep_var_label = payload.get("dep_var_label", "Sales")

        combined_df = build_combined_table(s1_coeff_df, s2_coeff_df, parent_channel)
        waterfall = build_waterfall_chart_data(combined_df, dep_var_label)

        total_positive = float(combined_df[combined_df["Impactable Sales"] >= 0]["Impactable Sales"].sum())
        total_negative = float(combined_df[combined_df["Impactable Sales"] < 0]["Impactable Sales"].sum())
        net_total = float(combined_df["Impactable Sales"].sum())
        n_s2 = int(combined_df[combined_df["Source"] == "Stage 2"].shape[0])

        return {
            "combined_table": combined_df.to_dict(orient="records"),
            "waterfall": waterfall,
            "metrics": {
                "net_impactable_sales": net_total,
                "positive_contributions": total_positive,
                "negative_contributions": total_negative,
                "stage2_subchannels": n_s2,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
