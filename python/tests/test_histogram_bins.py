"""Bucket width on POST /api/eda/histogram.

    python/.venv/Scripts/python.exe python/tests/test_histogram_bins.py

The Data Review screen now has a "Bucket Width (Bin Size)" control, which sends
`bin_width`. The endpoint has always accepted it; nothing was calling it, so
nothing pinned it either. What the screen relies on:

  * omitting it still gets the server's own choice, so the control can be left
    alone (and "Apply" on an empty box means exactly that);
  * `bin_width` in the response is the width actually drawn, since that is what
    the "Active bucket width" badge reads - and for the integer shortcut path
    it is not the number that was asked for;
  * a narrower width really does produce more buckets, which is the entire
    point of the control;
  * nothing is dropped: the counts still add up to every numeric row.
"""

import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# 0, 10, 20 ... 990: a 990-wide span with 100 rows, so every width below
# divides it cleanly and the expected bucket count is arithmetic, not a guess.
SPEND = "\n".join(["spend,calls"] + [f"{i * 10},{(i % 8) + 1}" for i in range(100)])


def hist(c, **body):
    r = c.post("/api/eda/histogram", json={"csv_data": SPEND, **body})
    assert r.status_code == 200, r.text[:300]
    return r.json()


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120.0)
    try:
        print("\n1. no bin_width - the server bins it")
        auto = hist(c, column="spend")
        check("counts returned", len(auto["counts"]) > 0, auto["counts"])
        check("a width is reported back", auto["bin_width"] > 0, auto["bin_width"])
        check("one label per bucket",
              len(auto["bin_labels"]) == len(auto["counts"]),
              (len(auto["bin_labels"]), len(auto["counts"])))
        check("every row is in a bucket", sum(auto["counts"]) == 100, sum(auto["counts"]))
        check("the span is the data's", (auto["min"], auto["max"]) == (0.0, 990.0),
              (auto["min"], auto["max"]))

        print("\n2. an explicit width is honoured")
        wide = hist(c, column="spend", bin_width=100)
        check("the width comes back as asked", wide["bin_width"] == 100.0, wide["bin_width"])
        edges = wide["bin_edges"]
        spacing = [round(edges[i + 1] - edges[i], 6) for i in range(len(edges) - 1)]
        check("every bucket really is that wide", set(spacing) == {100.0}, sorted(set(spacing)))
        check("nothing is dropped", sum(wide["counts"]) == 100, sum(wide["counts"]))
        check("a 990 span at 100 gives 10 buckets", len(wide["counts"]) == 10,
              len(wide["counts"]))

        print("\n3. narrower means more buckets")
        narrow = hist(c, column="spend", bin_width=50)
        check("50 gives more buckets than 100",
              len(narrow["counts"]) > len(wide["counts"]),
              (len(narrow["counts"]), len(wide["counts"])))
        check("and still accounts for every row", sum(narrow["counts"]) == 100,
              sum(narrow["counts"]))
        widest = hist(c, column="spend", bin_width=1000)
        check("a width past the span collapses to one bucket",
              len(widest["counts"]) == 1, len(widest["counts"]))

        print("\n4. a width that is not a width falls back to automatic")
        # The screen guards against these, but the endpoint is also reachable
        # from a restored state and from Aashika's client.
        for label, value in (("null", None), ("zero", 0), ("negative", -5)):
            got = hist(c, column="spend", bin_width=value)
            check(f"bin_width={label} bins automatically, not into nothing",
                  len(got["counts"]) == len(auto["counts"]), len(got["counts"]))

        print("\n5. the integer shortcut reports the width it used, not the one asked for")
        # calls is 1..8, so the server draws one bar per value and says 1.0.
        small = hist(c, column="calls")
        check("one bucket per distinct value", len(small["counts"]) == 8, len(small["counts"]))
        check("width reported as 1", small["bin_width"] == 1.0, small["bin_width"])
        check("labels are the values themselves",
              small["bin_labels"] == [str(i) for i in range(1, 9)], small["bin_labels"])
        # This is why the badge reads the response and not the input box.
        forced = hist(c, column="calls", bin_width=4)
        check("asking for 4 leaves the shortcut and is honoured",
              forced["bin_width"] == 4.0, forced["bin_width"])
        check("and gives fewer buckets", len(forced["counts"]) < 8, len(forced["counts"]))

        print("\n6. an empty column is a chart with nothing in it, not an error")
        r = c.post("/api/eda/histogram",
                   json={"csv_data": "spend\n\n", "column": "spend"})
        check("200, not 400", r.status_code == 200, r.text[:200])
        check("empty counts", r.json()["counts"] == [], r.json()["counts"])

        return 1 if FAIL else 0
    finally:
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
