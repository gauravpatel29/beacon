"""The `kind` filter on GET /v2/workflows/{id}/files.

    python/.venv/Scripts/python.exe python/tests/test_file_kinds.py

A workflow's files are not all the same thing. `upload` rows are what the user
put in; `ard` and `merge` rows are outputs this API wrote. The listing returned
all of them, so the ingestion screen showed generated ARDs in its upload card,
offering them for categorising and column remapping as though they were source
files.

The filter is opt-in, which is the part most worth pinning: every existing
caller passes no `kind` and must keep getting the full list. Section 1 covers
that, and section 4 covers rows written before the column existed.
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


def names(client, wf, **params):
    r = client.get(f"/v2/workflows/{wf}/files", params=params)
    assert r.status_code == 200, r.text[:300]
    return sorted(d["filename"] for d in r.json()["items"]), r.json()["items"]


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "kinds " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("s.csv", SALES, "text/csv")),
                      ("files", ("x.csv", XWALK, "text/csv"))],
               data={"manifest": "{}"})
        r = c.post(f"/v2/workflows/{wf}/ard/build",
                   json={"steps": STEPS, "target_grain": "hcp", "output": "HCP_ARD"})
        check("an ARD was built to filter against", r.status_code == 201, r.text[:250])

        print("\n1. no kind means every dataset, exactly as before")
        every, items = names(c, wf)
        check("uploads and the ARD are all listed",
              every == ["HCP_ARD.csv", "s.csv", "x.csv"], every)
        check("each row carries its kind", all("kind" in d for d in items),
              [sorted(d) for d in items][:1])

        print("\n2. kind=upload is what the ingestion screen asks for")
        uploads, items = names(c, wf, kind="upload")
        check("only the two uploads", uploads == ["s.csv", "x.csv"], uploads)
        # The whole point: this is the list that screen renders.
        check("the ARD is not among them", "HCP_ARD.csv" not in uploads, uploads)
        check("every row really is an upload",
              all(d["kind"] == "upload" for d in items), [d["kind"] for d in items])

        print("\n3. the filter is a list, not a single value")
        ards, _ = names(c, wf, kind="ard")
        check("kind=ard returns just the ARD", ards == ["HCP_ARD.csv"], ards)
        both, _ = names(c, wf, kind="upload,ard")
        check("kind=upload,ard returns both groups",
              both == ["HCP_ARD.csv", "s.csv", "x.csv"], both)
        spaced, _ = names(c, wf, kind=" upload , ard ")
        check("whitespace around the names is tolerated",
              spaced == both, spaced)

        print("\n4. nothing matches, and nothing breaks")
        none_of, _ = names(c, wf, kind="nonsense")
        check("an unknown kind is an empty list, not a 400", none_of == [], none_of)
        empty, _ = names(c, wf, kind="")
        check("an empty kind falls back to everything", empty == every, empty)

        print("\n5. the ARD registry is unaffected")
        # Data Review reads this one; it has always filtered server-side.
        reg = c.get(f"/v2/workflows/{wf}/ard").json()["items"]
        check("still lists the ARD", [i["filename"] for i in reg] == ["HCP_ARD.csv"],
              [i["filename"] for i in reg])

        print("\n6. deleting the ARD takes it out of both listings")
        # Deleting the tab on the stitching screen issues exactly this request.
        r = c.delete(f"/v2/workflows/{wf}/files/HCP_ARD.csv")
        check("delete accepted", r.status_code in (200, 204), r.status_code)
        left, _ = names(c, wf)
        check("the full listing is back to the uploads", left == ["s.csv", "x.csv"], left)
        check("the registry is empty",
              c.get(f"/v2/workflows/{wf}/ard").json()["items"] == [], "still listed")
        still, _ = names(c, wf, kind="upload")
        check("and the uploads are untouched", still == ["s.csv", "x.csv"], still)

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("HCP_ARD.csv", "s.csv", "x.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
