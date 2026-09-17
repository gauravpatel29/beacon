"""Which source date format the ingestion screen pre-fills.

    python/.venv/Scripts/python.exe python/tests/test_date_format_choice.py

Pure unit tests - no server, no database.

Written after ingestion failed with:

    CALL_DATE: Value "2025-01-13" at row 281 does not match format "%Y-%d-%m".

The data was correct ISO. The profile scored candidate formats against only the
first 200 rows, and that file had many rows per week, so the sample covered
weeks ending 04 and 11 - every day-of-month <= 12. Both %Y-%m-%d and %Y-%d-%m
explained the sample perfectly, and the tie broke toward %Y-%d-%m purely because
it comes first in the legacy format list. Row 281 then could not parse, which is
correct behaviour for an engine that refuses to infer - the pre-filled `from`
was simply wrong.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402

from core.profile import _date_candidates, profile_column, profile_frame  # noqa: E402

PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def weekly_frame():
    """The reported shape: 100 rows per week, five weeks."""
    weeks = ["2025-01-04", "2025-01-11", "2025-01-18", "2025-01-25", "2025-02-01"]
    calls = ["2025-01-06", "2025-01-07", "2025-01-13", "2025-01-20", "2025-02-03"]
    rows = []
    for w, c in zip(weeks, calls):
        rows += [(w, c)] * 100
    return pd.DataFrame(rows, columns=["WEEK_ENDING", "CALL_DATE"])


def main() -> int:
    print("\n1. the reported failure")
    df = weekly_frame()
    sampled = sorted(set(df["WEEK_ENDING"].head(200)))
    check("the 200-row sample really is all day <= 12",
          all(int(d.split("-")[2]) <= 12 for d in sampled), sampled)

    profile = {p["column"]: p for p in profile_frame(df)}
    for col in ("WEEK_ENDING", "CALL_DATE"):
        check(f"{col}: pre-fills ISO, not year-day-month",
              profile[col]["suggested_date_from"] == "%Y-%m-%d",
              profile[col]["suggested_date_from"])
        check(f"{col}: the chosen format parses EVERY row",
              pd.to_datetime(df[col], format=profile[col]["suggested_date_from"],
                             errors="coerce").notna().all())
        check(f"{col}: %Y-%d-%m is not even offered",
              "%Y-%d-%m" not in [c["format"] for c in profile[col]["date_candidates"]],
              [c["format"] for c in profile[col]["date_candidates"]])

    print("\n2. the whole column decides, not the head")
    # Row 281 is the only thing that rules %Y-%d-%m out. Scoring the sample
    # alone cannot see it.
    head_only = profile_column("WEEK_ENDING", df["WEEK_ENDING"].head(200))
    whole = profile_column("WEEK_ENDING", df["WEEK_ENDING"].head(200),
                           full_series=df["WEEK_ENDING"])
    check("the sample alone is genuinely ambiguous",
          head_only["ambiguous_date"], head_only["date_candidates"])
    check("the whole column is not", not whole["ambiguous_date"],
          whole["date_candidates"])

    print("\n3. a file that IS ambiguous throughout still says so")
    # Every day-of-month <= 12 everywhere: nothing in the data can settle it.
    amb = pd.DataFrame({"d": ["2025-01-04", "2025-02-11", "2025-03-09"] * 40})
    p = profile_frame(amb)[0]
    check("reported as ambiguous", p["ambiguous_date"], p["date_candidates"])
    check("still defaults to ISO rather than year-day-month",
          p["suggested_date_from"] == "%Y-%m-%d", p["suggested_date_from"])
    check("both readings offered so the user can choose",
          {"%Y-%m-%d", "%Y-%d-%m"} <= {c["format"] for c in p["date_candidates"]},
          [c["format"] for c in p["date_candidates"]])

    print("\n4. genuinely year-day-month data is still detected")
    # Month <= 12 but day > 12 in the third position -> only %Y-%d-%m fits.
    ydm = pd.DataFrame({"d": ["2025-18-01", "2025-25-01", "2025-13-02"] * 40})
    p = profile_frame(ydm)[0]
    check("picks %Y-%d-%m when that is the only fit",
          p["suggested_date_from"] == "%Y-%d-%m", p["suggested_date_from"])

    print("\n5. day-first and month-first are unaffected")
    dmy = pd.DataFrame({"d": ["25/01/2025", "26/01/2025", "13/02/2025"] * 40})
    check("day-first stays day-first",
          profile_frame(dmy)[0]["suggested_date_from"] == "%d/%m/%Y",
          profile_frame(dmy)[0]["suggested_date_from"])
    mdy = pd.DataFrame({"d": ["01/25/2025", "01/26/2025", "02/13/2025"] * 40})
    check("month-first stays month-first",
          profile_frame(mdy)[0]["suggested_date_from"] == "%m/%d/%Y",
          profile_frame(mdy)[0]["suggested_date_from"])

    print("\n6. the tie-break only applies to real ties")
    # A format that explains more of the column must still win outright.
    mixed = pd.Series(["2025-01-04", "2025-01-11", "2025-01-18", "2025-01-25"])
    ranked = _date_candidates(mixed)
    check("higher match rate beats the tie-break preference",
          ranked[0]["format"] == "%Y-%m-%d" and ranked[0]["match_rate"] == 1.0,
          ranked)

    print("\n7. a date column with blanks still resolves")
    holes = pd.DataFrame({"d": ["2025-01-04", "", "2025-01-18", None] * 60})
    p = profile_frame(holes)[0]
    check("blanks ignored, ISO chosen", p["suggested_date_from"] == "%Y-%m-%d",
          p["suggested_date_from"])

    return 1 if FAIL else 0


if __name__ == "__main__":
    code = main()
    print("=" * 60)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
    raise SystemExit(code)
