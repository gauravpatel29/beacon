"""Outlier detection across both routers, end to end against the live backend.

    python/.venv/Scripts/python.exe python/tests/test_outliers.py

Written after a pull landed a second copy of detect_outliers_engine and
remove_outliers_engine in core/processing.py. Python keeps the last definition,
so the later copy won and the earlier one became dead code - and the two had
different signatures. Two consequences, both covered here:

  * /api/eda/detect-outliers and /remove-outliers pass six positional
    arguments. The surviving copy took four, so every request raised
    TypeError. Sections 1 and 2 would have caught that.

  * The surviving copy had no percentile branch; "percentile" fell through to
    its `else`, which is IQR. Callers got IQR numbers back under the label they
    asked for. Section 3 pins the three methods to genuinely different answers,
    which is what a silent fall-through cannot satisfy.

The copies are now merged into one engine supporting all three methods.
"""

import io
import os
import uuid

import httpx
import numpy as np
import pandas as pd

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def sample_csv() -> str:
    rng = np.random.default_rng(7)
    vals = list(rng.normal(100.0, 10.0, 240)) + [2.0, 500.0]
    dates = pd.date_range("2026-01-05", periods=len(vals), freq="D").strftime("%Y-%m-%d")
    df = pd.DataFrame({"week_end_date": dates,
                       "geo": ["G1"] * len(vals),
                       "trx": [round(float(v), 3) for v in vals]})
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    return buf.getvalue()


CSV = sample_csv()


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        print("\n1. /api/eda/detect-outliers - the six-argument call")
        for method in ("percentile", "zscore", "iqr"):
            r = c.post("/api/eda/detect-outliers", json={
                "csv_data": CSV, "column": "trx", "method": method,
                "threshold": 3.0, "lower_percentile": 1.0, "upper_percentile": 99.0,
            })
            check(f"{method} -> 200, not a TypeError", r.status_code == 200, r.text[:200])

        print("\n2. /api/eda/remove-outliers - same call shape")
        r = c.post("/api/eda/remove-outliers", json={
            "csv_data": CSV, "column": "trx", "method": "percentile",
            "threshold": 3.0, "lower_percentile": 1.0, "upper_percentile": 99.0,
        })
        check("200", r.status_code == 200, r.text[:200])
        if r.status_code == 200:
            d = r.json()
            check("it actually dropped rows", d["dropped_rows"] > 0, d.get("dropped_rows"))
            check("and returned the remainder as CSV",
                  d["remaining_rows"] == d["original_rows"] - d["dropped_rows"],
                  (d.get("original_rows"), d.get("dropped_rows"), d.get("remaining_rows")))

        print("\n3. the three methods give genuinely different answers")
        bounds, labels = {}, {}
        for method, thr in (("percentile", 3.0), ("zscore", 3.0), ("iqr", 1.5)):
            r = c.post("/api/eda/detect-outliers", json={
                "csv_data": CSV, "column": "trx", "method": method, "threshold": thr,
                "lower_percentile": 1.0, "upper_percentile": 99.0,
            })
            d = r.json()
            bounds[method] = (round(d["lower_bound"], 4), round(d["upper_bound"], 4))
            labels[method] = d["method"]
            # The z-score label carries a sigma, which a cp1252 console cannot
            # print. The response itself is UTF-8 JSON and unaffected.
            safe = labels[method].encode("ascii", "replace").decode("ascii")
            print(f"      {method:11} {bounds[method]}  n={d['outlier_count']}  {safe}")
        check("percentile is not silently IQR",
              bounds["percentile"] != bounds["iqr"], bounds)
        check("z-score is its own answer too",
              bounds["zscore"] not in (bounds["iqr"], bounds["percentile"]), bounds)
        check("the returned label names the method that actually ran",
              "percentile" in labels["percentile"].lower()
              and "iqr" in labels["iqr"].lower()
              and "z-score" in labels["zscore"].lower(), labels)

        print("\n4. the same three through the /v2 review router")
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "outliers " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("o.csv", CSV.encode(), "text/csv"))],
               data={"manifest": "{}"})
        c.patch(f"/v2/workflows/{wf}/files/o.csv/spec", json={
            "live_updates": {"dtype_changes": [
                {"column": "trx", "to": "float", "on_error": "null_out"}]},
            "filters": [], "granularity": None,
        })

        def v2(body):
            return c.post(f"/v2/workflows/{wf}/review/o.csv/detect-outliers", json=body)

        r = v2({"column": "trx", "method": "percentile",
                "lower_percentile": 1.0, "upper_percentile": 99.0})
        check("percentile is accepted, not a 422", r.status_code == 200, r.text[:300])
        v2_pct = (round(r.json()["lower_bound"], 4), round(r.json()["upper_bound"], 4))
        check("and matches what the v1 route computed for the same input",
              v2_pct == bounds["percentile"], (v2_pct, bounds["percentile"]))

        r = v2({"column": "trx", "method": "zscore", "threshold": 3.0})
        check("zscore still accepted", r.status_code == 200, r.text[:200])
        r = v2({"column": "trx", "method": "iqr", "threshold": 1.5})
        check("iqr still accepted, so Aashika's method is reachable",
              r.status_code == 200, r.text[:200])
        check("iqr through v2 matches the v1 route",
              (round(r.json()["lower_bound"], 4), round(r.json()["upper_bound"], 4))
              == bounds["iqr"], r.json().get("lower_bound"))

        print("\n5. the bounds are validated")
        check("a percentile above 100 is refused",
              v2({"column": "trx", "method": "percentile",
                  "lower_percentile": 1.0, "upper_percentile": 140.0}).status_code == 422)
        check("an unknown method is refused",
              v2({"column": "trx", "method": "vibes"}).status_code == 422)

        print("\n6. removal through /v2 honours the percentile bounds")
        r = c.post(f"/v2/workflows/{wf}/review/o.csv/remove-outliers", json={
            "column": "trx", "method": "percentile",
            "lower_percentile": 1.0, "upper_percentile": 99.0})
        check("200", r.status_code == 200, r.text[:200])
        if r.status_code == 200:
            check("dropped the same count the detector flagged",
                  r.json()["dropped_rows"] == v2({
                      "column": "trx", "method": "percentile",
                      "lower_percentile": 1.0, "upper_percentile": 99.0,
                  }).json()["outlier_count"], r.json().get("dropped_rows"))

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v2/workflows/{wf}/files/o.csv")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
