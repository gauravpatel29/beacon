"""All five join strategies, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_ard_joins.py

Two small files with a deliberate partial overlap, so each join type produces a
distinguishable row count:

    left  (A)  keys: k1, k2, k3
    right (B)  keys: k2, k3, k4

    inner -> 2   left -> 3   right -> 3   outer -> 4   cross -> 9
"""

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8100")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


A = b"key,trx\nk1,10\nk2,20\nk3,30\n"
B = b"key,calls\nk2,5\nk3,6\nk4,7\n"

EXPECTED = {"inner": 2, "left": 3, "right": 3, "outer": 4, "cross": 9}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "joins " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("a.csv", A, "text/csv")),
                      ("files", ("b.csv", B, "text/csv"))],
               data={"manifest": "{}"})

        print("\nrow counts per join type")
        for join, expected in EXPECTED.items():
            step = {"left_file": "a.csv", "right_file": "b.csv", "join_type": join}
            if join != "cross":
                step["left_key"] = ["key"]
                step["right_key"] = ["key"]
            r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True},
                       json={"steps": [step], "target_grain": "hcp"})
            got = r.json().get("row_count") if r.status_code == 200 else r.text[:160]
            check(f"{join:<6} -> {expected} rows", got == expected, got)

        print("\ncross join needs no keys")
        r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True},
                   json={"steps": [{"left_file": "a.csv", "right_file": "b.csv",
                                    "join_type": "cross"}], "target_grain": "hcp"})
        check("omitting keys is accepted for cross", r.status_code == 200, r.text[:200])
        check("lineage marks it as keyless",
              r.json()["lineage"]["steps_executed"][0]["keys"] == ["(cross join - no keys)"],
              r.json()["lineage"])

        print("\nkeys are still required for the other four")
        r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True},
                   json={"steps": [{"left_file": "a.csv", "right_file": "b.csv",
                                    "join_type": "outer"}], "target_grain": "hcp"})
        check("outer without keys -> 422", r.status_code == 422
              and r.json()["errors"][0]["code"] == "keys_missing", r.text[:200])

        print("\nan outer join must not fabricate zeros on the left")
        # k4 exists only on the right, so its `trx` is genuinely unknown. It
        # must stay null rather than becoming 0, or "no data" and "measured
        # zero" become indistinguishable downstream.
        r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True},
                   json={"steps": [{"left_file": "a.csv", "right_file": "b.csv",
                                    "left_key": ["key"], "right_key": ["key"],
                                    "join_type": "outer"}], "target_grain": "hcp"})
        rows = {row["key"]: row for row in r.json()["preview"]}
        check("right-only row keeps trx null", rows.get("k4", {}).get("trx") is None,
              rows.get("k4"))
        check("left-only row gets calls = 0", rows.get("k1", {}).get("calls") == 0,
              rows.get("k1"))

        print("\ndescriptive labels resolve correctly")
        for label, expected in (
            ("Left Join (Keep all dma_hcp_crosswalk.csv rows)", 3),
            ("Full Outer Join (Keep all rows from both)", 4),
            ("Inner Join (Match only)", 2),
        ):
            r = c.post(f"/v2/workflows/{wf}/ard/build", params={"dry_run": True},
                       json={"steps": [{"left_file": "a.csv", "right_file": "b.csv",
                                        "left_key": ["key"], "right_key": ["key"],
                                        "join_type": label}], "target_grain": "hcp"})
            got = r.json().get("row_count") if r.status_code == 200 else r.text[:120]
            check(f'"{label[:38]}" -> {expected}', got == expected, got)

        return 1 if FAIL else 0
    finally:
        if wf:
            for f in ("a.csv", "b.csv"):
                c.delete(f"/v2/workflows/{wf}/files/{f}")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 54)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
