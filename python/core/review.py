"""Histogram and scatter for the Data Review screen.

These lived inline in the upstream EDA router. They are here instead because
two routers now need them - the legacy `csv_data` route and the v2 route that
resolves a dataset from storage - and a chart that disagreed with itself
depending on which door the request came through would be worse than either.

Correlation is deliberately not part of this module.
"""

from typing import Any, Dict

import numpy as np
import pandas as pd

# Above this many points the scatter is sampled. Drawing 100k markers does not
# show the reader anything the sample does not, and the payload is the cost.
SCATTER_SAMPLE = 600
MAX_BINS = 25


NUMERIC_DTYPES = {"integer", "bigint", "float", "decimal"}
DATE_DTYPES = {"date", "timestamp"}


def analysis_frame(df: pd.DataFrame, spec=None) -> pd.DataFrame:
    """Give the frame real dtypes before anything tries to classify it.

    `transform.read_table` reads every column as object on purpose: a date must
    be reformatted from its own source text, not from pandas' guess at it. That
    is right for the transform pipeline and wrong for analysis, because
    `infer_column_semantic_type` calls any non-numeric dtype a Dimension - so
    over the v2 route every metric in the file would land in the wrong half of
    the summary table, with no total and no mean.

    The legacy csv_data route never hit this: `read_csv` inferred dtypes for
    free. This restores the same footing without re-introducing the guessing,
    by casting from what the manifest actually states, and only falling back to
    inference for columns the user has not typed.

    Dates are left as text. `compute_eda_stats` parses them itself, and the
    trend rollup is handed the manifest's format separately.
    """
    out = df.copy()

    declared_numeric: set = set()
    declared_other: set = set()
    if spec is not None:
        lu = spec.live_updates
        renames = {r.from_: r.to for r in lu.column_renames}
        for change in lu.dtype_changes:
            name = renames.get(change.column, change.column)
            (declared_numeric if change.to in NUMERIC_DTYPES else declared_other).add(name)
        for name in (renames.get(d.column, d.column) for d in lu.date_formats):
            declared_other.add(name)

    for col in out.columns:
        name = str(col)
        if name in declared_other:
            continue  # a stated date or string stays as it is

        values = out[col]
        blank = values.isna() | (values.astype(str).str.strip() == "")
        present = values[~blank]
        if not len(present):
            continue

        cleaned = (present.astype(str).str.strip()
                   .str.replace(",", "", regex=False)
                   .str.replace(r"^\$", "", regex=True))
        nums = pd.to_numeric(cleaned, errors="coerce")

        # Declared numeric: cast, and let anything unparseable become NaN - the
        # manifest already said what this column is. Undeclared: cast only when
        # EVERY present value is a number, which is the bar read_csv applies.
        if name in declared_numeric or nums.notna().all():
            casted = pd.Series(pd.NA, index=out.index, dtype="object")
            casted.loc[present.index] = nums
            out[col] = pd.to_numeric(casted, errors="coerce")

    return out


def histogram_of(df: pd.DataFrame, col: str) -> Dict[str, Any]:
    """Binned distribution of one numeric column.

    Small integer ranges get one bin per value - a column of 1..8 call counts
    reads as eight bars, not as "1.0 - 1.9". Everything else gets sqrt(n) bins,
    capped, which is the usual compromise between detail and noise.
    """
    vals = pd.to_numeric(df[col], errors="coerce").dropna()
    if len(vals) == 0:
        return {"counts": [], "bin_edges": [], "bin_labels": [],
                "mean": 0, "median": 0, "min": 0, "max": 0, "column": col}

    min_val = float(vals.min())
    max_val = float(vals.max())
    is_integer = bool((vals % 1 == 0).all())
    val_range = max_val - min_val

    if is_integer and 0 < val_range <= MAX_BINS:
        bin_edges = np.arange(min_val, max_val + 2) - 0.5
        counts, _ = np.histogram(vals, bins=bin_edges)
        bin_labels = [str(int(x)) for x in np.arange(min_val, max_val + 1)]
    else:
        num_bins = min(MAX_BINS, max(5, int(len(vals) ** 0.5)))
        counts, bin_edges = np.histogram(vals, bins=num_bins)
        bin_labels = [f"{bin_edges[i]:.1f} - {bin_edges[i + 1]:.1f}" for i in range(len(counts))]

    return {
        "counts": counts.tolist(),
        "bin_labels": bin_labels,
        "bin_edges": np.asarray(bin_edges).tolist(),
        "mean": float(vals.mean()),
        "median": float(vals.median()),
        "min": min_val,
        "max": max_val,
        "column": col,
    }


def scatter_of(df: pd.DataFrame, x_col: str, y_col: str) -> Dict[str, Any]:
    """Scatter of two numeric columns, with r and a least-squares trendline.

    The trendline is fitted on ALL points and only then is the scatter sampled,
    so the line the user sees is the line through the real data rather than
    through whichever 600 points happened to be drawn.
    """
    sub = df[[x_col, y_col]].dropna().copy()
    sub[x_col] = pd.to_numeric(sub[x_col], errors="coerce")
    sub[y_col] = pd.to_numeric(sub[y_col], errors="coerce")
    sub = sub.dropna()

    empty = {"x": [], "y": [], "r": 0, "trendline": [],
             "x_column": x_col, "y_column": y_col, "slope": 0, "intercept": 0}
    if len(sub) < 2:
        return empty

    x_vals = sub[x_col].values
    y_vals = sub[y_col].values

    # A column with no spread has no line and no correlation - polyfit would
    # warn and return nonsense rather than fail.
    if float(np.ptp(x_vals)) == 0.0:
        return {**empty, "x": sub[x_col].tolist(), "y": sub[y_col].tolist()}

    r_val = float(sub[x_col].corr(sub[y_col]))
    m, c = np.polyfit(x_vals, y_vals, 1)

    min_x = float(np.min(x_vals))
    max_x = float(np.max(x_vals))
    trendline = [
        {"x": min_x, "y": float(m * min_x + c)},
        {"x": max_x, "y": float(m * max_x + c)},
    ]

    if len(sub) > SCATTER_SAMPLE:
        sub = sub.sample(SCATTER_SAMPLE, random_state=42).sort_values(x_col)

    return {
        "x": sub[x_col].tolist(),
        "y": sub[y_col].tolist(),
        "r": round(r_val, 4) if not np.isnan(r_val) else 0.0,
        "slope": float(m),
        "intercept": float(c),
        "trendline": trendline,
        "x_column": x_col,
        "y_column": y_col,
    }
