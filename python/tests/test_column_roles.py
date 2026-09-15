"""Column-level categories survive a round trip through the manifest.

    python/.venv/Scripts/python.exe python/tests/test_column_roles.py

The file category says what a FILE is. Column roles say what each column in it
is - Time, Cross-sectional, Dependent, Promotion, Baseline - and every screen
after ingestion reads them instead of guessing from column names.

They live in `config_metadata`, which the Manifest types as a free-form
`Dict[str, Any]`: the engine stores it and never interprets it. That is the
whole contract, and it is worth pinning precisely because nothing validates it:

  * the block round-trips unchanged through PATCH /spec and GET /files;
  * it survives a re-derive, so roles are not lost when a filter or a rename is
    applied afterwards;
  * it does NOT reach the data - declaring a role changes no column and no row;
  * an unknown key inside it is stored rather than rejected, which is what lets
    the UI add to this block without a backend release.
"""

import json
import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


CSV = (
    "week,npi,trx,calls,population\n"
    "2026-01-05,1001,10,3,500\n"
    "2026-01-12,1001,12,4,500\n"
    "2026-01-05,1002,20,6,900\n"
    "2026-01-12,1002,22,7,900\n"
)

ROLES = {
    "week": "Time Variable",
    "npi": "Cross-sectional Variable",
    "trx": "Dependent Variable",
    "calls": "Independent Promotions",
    "population": "Baseline Variables",
}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "roles " + uuid.uuid4().hex[:6]}).json()["id"]
        r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
                   files=[("files", ("t.csv", CSV.encode(), "text/csv"))],
                   data={"manifest": "{}"})
        check("uploaded", r.status_code in (200, 201), r.text[:250])

        print("\n1. the roles round-trip with the file category")
        spec = {"config_metadata": {"category": "sales", "column_roles": ROLES}}
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json=spec)
        check("spec accepted", r.status_code == 200, r.text[:300])

        meta = c.get(f"/v2/workflows/{wf}/files/t.csv").json()
        stored = meta["spec"]["config_metadata"]
        check("the category is stored", stored.get("category") == "sales", stored)
        check("every role comes back exactly", stored.get("column_roles") == ROLES, stored)

        listed = next(d for d in c.get(f"/v2/workflows/{wf}/files").json()["items"]
                      if d["filename"] == "t.csv")
        # The transformation screen reads the roles off the LIST, not one file
        # at a time, so they have to be present there too.
        check("and are on the listing the UI reads",
              listed["spec"]["config_metadata"]["column_roles"] == ROLES,
              listed["spec"]["config_metadata"])

        print("\n2. declaring a role changes no data")
        rows = c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text.strip().splitlines()
        check("the header is untouched", rows[0] == "week,npi,trx,calls,population", rows[0])
        check("every row is still there", len(rows) - 1 == 4, len(rows) - 1)

        print("\n3. roles survive a re-derive")
        # A rename re-derives the frame from the raw bytes. The UI stores roles
        # under the NEW name, so this sends them that way - and what matters is
        # that the block comes back as sent rather than being dropped.
        renamed = dict(ROLES)
        renamed["scripts"] = renamed.pop("trx")
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json={
            "config_metadata": {"category": "sales", "column_roles": renamed},
            "live_updates": {"column_renames": [{"from": "trx", "to": "scripts"}]},
        })
        check("the rename applied", r.status_code == 200, r.text[:300])
        after = c.get(f"/v2/workflows/{wf}/files/t.csv").json()["spec"]["config_metadata"]
        check("the roles came through the re-derive", after["column_roles"] == renamed, after)
        header = c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text.splitlines()[0]
        check("and name a column that exists in the frame",
              all(col in header.split(",") for col in renamed), (header, sorted(renamed)))

        print("\n4. the block is free-form, which is what lets the UI extend it")
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json={
            "config_metadata": {"category": "sales", "column_roles": ROLES,
                                "something_new": {"added": "later"}},
        })
        check("an unknown key is accepted, not rejected", r.status_code == 200, r.text[:250])
        back = c.get(f"/v2/workflows/{wf}/files/t.csv").json()["spec"]["config_metadata"]
        check("and stored as sent", back.get("something_new") == {"added": "later"}, back)

        print("\n5. clearing it is expressible")
        # A spec with an empty block must clear the roles rather than leaving
        # the previous ones in place, or unassigning a role would be impossible.
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json={"config_metadata": {}})
        check("an empty block is accepted", r.status_code == 200, r.text[:250])
        cleared = c.get(f"/v2/workflows/{wf}/files/t.csv").json()["spec"]["config_metadata"]
        check("the roles are gone", "column_roles" not in cleared, cleared)

        print("\n6. it is metadata, not instructions")
        # Nothing in config_metadata may be interpreted as a transformation: a
        # role naming a column that does not exist must not fail a re-derive.
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json={
            "config_metadata": {"column_roles": {"no_such_column": "Time Variable"}},
        })
        check("a role for a missing column is not an error", r.status_code == 200, r.text[:250])
        rows_after = c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text.strip().splitlines()
        check("and the data is unchanged", len(rows_after) - 1 == 4, len(rows_after) - 1)

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v2/workflows/{wf}/files/t.csv")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
