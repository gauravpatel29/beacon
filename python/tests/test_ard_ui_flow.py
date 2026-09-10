"""Replays exactly what the DataStitching page sends, in page order."""
import os, sys, uuid
sys.path.insert(0, r"C:\Users\GauravPatel\procDNA-proj\Beacon branch\Aashika\beacon\python")
import httpx

B = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8095")
c = httpx.Client(base_url=B, timeout=180.0)
PASS, FAIL = [], []
def check(l, cond, x=""):
    (PASS if cond else FAIL).append(l)
    print(("  PASS  " if cond else "  FAIL  ") + l + (f"  :: {x}" if x and not cond else ""))

SALES = b"npi,month,trx\n1234567893,04-01-2026,120\n1234567893,11-02-2026,95\n1245319599,04-01-2026,60\n"
CALLS = b"NPI,Month,calls\n1234567893,2026-01-04,3\n1234567893,2026-01-04,2\n1234567893,2026-02-11,4\n1245319599,2026-01-04,7\n"
XWALK = b"npi,dma_id,dma_name\n1234567893,501,New York\n1245319599,803,Los Angeles\n"

wf = None
try:
    wf = c.post("/v1/workflows", json={"workflow_name": "ui ard " + uuid.uuid4().hex[:5]}).json()["id"]
    c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
           files=[("files", ("sales.csv", SALES, "text/csv")),
                  ("files", ("calls.csv", CALLS, "text/csv")),
                  ("files", ("xwalk.csv", XWALK, "text/csv"))],
           data={"manifest": "{}"})

    print("\n[page load] v2ListFiles, ARDs excluded from the source list")
    items = c.get(f"/v2/workflows/{wf}/files").json()["items"]
    sources = [d for d in items if d["kind"] != "ard"]
    check("three sources offered", len(sources) == 3, [d["filename"] for d in sources])
    check("each carries columns for the key pickers",
          all(d["columns"] for d in sources), [(d["filename"], d["columns"]) for d in sources])

    print("\n[Run Pipeline] two steps; step 2 joins on id only (no date on a crosswalk)")
    payload = {
        "steps": [
            {"left_file": "sales.csv", "right_file": "calls.csv",
             "left_key": ["npi", "month"], "right_key": ["NPI", "Month"], "join_type": "left"},
            {"left_file": "Step 1 Result", "right_file": "xwalk.csv",
             "left_key": ["npi"], "right_key": ["npi"], "join_type": "left"},
        ],
        "target_grain": "hcp",
        "output": "HCP_Master_ARD",
    }
    r = c.post(f"/v2/workflows/{wf}/ard/build", json=payload)
    check("build 201", r.status_code == 201, r.text[:300])
    res = r.json()
    check("named from the page's field", res["filename"] == "HCP_Master_ARD.csv", res["filename"])
    check("row_count present for the toast", res.get("row_count") == 3, res.get("row_count"))
    check("preview rows for the table", len(res.get("preview") or []) == 3, len(res.get("preview") or []))
    check("lineage for the panel", len((res.get("lineage") or {}).get("steps_executed", [])) == 2,
          res.get("lineage"))
    check("version for the panel", isinstance(res.get("version"), int), res.get("version"))
    check("crosswalk joined through step 2",
          {"dma_id", "dma_name"} <= set(res["columns"]), res["columns"])
    check("duplicate call rows summed, not fanned out",
          any(row.get("calls") == 5 for row in res["preview"]),
          [row.get("calls") for row in res["preview"]])

    print("\n[handoff] v2GetCsv feeds EDA")
    csv = c.get(f"/v2/workflows/{wf}/files/HCP_Master_ARD.csv/csv").text
    check("CSV handoff returns the ARD", "dma_name" in csv and "New York" in csv, csv[:100])

    print("\n[re-open page] the ARD is not offered as its own input")
    again = c.get(f"/v2/workflows/{wf}/files").json()["items"]
    check("ARD excluded from sources",
          len([d for d in again if d["kind"] != "ard"]) == 3
          and any(d["kind"] == "ard" for d in again),
          [(d["filename"], d["kind"]) for d in again])

    print("\n[errors] surface through problemMessage")
    r = c.post(f"/v2/workflows/{wf}/ard/build", json={
        "steps": [{"left_file": "sales.csv", "right_file": "calls.csv",
                   "left_key": ["npi"], "right_key": ["NPI", "Month"]}]})
    check("mismatched key counts -> 422 with a message", r.status_code == 422
          and r.json()["errors"][0]["message"], r.text[:200])
finally:
    if wf:
        for f in ("HCP_Master_ARD.csv", "sales.csv", "calls.csv", "xwalk.csv"):
            c.delete(f"/v2/workflows/{wf}/files/{f}")
        c.delete(f"/v1/workflows/{wf}")
        print("\n  cleaned up")
    print("=" * 56)
    print(f"PASSED {len(PASS)} / {len(PASS)+len(FAIL)}")
    for f in FAIL: print("   FAILED: " + f)
raise SystemExit(1 if FAIL else 0)
