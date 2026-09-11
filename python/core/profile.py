"""Column profiling: what the UI needs to propose sensible defaults.

This exists to close the gap between two things that are both true:

  * The transform engine must never GUESS a date format. Inferring one is how
    day and month get silently transposed for every day-of-month <= 12.
  * Making a user pick a strftime pattern blind, for every column, is a bad form.

The resolution is that the *server* profiles and *suggests*, the *form* is
pre-filled with the suggestion, and the user confirms or overrides. The manifest
still carries an explicit `from`, so nothing is ever inferred at transform time -
the difference is that a human saw the choice before it was applied.

Ambiguity is reported rather than resolved: "04-01-2026" matches both
%d-%m-%Y and %m-%d-%Y perfectly, and only the person who owns the data knows
which. The profile says so and the UI asks.
"""

from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Detection: unchanged from the original pipeline
# ---------------------------------------------------------------------------
# Whether a column *is* a date is decided by the same rule the pre-v2 ingestion
# screen used - `processing.detect_date_columns_by_sampling`: sample 200 rows,
# keep values of 6+ characters, and call it a date if any of these eight formats
# parses at least 80% of them.
#
# That detection was never the source of the day/month transposition bug. The
# corruption came from *parsing* with `dayfirst=True` inference at transform
# time, which is fixed separately by requiring an explicit `from`. Keeping the
# original detection means the set of columns offered date controls matches what
# users saw before, with no regression in either direction.
LEGACY_DATE_FORMATS = [
    "%d/%m/%Y", "%Y/%m/%d", "%Y/%d/%m", "%m/%d/%Y",
    "%m-%d-%Y", "%d-%m-%Y", "%Y-%d-%m", "%Y-%m-%d",
]
LEGACY_SAMPLE_SIZE = 200
LEGACY_THRESHOLD = 0.8
LEGACY_MIN_LENGTH = 6

# Suggestion only. Once detection says "date", these decide which format to
# pre-fill. Supersets LEGACY_DATE_FORMATS so a detected column always has at
# least one candidate; the extras cover formats the old list missed rather than
# widening what counts as a date.
CANDIDATE_DATE_FORMATS = LEGACY_DATE_FORMATS + [
    "%d.%m.%Y",
    "%Y%m%d",
    "%d-%b-%Y",
    "%d %b %Y",
    "%b %d, %Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
]

# Lower sorts earlier when two formats explain the data equally well. Only
# the genuinely ambiguous layouts need an entry; everything else keeps its
# position in CANDIDATE_DATE_FORMATS.
TIE_BREAK_RANK = {
    "%Y-%m-%d": 0,   # ISO
    "%Y/%m/%d": 1,
    "%d/%m/%Y": 2,   # the UI's own default for slash dates
    "%d-%m-%Y": 3,
    "%m/%d/%Y": 4,
    "%m-%d-%Y": 5,
    "%Y/%d/%m": 8,   # year-day-month: real, but rare
    "%Y-%d-%m": 9,
}

DATE_MATCH_THRESHOLD = LEGACY_THRESHOLD
NUMERIC_THRESHOLD = 0.90
BOOL_THRESHOLD = 0.90
SAMPLE_ROWS = LEGACY_SAMPLE_SIZE   # match the original 200-row sample

BOOL_TRUE = {"true", "1", "yes", "y", "t"}
BOOL_FALSE = {"false", "0", "no", "n", "f"}


def _blank(series: pd.Series) -> pd.Series:
    return series.isna() | (series.astype(str).str.strip() == "")


def _is_date_column(values: pd.Series) -> bool:
    """The original detection rule, ported verbatim.

    Mirrors `processing.detect_date_columns_by_sampling`: values shorter than
    six characters are ignored, and the column is a date as soon as any one of
    the eight legacy formats parses >= 80% of what remains.
    """
    vals = values[values.str.len() >= LEGACY_MIN_LENGTH]
    if vals.empty:
        return False
    for fmt in LEGACY_DATE_FORMATS:
        try:
            parsed = pd.to_datetime(vals, format=fmt, errors="coerce")
        except Exception:
            continue
        if float(parsed.notna().sum()) / len(vals) >= LEGACY_THRESHOLD:
            return True
    return False


def _date_candidates(values: pd.Series) -> List[Dict[str, Any]]:
    """Which formats could produce these values - for pre-filling `from`.

    Only consulted once `_is_date_column` has already said yes, so this widens
    the format choice without widening what counts as a date.
    """
    out: List[Dict[str, Any]] = []
    total = len(values)
    if not total:
        return out
    for fmt in CANDIDATE_DATE_FORMATS:
        parsed = pd.to_datetime(values, format=fmt, errors="coerce")
        rate = float(parsed.notna().sum()) / total
        if rate >= DATE_MATCH_THRESHOLD:
            out.append({"format": fmt, "match_rate": round(rate, 4)})

    # Best first. On a tie, prefer the conventional reading of the layout:
    # "2025-01-04" is ISO far more often than it is year-day-month, and
    # CANDIDATE_DATE_FORMATS happens to list %Y-%d-%m first - which used to
    # decide the winner and pre-fill a `from` that fails on the first
    # day-of-month over 12 anywhere in the file.
    out.sort(key=lambda c: (-c["match_rate"], TIE_BREAK_RANK.get(c["format"], 50)))
    return out


def _numeric_rate(values: pd.Series) -> float:
    if not len(values):
        return 0.0
    cleaned = values.str.replace(",", "", regex=False).str.replace(r"^\$", "", regex=True)
    return float(pd.to_numeric(cleaned, errors="coerce").notna().sum()) / len(values)


def _looks_integer(values: pd.Series) -> bool:
    cleaned = values.str.replace(",", "", regex=False)
    nums = pd.to_numeric(cleaned, errors="coerce").dropna()
    if nums.empty:
        return False
    return bool(np.all(np.equal(np.mod(nums, 1), 0)))


def profile_column(
    name: str, series: pd.Series, full_series: Optional[pd.Series] = None
) -> Dict[str, Any]:
    """Describe one column well enough for a form to pre-fill itself.

    `series` is the sample the legacy heuristics run on. `full_series`, when
    given, is the whole column, and is used ONLY to choose the date format:
    that choice has to hold for every row the transform will later parse, and a
    200-row sample cannot establish it. A file with many rows per date can
    easily open with 200 rows whose day-of-month never exceeds 12, which makes
    %Y-%d-%m fit the sample perfectly and fail at the first later row.
    """
    blank = _blank(series)
    values = series[~blank].astype(str).str.strip()

    info: Dict[str, Any] = {
        "column": name,
        "non_null": int(len(values)),
        "null_count": int(blank.sum()),
        "unique_count": int(values.nunique()),
        "samples": [str(v) for v in values.drop_duplicates().head(3).tolist()],
        "date_candidates": [],
        "ambiguous_date": False,
        "suggested_dtype": "string",
        "suggested_date_from": None,
        "suggested_date_to": None,
    }

    if values.empty:
        return info

    # Detection first, exactly as the original pipeline decided it. Only then is
    # a format suggested, so the two concerns stay separate.
    if _is_date_column(values):
        # Detection stays on the sample - that is the original rule, and which
        # columns are offered date controls must not change. Only the format
        # choice widens to the whole column.
        scope = values
        if full_series is not None:
            full_blank = _blank(full_series)
            full_values = full_series[~full_blank].astype(str).str.strip()
            # Distinct values only: a date column repeats heavily, so this is a
            # few dozen strings even for a file of millions of rows.
            if len(full_values):
                scope = pd.Series(full_values.unique())
        candidates = _date_candidates(scope)
        info["date_candidates"] = candidates

    if info["date_candidates"]:
        candidates = info["date_candidates"]
        best = candidates[0]
        info["suggested_dtype"] = "date"
        info["suggested_date_from"] = best["format"]
        info["suggested_date_to"] = "%Y-%m-%d"
        # More than one format explains the data equally well. Only the data's
        # owner can settle it, so say so rather than pick.
        perfect = [c for c in candidates if c["match_rate"] >= best["match_rate"] - 1e-9]
        info["ambiguous_date"] = len(perfect) > 1
        if info["ambiguous_date"]:
            info["ambiguous_between"] = [c["format"] for c in perfect]
        return info

    lowered = values.str.lower()
    if float(lowered.isin(BOOL_TRUE | BOOL_FALSE).sum()) / len(values) >= BOOL_THRESHOLD:
        info["suggested_dtype"] = "boolean"
        return info

    if _numeric_rate(values) >= NUMERIC_THRESHOLD:
        # Identifier-ish columns stay strings: an NPI or ZIP cast to a number
        # loses leading zeros and picks up float formatting.
        lname = name.lower()
        looks_like_id = any(k in lname for k in ("npi", "zip", "id", "code", "phone"))
        if looks_like_id:
            info["suggested_dtype"] = "string"
            info["id_like"] = True
        else:
            info["suggested_dtype"] = "integer" if _looks_integer(values) else "float"
        return info

    return info


def profile_frame(df: pd.DataFrame, sample_rows: int = SAMPLE_ROWS) -> List[Dict[str, Any]]:
    """Profile every column from the first `sample_rows` rows.

    The full column goes through as well, for the date format alone - see
    `profile_column`.
    """
    head = df.head(sample_rows)
    return [profile_column(str(col), head[col], full_series=df[col]) for col in head.columns]


def date_columns(profile: List[Dict[str, Any]]) -> List[str]:
    """Convenience: the columns that look like dates, in column order."""
    return [c["column"] for c in profile if c["date_candidates"]]
