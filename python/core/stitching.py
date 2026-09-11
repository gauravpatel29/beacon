"""Multi-step dataset stitching, for building an Analytical Ready Dataset.

Ported from the `execute_ard_pipeline` prototype, with two changes that fit it
to the v2 architecture:

  * It works on resolved DataFrames rather than CSV text posted in the request
    body. Callers hand it frames loaded from object storage by id, so an ARD
    build is not bounded by request size and the browser never carries data.

  * Join keys that look like dates are normalised with the deterministic parser
    from `processing`, not `pd.to_datetime(..., dayfirst=True)`. Inference there
    reads an ISO date as `%Y-%d-%m` and silently transposes day and month for
    every day-of-month <= 12 - and on a *join key* that does not just corrupt a
    value, it stops rows matching at all, so the damage shows up as a quietly
    smaller ARD rather than an error.

Each step joins a left dataset to a right one. A step's output is registered as
"Step N Result", so later steps can build on it and the whole thing forms a
chain rather than a single join.
"""

from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from core.processing import _parse_dates_robust

# Column names containing any of these are treated as dates when normalising a
# join key, so "1/2/2026" on one side matches "2026-01-02" on the other.
DATE_KEY_HINTS = ("date", "week", "month", "time", "period", "day", "quarter")

JOIN_TYPES = ("left", "inner", "right", "outer", "cross")

# Substring order for descriptive input. "cross" is checked LAST on purpose: a
# join label carries the file name ("Left Join (keep all crosswalk.csv rows)"),
# and a crosswalk is exactly the kind of file this pipeline joins. Matching
# "cross" first would turn that left join into a Cartesian product silently.
_SUBSTRING_ORDER = ("inner", "outer", "right", "left", "cross")


def parse_join_type(value: Any) -> str:
    """Resolve a join type from either an exact value or descriptive text.

    Unrecognised input falls back to "left" - the safest of the five, since it
    preserves the left dataset's row count.
    """
    text = str(value or "").strip().lower()
    if text in JOIN_TYPES:
        return text
    for candidate in _SUBSTRING_ORDER:
        if candidate in text:
            return candidate
    return "left"


class StitchError(Exception):
    """A step could not run. Carries the structured detail the UI renders."""

    def __init__(self, step: Optional[int], code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.step = step
        self.code = code
        self.message = message
        self.extra = extra

    def as_error(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.step is not None:
            out["step"] = self.step
        out.update(self.extra)
        return out


def clean_key_list(value: Any) -> List[str]:
    """Accepts a list or a comma-separated string."""
    if isinstance(value, list):
        return [str(k).strip() for k in value if str(k).strip()]
    if isinstance(value, str):
        return [k.strip() for k in value.split(",") if k.strip()]
    return []


def find_column(df: pd.DataFrame, name: str) -> Optional[str]:
    """Resolve a column name ignoring case and surrounding whitespace."""
    wanted = str(name).strip().lower()
    for col in df.columns:
        if str(col).strip().lower() == wanted:
            return str(col)
    return None


def looks_like_date_key(name: str) -> bool:
    lowered = str(name).lower()
    return any(hint in lowered for hint in DATE_KEY_HINTS)


def normalize_key(series: pd.Series, is_date: bool = False) -> pd.Series:
    """Make a join key comparable across files.

    Numeric ids read as floats lose their trailing ".0", blanks collapse to the
    empty string, and dates become ISO so two files written in different
    conventions still line up.
    """
    text = (
        series.astype(str)
        .str.strip()
        .str.replace(r"\.0$", "", regex=True)
        .replace({"nan": "", "None": "", "null": "", "<NA>": "", "NaN": "", "NaT": ""})
    )
    if not is_date:
        return text

    parsed = _parse_dates_robust(text)
    if parsed.notna().sum() == 0:
        # Not actually dates despite the column name; leave the text alone
        # rather than replacing every value with a blank.
        return text
    return parsed.dt.strftime("%Y-%m-%d").fillna("")


def _aggregate_right(df: pd.DataFrame, keys: List[str]) -> pd.DataFrame:
    """Collapse the right side to one row per key.

    A join against duplicate keys multiplies rows, which is how an ARD silently
    grows past its own grain. Numeric columns are summed, everything else takes
    the first value.
    """
    others = [c for c in df.columns if c not in keys]
    if not others:
        return df.drop_duplicates(subset=keys)

    how: Dict[str, Any] = {}
    for col in others:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() > 0:
            df[col] = numeric.fillna(0)
            how[col] = "sum"
        else:
            how[col] = "first"
    return df.groupby(keys, as_index=False, dropna=False).agg(how)


def execute_pipeline(
    steps: List[Dict[str, Any]],
    frames: Dict[str, pd.DataFrame],
    preview_rows: int = 100,
) -> Dict[str, Any]:
    """Run every step in order and return the stitched dataset.

    `frames` maps dataset name -> DataFrame. Names are matched case-insensitively,
    and each step's output is added as "Step N Result" so it can feed the next.
    """
    if not steps:
        raise StitchError(None, "no_steps", "Add at least one join step.")
    if not frames:
        raise StitchError(None, "no_datasets", "No source datasets were provided.")

    # One registry, looked up case-insensitively, holding both the uploaded
    # datasets and each step's result.
    registry: Dict[str, pd.DataFrame] = {}

    def register(name: str, df: pd.DataFrame) -> None:
        registry[str(name).strip().lower()] = df

    def lookup(name: str) -> Optional[pd.DataFrame]:
        return registry.get(str(name).strip().lower())

    for name, df in frames.items():
        if df is not None and not df.empty:
            register(name, df)

    if not registry:
        raise StitchError(None, "empty_datasets",
                          "Every source dataset is empty, so there is nothing to join.")

    available = sorted({str(n) for n in frames})
    current: Optional[pd.DataFrame] = None
    lineage: List[Dict[str, Any]] = []

    for idx, step in enumerate(steps, start=1):
        left_name = str(step.get("left_file", "")).strip()
        right_name = str(step.get("right_file", "")).strip()
        join_type = parse_join_type(step.get("join_type"))

        left = lookup(left_name)
        right = lookup(right_name)
        if left is None or left.empty:
            raise StitchError(idx, "left_not_found",
                              f'Step {idx}: left dataset "{left_name}" was not found.',
                              available=available)
        if right is None or right.empty:
            raise StitchError(idx, "right_not_found",
                              f'Step {idx}: right dataset "{right_name}" was not found.',
                              available=available)

        left = left.copy()
        right = right.copy()

        before = len(left)
        suffix = f"_step{idx}"

        if join_type == "cross":
            # Every row against every row, so there are no keys to resolve,
            # normalise or aggregate.
            left_keys = []
            current = pd.merge(left, right, how="cross", suffixes=("", suffix))
            lineage_keys = ["(cross join - no keys)"]
        else:
            left_wanted = clean_key_list(step.get("left_key"))
            right_wanted = clean_key_list(step.get("right_key"))
            if not left_wanted or not right_wanted:
                raise StitchError(idx, "keys_missing",
                                  f"Step {idx}: choose a join key on both sides.")
            if len(left_wanted) != len(right_wanted):
                raise StitchError(
                    idx, "key_count_mismatch",
                    f"Step {idx}: {len(left_wanted)} key(s) on the left but "
                    f"{len(right_wanted)} on the right. They must pair up.",
                )

            left_keys = []
            right_keys: List[str] = []
            for lk, rk in zip(left_wanted, right_wanted):
                real_l = find_column(left, lk)
                real_r = find_column(right, rk)
                if not real_l:
                    raise StitchError(idx, "left_key_not_found",
                                      f'Step {idx}: "{lk}" is not a column of "{left_name}".',
                                      column=lk, columns=[str(c) for c in left.columns])
                if not real_r:
                    raise StitchError(idx, "right_key_not_found",
                                      f'Step {idx}: "{rk}" is not a column of "{right_name}".',
                                      column=rk, columns=[str(c) for c in right.columns])
                left_keys.append(real_l)
                right_keys.append(real_r)

            for lk, rk in zip(left_keys, right_keys):
                is_date = looks_like_date_key(lk) or looks_like_date_key(rk)
                left[lk] = normalize_key(left[lk], is_date)
                right[rk] = normalize_key(right[rk], is_date)

            right = _aggregate_right(right, right_keys)

            # Line the right key names up with the left ones, dropping any
            # column already carrying the target name so the rename cannot
            # collide.
            renames = {rk: lk for lk, rk in zip(left_keys, right_keys) if lk != rk}
            if renames:
                clashes = [t for t in renames.values() if t in right.columns and t not in renames]
                if clashes:
                    right = right.drop(columns=clashes)
                right = right.rename(columns=renames)

            current = pd.merge(left, right, on=left_keys, how=join_type,
                               suffixes=("", suffix))
            lineage_keys = left_keys

        # An unmatched row leaves NaN in the other side's metrics. Zero is the
        # meaningful value for spend/calls, so fill those numerics.
        #
        # Deliberately limited to the columns this step brought in from the
        # right: filling every numeric in the frame would also overwrite values
        # that were genuinely missing in the left dataset, and a full outer join
        # creates exactly those. "No data" and "measured zero" have to stay
        # distinguishable for anything feeding a model.
        for col in right.columns:
            if col in left_keys or col not in current.columns:
                continue
            if pd.api.types.is_numeric_dtype(current[col]):
                current[col] = current[col].fillna(0)

        current = current.loc[:, ~current.columns.duplicated()]

        register(f"Step {idx} Result", current.copy())
        lineage.append({
            "step": idx,
            "left": left_name,
            "right": right_name,
            "join": join_type,
            "keys": lineage_keys,
            "rows_in": before,
            "rows_out": int(len(current)),
            # What this step actually produced, so a later step referencing
            # "Step N Result" can offer its real columns as join keys. The
            # client cannot derive this: it would have to guess the union of the
            # two inputs, which misses the duplicate-key collapse and the
            # "_stepN" suffixes this join adds on a name clash.
            "columns": [str(c) for c in current.columns],
        })

    if current is None or current.empty:
        raise StitchError(
            None, "empty_result",
            "The pipeline produced 0 rows. Check that the join keys actually "
            "share values across the files.",
            lineage=lineage,
        )

    out = current.replace({np.nan: None})
    return {
        "df": out,
        "rows": int(len(out)),
        "cols": int(len(out.columns)),
        "columns": [str(c) for c in out.columns],
        "preview": out.head(preview_rows).to_dict(orient="records"),
        "lineage": {"steps_executed": lineage},
    }
