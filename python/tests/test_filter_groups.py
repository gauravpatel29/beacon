"""Several conditions on one column, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_filter_groups.py

Three levels combine, innermost first:

    filters within a condition  ->  always AND
    conditions within a group   ->  group.mode     (one group per column)
    groups                      ->  filter_mode

The case that forced the nesting is two ranges on one column: "under 150 OR
over 450" cannot be written as a flat list of filters under any single mode.

As with filter_mode, the assertion that matters most is that a spec carrying
only the flat `filters` list replays exactly as it did before groups existed.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


#   trx:    100  200  300  150  400  500
#   region: E    W    E    N    E    W
ROWS = [
    ("1234567893", "East",  100),
    ("1234567901", "West",  200),
    ("1234567919", "East",  300),
    ("1234567927", "North", 150),
    ("1234567935", "East",  400),
    ("1234567943", "West",  500),
]
CSV = "npi,region,trx\n" + "".join(f"{n},{r},{t}\n" for n, r, t in ROWS)

LU = {"dtype_changes": [{"column": "trx", "to": "integer", "on_error": "null_out"}]}


def group(mode, *conditions):
    return {"mode": mode, "conditions": [{"filters": list(f)} for f in conditions]}


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "groups " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("s.csv", CSV.encode(), "text/csv"))],
               data={"manifest": "{}"})

        def preview(body):
            body = {"live_updates": LU, "granularity": None, **body}
            return c.post(f"/v2/workflows/{wf}/files/s.csv/preview", json=body)

        def trx_of(resp):
            return sorted(int(row["trx"]) for row in resp.json()["preview"])

        print("\n1. two ranges on one column, ORed")
        r = preview({"filter_groups": [group(
            "any",
            [{"type": "range", "column": "trx", "max": 150}],
            [{"type": "range", "column": "trx", "min": 450}],
        )]})
        check("200", r.status_code == 200, r.text[:400])
        check("keeps the tails, drops the middle", trx_of(r) == [100, 150, 500], trx_of(r))
        check("both filters counted as applied",
              r.json()["applied"]["filters_applied"] == 2,
              r.json()["applied"]["filters_applied"])

        print("\n2. the same two conditions ANDed match nothing")
        r = preview({"filter_groups": [group(
            "all",
            [{"type": "range", "column": "trx", "max": 150}],
            [{"type": "range", "column": "trx", "min": 450}],
        )]})
        check("no row is both under 150 and over 450", r.json()["row_count"] == 0,
              r.json()["row_count"])

        print("\n3. predicates inside ONE condition still AND, while the column ORs")
        # (region not null AND region = East) OR region = North
        r = preview({"filter_groups": [group(
            "any",
            [{"type": "not_null", "column": "region"},
             {"type": "value_in", "column": "region", "values": ["East"]}],
            [{"type": "value_in", "column": "region", "values": ["North"]}],
        )]})
        check("not_null did not become an alternative",
              trx_of(r) == [100, 150, 300, 400], trx_of(r))

        print("\n4. groups combine by filter_mode")
        two = [
            group("any",
                  [{"type": "range", "column": "trx", "max": 150}],
                  [{"type": "range", "column": "trx", "min": 450}]),
            group("all", [{"type": "value_in", "column": "region", "values": ["East"]}]),
        ]
        r = preview({"filter_groups": two, "filter_mode": "all"})
        # tails = 100,150,500; East = 100,300,400  ->  100
        check("AND across columns intersects", trx_of(r) == [100], trx_of(r))
        r = preview({"filter_groups": two, "filter_mode": "any"})
        check("OR across columns unions", trx_of(r) == [100, 150, 300, 400, 500], trx_of(r))

        print("\n5. the flat list is unchanged by any of this")
        flat = [{"type": "range", "column": "trx", "min": 200},
                {"type": "value_in", "column": "region", "values": ["East"]}]
        a = preview({"filters": flat})
        check("flat + default mode still ANDs", trx_of(a) == [300, 400], trx_of(a))
        b = preview({"filters": flat, "filter_mode": "any"})
        check("flat + any still ORs", trx_of(b) == [100, 200, 300, 400, 500], trx_of(b))

        print("\n6. groups win over a flat list sent alongside them")
        r = preview({
            "filters": [{"type": "value_in", "column": "region", "values": ["North"]}],
            "filter_groups": [group("all", [{"type": "range", "column": "trx", "min": 450}])],
        })
        check("the groups decided, not the stale flat list", trx_of(r) == [500], trx_of(r))

        print("\n7. the groups survive a commit and reload")
        r = c.patch(f"/v2/workflows/{wf}/files/s.csv/spec",
                    json={"live_updates": LU, "filter_groups": [group(
                        "any",
                        [{"type": "range", "column": "trx", "max": 150}],
                        [{"type": "range", "column": "trx", "min": 450}],
                    )], "granularity": None})
        check("commit 200", r.status_code == 200, r.text[:400])
        check("stored row count is the OR result", r.json()["row_count"] == 3,
              r.json().get("row_count"))
        listed = [x for x in c.get(f"/v2/workflows/{wf}/files").json()["items"]
                  if x["filename"] == "s.csv"][0]
        spec = listed["spec"]
        check("the spec records the groups, so the screen can restore them",
              len(spec.get("filter_groups", [])) == 1
              and len(spec["filter_groups"][0]["conditions"]) == 2,
              spec.get("filter_groups"))
        check("and mirrors them into the flat list for anything reading that",
              len(spec.get("filters", [])) == 2, spec.get("filters"))

        print("\n8. malformed groups are refused rather than guessed")
        r = preview({"filter_groups": [{"mode": "sometimes", "conditions": []}]})
        check("unknown group mode -> 422", r.status_code == 422, r.status_code)
        r = preview({"filter_groups": [{"mode": "all", "conditions": [
            {"filters": [{"type": "range", "column": "nope", "min": 1}]}]}]})
        check("a group naming a missing column is still validated",
              r.status_code in (400, 422), r.status_code)

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v2/workflows/{wf}/files/s.csv")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
