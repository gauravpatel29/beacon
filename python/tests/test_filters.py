"""The exact filter payloads buildFilters() emits, against the live API."""
import uuid
import httpx

BASE = "http://127.0.0.1:8090"
c = httpx.Client(base_url=BASE, timeout=180.0)
PASS, FAIL = [], []


def check(l, cond, d=""):
    (PASS if cond else FAIL).append(l)
    print(("  PASS  " if cond else "  FAIL  ") + l + (f"  :: {d}" if d and not cond else ""))


# Four real NPIs (verified against core.transform.luhn_valid_npi); row 3's
# 1234567890 fails the CMS checksum. Dates are day-first.
CSV = (
    "npi,region,trx,month\n"
    "1234567893,East,100,04-01-2026\n"
    "1234567901,West,200,05-02-2026\n"
    "1234567890,East,300,06-03-2026\n"
    "1234567919,North,,07-01-2026\n"
    "1234567927,West,500,08-01-2026\n"
).encode()

LU = {"dtype_changes": [{"column": "trx", "to": "integer", "on_error": "null_out"}],
      "date_formats": [{"column": "month", "from": "%d-%m-%Y", "to": "%Y-%m-%d"}]}

wf = c.post("/v1/workflows", json={"workflow_name": "flt " + uuid.uuid4().hex[:6]}).json()["id"]


def preview(filters):
    return c.post(f"/v2/workflows/{wf}/files/s.csv/preview",
                  json={"live_updates": LU, "filters": filters, "granularity": None})


try:
    c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
           files=[("files", ("s.csv", CSV, "text/csv"))], data={"manifest": "{}"})

    print("\n1. range (numeric)")
    r = preview([{"type": "range", "column": "trx", "min": 200, "max": 400}])
    check("accepted", r.status_code == 200, r.text[:300])
    check("keeps 200 and 300 only", r.json()["row_count"] == 2, r.json()["row_count"])

    r = preview([{"type": "range", "column": "trx", "max": 200}])
    check("open lower bound accepted", r.status_code == 200 and r.json()["row_count"] == 2,
          r.text[:200])

    print("\n2. date_range")
    # Jan 4, Feb 5, Mar 6, Jan 7, Jan 8 -> January holds three rows.
    r = preview([{"type": "date_range", "column": "month",
                  "start": "2026-01-01", "end": "2026-01-31"}])
    check("accepted", r.status_code == 200, r.text[:300])
    check("day-first source read correctly: 3 January rows",
          r.json()["row_count"] == 3, r.json()["row_count"])

    print("\n3. value_in")
    r = preview([{"type": "value_in", "column": "region", "values": ["East", "North"]}])
    check("accepted", r.status_code == 200, r.text[:300])
    check("keeps 3 rows", r.json()["row_count"] == 3, r.json()["row_count"])

    print("\n4. npi_luhn")
    r = preview([{"type": "npi_luhn", "column": "npi"}])
    check("accepted", r.status_code == 200, r.text[:300])
    check("drops the one invalid NPI", r.json()["row_count"] == 4, r.json()["row_count"])

    print("\n5. not_null")
    r = preview([{"type": "not_null", "column": "trx"}])
    check("accepted", r.status_code == 200, r.text[:300])
    check("drops the blank trx row", r.json()["row_count"] == 4, r.json()["row_count"])

    print("\n6. several columns at once, as the tab sends them")
    r = preview([
        {"type": "not_null", "column": "trx"},
        {"type": "npi_luhn", "column": "npi"},
        {"type": "range", "column": "trx", "min": 100},
        {"type": "value_in", "column": "region", "values": ["East", "West"]},
        {"type": "date_range", "column": "month", "start": "2026-01-01"},
    ])
    check("all five accepted together", r.status_code == 200, r.text[:400])
    # Rows 1, 2 and 5 survive. Row 3 fails Luhn, row 4 has a null trx. Row 2 is
    # February and still passes: the date_range has a start and no end, so it is
    # open-ended forward - which is the point of allowing one-sided bounds.
    check("three rows survive", r.json()["row_count"] == 3, r.json()["row_count"])

    print("\n6b. adding the end bound closes February out")
    r = preview([
        {"type": "not_null", "column": "trx"},
        {"type": "npi_luhn", "column": "npi"},
        {"type": "range", "column": "trx", "min": 100},
        {"type": "value_in", "column": "region", "values": ["East", "West"]},
        {"type": "date_range", "column": "month", "start": "2026-01-01", "end": "2026-01-31"},
    ])
    check("now two rows survive", r.status_code == 200 and r.json()["row_count"] == 2,
          r.json().get("row_count"))

    print("\n7. /stats reflects a committed filter")
    c.patch(f"/v2/workflows/{wf}/files/s.csv/spec",
            json={"live_updates": LU, "filters": [{"type": "not_null", "column": "trx"}],
                  "granularity": None})
    d = c.get(f"/v2/workflows/{wf}/files/s.csv/stats").json()
    check("row_count follows the filter", d["row_count"] == 4, d["row_count"])
    cols = {x["column"]: x for x in d["columns"]}
    check("trx now has no nulls", cols["trx"]["null_pct"] == 0.0, cols["trx"]["null_pct"])
    check("bounds recomputed on the filtered frame",
          cols["trx"]["min"] == 100 and cols["trx"]["max"] == 500,
          (cols["trx"]["min"], cols["trx"]["max"]))
finally:
    c.delete(f"/v2/workflows/{wf}/files/s.csv")
    c.delete(f"/v1/workflows/{wf}")
    print("\n" + "=" * 56 + f"\nPASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
