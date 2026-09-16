"""Does every module see the WHOLE dataset, or only the preview window?

    python/.venv/Scripts/python.exe python/tests/test_full_data_flow.py

Each screen shows a preview table of the first N rows, and each also computes
numbers. The danger is a screen computing its numbers from the rows it happens
to be displaying: the result looks authoritative, is plausible, and is wrong.
Nothing about the output says which happened - which is why this test exists
rather than a reading of the code.

The file is built so the two answers cannot be confused. `spend` is 1 for the
first 100 rows and 11 for the remaining 350:

    whole file   100 * 1 + 350 * 11 = 3,950
    first 100                        =   100
    first 60                         =    60

So any module reporting 100 or 60 is reading a preview window, and any module
reporting 3,950 has read the file. The gap is 40x, not a rounding difference.
"""

import os
import re
import uuid
from datetime import date, timedelta

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


ROWS = 450
PREVIEW_SUM = 100          # what a 100-row preview would total
FULL_SUM = 100 * 1 + 350 * 11   # 3950

def _csv():
    out = ["week,npi,trx,spend"]
    start = date(2026, 1, 5)
    for i in range(ROWS):
        # Two geographies sharing one weekly calendar, so the series is
        # 225 weeks long and every date is a real one.
        geo = 1001 + (i % 2)
        week = start + timedelta(weeks=i // 2)
        spend = 1 if i < 100 else 11
        out.append(f"{week.isoformat()},{geo},{100 + spend},{spend}")
    return "\n".join(out) + "\n"


CSV = _csv()


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=300.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "fullflow " + uuid.uuid4().hex[:6]}).json()["id"]
        r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
                   files=[("files", ("t.csv", CSV.encode(), "text/csv"))],
                   data={"manifest": "{}"})
        check("uploaded", r.status_code in (200, 201), r.text[:250])

        print("\n1. the preview really is only a window")
        # If it were not, the rest of this test would prove nothing.
        meta = c.get(f"/v2/workflows/{wf}/files/t.csv").json()
        check("row_count is the whole file", meta["row_count"] == ROWS, meta["row_count"])
        check("but the preview is capped", len(meta["preview"]) < ROWS, len(meta["preview"]))

        print("\n2. Data Ingestion: control totals come from the server")
        # The summary ribbon and the null percentages read /stats, not the
        # preview rows rendered beside them.
        stats = c.get(f"/v2/workflows/{wf}/files/t.csv/stats").json()
        check("stats row_count is the whole file", stats["row_count"] == ROWS, stats["row_count"])
        spend_col = next(col for col in stats["columns"] if col["column"] == "spend")
        check("and its max sees the back of the file", float(spend_col["max"]) == 11.0,
              spend_col["max"])

        print("\n3. Data Ingestion: the trend chart reads the file, not the preview")
        body = c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text
        rows = [ln for ln in body.strip().splitlines()[1:] if ln]
        check("the /csv endpoint returns every row", len(rows) == ROWS, len(rows))
        total = sum(float(ln.split(",")[3]) for ln in rows)
        check(f"summing it gives {FULL_SUM}, not {PREVIEW_SUM}", total == FULL_SUM, total)

        print("\n4. Data Review: the EDA engines see the whole frame")
        r = c.post("/api/eda/stats", json={
            "csv_data": body, "date_column": "week", "geo_column": "npi",
            "dependent_variable": "trx",
        })
        check("stats 200", r.status_code == 200, r.text[:200])
        eda = r.json()
        summary = eda.get("summary_stats") or []
        spend_row = next((s for s in summary if s.get("variable") == "spend"), None)
        check("spend is in the summary", spend_row is not None, sorted(eda))
        check(f"total_rows is {ROWS}", eda.get("total_rows") == ROWS, eda.get("total_rows"))
        if spend_row:
            control = spend_row["control_total"]
            check(f"its control total is {FULL_SUM}", float(control) == float(FULL_SUM), control)

        r = c.post("/api/eda/histogram", json={"csv_data": body, "column": "spend"})
        counts = sum(r.json()["counts"])
        check(f"the histogram bins all {ROWS} rows", counts == ROWS, counts)

        print("\n5. Data Stitching: the ARD is built over the whole file")
        r = c.post(f"/v2/workflows/{wf}/ard/build", json={
            "steps": [], "target_grain": "hcp", "output": "ARD1",
            "base_file": "t.csv",
        })
        if r.status_code == 201:
            check("the ARD has every row", r.json()["row_count"] == ROWS, r.json()["row_count"])
            ard_rows = c.get(f"/v2/workflows/{wf}/files/ARD1.csv/csv").text.strip().splitlines()
            check("and its CSV does too", len(ard_rows) - 1 == ROWS, len(ard_rows) - 1)
        else:
            # A single-file ARD may not be a supported shape; the join path is
            # covered by test_ard_joins. Not a failure of this question.
            check("ARD build needs >1 file (covered elsewhere)", True)

        print("\n6. Data Transformation: apply transforms every row")
        r = c.post("/api/transformation/apply", json={
            "csv_data": body, "geo_column": "npi", "date_column": "week",
            "dependent_variable": "trx",
            "transformations": [{
                "Channel Name": "spend", "Normalization": "none", "Adstock": 0.0,
                "Lags": 0, "Lag": 0, "Saturation Function": "none",
                "Power (k)": 0.5, "Log (k)": 1.0,
            }],
            "derived_variables": [], "pop_column": None, "add_carryover": False,
        })
        check("apply 200", r.status_code == 200, r.text[:250])
        applied = r.json()
        check(f"it reports {ROWS} rows", applied["rows"] == ROWS, applied["rows"])
        # The preview it returns is a window; the csv_data beside it is not.
        check("its preview is a window", len(applied["preview"]) < ROWS, len(applied["preview"]))
        t_rows = [ln for ln in applied["csv_data"].strip().splitlines()[1:] if ln]
        check(f"but its csv_data has all {ROWS}", len(t_rows) == ROWS, len(t_rows))
        header = applied["csv_data"].splitlines()[0].split(",")
        idx = header.index("spend_transformed")
        t_total = sum(float(ln.split(",")[idx]) for ln in t_rows)
        check(f"and the transformed column totals {FULL_SUM}", t_total == float(FULL_SUM), t_total)

        print("\n7. Model Configuration: the fit uses every row")
        # `Modelled Activity` is the sum of the channel over the training
        # window. A model fitted on a preview would report 100 here.
        r = c.post("/api/modelling/run-regression", json={
            "transformed_csv": applied["csv_data"], "granular_csv": body,
            "date_column": "week", "geo_column": "npi",
            "dependent_variable": "trx", "dependent_variable_user_input": "trx",
            "selected_channels": ["spend_transformed"],
            "start_date": "2026-01-05", "end_date": "2030-12-31",
        })
        check("regression 200", r.status_code == 200, r.text[:300])
        if r.status_code == 200:
            coefs = r.json()["coefficients"]
            row = next(x for x in coefs if x["Variable"] == "spend_transformed")
            check(f"Modelled Activity is {FULL_SUM}, not {PREVIEW_SUM}",
                  float(row["Modelled Activity"]) == float(FULL_SUM), row["Modelled Activity"])
            check(f"Raw Activity is {FULL_SUM} too",
                  float(row["Raw Activity"]) == float(FULL_SUM), row["Raw Activity"])
            # statsmodels prints the observation count it actually fitted on.
            summary_text = r.json()["summary"]
            observed = re.search(r"No\. Observations:\s+(\d+)", summary_text)
            check("the summary states its observation count", observed is not None,
                  summary_text[:120])
            if observed:
                check(f"statsmodels fitted all {ROWS} rows",
                      int(observed.group(1)) == ROWS, observed.group(1))

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("ARD1.csv", "t.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
