"""
Integrated Analytics Dataset Builder router (Page 2)
"""
import io
import json
import polars as pl
import pandas as pd
from fastapi import APIRouter, HTTPException

router = APIRouter()


def _parse_csv(csv_data: str) -> pl.DataFrame:
    return pl.read_csv(io.BytesIO(csv_data.encode("latin-1")), infer_schema_length=10000)


def _to_json(df: pl.DataFrame, n: int = 200) -> list:
    pdf = df.head(n).to_pandas()
    for col in pdf.columns:
        try:
            if pdf[col].dtype == object:
                pdf[col] = pdf[col].astype(str)
        except Exception:
            pass
    return json.loads(pdf.to_json(orient="records", date_format="iso"))


@router.post("/build")
async def build_analytics(payload: dict):
    """
    Build integrated analytics DB by joining multiple channel files on geo+date keys.
    payload: { files: [{csv_data, label}], geo_col, date_col, join_type }
    """
    try:
        dfs = []
        geo_col = payload["geo_col"]
        date_col = payload["date_col"]
        join_type = payload.get("join_type", "outer")

        for f in payload["files"]:
            df = _parse_csv(f["csv_data"])
            # Normalise date column
            if date_col in df.columns:
                dtype = df.schema.get(date_col)
                if dtype in (pl.Utf8, pl.Categorical):
                    df = df.with_columns(
                        pl.col(date_col).str.strptime(pl.Date, strict=False).alias(date_col)
                    )
                elif dtype == pl.Datetime:
                    df = df.with_columns(pl.col(date_col).cast(pl.Date).alias(date_col))
            dfs.append((f.get("label", ""), df))

        if not dfs:
            raise HTTPException(status_code=400, detail="No files provided")

        merged = dfs[0][1]
        for label, d in dfs[1:]:
            suffix = f"_{label}" if label else "_right"
            merged = merged.join(d, on=[geo_col, date_col], how=join_type, suffix=suffix)

        return {
            "preview": _to_json(merged, 200),
            "columns": merged.columns,
            "rows": merged.height,
            "csv_data": merged.write_csv(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
