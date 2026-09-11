"""AND / OR across several filters, end to end against the live Neon branch.

    python/.venv/Scripts/python.exe python/tests/test_filter_mode.py

The engine used to narrow the frame one filter at a time, which can only ever
express AND. Masks are now evaluated against the same incoming frame and
combined at the end, so "any" is expressible: a row the first filter rejects is
still available for the second to accept.

The assertion that matters most is that "all" is unchanged. It is the default,
every stored spec relies on it, and a mode field that quietly altered existing
results would be worse than not having one.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# Six rows chosen so the two filters below select different, overlapping sets:
#   trx >= 200        -> rows 2,3,5,6
#   region in (East)  -> rows 1,3,5
#   AND               -> rows 3,5          (2)
#   OR                -> rows 1,2,3,5,6    (5)
ROWS = [
    ("1234567893", "East",  100),
    ("1234567901", "West",  200),
    ("1234567919", "East",  300),
    ("1234567927", "North", 150),
    ("1234567935", "East",  400),
    ("1234567943", "West",  500),
]
CSV = "npi,region,trx\n" + "".join(f"{n},{r},{t}\n" for n, r, t in ROWS).encode().decode()

LU = {"dtype_changes": [{"column": "trx", "to": "integer", "on_error": "null_out"}]}
FILTERS = [
    {"type": "range", "column": "trx", "min": 200},
    {"type": "value_in", "column": "region", "values": ["East"]},
]


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "mode " + uuid.uuid4().hex[:6]}).json()["id"]
        c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
               files=[("files", ("s.csv", CSV.encode(), "text/csv"))],
               data={"manifest": "{}"})

        def preview(body):
            return c.post(f"/v2/workflows/{wf}/files/s.csv/preview", json=body)

        print("\n1. each filter on its own")
        r = preview({"live_updates": LU, "filters": [FILTERS[0]], "granularity": None})
        check("trx >= 200 keeps 4 rows", r.json()["row_count"] == 4, r.json().get("row_count"))
        r = preview({"live_updates": LU, "filters": [FILTERS[1]], "granularity": None})
        check("region = East keeps 3 rows", r.json()["row_count"] == 3, r.json().get("row_count"))

        print("\n2. AND is unchanged, with or without the new field")
        legacy = preview({"live_updates": LU, "filters": FILTERS, "granularity": None})
        check("no mode given -> 200", legacy.status_code == 200, legacy.text[:300])
        check("defaults to AND: 2 rows", legacy.json()["row_count"] == 2,
              legacy.json().get("row_count"))
        explicit = preview({"live_updates": LU, "filters": FILTERS,
                            "filter_mode": "all", "granularity": None})
        check("explicit all matches the default exactly",
              explicit.json()["row_count"] == legacy.json()["row_count"]
              and explicit.json()["preview"] == legacy.json()["preview"],
              (explicit.json()["row_count"], legacy.json()["row_count"]))

        print("\n3. OR keeps the union")
        r = preview({"live_updates": LU, "filters": FILTERS,
                     "filter_mode": "any", "granularity": None})
        check("any -> 200", r.status_code == 200, r.text[:300])
        d = r.json()
        check("5 rows, not 2", d["row_count"] == 5, d["row_count"])
        kept = {row["npi"] for row in d["preview"]}
        # Row 4 (North, 150) satisfies neither filter and is the only exclusion.
        check("the row matching neither filter is the only one dropped",
              "1234567927" not in kept and len(kept) == 5, sorted(kept))
        check("a row matching only the first filter survives",
              "1234567943" in kept, sorted(kept))
        check("a row matching only the second survives",
              "1234567893" in kept, sorted(kept))

        print("\n4. the mode is reported the same way either way")
        check("filters_applied counts both in AND", legacy.json()["applied"]["filters_applied"] == 2,
              legacy.json()["applied"]["filters_applied"])
        check("filters_applied counts both in OR", d["applied"]["filters_applied"] == 2,
              d["applied"]["filters_applied"])
        check("rows_removed follows the mode",
              legacy.json()["applied"]["rows_removed"] == 4
              and d["applied"]["rows_removed"] == 1,
              (legacy.json()["applied"]["rows_removed"], d["applied"]["rows_removed"]))

        print("\n5. a single filter behaves identically in both modes")
        one = [FILTERS[0]]
        a = preview({"live_updates": LU, "filters": one, "filter_mode": "all", "granularity": None})
        b = preview({"live_updates": LU, "filters": one, "filter_mode": "any", "granularity": None})
        check("same row count", a.json()["row_count"] == b.json()["row_count"] == 4,
              (a.json()["row_count"], b.json()["row_count"]))

        print("\n6. the mode survives a commit and reload")
        r = c.patch(f"/v2/workflows/{wf}/files/s.csv/spec",
                    json={"live_updates": LU, "filters": FILTERS,
                          "filter_mode": "any", "granularity": None})
        check("commit 200", r.status_code == 200, r.text[:300])
        check("the stored dataset has the OR row count", r.json()["row_count"] == 5,
              r.json().get("row_count"))
        listed = [x for x in c.get(f"/v2/workflows/{wf}/files").json()["items"]
                  if x["filename"] == "s.csv"][0]
        check("the spec records the mode, so the screen can restore it",
              listed["spec"].get("filter_mode") == "any", listed["spec"].get("filter_mode"))

        print("\n7. an invalid mode is refused rather than guessed")
        r = preview({"live_updates": LU, "filters": FILTERS,
                     "filter_mode": "maybe", "granularity": None})
        check("unknown mode -> 422", r.status_code == 422, r.status_code)

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
