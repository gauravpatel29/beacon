"""The ARD registry the Data Review screen reads.

    python/.venv/Scripts/python.exe python/tests/test_ard_registry.py

EDA.jsx populates its "Active ARD Dataset Under Review" selector from
GET /v2/workflows/{id}/ard and then fetches the chosen one by filename. This
pins that contract: the fields the option label renders, newest-first ordering,
and that every listed ARD is actually fetchable by name.

It exists because the screen previously depended on an in-memory handoff from
the stitching page. CSV payloads are never persisted to localStorage (they blow
the quota), so that handoff did not survive a reload and the screen came up
empty. Reading the registry is what fixes it - so the registry has to hold.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


SALES = b"npi,month,trx\n1234567893,04-01-2026,120\n1245319599,05-01-2026,60\n"
XWALK = b"npi,dma_id\n1234567893,501\n1245319599,803\n"
STEPS = [{"left_file": "s.csv", "right_file": "x.csv",
          "left_key": ["npi"], "right_key": ["npi"], "join_type": "left"}]

# What the option label in EDA.jsx reads off each item.
SELECTOR_FIELDS = {"filename", "grain", "row_count", "columns", "version"}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "registry " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("s.csv", SALES, "text/csv")),
                      ("files", ("x.csv", XWALK, "text/csv"))],
               data={"manifest": "{}"})

        print("\n1. an empty workflow offers nothing rather than failing")
        r = c.get(f"/v2/workflows/{wf}/ard")
        check("list 200 on a workflow with no ARDs", r.status_code == 200, r.text[:200])
        check("empty list", r.json()["items"] == [], r.json()["items"])

        print("\n2. build one ARD per grain")
        for name, grain in (("HCP_ARD", "hcp"), ("DMA_ARD", "dma")):
            r = c.post(f"/v2/workflows/{wf}/ard/build",
                       json={"steps": STEPS, "target_grain": grain, "output": name})
            check(f"{name} built", r.status_code == 201, r.text[:250])

        items = c.get(f"/v2/workflows/{wf}/ard").json()["items"]
        check("both ARDs listed", len(items) == 2, [i["filename"] for i in items])

        print("\n3. the selector can render every option")
        for item in items:
            check(f"{item['filename']}: has the fields the label uses",
                  SELECTOR_FIELDS <= set(item), sorted(SELECTOR_FIELDS - set(item)))
            check(f"{item['filename']}: grain populated", bool(item["grain"]), item["grain"])
            check(f"{item['filename']}: column list non-empty", len(item["columns"]) > 0,
                  item["columns"])

        # A DMA ARD used to be invisible on this screen: the stitching page put
        # it in `filteredCsvData` while EDA read `granularCsvData` first, so the
        # ingested file shadowed it. Listing by workflow makes grain irrelevant.
        check("the DMA-grain ARD is listed, not shadowed",
              any(i["grain"] == "dma" for i in items), [i["grain"] for i in items])

        print("\n4. newest first - the screen defaults to items[0]")
        check("DMA_ARD (built last) is first", items[0]["filename"] == "DMA_ARD.csv",
              [i["filename"] for i in items])

        print("\n5. every listed ARD is fetchable by the name shown")
        for item in items:
            r = c.get(f"/v2/workflows/{wf}/files/{item['filename']}/csv")
            check(f"{item['filename']}: CSV fetched", r.status_code == 200, r.text[:150])
            header = r.text.splitlines()[0].split(",")
            check(f"{item['filename']}: header matches the listed columns",
                  header == item["columns"], (header, item["columns"]))
            body_rows = len(r.text.strip().splitlines()) - 1
            check(f"{item['filename']}: row count matches the label",
                  body_rows == item["row_count"], (body_rows, item["row_count"]))

        print("\n6. rebuilding under the same name versions it rather than duplicating")
        c.post(f"/v2/workflows/{wf}/ard/build",
               json={"steps": STEPS, "target_grain": "hcp", "output": "HCP_ARD"})
        items = c.get(f"/v2/workflows/{wf}/ard").json()["items"]
        check("still two entries, not three", len(items) == 2,
              [i["filename"] for i in items])
        hcp = next(i for i in items if i["filename"] == "HCP_ARD.csv")
        check("version incremented", hcp["version"] == 2, hcp["version"])

        print("\n7. a deleted ARD leaves the registry")
        c.delete(f"/v2/workflows/{wf}/files/DMA_ARD.csv")
        items = c.get(f"/v2/workflows/{wf}/ard").json()["items"]
        check("one left", [i["filename"] for i in items] == ["HCP_ARD.csv"],
              [i["filename"] for i in items])

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("HCP_ARD.csv", "DMA_ARD.csv", "s.csv", "x.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
