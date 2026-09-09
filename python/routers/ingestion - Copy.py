import io
import json
from datetime import datetime, date
from typing import Optional, List
import pandas as pd
import polars as pl
import numpy as np
from fastapi import APIRouter, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from core.processing import (
    detect_date_columns_by_sampling,
    detect_date_granularity,
    modify_granularity,
    normalize_columns_pl,
    luhn_valid_npi,
    parse_date_series_polars,
    format_date_column,
)

router = APIRouter()


def _parse_content_to_polars(filename: str, content: bytes) -> pl.DataFrame:
    """Parses both .csv and Excel (.xlsx / .xls) streams safely into Polars."""
    lower = filename.lower()
    if lower.endswith(".xlsx") or lower.endswith(".xls"):
        try:
            pdf = pd.read_excel(io.BytesIO(content))
            return pl.from_pandas(pdf)
        except Exception as e:
            raise ValueError(f"Failed to parse Excel file: {str(e)}")

    try:
        return pl.read_csv(io.BytesIO(content), infer_schema_length=10000, ignore_errors=True)
    except Exception:
        try:
            pdf = pd.read_csv(io.BytesIO(content), encoding="latin-1", on_bad_lines="skip")
            return pl.from_pandas(pdf)
        except Exception:
            pdf = pd.read_csv(io.BytesIO(content), encoding="utf-8", errors="replace", on_bad_lines="skip")
            return pl.from_pandas(pdf)


def _polars_to_json(df: pl.DataFrame, max_rows: int = 200) -> list:
    """Safely converts DataFrame slice to JSON without failing on NaT/NaN/None."""
    try:
        pdf = df.head(max_rows).to_pandas()
        pdf = pdf.replace({np.nan: None})
        for col in pdf.columns:
            if pd.api.types.is_datetime64_any_dtype(pdf[col]):
                pdf[col] = pdf[col].dt.strftime("%Y-%m-%d").replace({"NaT": None, "": None})
            elif pdf[col].dtype == object:
                pdf[col] = pdf[col].apply(
                    lambda v: None if v is None or pd.isna(v) or str(v).strip() in ("NaT", "nan", "None", "<NA>") else str(v)
                )
        return json.loads(pdf.to_json(orient="records", date_format="iso"))
    except Exception:
        try:
            return df.head(max_rows).to_dicts()
        except Exception:
            return []


def parse_filter_date(date_str: Optional[str]) -> Optional[date]:
    """Robustly parse start/end filter strings (handles DD/MM/YYYY, YYYY-MM-DD, MM/DD/YYYY)."""
    if not date_str or not str(date_str).strip():
        return None
    s = str(date_str).strip()

    try:
        dt = pd.to_datetime(s, dayfirst=True, errors="coerce")
        if pd.notna(dt):
            return dt.date()
    except Exception:
        pass

    try:
        dt = pd.to_datetime(s, dayfirst=False, errors="coerce")
        if pd.notna(dt):
            return dt.date()
    except Exception:
        pass

    return None


@router.post("/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload one or more CSV/Excel files. Returns preview, columns, dtypes, and suggested date columns."""
    try:
        results = []
        for f in files:
            content = await f.read()
            df = _parse_content_to_polars(f.filename, content)

            try:
                suggested_dates = detect_date_columns_by_sampling(df)
            except Exception:
                suggested_dates = []

            schema = {str(col): str(dt) for col, dt in df.schema.items()}

            results.append({
                "filename": f.filename,
                "rows": int(df.height),
                "cols": int(len(df.columns)),
                "columns": [str(c) for c in df.columns],
                "schema": schema,
                "suggested_date_columns": suggested_dates,
                "preview": _polars_to_json(df, 100),
                "content_b64": df.write_csv(),
            })
        return JSONResponse(content={"files": results})
    except Exception as e:
        print(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Upload processing failed: {str(e)}")


@router.post("/standardize")
async def standardize_columns(payload: dict):
    """Apply column selection, explicit data type casting, date formatting, and renaming."""
    try:
        csv_bytes = payload["csv_data"].encode("latin-1")
        df = _parse_content_to_polars("file.csv", csv_bytes)

        # 1. Column Selection
        if payload.get("selected_cols"):
            df = df.select([c for c in payload["selected_cols"] if c in df.columns])

        # 2. Explicit Data Type Casting
        type_cast_map = payload.get("type_cast_map", {})
        for col, target_t in type_cast_map.items():
            if col in df.columns:
                if target_t in ("float", "numeric"):
                    df = df.with_columns(pl.col(col).cast(pl.Float64, strict=False))
                elif target_t == "integer":
                    df = df.with_columns(pl.col(col).cast(pl.Int64, strict=False))
                elif target_t in ("string", "text", "category"):
                    df = df.with_columns(pl.col(col).cast(pl.Utf8))

        # 3. Date Formatting
        for dc in payload.get("date_configs", []):
            col = dc.get("col")
            fmt = dc.get("format") or "%d/%m/%Y"
            if col in df.columns:
                formatted_dates = format_date_column(df.get_column(col).to_pandas(), target_format=fmt)
                df = df.with_columns(pl.Series(col, formatted_dates))

        # 4. Rename Columns
        if payload.get("rename_map"):
            rename_map = {
                str(k): str(v).strip()
                for k, v in payload["rename_map"].items()
                if k in df.columns and v and str(v).strip() != "" and str(k) != str(v).strip()
            }
            if rename_map:
                df = df.rename(rename_map)

        str_cols = [c for c, dt in zip(df.columns, df.dtypes) if dt == pl.Utf8]
        if str_cols:
            df = df.with_columns([pl.col(c).fill_null("") for c in str_cols])

        return {
            "preview": _polars_to_json(df, 200),
            "columns": [str(c) for c in df.columns],
            "rows": int(df.height),
            "cols": int(len(df.columns)),
            "csv_data": df.write_csv(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/filter")
async def filter_data(payload: dict):
    """Apply NPI validity filter, date range filter, categorical & numerical filters."""
    try:
        csv_bytes = payload["csv_data"].encode("latin-1")
        df = _parse_content_to_polars("file.csv", csv_bytes)
        npi_col = payload.get("npi_col")
        date_col = payload.get("date_col")
        use_luhn = bool(payload.get("use_luhn", False))
        luhn_warning = False

        # 1. Date normalization
        if date_col and date_col in df.columns:
            df = parse_date_series_polars(df, date_col)

        # 2. NPI Filtering (Type-Safe)
        if npi_col and npi_col in df.columns:
            df = df.filter(pl.col(npi_col).is_not_null())
            if use_luhn:
                raw_series = df.get_column(npi_col)
                unique_vals = raw_series.unique().to_list()
                valid_lookup = set()
                for val in unique_vals:
                    if luhn_valid_npi(val):
                        valid_lookup.add(str(val).strip().replace(".0", ""))

                if len(valid_lookup) == 0 and len(unique_vals) > 0:
                    luhn_warning = True

                df = df.filter(
                    pl.col(npi_col).cast(pl.Utf8).str.strip_chars().str.replace(r"\.0$", "").is_in(list(valid_lookup))
                )

        # 3. Date range filter
        if date_col and date_col in df.columns:
            start_date_str = payload.get("start_date")
            end_date_str = payload.get("end_date")

            s_dt = parse_filter_date(start_date_str)
            e_dt = parse_filter_date(end_date_str)

            if s_dt and e_dt and s_dt > e_dt:
                s_dt, e_dt = e_dt, s_dt

            if s_dt:
                df = df.filter(pl.col(date_col).is_not_null() & (pl.col(date_col) >= s_dt))
            if e_dt:
                df = df.filter(pl.col(date_col).is_not_null() & (pl.col(date_col) <= e_dt))

        return {
            "rows": int(df.height),
            "columns": [str(c) for c in df.columns],
            "cols": int(len(df.columns)),
            "luhn_warning": luhn_warning,
            "preview": _polars_to_json(df, 200),
            "csv_data": df.write_csv(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/detect-granularity")
async def detect_granularity(payload: dict):
    """Detect time granularity of a date column."""
    try:
        csv_bytes = payload["csv_data"].encode("latin-1")
        df = _parse_content_to_polars("file.csv", csv_bytes)
        date_col = payload["date_col"]
        gran = detect_date_granularity(df, date_col)
        if gran is None:
            raise HTTPException(status_code=400, detail=f"Could not detect granularity for '{date_col}'")
        return {"granularity": gran}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/modify-granularity")
async def modify_gran(payload: dict):
    """Modify time granularity of the dataset."""
    try:
        csv_bytes = payload["csv_data"].encode("latin-1")
        df = _parse_content_to_polars("file.csv", csv_bytes)
        result_df, new_date_col = modify_granularity(
            df=df,
            geo_column=payload["geo_column"],
            date_column=payload["date_column"],
            granularity_level_df=payload["current_granularity"],
            granularity_level_user_input=payload["target_granularity"],
            work_days=payload.get("work_days", 7),
            numerical_config_dict=payload.get("numerical_config_dict", {}),
            categorical_config_dict=payload.get("categorical_config_dict", {}),
        )
        return {
            "preview": _polars_to_json(result_df, 200),
            "columns": [str(c) for c in result_df.columns],
            "rows": int(result_df.height),
            "cols": int(len(result_df.columns)),
            "new_date_col": new_date_col,
            "csv_data": result_df.write_csv(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/normalize")
async def normalize(payload: dict):
    """Apply normalization."""
    try:
        csv_bytes = payload["csv_data"].encode("latin-1")
        df = _parse_content_to_polars("file.csv", csv_bytes)
        result = normalize_columns_pl(df, payload["columns"], method=payload.get("method", "zscore"))
        return {
            "preview": _polars_to_json(result, 200),
            "columns": [str(c) for c in result.columns],
            "rows": int(result.height),
            "cols": len(result.columns),
            "csv_data": result.write_csv(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/download")
async def download_csv(payload: dict):
    """Return a CSV file for download."""
    csv_bytes = payload["csv_data"].encode("latin-1")
    filename = payload.get("filename", "download.csv")
    return StreamingResponse(io.BytesIO(csv_bytes), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})