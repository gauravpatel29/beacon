"""Data Review (EDA) endpoints, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_review.py

Correlation is deliberately not covered - it was excluded from the port.

The assertion that matters most is the trend rollup. The source dates are
day-first, and the upstream engine parsed them with `dayfirst=True` inference;
here the format comes from the stored manifest, so January stays January.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# 12 rows across 2 geos and 3 months. `tv` is deliberately sparse (2 of 12
# non-zero) and carries one extreme value to be found as an outlier.
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
    ("B", "01-03-2026", 5000, 9, 0),   # sales outlier
]
CSV = ("geo,week,sales,calls,tv\n" + "".join(
    f"{g},{d},{s},{c},{t}\n" for g, d, s, c, t in ROWS)).encode()

LU = {
    "dtype_changes": [
        {"column": "sales", "to": "integer", "on_error": "null_out"},
        {"column": "calls", "to": "integer", "on_error": "null_out"},
        {"column": "tv", "to": "integer", "on_error": "null_out"},
    ],
    # Source is day-first; kept day-first on output so the rollup has to use
    # the stated format rather than guess.
    "date_formats": [{"column": "week", "from": "%d-%m-%Y", "to": "%d-%m-%Y"}],
}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "review " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("mmm.csv", CSV, "text/csv"))], data={"manifest": "{}"})
        c.patch(f"/v2/workflows/{wf}/files/mmm.csv/spec",
                json={"live_updates": LU, "filters": [], "granularity": None})

        base = f"/v2/workflows/{wf}/review/mmm.csv"

        print("\n1. summary stats, with the new control totals")
        r = c.post(f"{base}/stats", json={"date_column": "week", "geo_column": "geo",
                                          "dependent_variable": "sales"})
        check("stats 200", r.status_code == 200, r.text[:300])
        d = r.json()
        stats = {s["variable"]: s for s in d["summary_stats"]}
        check("control_total present on every column",
              all("control_total" in s for s in stats.values()), list(stats))
        check("sales control total is the column sum (6900)",
              stats["sales"]["control_total"] == 6900, stats["sales"]["control_total"])
        check("calls control total (84)", stats["calls"]["control_total"] == 84,
              stats["calls"]["control_total"])
        check("non-numeric columns report no total",
              stats["geo"]["control_total"] == "—", stats["geo"]["control_total"])

        print("\n2. sparsity: which tactics are too thin to model")
        r = c.post(f"{base}/sparsity", json={"metric_columns": ["sales", "calls", "tv"]})
        check("sparsity 200", r.status_code == 200, r.text[:300])
        table = {t["tactic"]: t for t in r.json()["sparsity_table"]}
        check("tv is 2 of 12 non-zero", table["tv"]["non_zero_count"] == 2,
              table["tv"]["non_zero_count"])
        check("tv flagged critical (<10% would be 1; 16.7% is moderate)",
              table["tv"]["status"] == "warning", table["tv"]["status"])
        check("sales is healthy", table["sales"]["status"] == "healthy", table["sales"]["status"])
        check("sorted by non-zero share, densest first",
              r.json()["sparsity_table"][0]["tactic"] in ("sales", "calls"),
              r.json()["sparsity_table"][0])

        print("\n3. outliers")
        r = c.post(f"{base}/detect-outliers", json={"column": "sales", "method": "iqr",
                                                    "threshold": 1.5})
        check("detect 200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("finds the 5000 row", d["outlier_count"] == 1, d["outlier_count"])
        check("reports the bounds it used", d["upper_bound"] < 5000, d["upper_bound"])
        check("flagged rows previewed", len(d["preview_flagged_rows"]) == 1,
              d["preview_flagged_rows"])

        r = c.post(f"{base}/remove-outliers", json={"column": "sales", "method": "iqr",
                                                    "threshold": 1.5})
        check("remove 200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("11 of 12 rows remain", d["remaining_rows"] == 11, d["remaining_rows"])
        check("returns CSV without writing", "5000" not in d["clean_csv"], d["clean_csv"][:120])
        listed = c.get(f"/v2/workflows/{wf}/files").json()["items"]
        check("removal stored nothing", len(listed) == 1, [x["filename"] for x in listed])

        print("\n4. trend rollup reads the manifest's date format")
        r = c.post(f"{base}/trend-rollup", json={"date_column": "week",
                                                 "metric_columns": ["sales"],
                                                 "period": "month"})
        check("trend 200", r.status_code == 200, r.text[:300])
        trend = {t["date"]: t["sales"] for t in r.json()["trend_data"]}
        # Day-first: 04-01, 11-01, 18-01 are all January. Read as month-first,
        # they would scatter across April, November and... nothing.
        check("three months, not scattered", sorted(trend) == ["2026-01", "2026-02", "2026-03"],
              sorted(trend))
        check("January sums both geos (100+120+130+200+210+220)",
              trend.get("2026-01") == 980, trend.get("2026-01"))
        check("March holds the outlier row (160+5000)", trend.get("2026-03") == 5160,
              trend.get("2026-03"))

        print("\n5. histogram and scatter")
        r = c.post(f"{base}/histogram", json={"column": "calls"})
        check("histogram 200", r.status_code == 200, r.text[:300])
        h = r.json()
        check("small integer range gets one bin per value",
              h["bin_labels"] == [str(n) for n in range(4, 11)], h["bin_labels"])
        check("counts total 12", sum(h["counts"]) == 12, h["counts"])

        r = c.post(f"{base}/scatter", json={"x_column": "calls", "y_column": "sales"})
        check("scatter 200", r.status_code == 200, r.text[:300])
        s = r.json()
        check("r reported", isinstance(s["r"], float), s["r"])
        check("trendline has two endpoints", len(s["trendline"]) == 2, s["trendline"])
        check("all 12 points returned (under the sample cap)", len(s["x"]) == 12, len(s["x"]))

        print("\n6. poor man's curve")
        r = c.post(f"{base}/poor-mans-curve", json={"x_column": "calls", "y_column": "sales",
                                                    "n_bins": 4})
        check("curve 200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("binned curve returned", len(d["binned_curve"]) >= 2, d["binned_curve"])
        check("shape assessed", isinstance(d["shape_indicator"], str), d["shape_indicator"])

        print("\n7. errors name the column")
        r = c.post(f"{base}/histogram", json={"column": "ghost"})
        check("unknown column -> 422", r.status_code == 422
              and r.json()["errors"][0]["code"] == "column_not_found", r.text[:250])
        r = c.post(f"/v2/workflows/{wf}/review/nosuch.csv/histogram", json={"column": "calls"})
        check("unknown dataset -> 404", r.status_code == 404, r.status_code)
        r = c.post(f"{base}/detect-outliers", json={"column": "sales", "method": "nonsense"})
        check("bad method rejected", r.status_code == 422, r.status_code)

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v2/workflows/{wf}/files/mmm.csv")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
