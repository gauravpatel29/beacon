"""Replays a Manifest against a raw uploaded table.

Contract
--------
* Nothing is mutated until every referenced column is known to exist. A typo
  fails before any work happens, so a rejected request never half-applies.
* Every per-column failure is collected and reported together, each with the
  offending value and its 1-based row number in the source file.
* Order is fixed:  live_updates -> filters -> granularity, and within
  live_updates:    date_formats -> dtype_changes -> column_renames.
  Renames land last, so no operation ever names a column another operation
  produced. Filters and granularity therefore run against the *renamed*
  columns, which is what the caller sees in the preview.

The engine is pure: it takes a DataFrame and a spec and returns a DataFrame.
It touches no database, no bucket and no request context, so it is fully
testable on its own - and `preview()` is the same code path as a real apply,
which is what makes dry-run previews trustworthy.
"""

import io
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from core.manifest import (
    AppliedCounts, FilterCondition, FilterGroup, Granularity, LiveUpdates, ResolvedSpec,
)
from core.processing import luhn_valid_npi

CSV_EXT = {".csv", ".txt", ".tsv"}
EXCEL_EXT = {".xlsx", ".xlsm", ".xls"}
SUPPORTED_EXT = CSV_EXT | EXCEL_EXT

CONTENT_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xls": "application/vnd.ms-excel",
}

# Period aliases (for Series.dt.to_period), not offset aliases: "MS"/"YS" are
# offsets and are rejected by to_period. `.start_time` then yields the first
# day of the period, so a weekly rollup is stamped with its Monday.
PERIOD_FREQ = {"Weekly": "W-MON", "Monthly": "M", "Yearly": "Y"}


class TransformError(Exception):
    """Carries every per-column failure so one 422 can report them all."""

    def __init__(self, errors: List[Dict[str, Any]]) -> None:
        super().__init__("transformation failed")
        self.errors = errors


def suffix_of(filename: str) -> str:
    return PurePosixPath(filename).suffix.lower()


def content_type_for(filename: str) -> str:
    return CONTENT_TYPES.get(suffix_of(filename), "application/octet-stream")


# ---------------------------------------------------------------------------
# read / write
# ---------------------------------------------------------------------------


def read_table(filename: str, raw: bytes) -> pd.DataFrame:
    """Parse an upload with values preserved exactly as written.

    `dtype=object` + `keep_default_na=False` mean a date column is reformatted
    from its real source text rather than from pandas' guess at it, and strings
    like "NA" or "None" survive as themselves instead of becoming NaN.
    """
    ext = suffix_of(filename)
    try:
        if ext in EXCEL_EXT:
            return pd.read_excel(io.BytesIO(raw), dtype=object)
        sep = "\t" if ext == ".tsv" else ","
        try:
            return pd.read_csv(
                io.BytesIO(raw), dtype=object, sep=sep, keep_default_na=False
            )
        except UnicodeDecodeError:
            # Genuinely non-UTF-8 file (legacy Windows exports). Fall back
            # rather than fail, but never silently skip malformed rows.
            return pd.read_csv(
                io.BytesIO(raw), dtype=object, sep=sep,
                keep_default_na=False, encoding="latin-1",
            )
    except Exception as exc:
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


# ---------------------------------------------------------------------------
# up-front validation
# ---------------------------------------------------------------------------


def _err(filename: str, code: str, message: str, column: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"filename": filename, "code": code, "message": message}
    if column is not None:
        out["column"] = column
    return out


def _validate(filename: str, df: pd.DataFrame, spec: ResolvedSpec) -> List[Dict[str, Any]]:
    """Every column any operation names must exist, before anything runs."""
    original = set(df.columns)
    errors: List[Dict[str, Any]] = []
    lu = spec.live_updates

    dropped = set(lu.column_drops)
    for col in lu.column_drops:
        if col not in original:
            errors.append(_err(
                filename, "column_not_found",
                f'Cannot drop "{col}": it is not present in the uploaded file.', col,
            ))
    if dropped >= original and original:
        errors.append(_err(
            filename, "all_columns_dropped",
            "Every column was deselected; keep at least one.",
        ))

    # Drops run first, so everything after them sees only what survived.
    present = original - dropped

    for col in (
        [d.column for d in lu.date_formats]
        + [d.column for d in lu.dtype_changes]
        + [r.from_ for r in lu.column_renames]
    ):
        if col in dropped:
            errors.append(_err(
                filename, "column_dropped",
                f'Column "{col}" is deselected, so it cannot also be transformed.',
                col,
            ))
        elif col not in present:
            errors.append(_err(
                filename, "column_not_found",
                f'Column "{col}" is not present in the uploaded file.', col,
            ))

    # A rename onto a name that survives the rename produces duplicate headers.
    renamed_from = {r.from_ for r in lu.column_renames}
    survivors = present - renamed_from
    seen: set = set()
    for rename in lu.column_renames:
        if rename.to in survivors or rename.to in seen:
            errors.append(_err(
                filename, "rename_collision",
                f'Renaming "{rename.from_}" to "{rename.to}" would produce a '
                f"duplicate column.", rename.from_,
            ))
        seen.add(rename.to)

    # Filters and granularity see post-rename names.
    after = (present - renamed_from) | {r.to for r in lu.column_renames}

    for filt in spec.filters:
        if filt.column not in after:
            errors.append(_err(
                filename, "column_not_found",
                f'Filter references column "{filt.column}", which does not '
                f"exist after renames.", filt.column,
            ))

    if spec.granularity is not None:
        g = spec.granularity
        for label, col in (("date_column", g.date_column), ("geo_column", g.geo_column)):
            if col not in after:
                errors.append(_err(
                    filename, "column_not_found",
                    f'Granularity {label} "{col}" does not exist after renames.', col,
                ))
        for col in list(g.numeric) + list(g.categorical):
            if col not in after:
                errors.append(_err(
                    filename, "column_not_found",
                    f'Granularity references column "{col}", which does not '
                    f"exist after renames.", col,
                ))

    return errors


# ---------------------------------------------------------------------------
# live_updates
# ---------------------------------------------------------------------------


def _blank(series: pd.Series) -> pd.Series:
    return series.isna() | (series.astype(str).str.strip() == "")


def _apply_date_formats(
    filename: str, df: pd.DataFrame, lu: LiveUpdates, errors: List[Dict[str, Any]]
) -> int:
    applied = 0
    for change in lu.date_formats:
        series = df[change.column]
        text = series.astype(str).str.strip()
        parsed = pd.to_datetime(text, format=change.from_, errors="coerce")

        bad = parsed.isna() & ~_blank(series)
        if bad.any():
            pos = int(np.flatnonzero(bad.to_numpy())[0])
            errors.append(_err(
                filename, "date_parse_failed",
                f'Value "{series.iloc[pos]}" at row {pos + 2} does not match '
                f'format "{change.from_}".', change.column,
            ))
            continue

        df[change.column] = parsed.dt.strftime(change.to).where(parsed.notna(), None)
        applied += 1
    return applied


def _cast_value(value: Any, target: str, scale: Optional[int]) -> Any:
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
    filename: str, df: pd.DataFrame, lu: LiveUpdates, errors: List[Dict[str, Any]]
) -> Tuple[int, int]:
    applied = nulled = 0
    for change in lu.dtype_changes:
        out: List[Any] = []
        failed = False
        for idx, value in enumerate(df[change.column].tolist()):
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
                errors.append(_err(
                    filename, "cast_failed",
                    f'Value "{value}" at row {idx + 2} cannot be cast to {target}.',
                    change.column,
                ))
                failed = True
                break
        if not failed:
            df[change.column] = out
            applied += 1
    return applied, nulled


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------


def output_date_formats(lu: LiveUpdates) -> Dict[str, str]:
    """Post-rename column -> the format `date_formats` wrote its values in.

    Filters and the rollup run after `date_formats`, so a column reformatted to
    "%d/%m/%Y" no longer parses by inference the way ISO text does. Carrying the
    format forward keeps every date read in this module explicit; nothing has to
    guess, and the caller never has to restate a format it already gave.
    """
    renames = {r.from_: r.to for r in lu.column_renames}
    return {renames.get(d.column, d.column): d.to for d in lu.date_formats}


def _parse_dates(series: pd.Series, fmt: Optional[str]) -> pd.Series:
    """Parse with the known format; fall back to inference only when unknown."""
    if fmt:
        return pd.to_datetime(series.astype(str).str.strip(), format=fmt, errors="coerce")
    return pd.to_datetime(series, errors="coerce")


def _filter_mask(
    filename: str, df: pd.DataFrame, filt: Any, errors: List[Dict[str, Any]],
    date_formats: Optional[Dict[str, str]] = None,
) -> Optional[pd.Series]:
    """One filter's row mask, or None when the filter cannot be applied.

    Always evaluated against the full incoming frame, never against the result
    of an earlier filter: a row rejected by one filter has to stay available for
    the next, or "any" could not be expressed at all.
    """
    col = df[filt.column]
    kind = filt.type

    if kind == "npi_luhn":
        # Validate each distinct value once, then map back.
        norm = col.astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
        valid = {v for v in norm.unique() if luhn_valid_npi(v)}
        if not valid and len(norm):
            errors.append(_err(
                filename, "npi_luhn_no_matches",
                f'No value in "{filt.column}" is a valid CMS NPI. Check that '
                f"this is the right column before filtering it away.",
                filt.column,
            ))
            return None
        mask = norm.isin(valid)

    elif kind == "date_range":
        parsed = _parse_dates(col, (date_formats or {}).get(filt.column))
        mask = parsed.notna()
        if filt.start:
            mask &= parsed >= pd.Timestamp(filt.start)
        if filt.end:
            mask &= parsed <= pd.Timestamp(filt.end)

    elif kind in ("value_in", "value_not_in"):
        wanted = {str(v) for v in filt.values}
        hit = col.astype(str).str.strip().isin(wanted)
        mask = hit if kind == "value_in" else ~hit

    elif kind == "range":
        nums = pd.to_numeric(col, errors="coerce")
        mask = nums.notna()
        if filt.min is not None:
            mask &= nums >= filt.min
        if filt.max is not None:
            mask &= nums <= filt.max

    elif kind == "not_null":
        mask = ~_blank(col)

    else:  # unreachable: the Literal union constrains `type`
        return None

    return mask.fillna(False)


def _combine(masks: List[pd.Series], mode: str) -> pd.Series:
    """Fold masks together with OR for "any", AND for anything else."""
    combined = masks[0]
    for mask in masks[1:]:
        combined = (combined | mask) if mode == "any" else (combined & mask)
    return combined


def _apply_filters(
    filename: str, df: pd.DataFrame, spec: ResolvedSpec, errors: List[Dict[str, Any]],
    date_formats: Optional[Dict[str, str]] = None,
) -> Tuple[pd.DataFrame, int]:
    """Keep the rows the filter tree accepts.

    Three levels, innermost first:

        filters within a condition  ->  always AND
        conditions within a group   ->  group.mode      (one group per column)
        groups                      ->  spec.filter_mode

    A spec carrying only the flat `filters` list becomes one single-filter
    condition per group, which reduces exactly to the old behaviour under both
    modes - so specs written before groups existed replay unchanged.
    """
    groups = spec.filter_groups or [
        FilterGroup(mode="all", conditions=[FilterCondition(filters=[f])])
        for f in spec.filters
    ]

    applied = 0
    group_masks: List[pd.Series] = []

    for group in groups:
        condition_masks: List[pd.Series] = []
        for condition in group.conditions:
            masks: List[pd.Series] = []
            for filt in condition.filters:
                mask = _filter_mask(filename, df, filt, errors, date_formats)
                if mask is None:
                    continue
                masks.append(mask)
                applied += 1
            if masks:
                condition_masks.append(_combine(masks, "all"))
        if condition_masks:
            group_masks.append(_combine(condition_masks, group.mode))

    if not group_masks:
        return df.reset_index(drop=True), applied

    return df[_combine(group_masks, spec.filter_mode)].reset_index(drop=True), applied


# ---------------------------------------------------------------------------
# granularity
# ---------------------------------------------------------------------------


def _mode(series: pd.Series) -> Any:
    m = series.mode(dropna=True)
    return m.iloc[0] if len(m) else None


AGG_NUMERIC = {
    "sum": "sum", "average": "mean", "min": "min", "max": "max",
    "product": lambda s: pd.to_numeric(s, errors="coerce").dropna().prod(),
}
AGG_CATEGORICAL = {
    "first": "first", "last": "last", "count": "count",
    "distinct_count": "nunique", "mode": _mode,
}


def _apply_granularity(
    filename: str, df: pd.DataFrame, g: Granularity, errors: List[Dict[str, Any]],
    date_formats: Optional[Dict[str, str]] = None,
) -> Tuple[pd.DataFrame, List[str]]:
    parsed = _parse_dates(df[g.date_column], (date_formats or {}).get(g.date_column))
    if parsed.isna().all() and len(df):
        errors.append(_err(
            filename, "date_parse_failed",
            f'Cannot roll up: no value in "{g.date_column}" parses as a date. '
            f"Add a date_formats entry for it first.", g.date_column,
        ))
        return df, []

    period_start = parsed.dt.to_period(PERIOD_FREQ[g.to]).dt.start_time

    work = df.copy()
    work["__period__"] = period_start.dt.strftime("%Y-%m-%d")

    spec: Dict[str, Any] = {}
    for col, op in g.numeric.items():
        work[col] = pd.to_numeric(work[col], errors="coerce")
        spec[col] = AGG_NUMERIC[op]
    for col, op in g.categorical.items():
        spec[col] = AGG_CATEGORICAL[op]

    handled = {g.date_column, g.geo_column, *g.numeric, *g.categorical}
    unhandled = [c for c in df.columns if c not in handled]

    if not spec:
        # Nothing to aggregate: collapse to the distinct grain rather than
        # silently returning the ungrouped frame.
        out = work[[g.geo_column, "__period__"]].drop_duplicates()
    else:
        out = work.groupby([g.geo_column, "__period__"], dropna=False, as_index=False).agg(spec)

    out = out.rename(columns={"__period__": g.date_column})
    ordered = [g.geo_column, g.date_column] + [c for c in out.columns
                                               if c not in (g.geo_column, g.date_column)]
    return out[ordered].reset_index(drop=True), unhandled


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def apply_manifest(
    filename: str, df: pd.DataFrame, spec: ResolvedSpec
) -> Tuple[pd.DataFrame, AppliedCounts]:
    """Replay `spec` against `df`. Raises TransformError with every cause."""
    errors = _validate(filename, df, spec)
    if errors:
        raise TransformError(errors)

    counts = AppliedCounts(rows_in=int(len(df)))
    df = df.copy()
    lu = spec.live_updates

    # Drops first: no point formatting or casting a column that is on its way out.
    if lu.column_drops:
        df = df.drop(columns=[c for c in lu.column_drops if c in df.columns])
        counts.columns_dropped = len(lu.column_drops)

    counts.date_formats = _apply_date_formats(filename, df, lu, errors)
    counts.dtype_changes, counts.nulled_values = _apply_dtype_changes(
        filename, df, lu, errors
    )
    if errors:
        raise TransformError(errors)

    if lu.column_renames:
        df = df.rename(columns={r.from_: r.to for r in lu.column_renames})
        counts.column_renames = len(lu.column_renames)

    # Dates written by `date_formats` are no longer ISO, so everything after it
    # parses them with the format it just wrote rather than guessing.
    date_fmts = output_date_formats(lu)

    if spec.filters:
        df, counts.filters_applied = _apply_filters(
            filename, df, spec, errors, date_fmts
        )
        if errors:
            raise TransformError(errors)

    if spec.granularity is not None:
        df, counts.unhandled_columns = _apply_granularity(
            filename, df, spec.granularity, errors, date_fmts
        )
        if errors:
            raise TransformError(errors)
        counts.granularity_applied = True

    counts.rows_out = int(len(df))
    counts.rows_removed = counts.rows_in - counts.rows_out
    return df, counts


def preview(
    filename: str, df: pd.DataFrame, spec: ResolvedSpec, limit: int = 100
) -> Dict[str, Any]:
    """Dry-run: the exact apply_manifest path, nothing persisted.

    Because this is the same code, a preview that succeeds guarantees the real
    apply succeeds on the same bytes - and a preview that fails reports the
    identical errors the real apply would have.
    """
    out, counts = apply_manifest(filename, df, spec)
    return {
        "filename": filename,
        "dry_run": True,
        "row_count": int(len(out)),
        "columns": [str(c) for c in out.columns],
        "preview": to_records(out, limit),
        "applied": counts.model_dump(),
    }


def to_records(df: pd.DataFrame, limit: int = 100) -> List[Dict[str, Any]]:
    """JSON-safe rows: NaN/NaT/Decimal/Timestamp all become plain values."""
    head = df.head(limit).copy()
    for col in head.columns:
        if pd.api.types.is_datetime64_any_dtype(head[col]):
            head[col] = head[col].dt.strftime("%Y-%m-%d")
        else:
            head[col] = head[col].map(
                lambda v: None
                if v is None or (not isinstance(v, (list, dict, tuple)) and pd.isna(v))
                else (float(v) if isinstance(v, Decimal) else v)
            )
    return head.replace({np.nan: None}).to_dict(orient="records")
