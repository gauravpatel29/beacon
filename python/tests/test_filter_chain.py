"""The filter chain, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_filter_chain.py

The Filter tab builds an ordered chain of cards with an AND/OR dropdown in
every gap. The chain is folded STRICTLY LEFT TO RIGHT, not with SQL precedence
where AND binds tighter than OR, because the chain is a visual sequence and
regrouping it silently would make the order on screen a lie about the result.

Section 3 is the one that pins that decision: "A or B and C" must come out as
"(A or B) and C". Under SQL precedence it would be "A or (B and C)" and the row
counts differ, so the test fails loudly if anyone changes the fold.
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

A = {"filters": [{"type": "range", "column": "trx", "min": 300}]}       # 300,400,500
B = {"filters": [{"type": "value_in", "column": "region", "values": ["East"]}]}  # 100,300,400
C = {"filters": [{"type": "range", "column": "trx", "max": 150}]}       # 100,150


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "chain " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("s.csv", CSV.encode(), "text/csv"))],
               data={"manifest": "{}"})

        def preview(body):
            body = {"live_updates": LU, "granularity": None, **body}
            return c.post(f"/v2/workflows/{wf}/files/s.csv/preview", json=body)

        def trx(items, operators):
            r = preview({"filter_chain": {"items": items, "operators": operators}})
            if r.status_code != 200:
                return r.status_code, r.text[:300]
            return sorted(int(row["trx"]) for row in r.json()["preview"])

        print("\n1. one card")
        check("A alone", trx([A], []) == [300, 400, 500], trx([A], []))

        print("\n2. two cards")
        check("A and B", trx([A, B], ["and"]) == [300, 400], trx([A, B], ["and"]))
        check("A or B", trx([A, B], ["or"]) == [100, 300, 400, 500], trx([A, B], ["or"]))

        print("\n3. three cards fold LEFT TO RIGHT, not by SQL precedence")
        # (A and B) or C  ->  {300,400} | {100,150}
        got = trx([A, B, C], ["and", "or"])
        check("A and B or C == (A and B) or C", got == [100, 150, 300, 400], got)
        # (A or B) and C  ->  {100,300,400,500} & {100,150} = {100}
        # SQL precedence would read A or (B and C) = {300,400,500} | {100} and
        # give four rows, so this is the assertion that pins the fold.
        got = trx([A, B, C], ["or", "and"])
        check("A or B and C == (A or B) and C, NOT A or (B and C)", got == [100], got)
        check("and it is not the SQL reading", got != [100, 300, 400, 500], got)

        print("\n4. several cards on one column")
        # trx <= 150 or trx >= 400 - the case a flat list cannot express.
        got = trx([C, {"filters": [{"type": "range", "column": "trx", "min": 400}]}], ["or"])
        check("the tails, without the middle", got == [100, 150, 400, 500], got)
        got = trx([C, {"filters": [{"type": "range", "column": "trx", "min": 400}]}], ["and"])
        check("the same two ANDed match nothing", got == [], got)

        print("\n5. predicates inside one card still AND")
        both = {"filters": [{"type": "not_null", "column": "region"},
                            {"type": "value_in", "column": "region", "values": ["East"]}]}
        got = trx([both, {"filters": [{"type": "value_in", "column": "region",
                                       "values": ["North"]}]}], ["or"])
        check("not_null did not become an alternative", got == [100, 150, 300, 400], got)

        print("\n6. the operator count has to match the gaps")
        r = preview({"filter_chain": {"items": [A, B, C], "operators": ["and"]}})
        check("too few operators -> 422", r.status_code == 422, r.status_code)
        r = preview({"filter_chain": {"items": [A, B], "operators": ["and", "or"]}})
        check("too many operators -> 422", r.status_code == 422, r.status_code)
        r = preview({"filter_chain": {"items": [A, B], "operators": ["maybe"]}})
        check("an unknown operator -> 422", r.status_code == 422, r.status_code)
        r = preview({"filter_chain": {"items": [], "operators": []}})
        check("an empty chain is fine and filters nothing",
              r.status_code == 200 and r.json()["row_count"] == 6,
              (r.status_code, r.json().get("row_count")))

        print("\n7. the chain wins over the older forms sent alongside it")
        r = preview({
            "filters": [{"type": "value_in", "column": "region", "values": ["North"]}],
            "filter_mode": "any",
            "filter_chain": {"items": [A], "operators": []},
        })
        got = sorted(int(row["trx"]) for row in r.json()["preview"])
        check("the chain decided", got == [300, 400, 500], got)
        check("and filters was re-derived from it, not left as sent",
              r.json()["applied"]["filters_applied"] == 1,
              r.json()["applied"]["filters_applied"])

        print("\n8. older forms still work when no chain is sent")
        r = preview({"filters": [{"type": "range", "column": "trx", "min": 300}]})
        check("a bare filters list still filters",
              sorted(int(x["trx"]) for x in r.json()["preview"]) == [300, 400, 500],
              r.json()["row_count"])
        r = preview({"filter_groups": [{"mode": "any", "conditions": [C, A]}]})
        check("filter_groups still work",
              sorted(int(x["trx"]) for x in r.json()["preview"]) == [100, 150, 300, 400, 500],
              r.json()["row_count"])

        print("\n9. the chain survives a commit and reload")
        r = c.patch(f"/v2/workflows/{wf}/files/s.csv/spec", json={
            "live_updates": LU, "granularity": None,
            "filter_chain": {"items": [A, B, C], "operators": ["and", "or"]},
        })
        check("commit 200", r.status_code == 200, r.text[:300])
        check("stored row count is the left-to-right result", r.json()["row_count"] == 4,
              r.json().get("row_count"))
        listed = [x for x in c.get(f"/v2/workflows/{wf}/files").json()["items"]
                  if x["filename"] == "s.csv"][0]
        spec = listed["spec"]
        check("the spec records the chain, so the screen can rebuild it",
              len(spec.get("filter_chain", {}).get("items", [])) == 3
              and spec["filter_chain"]["operators"] == ["and", "or"],
              spec.get("filter_chain"))
        check("and mirrors it into the flat list",
              len(spec.get("filters", [])) == 3, spec.get("filters"))

        print("\n10. a card naming a missing column is still validated")
        r = preview({"filter_chain": {"items": [
            {"filters": [{"type": "range", "column": "nope", "min": 1}]}], "operators": []}})
        check("422 or 400, naming it", r.status_code in (400, 422), r.status_code)

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
