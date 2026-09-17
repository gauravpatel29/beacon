"""Data Stitching / ARD creation, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_ard.py

Uploads three datasets the way the ingestion screen does, chains two join
steps, and checks the stitched result. Cleans up after itself.
"""

import io
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# Sales: HCP x month.  Dates written day-first.
SALES = (
    "npi,month,trx\n"
    "1234567893,04-01-2026,120\n"   # day 04 -> ambiguous under inference
    "1234567893,11-02-2026,95\n"
    "1245319599,04-01-2026,60\n"
).encode()

# Calls: same grain, ISO dates, and DUPLICATE rows per key to prove the
# right-hand side is aggregated rather than fanning the join out.
CALLS = (
    "NPI,Month,calls\n"
    "1234567893,2026-01-04,3\n"
    "1234567893,2026-01-04,2\n"     # duplicate key: 3 + 2 should become 5
    "1234567893,2026-02-11,4\n"
    "1245319599,2026-01-04,7\n"
).encode()

# Crosswalk: one row per HCP, no date.
XWALK = b"npi,dma_id,dma_name\n1234567893,501,New York\n1245319599,803,Los Angeles\n"


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "ard " + uuid.uuid4().hex[:6]}).json()["id"]

        print("\n1. upload the three sources")
        r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
                   files=[("files", ("sales.csv", SALES, "text/csv")),
                          ("files", ("calls.csv", CALLS, "text/csv")),
                          ("files", ("xwalk.csv", XWALK, "text/csv"))],
                   data={"manifest": "{}"})
        check("upload 201", r.status_code == 201, r.text[:200])

        print("\n2. dry run: two chained steps, nothing stored")
        steps = [
            {"left_file": "sales.csv", "right_file": "calls.csv",
             "left_key": ["npi", "month"], "right_key": ["NPI", "Month"],
             "join_type": "left"},
            {"left_file": "Step 1 Result", "right_file": "xwalk.csv",
             "left_key": ["npi"], "right_key": ["npi"], "join_type": "left"},
        ]
        body = {"steps": steps, "target_grain": "hcp"}
        r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True}, json=body)
        check("dry run 200", r.status_code == 200, r.text[:400])
        d = r.json()
        check("dry run stores nothing",
              not any(x["kind"] == "ard"
                      for x in c.get(f"/v2/workflows/{wf}/files").json()["items"]))

        print("\n3. the join actually matched (the date-key bug)")
        # sales `month` is 04-01-2026 day-first; calls `Month` is 2026-01-04 ISO.
        # Under dayfirst inference the ISO side reads as %Y-%d-%m, turning
        # 2026-01-04 into 04 Jan vs 01 Apr - and the rows stop matching.
        check("all 3 sales rows survive the join", d["row_count"] == 3, d["row_count"])
        check("dry run reports the same fields as a commit",
              {"filename", "row_count", "columns", "preview", "lineage"} <= set(d), sorted(d))
        rows = {(r_["npi"], r_["month"]): r_ for r_ in d["preview"]}
        check("day-first and ISO dates matched",
              all(r_.get("calls") not in (None, 0) for r_ in d["preview"]),
              [(k, v.get("calls")) for k, v in rows.items()])

        print("\n4. duplicate right-hand keys are aggregated, not fanned out")
        jan = rows.get(("1234567893", "2026-01-04"))
        check("duplicate rows summed (3 + 2 = 5)", jan and jan.get("calls") == 5,
              jan.get("calls") if jan else None)

        print("\n5. step 2 chained off step 1")
        check("crosswalk columns present", {"dma_id", "dma_name"} <= set(d["columns"]),
              d["columns"])
        check("lineage records both steps", len(d["lineage"]["steps_executed"]) == 2,
              d["lineage"])

        print("\n5b. lineage reports each step's OUTPUT columns")
        # The stitching UI offers "Step N Result" as a later step's left
        # dataset. That name is virtual - never a file - so the key dropdown
        # has nothing to read unless lineage says what the step produced.
        exec_steps = d["lineage"]["steps_executed"]
        check("every step reports its columns",
              all(s.get("columns") for s in exec_steps),
              [s.get("columns") for s in exec_steps])
        s1_cols = exec_steps[0]["columns"]
        check("step 1 columns come from both sides",
              "trx" in s1_cols and "calls" in s1_cols, s1_cols)
        # Here npi and month are BOTH join keys, so the right-hand copies are
        # consumed rather than carried through. That is the point: the true
        # column set depends on which keys were used, which the client cannot
        # work out from the file listing alone.
        check("join keys are not duplicated into the output",
              s1_cols == ["npi", "month", "trx", "calls"], s1_cols)
        check("no right-hand key columns leaked in",
              not any(c.lower().startswith("npi_") or c.lower().startswith("month_")
                      for c in s1_cols), s1_cols)
        check("step 2 columns include what step 1 carried forward",
              set(s1_cols) <= set(exec_steps[1]["columns"]),
              (s1_cols, exec_steps[1]["columns"]))
        check("the last step's columns are the ARD's columns",
              exec_steps[-1]["columns"] == d["columns"],
              (exec_steps[-1]["columns"], d["columns"]))

        print("\n6. build for real")
        r = c.post(f"/v2/workflows/{wf}/ard/build", json=body)
        check("build 201", r.status_code == 201, r.text[:400])
        ard = r.json()
        check("stored as a dataset with kind=ard", ard["kind"] == "ard", ard.get("kind"))
        check("grain recorded", ard["derived_from"]["grain"] == "hcp", ard.get("derived_from"))
        check("default filename by grain", ard["filename"] == "__ard_hcp__.csv", ard["filename"])

        print("\n7. the ARD behaves like any other dataset")
        csv = c.get(f"/v2/workflows/{wf}/files/__ard_hcp__.csv/csv").text
        check("CSV handoff works", "dma_name" in csv and "New York" in csv, csv[:120])
        listed = c.get(f"/v2/workflows/{wf}/ard").json()["items"]
        check("listed by the ARD endpoint", len(listed) == 1 and listed[0]["grain"] == "hcp",
              listed)

        print("\n8. errors are specific")
        r = c.post(f"/v2/workflows/{wf}/ard/build", json={
            "steps": [{"left_file": "sales.csv", "right_file": "ghost.csv",
                       "left_key": "npi", "right_key": "npi"}]})
        check("unknown dataset -> 422 naming it", r.status_code == 422
              and r.json()["errors"][0]["code"] == "dataset_not_found", r.text[:250])

        r = c.post(f"/v2/workflows/{wf}/ard/build", json={
            "steps": [{"left_file": "sales.csv", "right_file": "xwalk.csv",
                       "left_key": "nope", "right_key": "npi"}]})
        check("unknown key -> 422 naming the column", r.status_code == 422
              and r.json()["errors"][0]["code"] == "left_key_not_found", r.text[:250])

        r = c.post(f"/v2/workflows/{wf}/ard/build", json={
            "steps": [{"left_file": "sales.csv", "right_file": "xwalk.csv",
                       "left_key": ["npi", "month"], "right_key": "npi"}]})
        check("mismatched key counts -> 422", r.status_code == 422
              and r.json()["errors"][0]["code"] == "key_count_mismatch", r.text[:250])

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("__ard_hcp__.csv", "sales.csv", "calls.csv", "xwalk.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
