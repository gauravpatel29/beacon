"""Applies `live_updates` to a tabular file before it reaches object storage.

Fixed order, per the contract:

    date_formats  ->  dtype_changes  ->  column_renames

Every operation names columns as they appear in the *uploaded* file. Renames
land last, so no operation ever refers to a name another operation produced.
"""

import io
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from typing import Any

import pandas as pd

from app.errors import unprocessable
from app.schemas import AppliedCounts, LiveUpdates

CSV_EXT = {".csv", ".txt", ".tsv"}
EXCEL_EXT = {".xlsx", ".xlsm"}
SUPPORTED_EXT = CSV_EXT | EXCEL_EXT

CONTENT_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
}


class TransformError(Exception):
    """Collects every per-column failure so the 422 can report them together."""

    def __init__(self, errors: list[dict[str, Any]]) -> None:
        super().__init__("transformation failed")
        self.errors = errors


def suffix_of(filename: str) -> str:
    return PurePosixPath(filename).suffix.lower()


def content_type_for(filename: str) -> str:
    return CONTENT_TYPES.get(suffix_of(filename), "application/octet-stream")


def read_table(filename: str, raw: bytes) -> pd.DataFrame:
    ext = suffix_of(filename)
    try:
        if ext in EXCEL_EXT:
            return pd.read_excel(io.BytesIO(raw), dtype=object)
        sep = "\t" if ext == ".tsv" else ","
        # dtype=object keeps values as written, so a date column is reformatted
        # from its real source text rather than from pandas' guess.
        return pd.read_csv(io.BytesIO(raw), dtype=object, sep=sep, keep_default_na=False)
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as 422
        raise TransformError(
            [{"filename": filename, "code": "unreadable",
              "message": f"Could not parse file: {exc}"}]
        ) from exc


def write_table(filename: str, df: pd.DataFrame) -> bytes:
    ext = suffix_of(filename)
    if ext in EXCEL_EXT:
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
        return buf.getvalue()
    sep = "\t" if ext == ".tsv" else ","
    return df.to_csv(index=False, sep=sep).encode("utf-8")


def _validate_columns(
    filename: str, df: pd.DataFrame, updates: LiveUpdates
) -> list[dict[str, Any]]:
    """Every referenced column must exist in the upload, before anything runs."""
    present = set(df.columns)
    errors: list[dict[str, Any]] = []

    referenced: list[str] = (
        [d.column for d in updates.date_formats]
        + [d.column for d in updates.dtype_changes]
        + [r.from_ for r in updates.column_renames]
    )
    for col in referenced:
        if col not in present:
            errors.append(
                {
                    "filename": filename,
                    "column": col,
                    "code": "column_not_found",
                    "message": f'Column "{col}" is not present in the uploaded file.',
                }
            )

    # A rename that collides with a column that survives the rename would
    # silently produce duplicate headers.
    renamed_from = {r.from_ for r in updates.column_renames}
    survivors = present - renamed_from
    seen: set[str] = set()
    for rename in updates.column_renames:
        if rename.to in survivors or rename.to in seen:
            errors.append(
                {
                    "filename": filename,
                    "column": rename.from_,
                    "code": "rename_collision",
                    "message": (
                        f'Renaming "{rename.from_}" to "{rename.to}" would '
                        f"produce a duplicate column."
                    ),
                }
            )
        seen.add(rename.to)

    return errors


def _apply_date_formats(
    filename: str, df: pd.DataFrame, updates: LiveUpdates,
    errors: list[dict[str, Any]],
) -> int:
    applied = 0
    for change in updates.date_formats:
        series = df[change.column]
        parsed = pd.to_datetime(series, format=change.from_, errors="coerce")
        bad = parsed.isna() & series.notna() & (series.astype(str).str.strip() != "")
        if bad.any():
            row = int(bad.idxmax()) + 2  # +1 for header, +1 for 1-based rows
            errors.append(
                {
                    "filename": filename,
                    "column": change.column,
                    "code": "date_parse_failed",
                    "message": (
                        f'Value "{series[bad.idxmax()]}" at row {row} does not '
                        f'match format "{change.from_}".'
                    ),
                }
            )
            continue
        df[change.column] = parsed.dt.strftime(change.to).where(parsed.notna(), None)
        applied += 1
    return applied


def _cast_value(value: Any, target: str, scale: int | None) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    text = str(value).strip()
    if target in ("integer", "bigint"):
        return int(Decimal(text))
    if target == "float":
        return float(text)
    if target == "decimal":
        dec = Decimal(text)
        if scale is not None:
            dec = dec.quantize(Decimal(1).scaleb(-scale))
        return dec
    if target == "boolean":
        low = text.lower()
        if low in ("true", "1", "yes", "y", "t"):
            return True
        if low in ("false", "0", "no", "n", "f"):
            return False
        raise ValueError(f"{text!r} is not a boolean")
    if target in ("date", "timestamp"):
        ts = pd.to_datetime(text, errors="raise")
        return ts.strftime("%Y-%m-%d" if target == "date" else "%Y-%m-%d %H:%M:%S")
    return text


def _apply_dtype_changes(
    filename: str, df: pd.DataFrame, updates: LiveUpdates,
    errors: list[dict[str, Any]],
) -> tuple[int, int]:
    applied = 0
    nulled = 0
    for change in updates.dtype_changes:
        column = df[change.column]
        out: list[Any] = []
        failed = False
        for idx, value in enumerate(column.tolist()):
            try:
                out.append(_cast_value(value, change.to, change.scale))
            except (ValueError, TypeError, ArithmeticError, InvalidOperation):
                if change.on_error == "null_out":
                    out.append(None)
                    nulled += 1
                    continue
                target = change.to
                if change.to == "decimal":
                    target = f"decimal({change.precision or ''},{change.scale})"
                errors.append(
                    {
                        "filename": filename,
                        "column": change.column,
                        "code": "cast_failed",
                        "message": (
                            f'Value "{value}" at row {idx + 2} cannot be cast '
                            f"to {target}."
                        ),
                    }
                )
                failed = True
                break
        if not failed:
            df[change.column] = out
            applied += 1
    return applied, nulled


def apply_live_updates(
    filename: str, df: pd.DataFrame, updates: LiveUpdates
) -> tuple[pd.DataFrame, AppliedCounts]:
    """Returns the transformed frame, or raises TransformError with every cause."""
    errors = _validate_columns(filename, df, updates)
    if errors:
        raise TransformError(errors)

    df = df.copy()
    counts = AppliedCounts()

    counts.date_formats = _apply_date_formats(filename, df, updates, errors)
    dtype_applied, nulled = _apply_dtype_changes(filename, df, updates, errors)
    counts.dtype_changes = dtype_applied
    counts.nulled_values = nulled

    if errors:
        raise TransformError(errors)

    if updates.column_renames:
        df = df.rename(columns={r.from_: r.to for r in updates.column_renames})
        counts.column_renames = len(updates.column_renames)

    return df, counts


def transform_failed(errors: list[dict[str, Any]]):
    return unprocessable(
        "Transformation failed",
        detail="No object was written; the request was rolled back.",
        errors=errors,
    )
