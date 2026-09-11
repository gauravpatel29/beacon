"""The Data Review screen's own call sequence, against /api/eda.

    python/.venv/Scripts/python.exe python/tests/test_review_screen.py

Replays exactly what client/src/pages/EDA.jsx sends, tab by tab, with the same
payload shapes and the same chained dependencies (tab 1's `numeric_cols` feeds
the sparsity call; the outlier tab feeds its own removal). It needs no database
- the legacy route takes the CSV in the body.

Correlation (tab 5) is deliberately not covered: it was excluded from the port.
"""

import os

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


ROWS = [
    ("A", "04-01-2026", 100, 5, 0),
    ("A", "11-01-2026", 120, 6, 0),
    ("A", "18-01-2026", 130, 7, 0),
    ("A", "01-02-2026", 140, 8, 0),
    ("A", "08-02-2026", 150, 9, 900),
    ("A", "01-03-2026", 160, 10, 0),
    ("B", "04-01-2026", 200, 4, 0),
    ("B", "11-01-2026", 210, 5, 0),
    ("B", "18-01-2026", 220, 6, 0),
    ("B", "01-02-2026", 230, 7, 0),
    ("B", "08-02-2026", 240, 8, 50),
    ("B", "01-03-2026", 5000, 9, 0),
]
CSV = "geo,week,sales,calls,tv\n" + "".join(
    f"{g},{d},{s},{c},{t}\n" for g, d, s, c, t in ROWS)


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120.0)

    print("\ntab 1 - summary stats and sparsity")
    # EDA.jsx: handleRunEDA()
    r = c.post("/api/eda/stats", json={"csv_data": CSV, "date_column": "week",
                                       "geo_column": "geo", "dependent_variable": "sales"})
    check("stats 200", r.status_code == 200, r.text[:300])
    stats = r.json()
    check("numeric_cols drives the sparsity call", stats.get("numeric_cols"),
          stats.get("numeric_cols"))
    check("control_total rendered by the summary table",
          all("control_total" in s for s in stats["summary_stats"]),
          [s["variable"] for s in stats["summary_stats"] if "control_total" not in s])

    # EDA.jsx: edaSparsity({ csv_data, metric_columns: statsResult.numeric_cols })
    r = c.post("/api/eda/sparsity", json={"csv_data": CSV,
                                          "metric_columns": stats["numeric_cols"]})
    check("sparsity 200", r.status_code == 200, r.text[:300])
    table = r.json()["sparsity_table"]
    check("every metric keyed by `tactic`", all("tactic" in row for row in table), table[:1])
    check("tv flagged as sparse", next(x["status"] for x in table if x["tactic"] == "tv") != "healthy",
          table)

    print("\ntab 2 - time trends")
    # EDA.jsx: edaTrendRollup({ csv_data, date_column, metric_columns, period })
    for period in ("week", "month"):
        r = c.post("/api/eda/trend-rollup", json={"csv_data": CSV, "date_column": "week",
                                                  "metric_columns": ["sales", "calls"],
                                                  "period": period})
        check(f"trend-rollup ({period}) 200", r.status_code == 200, r.text[:300])
        rows = r.json()["trend_data"]
        check(f"{period}: rows carry `date` and the metrics",
              rows and all({"date", "sales", "calls"} <= set(x) for x in rows), rows[:1])
    # The chart plots res.trend_data directly, so ordering is the API's job.
    dates = [x["date"] for x in rows]
    check("months returned in order", dates == sorted(dates), dates)

    # EDA.jsx also runs a bivariate scatter on this tab.
    r = c.post("/api/eda/scatter", json={"csv_data": CSV, "x_column": "calls",
                                         "y_column": "sales"})
    check("bivariate scatter 200", r.status_code == 200, r.text[:300])

    print("\ntab 3 - distributions and outliers")
    # EDA.jsx fires these two together via Promise.all
    h = c.post("/api/eda/histogram", json={"csv_data": CSV, "column": "sales"})
    o = c.post("/api/eda/detect-outliers", json={"csv_data": CSV, "column": "sales",
                                                 "method": "iqr", "threshold": 1.5})
    check("histogram 200", h.status_code == 200, h.text[:300])
    check("detect-outliers 200", o.status_code == 200, o.text[:300])
    check("histogram gives counts and labels of equal length",
          len(h.json()["counts"]) == len(h.json()["bin_labels"]),
          (len(h.json()["counts"]), len(h.json()["bin_labels"])))
    check("outlier found", o.json()["outlier_count"] == 1, o.json()["outlier_count"])

    r = c.post("/api/eda/detect-outliers", json={"csv_data": CSV, "column": "sales",
                                                 "method": "zscore", "threshold": 2.0})
    check("zscore method also works (the tab's method toggle)",
          r.status_code == 200, r.text[:300])

    # EDA.jsx: removal writes res.clean_csv back into app state, so the shape matters.
    r = c.post("/api/eda/remove-outliers", json={"csv_data": CSV, "column": "sales",
                                                 "method": "iqr", "threshold": 1.5})
    check("remove-outliers 200", r.status_code == 200, r.text[:300])
    clean = r.json()["clean_csv"]
    check("clean_csv is a usable CSV the next screen can parse",
          clean.splitlines()[0] == "geo,week,sales,calls,tv", clean.splitlines()[0])
    check("one row dropped", len(clean.strip().splitlines()) == len(ROWS),
          len(clean.strip().splitlines()))
    # The page re-runs EDA on the cleaned CSV; it has to survive a round trip.
    r = c.post("/api/eda/stats", json={"csv_data": clean, "date_column": "week",
                                       "geo_column": "geo", "dependent_variable": "sales"})
    check("cleaned CSV round-trips back through stats", r.status_code == 200, r.text[:300])
    check("total reflects the removal (6900 - 5000)",
          next(s["control_total"] for s in r.json()["summary_stats"]
               if s["variable"] == "sales") == 1900,
          next(s["control_total"] for s in r.json()["summary_stats"] if s["variable"] == "sales"))

    print("\ntab 4 - poor man's response curve")
    p = c.post("/api/eda/poor-mans-curve", json={"csv_data": CSV, "x_column": "calls",
                                                 "y_column": "sales", "n_bins": 12})
    s = c.post("/api/eda/scatter", json={"csv_data": CSV, "x_column": "calls",
                                         "y_column": "sales"})
    check("poor-mans-curve 200", p.status_code == 200, p.text[:300])
    check("scatter 200", s.status_code == 200, s.text[:300])
    d = p.json()
    check("binned_curve rows carry what the chart plots",
          d["binned_curve"] and all({"spend_x", "response_y", "bin_label"} <= set(x)
                                    for x in d["binned_curve"]), d["binned_curve"][:1])
    check("shape_indicator is a string for the caption",
          isinstance(d["shape_indicator"], str), d["shape_indicator"])
    check("scatter trendline drawn from two points", len(s.json()["trendline"]) == 2,
          s.json()["trendline"])

    print("\ntab 2 on a real stitched-ARD shape")
    # The trend chart is driven entirely by `numeric_cols` from tab 1: it fills
    # the metric chips, the chips fill `selectedTrendMetrics`, and the rollup
    # fetch is guarded on that being non-empty. So an ARD whose ID-ish columns
    # all classify as Dimensions must still leave real metrics behind, or tab 2
    # renders nothing at all.
    ard = ("npi,month,trx,calls,dma_id,dma_name\n"
           "1234567893,04-01-2026,120,3,501,New York\n"
           "1234567893,11-01-2026,95,2,501,New York\n"
           "1245319599,04-01-2026,60,7,803,Los Angeles\n"
           "1245319599,08-02-2026,80,5,803,Los Angeles\n")
    r = c.post("/api/eda/stats", json={"csv_data": ard, "date_column": "month",
                                       "geo_column": "npi", "dependent_variable": "trx"})
    check("ARD-shaped stats 200", r.status_code == 200, r.text[:300])
    ard_stats = r.json()
    check("metrics survive the ID-token rule (npi, dma_id are Dimensions)",
          ard_stats["numeric_cols"] == ["trx", "calls"], ard_stats["numeric_cols"])

    for period, expected in (("month", {"2026-01": 275, "2026-02": 80}),
                             ("week", None)):
        r = c.post("/api/eda/trend-rollup",
                   json={"csv_data": ard, "date_column": "month",
                         "metric_columns": ard_stats["numeric_cols"], "period": period})
        check(f"{period} rollup 200", r.status_code == 200, r.text[:300])
        rows = r.json()["trend_data"]
        check(f"{period} rollup is non-empty - an empty one renders a blank tab",
              len(rows) > 0, rows)
        if expected:
            got = {x["date"]: x["trx"] for x in rows}
            check("month totals correct (day-first dates)", got == expected, got)
        check(f"{period}: every selected metric present on every row",
              all(set(ard_stats["numeric_cols"]) <= set(x) for x in rows), rows[:1])

    # The screen would silently show an empty chart if this 422'd instead.
    r = c.post("/api/eda/trend-rollup", json={"csv_data": ard, "date_column": "month",
                                              "metric_columns": [], "period": "week"})
    check("no metrics selected -> empty data, not an error",
          r.status_code == 200, r.text[:200])

    print("\nedge cases the screen can reach")
    r = c.post("/api/eda/histogram", json={"csv_data": CSV, "column": "geo"})
    check("histogram on a text column returns empty, not 500",
          r.status_code == 200 and r.json()["counts"] == [], r.text[:200])
    r = c.post("/api/eda/scatter", json={"csv_data": CSV, "x_column": "tv",
                                         "y_column": "sales"})
    check("scatter on a mostly-zero column still responds",
          r.status_code == 200, r.text[:200])
    r = c.post("/api/eda/histogram", json={"csv_data": CSV, "column": "ghost"})
    check("unknown column -> 400, not 500", r.status_code == 400, r.status_code)

    return 1 if FAIL else 0


if __name__ == "__main__":
    code = main()
    print("=" * 58)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
    raise SystemExit(code)
