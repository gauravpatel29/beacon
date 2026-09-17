"""Drives the four tabs exactly as the redesigned screen does."""
import io, os, sys, uuid
sys.path.insert(0, r"C:\Users\GauravPatel\procDNA-proj\Beacon branch\Aashika\beacon\python")
import httpx

B = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8070")
c = httpx.Client(base_url=B, timeout=120.0)
PASS, FAIL = [], []
def check(l, cond, x=""):
    (PASS if cond else FAIL).append(l)
    print(("  PASS  " if cond else "  FAIL  ") + l + (f"  :: {x}" if x and not cond else ""))

CSV = ("NPI,DATE,CALLS,REP,NOTES\n"
       "1234567893,04-01-2026,3,R1,routine\n"
       "1234567893,11-01-2026,2,R1,follow up\n"
       "1234567893,18-01-2026,4,R1,call\n"
       "1245319599,04-01-2026,5,R2,intro\n"
       "1245319599,11-01-2026,1,R2,drop\n"
       "1234567890,04-01-2026,9,R3,invalid npi\n").encode()

wf = None
try:
    wf = c.post("/v1/workflows", json={"workflow_name": "screen flow " + uuid.uuid4().hex[:5]}).json()["id"]

    print("\n[upload] drop files, empty manifest")
    r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("calls.csv", CSV, "text/csv"))], data={"manifest": "{}"})
    check("upload 201", r.status_code == 201, r.text[:200])
    check("profile returned inline", bool(r.json()["files"][0].get("profile")))

    print("\n[tab 1] Assign Category — preview rows")
    r = c.get(f"/v2/workflows/{wf}/files/calls.csv", params={"preview_rows": 15})
    check("preview rows for the category tab", len(r.json()["preview"]) == 6, len(r.json()["preview"]))

    print("\n[tab 2] Columns & Types — Keep unchecked drops NOTES, rename + date format")
    spec = {
        "config_metadata": {"category": "hcp_promo"},
        "live_updates": {
            "column_drops": ["NOTES"],
            "date_formats": [{"column": "DATE", "from": "%d-%m-%Y", "to": "%d/%m/%Y"}],
            "dtype_changes": [{"column": "CALLS", "to": "integer"}],
            "column_renames": [{"from": "NPI", "to": "npi"}, {"from": "DATE", "to": "week_end_date"}],
        },
        "filters": [],
    }
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/preview", json=spec)
    check("preview 200", r.status_code == 200, r.text[:300])
    body = r.json()
    check("NOTES dropped", "NOTES" not in body["columns"], body["columns"])
    check("columns_dropped counted", body["applied"]["columns_dropped"] == 1, body["applied"])
    check("renames applied", {"npi", "week_end_date"} <= set(body["columns"]), body["columns"])
    check("target date format honoured",
          body["preview"][0]["week_end_date"] == "04/01/2026", body["preview"][0])
    c.patch(f"/v2/workflows/{wf}/files/calls.csv/spec", json=spec)

    print("\n[tab 2] dropping a column you also transform is rejected")
    bad = {"live_updates": {"column_drops": ["REP"],
                            "column_renames": [{"from": "REP", "to": "rep_id"}]}}
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/preview", json=bad)
    check("column_dropped error", r.status_code == 422
          and any(e["code"] == "column_dropped" for e in r.json().get("errors", [])), r.text[:200])

    print("\n[tab 2] dropping everything is rejected")
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/preview",
               json={"live_updates": {"column_drops": ["NPI","DATE","CALLS","REP","NOTES"]}})
    check("all_columns_dropped error", r.status_code == 422
          and any(e["code"] == "all_columns_dropped" for e in r.json().get("errors", [])), r.text[:200])

    print("\n[tab 3] Filter — Luhn + date range on post-rename names")
    spec_f = {**spec, "filters": [
        {"type": "npi_luhn", "column": "npi"},
        {"type": "date_range", "column": "week_end_date", "start": "2026-01-01", "end": "2026-01-31"}]}
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/preview", json=spec_f)
    check("filter preview 200", r.status_code == 200, r.text[:300])
    check("invalid NPI removed", r.json()["row_count"] == 5, r.json()["row_count"])
    c.patch(f"/v2/workflows/{wf}/files/calls.csv/spec", json=spec_f)

    print("\n[tab 4] Detect Granularity")
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/detect-granularity",
               json={"date_column": "week_end_date",
                     "live_updates": spec_f["live_updates"], "filters": spec_f["filters"]})
    check("detect 200", r.status_code == 200, r.text[:300])
    check("Weekly detected", r.json().get("granularity") == "Weekly", r.json())
    check("range reported", r.json()["distinct_dates"] == 3, r.json())

    print("\n[tab 4] Modify Granularity — Weekly -> Monthly")
    spec_g = {**spec_f, "granularity": {
        "from": "Weekly", "to": "Monthly", "date_column": "week_end_date",
        "geo_column": "npi", "numeric": {"CALLS": "sum"}, "categorical": {}}}
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/preview", json=spec_g)
    check("rollup 200", r.status_code == 200, r.text[:300])
    check("one row per npi per month", r.json()["row_count"] == 2, r.json()["row_count"])
    check("REP reported as unhandled",
          r.json()["applied"]["unhandled_columns"] == ["REP"],
          r.json()["applied"]["unhandled_columns"])

    print("\n[detect] unformatted date column fails loudly")
    r = c.post(f"/v2/workflows/{wf}/files/calls.csv/detect-granularity",
               json={"date_column": "REP", "live_updates": spec["live_updates"]})
    check("non-date column -> 422", r.status_code == 422, r.status_code)

finally:
    if wf:
        for f in ("calls.csv",):
            c.delete(f"/v2/workflows/{wf}/files/{f}")
        c.delete(f"/v1/workflows/{wf}")
        print("\n  cleaned up")
    print("=" * 60)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL: print("   FAILED: " + f)
raise SystemExit(1 if FAIL else 0)
