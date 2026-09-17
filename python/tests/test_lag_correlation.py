"""The /api/eda/lag-correlation endpoint added with the Data Review update.

    python/.venv/Scripts/python.exe python/tests/test_lag_correlation.py

The engine it calls, `compute_cross_correlation_lags`, was added in one commit
and deleted in the next while the import and the route stayed in routers/eda.py
- so the whole app failed to start with an ImportError. It is restored here,
with the same explicit-format date parsing the rest of the pipeline uses: the
original inferred with dayfirst=True, which reads an ISO date as %Y-%d-%m and
would scatter one week across several, changing every correlation it reports.
"""

import os

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# Twelve ISO weeks. `spend` leads `sales` by exactly two weeks, so the strongest
# correlation must appear at lag +2 and nowhere else.
WEEKS = [f"2026-{m:02d}-{d:02d}" for m, d in
         [(1, 4), (1, 11), (1, 18), (1, 25), (2, 1), (2, 8),
          (2, 15), (2, 22), (3, 1), (3, 8), (3, 15), (3, 22)]]
SPEND = [10, 50, 20, 60, 30, 70, 40, 80, 20, 90, 35, 15]
SALES = [0, 0, 10, 50, 20, 60, 30, 70, 40, 80, 20, 90]      # spend shifted +2

CSV = "week,spend,sales\n" + "".join(
    f"{w},{sp},{sa}\n" for w, sp, sa in zip(WEEKS, SPEND, SALES))


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120.0)

    print("\n1. the endpoint exists and responds")
    r = c.post("/api/eda/lag-correlation",
               json={"csv_data": CSV, "date_column": "week",
                     "x_column": "spend", "y_column": "sales", "max_lags": 6})
    check("200 (an ImportError here means the engine is missing again)",
          r.status_code == 200, r.text[:300])
    if r.status_code != 200:
        return 1
    lags = r.json()["lag_results"]

    print("\n2. the shape the screen renders")
    check("one entry per lag, -6..+6", len(lags) == 13, len(lags))
    check("every entry has lag, label and correlation",
          all({"lag", "label", "correlation"} <= set(x) for x in lags), lags[:1])
    check("ordered from the most negative lag", [x["lag"] for x in lags] == list(range(-6, 7)),
          [x["lag"] for x in lags])
    check("lag 0 is labelled for humans",
          next(x["label"] for x in lags if x["lag"] == 0) == "Same Week (Lag 0)",
          next(x["label"] for x in lags if x["lag"] == 0))
    check("correlations are real numbers in range",
          all(isinstance(x["correlation"], float) and -1.0 <= x["correlation"] <= 1.0
              for x in lags), lags)

    print("\n3. it finds a lead that is actually in the data")
    best = max(lags, key=lambda x: x["correlation"])
    check("strongest correlation is at lag +2, where spend leads sales",
          best["lag"] == 2, best)
    check("that correlation is near-perfect", best["correlation"] > 0.95, best)
    same_week = next(x["correlation"] for x in lags if x["lag"] == 0)
    check("and it beats the same-week reading", best["correlation"] > same_week,
          (best["correlation"], same_week))

    print("\n4. ISO dates are not transposed")
    # Under dayfirst inference 2026-01-04 reads as 1 April and 2026-01-18 fails
    # outright, so the twelve weeks would collapse into a handful of buckets and
    # the lead above would vanish.
    check("the lead survives, so the weeks stayed distinct", best["lag"] == 2, best)

    print("\n5. it degrades instead of throwing")
    r = c.post("/api/eda/lag-correlation",
               json={"csv_data": CSV, "date_column": "ghost",
                     "x_column": "spend", "y_column": "sales"})
    check("unknown date column -> empty, not a 500",
          r.status_code == 200 and r.json()["lag_results"] == [], r.text[:200])
    r = c.post("/api/eda/lag-correlation",
               json={"csv_data": "week,spend,sales\nnot-a-date,1,2\n",
                     "date_column": "week", "x_column": "spend", "y_column": "sales"})
    check("unparseable dates -> empty, not a 500",
          r.status_code == 200 and r.json()["lag_results"] == [], r.text[:200])

    print("\n6. the rest of the Data Review endpoints still answer")
    for ep, body in (
        ("stats", {"date_column": "week", "geo_column": "spend", "dependent_variable": "sales"}),
        ("trend-rollup", {"date_column": "week", "metric_columns": ["sales"], "period": "week"}),
        ("histogram", {"column": "sales"}),
    ):
        r = c.post(f"/api/eda/{ep}", json={"csv_data": CSV, **body})
        check(f"/{ep} 200", r.status_code == 200, r.text[:200])

    return 1 if FAIL else 0


if __name__ == "__main__":
    code = main()
    print("=" * 58)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
    raise SystemExit(code)
