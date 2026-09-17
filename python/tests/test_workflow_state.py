"""Session resume: where a workflow got to, and what each screen had open.

    python/.venv/Scripts/python.exe python/tests/test_workflow_state.py

The workflow row has carried `current_stage`, `current_route`, `module_status`
and `state_data` since the first migration, but nothing wrote to them: every
screen kept its work in component state, so closing the tab lost it and Resume
always reopened Data Ingestion no matter how far the user had got.

The assertion that matters most is section 3. `state_data` used to be replaced
wholesale, so two screens each saving their own key meant whichever saved last
erased the other. It is merged at the top level now, and this pins that.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120.0)
    wf = None
    try:
        print("\n1. a new workflow starts at the beginning")
        created = c.post("/v1/workflows",
                         json={"workflow_name": "state " + uuid.uuid4().hex[:6]}).json()
        wf = created["id"]
        check("current_stage defaults to Data Ingestion",
              created.get("current_stage") == "Data Ingestion", created.get("current_stage"))
        check("current_route defaults to /ingestion",
              created.get("current_route") == "/ingestion", created.get("current_route"))
        check("state_data starts empty", created.get("state_data") == {}, created.get("state_data"))

        print("\n2. moving to a screen records it")
        r = c.patch(f"/v1/workflows/{wf}", json={
            "current_stage": "Data Stitching",
            "current_route": "/data-stitching",
            "module_status": {"stitching": "in_progress"},
        })
        check("200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("the stage is stored", d["current_stage"] == "Data Stitching", d["current_stage"])
        check("the route is stored", d["current_route"] == "/data-stitching", d["current_route"])
        check("and it survives a reload, which is what Resume reads",
              c.get(f"/v1/workflows/{wf}").json()["current_route"] == "/data-stitching")

        print("\n3. one screen saving does NOT erase another's state")
        c.patch(f"/v1/workflows/{wf}", json={"state_data": {
            "stitching": {"activeTabId": "hcp", "drafts": {"hcp": {"steps": [{"leftFile": "a.csv"}]}}},
        }})
        c.patch(f"/v1/workflows/{wf}", json={"state_data": {
            "transformation": {"selected": ["calls", "emails"]},
        }})
        stored = c.get(f"/v1/workflows/{wf}").json()["state_data"]
        check("the second save kept the first screen's key",
              "stitching" in stored, sorted(stored.keys()))
        check("and its contents are intact",
              stored.get("stitching", {}).get("drafts", {}).get("hcp", {}).get("steps")
              == [{"leftFile": "a.csv"}], stored.get("stitching"))
        check("alongside the second screen's key",
              stored.get("transformation", {}).get("selected") == ["calls", "emails"],
              stored.get("transformation"))

        print("\n4. re-saving one key replaces just that key")
        c.patch(f"/v1/workflows/{wf}", json={"state_data": {
            "stitching": {"activeTabId": "dma", "drafts": {}},
        }})
        stored = c.get(f"/v1/workflows/{wf}").json()["state_data"]
        check("the key it wrote is the new value",
              stored["stitching"]["activeTabId"] == "dma", stored["stitching"])
        check("the old steps under that key are gone, not merged into",
              stored["stitching"]["drafts"] == {}, stored["stitching"]["drafts"])
        check("the other screen is still untouched",
              stored["transformation"]["selected"] == ["calls", "emails"],
              stored.get("transformation"))

        print("\n5. module_status accumulates the same way")
        c.patch(f"/v1/workflows/{wf}", json={"module_status": {"ingestion": "completed"}})
        c.patch(f"/v1/workflows/{wf}", json={"module_status": {"review": "in_progress"}})
        ms = c.get(f"/v1/workflows/{wf}").json()["module_status"]
        check("every module reported so far is present",
              {"stitching", "ingestion", "review"} <= set(ms), sorted(ms.keys()))
        check("with the values each screen wrote",
              ms["ingestion"] == "completed" and ms["review"] == "in_progress", ms)

        print("\n6. the listing carries the stage, so Home can show it")
        listed = [w for w in c.get("/v1/workflows").json()["items"] if w["id"] == wf]
        check("the workflow is listed", len(listed) == 1, len(listed))
        if listed:
            check("with its stage, not 'Not Started'",
                  listed[0].get("current_stage") == "Data Stitching",
                  listed[0].get("current_stage"))

        print("\n7. partial updates leave everything else alone")
        before = c.get(f"/v1/workflows/{wf}").json()
        c.patch(f"/v1/workflows/{wf}", json={"workflow_name": "renamed only"})
        after = c.get(f"/v1/workflows/{wf}").json()
        check("the rename applied", after["workflow_name"] == "renamed only",
              after["workflow_name"])
        check("the stage was not reset", after["current_stage"] == before["current_stage"],
              after["current_stage"])
        check("and neither was state_data", after["state_data"] == before["state_data"],
              after["state_data"])

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
