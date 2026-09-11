"""compute_eda_stats edge cases the Data Review screen can actually reach.

    python/.venv/Scripts/python.exe python/tests/test_eda_stats_edges.py

Pure unit tests - no server, no database.

Written after "Recalculate EDA" failed with:

    ValueError: cannot insert npi_id, already exists

The screen auto-detects the Geo key and the KPI from column names. On an ARD
whose first column is the ID and which has no sales-like column, both landed on
the same column, and grouping a column by itself made `reset_index` collide with
its own index name.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402

from core.processing import compute_eda_stats  # noqa: E402

PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def frame():
    return pd.DataFrame({
        "npi_id": ["1001", "1001", "1002", "1002"],
        "week": ["04-01-2026", "11-01-2026", "04-01-2026", "11-01-2026"],
        "trx": [10, 20, 30, 40],
    })


def main() -> int:
    print("\n1. the reported crash: Geo key and KPI are the same column")
    try:
        r = compute_eda_stats(frame(), "week", "npi_id", "npi_id")
        check("does not raise", True)
        check("still returns a by_geo table", isinstance(r["by_geo"], list), r["by_geo"])
        check("rows carry the renamed keys",
              all({"geo", "value"} == set(x) for x in r["by_geo"]), r["by_geo"][:1])
    except Exception as e:
        check("does not raise", False, f"{type(e).__name__}: {e}")

    print("\n2. the same, with the date column as the KPI")
    for geo, dep in (("week", "week"), ("npi_id", "week"), ("week", "npi_id")):
        try:
            compute_eda_stats(frame(), "week", geo, dep)
            check(f"geo={geo!r} dep={dep!r} does not raise", True)
        except Exception as e:
            check(f"geo={geo!r} dep={dep!r} does not raise", False,
                  f"{type(e).__name__}: {e}")

    print("\n3. the normal case is unaffected")
    r = compute_eda_stats(frame(), "week", "npi_id", "trx")
    by_geo = {x["geo"]: x["value"] for x in r["by_geo"]}
    check("per-geo totals correct", by_geo == {"1001": 30, "1002": 70}, by_geo)
    check("sorted by value, largest first",
          [x["value"] for x in r["by_geo"]] == sorted((x["value"] for x in r["by_geo"]),
                                                      reverse=True), r["by_geo"])
    trend = {x["date"]: x["trx"] for x in r["trend_data"]}
    check("day-first dates land in January",
          sorted(trend) == ["2026-01-04", "2026-01-11"], sorted(trend))
    check("trend totals correct", trend == {"2026-01-04": 40, "2026-01-11": 60}, trend)

    print("\n4. the temporary parsing column never escapes")
    # `all_cols` fills the screen's column pickers, so a leaked internal column
    # is offered to the user as if it were part of their data.
    check("all_cols holds only real columns",
          r["all_cols"] == ["npi_id", "week", "trx"], r["all_cols"])
    check("no underscore-prefixed internals",
          not any(c.startswith("_") for c in r["all_cols"]), r["all_cols"])

    print("\n5. the caller's DataFrame is not mutated")
    df = frame()
    before = list(df.columns)
    compute_eda_stats(df, "week", "npi_id", "trx")
    check("columns unchanged", list(df.columns) == before, list(df.columns))

    print("\n6. a geo column with nulls, and an unparseable date column")
    dirty = frame()
    dirty.loc[0, "npi_id"] = None
    r = compute_eda_stats(dirty, "week", "npi_id", "trx")
    check("null geo rows dropped, not crashed", len(r["by_geo"]) == 2, r["by_geo"])

    nodate = frame()
    nodate["week"] = ["not a date"] * 4
    r = compute_eda_stats(nodate, "week", "npi_id", "trx")
    check("unparseable dates give an empty trend, not an error",
          r["trend_data"] == [], r["trend_data"])

    print("\n7. a column the screen offers but that is missing from the data")
    r = compute_eda_stats(frame(), "ghost_date", "npi_id", "trx")
    check("missing date column -> empty trend", r["trend_data"] == [], r["trend_data"])
    r = compute_eda_stats(frame(), "week", "ghost_geo", "trx")
    check("missing geo column -> empty by_geo", r["by_geo"] == [], r["by_geo"])

    print("\n8. ISO week-ending dates are not transposed")
    # The real failure: a stitched ARD carried 26 ISO week-ending dates, and
    # `dayfirst=True` inference made pandas choose %Y-%d-%m - reading 2026-01-04
    # as 1 April and 2026-01-11 as 1 November, while failing outright on
    # 2026-01-18. The chart showed 11 "months" for a six-month file.
    from core.processing import compute_trend_rollup

    weeks = pd.date_range("2026-01-04", periods=26, freq="7D").strftime("%Y-%m-%d")
    iso = pd.DataFrame({
        "npi_id": ["1001"] * 26,
        "week_end_date": weeks,
        "trx": [100] * 26,
    })

    rows = compute_trend_rollup(iso, "week_end_date", ["trx"], "week")
    check("one weekly bucket per week, none merged or lost",
          len(rows) == 26, len(rows))
    check("every week carries its own 100, none doubled up",
          all(r["trx"] == 100 for r in rows), [r["trx"] for r in rows])

    rows = compute_trend_rollup(iso, "week_end_date", ["trx"], "month")
    months = [r["date"] for r in rows]
    # 26 weeks from 4 Jan runs into the first week of July.
    check("months are consecutive and within the real range",
          months == sorted(months) and months[0] == "2026-01" and len(months) <= 7,
          months)
    check("no month outside the data's span",
          all(m.startswith("2026-0") for m in months), months)
    check("all 2600 trx accounted for", sum(r["trx"] for r in rows) == 2600,
          sum(r["trx"] for r in rows))

    # The same column via compute_eda_stats' own trend series.
    r = compute_eda_stats(iso, "week_end_date", "npi_id", "trx")
    check("stats trend agrees with the rollup", len(r["trend_data"]) == 26,
          len(r["trend_data"]))
    dates = [x["date"] for x in r["trend_data"]]
    check("stats trend keeps January in January", dates[0] == "2026-01-04", dates[:3])

    print("\n9. genuinely day-first dates still read day-first")
    dayfirst = pd.DataFrame({
        "npi_id": ["1001"] * 3,
        "d": ["25-01-2026", "26-01-2026", "27-01-2026"],   # unambiguous: day > 12
        "trx": [1, 2, 3],
    })
    rows = compute_trend_rollup(dayfirst, "d", ["trx"], "month")
    check("day-first column lands in January", [r["date"] for r in rows] == ["2026-01"],
          [r["date"] for r in rows])

    return 1 if FAIL else 0


if __name__ == "__main__":
    code = main()
    print("=" * 58)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
    raise SystemExit(code)
