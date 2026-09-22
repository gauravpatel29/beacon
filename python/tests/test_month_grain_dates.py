"""A month-grain date column: detected, castable, and rolled up.

    python/.venv/Scripts/python.exe python/tests/test_month_grain_dates.py

A monthly file stores its period as "2023-01" - a year and a month, no day.
Every format in the detector expected a day, so such a column was reported as
"not detected", could not be cast to a date, and was left as text.

Nothing failed loudly. The engine reads "2023-01" perfectly well (pandas takes
it as the first of that month), so granularity detection said Monthly while
the Standardize tab said the column was not a date.

Pinned here:
  * the column is detected as a date, and its source format is the year-month one;
  * casting it succeeds and keeps the grain rather than inventing a day;
  * nothing that was detected before changes - a full date never falls through
    to the year-month format;
  * granularity still reads Monthly off it.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# One row per month per geography, exactly as the real files are shaped.
MONTHLY = "DMA,Month,TRx\n" + "".join(
    f"{geo},2023-{m:02d},{100 + m}\n" for geo in ("New York", "Boston") for m in range(1, 13)
)

# A full ISO date, to prove the widening did not change existing behaviour.
DAILY = "DMA,Day,TRx\n" + "".join(
    f"NY,2023-01-{d:02d},{d}\n" for d in range(1, 21)
)


def col(profile, name):
    return next((p for p in profile if p["column"] == name), {})


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "monthgrain " + uuid.uuid4().hex[:6]}).json()["id"]
        r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
                   files=[("files", ("m.csv", MONTHLY.encode(), "text/csv")),
                          ("files", ("d.csv", DAILY.encode(), "text/csv")),
                          ],
                   data={"manifest": "{}"})
        check("uploaded", r.status_code in (200, 201), r.text[:250])

        print("\n1. the year-month column is recognised as a date")
        prof = c.get(f"/v2/workflows/{wf}/files/m.csv/profile").json()["profile"]
        month = col(prof, "Month")
        check("Month is suggested as a date", month.get("suggested_dtype") == "date",
              month.get("suggested_dtype"))
        check("and its source format is the year-month one",
              month.get("suggested_date_from") == "%Y-%m", month.get("suggested_date_from"))

        print("\n2. the widening did not touch anything else")
        check("DMA is still not a date", col(prof, "DMA").get("suggested_dtype") != "date",
              col(prof, "DMA").get("suggested_dtype"))
        check("TRx is still numeric", col(prof, "TRx").get("suggested_dtype") in ("integer", "float"),
              col(prof, "TRx").get("suggested_dtype"))
        # A full date cannot be explained by a year-month format, so a column
        # that was detected before is detected the same way now.
        dprof = c.get(f"/v2/workflows/{wf}/files/d.csv/profile").json()["profile"]
        day = col(dprof, "Day")
        check("a full ISO date is still detected", day.get("suggested_dtype") == "date",
              day.get("suggested_dtype"))
        check("and still reports a day-bearing format",
              day.get("suggested_date_from") == "%Y-%m-%d", day.get("suggested_date_from"))

        print("\n3. casting it keeps the grain")
        # Target %Y-%m: rewriting "2023-01" as "01/01/2023" would invent a day.
        r = c.patch(f"/v2/workflows/{wf}/files/m.csv/spec", json={
            "live_updates": {
                "dtype_changes": [{"column": "Month", "to": "date"}],
                "date_formats": [{"column": "Month", "from": "%Y-%m", "to": "%Y-%m"}],
            },
        })
        check("the cast is accepted", r.status_code == 200, r.text[:300])
        body = c.get(f"/v2/workflows/{wf}/files/m.csv/csv").text
        rows = [ln for ln in body.strip().splitlines()[1:] if ln]
        check("every row survived", len(rows) == 24, len(rows))
        first_month = rows[0].split(",")[1]
        check("and the value is still a year-month", first_month == "2023-01", first_month)

        print("\n4. granularity reads Monthly off it")
        r = c.post(f"/v2/workflows/{wf}/files/m.csv/detect-granularity", json={
            "date_column": "Month",
            "live_updates": {
                "dtype_changes": [{"column": "Month", "to": "date"}],
                "date_formats": [{"column": "Month", "from": "%Y-%m", "to": "%Y-%m"}],
            },
        })
        check("detection succeeds", r.status_code == 200, r.text[:300])
        if r.status_code == 200:
            g = r.json()
            check("and says Monthly", g["granularity"] == "Monthly", g["granularity"])
            check("over 12 distinct months", g["distinct_dates"] == 12, g["distinct_dates"])

        print("\n5. a target that invents a day is still allowed, just not the default")
        # Some files genuinely want a full date out; the API must not refuse it.
        r = c.patch(f"/v2/workflows/{wf}/files/m.csv/spec", json={
            "live_updates": {
                "dtype_changes": [{"column": "Month", "to": "date"}],
                "date_formats": [{"column": "Month", "from": "%Y-%m", "to": "%d/%m/%Y"}],
            },
        })
        check("a day-bearing target is accepted", r.status_code == 200, r.text[:300])
        out = c.get(f"/v2/workflows/{wf}/files/m.csv/csv").text.strip().splitlines()[1]
        check("and lands on the first of the month", out.split(",")[1] == "01/01/2023",
              out.split(",")[1])

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("m.csv", "d.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
