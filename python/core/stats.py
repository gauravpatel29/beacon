"""Full-frame column statistics: control totals, and what a filter needs to
offer sensible bounds.

Distinct from `core.profile`, and the difference matters:

  * `profile` samples the first 200 rows of the RAW upload to *suggest* how a
    column should be configured. Sampling is right there - it feeds a form that
    a human confirms, and reading a large file twice to pre-fill a dropdown is
    waste.

  * This module reads the WHOLE frame, and the frame as the user will actually
    see it (post-rename, post-dtype, post-format). A "3% null" ribbon computed
    from the first 200 rows would be a number that looks authoritative and
    isn't, and a min/max that excludes 99% of the file gives a range filter
    that silently drops rows. Control totals have to be true totals.

Types are taken from the manifest rather than from pandas. Everything is read
back as `dtype=object` text (see `transform.read_table`), so the spec's
`dtype_changes` is the only statement of what a column *is* - and dates are
parsed with the explicit format `date_formats` wrote them in, never inferred.
"""

from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from core.manifest import LiveUpdates, ResolvedSpec
from core.transform import output_date_formats

# How many distinct values a categorical search may return at once. The UI
# searches as the user types rather than rendering the whole domain, so this
# caps one response, not the column.
VALUES_LIMIT = 50
MAX_VALUES_LIMIT = 500

NUMERIC_DTYPES = {"integer", "bigint", "float", "decimal"}
DATE_DTYPES = {"date", "timestamp"}


def _blank(series: pd.Series) -> pd.Series:
    """Null, or whitespace-only text. Matches `profile._blank` so the two
    modules never disagree about what counts as missing."""
    return series.isna() | (series.astype(str).str.strip() == "")


def _to_numeric(values: pd.Series) -> pd.Series:
    """Thousands separators and a leading currency symbol are formatting, not
    data - the same cleaning `profile._numeric_rate` uses to decide a column is
    numeric in the first place."""
    cleaned = (
        values.astype(str)
        .str.strip()
        .str.replace(",", "", regex=False)
        .str.replace(r"^\$", "", regex=True)
    )
    return pd.to_numeric(cleaned, errors="coerce")


def _kind_map(spec: Optional[ResolvedSpec]) -> Dict[str, str]:
    """Post-rename column -> "number" | "date" | "string".

    Read off the manifest the user configured. A column they never re-typed is
    a string here, which is the honest answer: the profile only ever *suggested*
    a type, and an unconfirmed suggestion is not a fact about the data.
    """
    if spec is None:
        return {}
    lu: LiveUpdates = spec.live_updates
    renames = {r.from_: r.to for r in lu.column_renames}
    kinds: Dict[str, str] = {}

    for change in lu.dtype_changes:
        name = renames.get(change.column, change.column)
        if change.to in NUMERIC_DTYPES:
            kinds[name] = "number"
        elif change.to in DATE_DTYPES:
            kinds[name] = "date"
        else:
            kinds[name] = "string"

    # A date_formats entry is itself a statement that the column holds dates,
    # even when no dtype_change accompanies it.
    for name in output_date_formats(lu):
        kinds[name] = "date"

    return kinds


def _numeric_bounds(values: pd.Series) -> Dict[str, Any]:
    nums = _to_numeric(values).dropna()
    if nums.empty:
        return {"min": None, "max": None}
    lo, hi = float(nums.min()), float(nums.max())
    # Integral bounds come back as ints so a range input doesn't show "0.0".
    whole = bool(np.all(np.equal(np.mod(nums, 1), 0)))
    return {"min": int(lo) if whole else lo, "max": int(hi) if whole else hi}


def _date_bounds(values: pd.Series, fmt: Optional[str]) -> Dict[str, Any]:
    """Bounds as ISO `YYYY-MM-DD`, which is what `date_range` accepts.

    `fmt` is the format `date_formats` wrote the column in. Without it there is
    nothing to do but infer, and inference on day-first text is exactly the
    transposition bug - so an unparseable column reports no bounds rather than
    a plausible wrong one.
    """
    parsed = pd.to_datetime(values, format=fmt, errors="coerce") if fmt \
        else pd.to_datetime(values, errors="coerce")
    parsed = parsed.dropna()
    if parsed.empty:
        return {"min": None, "max": None}
    return {"min": parsed.min().strftime("%Y-%m-%d"),
            "max": parsed.max().strftime("%Y-%m-%d")}


def column_stats(
    name: str, series: pd.Series, kind: str, date_fmt: Optional[str], total: int
) -> Dict[str, Any]:
    blank = _blank(series)
    null_count = int(blank.sum())
    values = series[~blank]

    info: Dict[str, Any] = {
        "column": name,
        "kind": kind,
        "null_count": null_count,
        # Rounded for display; the counts above stay exact for anyone who needs
        # to compute their own. A zero-row file is 0% null, not undefined.
        "null_pct": round(100.0 * null_count / total, 2) if total else 0.0,
        "distinct_count": int(values.nunique()) if len(values) else 0,
    }

    if not len(values):
        info["min"] = info["max"] = None
        return info

    if kind == "number":
        info.update(_numeric_bounds(values))
    elif kind == "date":
        info.update(_date_bounds(values, date_fmt))
    else:
        info["min"] = info["max"] = None

    return info


def frame_stats(df: pd.DataFrame, spec: Optional[ResolvedSpec] = None) -> Dict[str, Any]:
    """Control totals for the ribbon plus per-column filter bounds.

    One pass over the whole frame serving both, because they are the same read:
    the ribbon wants null counts, the filter wants bounds, and splitting them
    would mean loading a large file twice to answer one screen.
    """
    total = int(len(df))
    kinds = _kind_map(spec)
    fmts = output_date_formats(spec.live_updates) if spec else {}

    return {
        "row_count": total,
        # A duplicate is a row identical to an earlier one across every column.
        # `keep="first"` counts the copies, not the originals, so subtracting
        # gives the distinct-row count the user expects.
        "duplicate_rows": int(df.duplicated(keep="first").sum()) if total else 0,
        "columns": [
            column_stats(
                str(col), df[col], kinds.get(str(col), "string"),
                fmts.get(str(col)), total,
            )
            for col in df.columns
        ],
    }


def search_values(
    df: pd.DataFrame, column: str, q: str = "", limit: int = VALUES_LIMIT
) -> Dict[str, Any]:
    """Distinct values of one column, optionally narrowed by a search term.

    Backs the categorical filter's type-ahead. Returning the whole domain would
    be fine for a status column and ruinous for an ID column, so the search
    happens here, over the real data, and only a page of matches crosses the
    wire.
    """
    limit = max(1, min(int(limit or VALUES_LIMIT), MAX_VALUES_LIMIT))
    series = df[column]
    values = series[~_blank(series)].astype(str).str.strip()

    total_distinct = int(values.nunique())
    if q:
        values = values[values.str.contains(q, case=False, regex=False, na=False)]

    counts = values.value_counts()
    items = [{"value": str(v), "count": int(n)} for v, n in counts.head(limit).items()]

    return {
        "column": column,
        "query": q,
        "values": items,
        # Distinct values MATCHING the query, so the UI can say "showing 50 of
        # 312" rather than implying it listed everything.
        "match_count": int(counts.size),
        "distinct_count": total_distinct,
        "truncated": bool(counts.size > len(items)),
    }
