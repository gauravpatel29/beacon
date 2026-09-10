"""Control totals + filter bounds, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_stats.py

Uploads one small file with known nulls and one exact duplicate row, then
checks /stats and /values. Cleans up after itself.

The assertion that matters most is the date bound: the source is day-first
(04-01-2026 .. 12-01-2026 = 4 Jan .. 12 Jan). Read by inference those become
April .. December, and a date filter seeded from them would silently exclude
the whole file.
"""
import os
import uuid

import httpx
BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
c=httpx.Client(base_url=BASE,timeout=180.0)
PASS,FAIL=[],[]
def check(l,cond,d=""):
    (PASS if cond else FAIL).append(l)
    print(("  PASS  " if cond else "  FAIL  ")+l+(f"  :: {d}" if d and not cond else ""))

# 10 rows; row 9 duplicates row 1 exactly. `region` blank twice, `trx` blank once.
CSV=(
 "npi,region,trx,month\n"
 "1234567893,East,100,04-01-2026\n"
 "1234567891,West,200,05-01-2026\n"
 "1234567892,,300,06-01-2026\n"
 "1234567894,East,,07-01-2026\n"
 "1234567895,North,500,08-01-2026\n"
 "1234567896,,600,09-01-2026\n"
 "1234567897,West,700,10-01-2026\n"
 "1234567898,South,800,11-01-2026\n"
 "1234567893,East,100,04-01-2026\n"   # exact duplicate of row 1
 "1234567899,East,900,12-01-2026\n"
).encode()

wf=c.post("/v1/workflows",json={"workflow_name":"stats "+uuid.uuid4().hex[:6]}).json()["id"]
try:
    c.post(f"/v2/workflows/{wf}/files",params={"overwrite":True},
           files=[("files",("s.csv",CSV,"text/csv"))],data={"manifest":"{}"})

    print("\n1. control totals on the raw upload")
    r=c.get(f"/v2/workflows/{wf}/files/s.csv/stats")
    check("stats 200", r.status_code==200, r.text[:300])
    d=r.json()
    check("row_count is the whole file", d["row_count"]==10, d["row_count"])
    check("duplicate_rows counts the copy, not the original", d["duplicate_rows"]==1, d["duplicate_rows"])
    cols={x["column"]:x for x in d["columns"]}
    check("region: 2 of 10 null -> 20%", cols["region"]["null_count"]==2 and cols["region"]["null_pct"]==20.0,
          (cols["region"]["null_count"],cols["region"]["null_pct"]))
    check("trx: 1 of 10 null -> 10%", cols["trx"]["null_pct"]==10.0, cols["trx"]["null_pct"])
    check("npi: no nulls -> 0%", cols["npi"]["null_pct"]==0.0, cols["npi"]["null_pct"])
    check("untyped column reports as string", cols["trx"]["kind"]=="string", cols["trx"]["kind"])

    print("\n2. after typing the columns, bounds appear")
    spec={"live_updates":{"dtype_changes":[{"column":"trx","to":"integer","on_error":"null_out"}],
                          "date_formats":[{"column":"month","from":"%d-%m-%Y","to":"%Y-%m-%d"}]},
          "filters":[],"granularity":None}
    r=c.patch(f"/v2/workflows/{wf}/files/s.csv/spec",json=spec)
    check("spec committed", r.status_code==200, r.text[:300])
    d=c.get(f"/v2/workflows/{wf}/files/s.csv/stats").json()
    cols={x["column"]:x for x in d["columns"]}
    check("trx now numeric", cols["trx"]["kind"]=="number", cols["trx"]["kind"])
    check("numeric bounds are whole numbers", cols["trx"]["min"]==100 and cols["trx"]["max"]==900,
          (cols["trx"]["min"],cols["trx"]["max"]))
    check("month now a date", cols["month"]["kind"]=="date", cols["month"]["kind"])
    # THE BUG THAT MATTERS: source is day-first 04-01-2026 = 4 Jan .. 12-01-2026 = 12 Jan.
    check("date bounds read day-first correctly (not Apr..Dec)",
          cols["month"]["min"]=="2026-01-04" and cols["month"]["max"]=="2026-01-12",
          (cols["month"]["min"],cols["month"]["max"]))
    check("string column reports no bounds", cols["region"]["min"] is None, cols["region"]["min"])
    check("distinct counts present (blanks excluded)", cols["region"]["distinct_count"]==4, cols["region"]["distinct_count"])

    print("\n3. type-ahead over distinct values")
    r=c.get(f"/v2/workflows/{wf}/files/s.csv/values",params={"column":"region"})
    check("values 200", r.status_code==200, r.text[:200])
    v=r.json()
    check("blank values excluded", all(x["value"].strip() for x in v["values"]), v["values"])
    check("East counted 4 times", next(x["count"] for x in v["values"] if x["value"]=="East")==4, v["values"])
    check("ordered by frequency", v["values"][0]["value"]=="East", v["values"][0])
    r=c.get(f"/v2/workflows/{wf}/files/s.csv/values",params={"column":"region","q":"est"})
    v=r.json()
    check("search 'est' matches West only (case-insensitive substring)",
          [x["value"] for x in v["values"]]==["West"], v["values"])
    check("match_count reflects the query", v["match_count"]==1, v["match_count"])
    r=c.get(f"/v2/workflows/{wf}/files/s.csv/values",params={"column":"region","limit":2})
    v=r.json()
    check("limit honoured and truncation flagged", len(v["values"])==2 and v["truncated"], v)

    print("\n4. errors")
    r=c.get(f"/v2/workflows/{wf}/files/s.csv/values",params={"column":"ghost"})
    check("unknown column -> 422 naming it", r.status_code==422
          and r.json()["errors"][0]["code"]=="column_not_found", r.text[:200])
finally:
    c.delete(f"/v2/workflows/{wf}/files/s.csv"); c.delete(f"/v1/workflows/{wf}")
    print("\n"+"="*56+f"\nPASSED {len(PASS)} / {len(PASS)+len(FAIL)}")
    for f in FAIL: print("   FAILED: "+f)
