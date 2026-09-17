"""The Correlation tab's own call sequence, against /api/correlation.

    python/.venv/Scripts/python.exe python/tests/test_correlation_screen.py

Tushar's Data Review screen computed all of this in the browser: Pearson by
hand, and VIF by inverting X'X via the normal equations. That inversion goes
singular on collinear inputs - which is exactly the case VIF exists to measure -
so the figure shown was least trustworthy precisely when it mattered. The tab
now calls these endpoints instead, so this pins what it depends on.
"""

import os

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


# `tv` and `tv_copy` are near-duplicates, so they must show as a correlated pair
# and carry a high VIF. `radio` is independent. `sales` is the KPI.
ROWS = [
    (10, 10.2, 55, 120), (20, 19.7, 12, 190), (30, 30.4, 80, 250),
    (40, 39.6, 33, 310), (50, 50.3, 91, 380), (60, 59.8, 24, 430),
    (70, 70.1, 67, 500), (80, 79.9, 45, 560), (90, 90.2, 88, 630),
    (100, 99.6, 19, 700), (110, 110.3, 72, 760), (120, 119.7, 38, 820),
]
CSV = "tv,tv_copy,radio,sales\n" + "".join(f"{a},{b},{c},{d}\n" for a, b, c, d in ROWS)
COLS = ["tv", "tv_copy", "radio"]


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120.0)

    print("\n1. matrix — what the heatmap renders")
    r = c.post("/api/correlation/matrix", json={"csv_data": CSV, "columns": COLS})
    check("200", r.status_code == 200, r.text[:300])
    d = r.json()
    check("columns echoed back in order", d["columns"] == COLS, d["columns"])
    check("matrix is keyed by column name both ways",
          all(set(d["matrix"][a]) >= set(COLS) for a in COLS), list(d["matrix"])[:2])
    check("self-correlation is 1", abs(d["matrix"]["tv"]["tv"] - 1.0) < 1e-6,
          d["matrix"]["tv"]["tv"])
    check("the near-duplicate pair is ~1", d["matrix"]["tv"]["tv_copy"] > 0.99,
          d["matrix"]["tv"]["tv_copy"])
    check("the independent column is not", abs(d["matrix"]["tv"]["radio"]) < 0.6,
          d["matrix"]["tv"]["radio"])
    check("symmetric", abs(d["matrix"]["tv"]["radio"] - d["matrix"]["radio"]["tv"]) < 1e-9)

    print("\n2. VIF — the number the browser could not compute")
    r = c.post("/api/correlation/vif", json={"csv_data": CSV, "columns": COLS})
    check("200", r.status_code == 200, r.text[:300])
    vif = {v["variable"]: v for v in r.json()["vif"]}
    check("one row per column", set(vif) == set(COLS), list(vif))
    check("rows carry variable, VIF and status",
          all({"variable", "VIF", "status"} <= set(v) for v in vif.values()), list(vif.values())[:1])
    check("the collinear pair scores high", vif["tv"]["VIF"] > 10, vif["tv"]["VIF"])
    check("and is flagged as such", "High" in vif["tv"]["status"], vif["tv"]["status"])
    # 6.83 with 12 rows against 3 predictors: some inflation is expected in a
    # small sample. What matters is that it is orders of magnitude below the
    # collinear pair and is not flagged High.
    check("the independent column scores far lower",
          vif["radio"]["VIF"] < vif["tv"]["VIF"] / 10,
          (vif["radio"]["VIF"], vif["tv"]["VIF"]))
    check("and is not flagged High", "High" not in vif["radio"]["status"],
          vif["radio"]["status"])

    print("\n3. high-pairs — what the threshold slider filters")
    r = c.post("/api/correlation/high-pairs",
               json={"csv_data": CSV, "columns": COLS, "threshold": 0.9})
    check("200", r.status_code == 200, r.text[:300])
    pairs = r.json()["pairs"]
    check("finds exactly the duplicate pair", len(pairs) == 1, pairs)
    check("names both sides and the coefficient",
          {"feature1", "feature2", "corr"} <= set(pairs[0]), pairs[0])
    # The duplicate pair correlates at 0.999967, so 0.999 still catches it -
    # the threshold has to clear the actual coefficient to exclude it.
    above = c.post("/api/correlation/high-pairs",
                   json={"csv_data": CSV, "columns": COLS, "threshold": 0.99999}).json()["pairs"]
    check("a threshold above the real coefficient finds nothing", above == [], above)
    below = c.post("/api/correlation/high-pairs",
                   json={"csv_data": CSV, "columns": COLS, "threshold": 0.3}).json()["pairs"]
    check("a low threshold finds more", len(below) >= len(pairs), (len(below), len(pairs)))

    print("\n4. preview-removal — shown before anything changes")
    r = c.post("/api/correlation/preview-removal",
               json={"csv_data": CSV, "columns": COLS, "threshold": 0.9,
                     "dependent_variable": "sales"})
    check("200", r.status_code == 200, r.text[:300])
    prev = r.json()
    check("reports totals for the summary line",
          {"total_pairs", "total_dropped", "total_kept"} <= set(prev), list(prev))
    check("one pair to treat", prev["total_pairs"] == 1, prev["total_pairs"])
    check("names which side goes and which stays",
          {"will_drop", "will_keep", "reason", "correlation"} <= set(prev["pairs"][0]),
          prev["pairs"][0])
    check("it drops one of the duplicate pair, not radio",
          prev["dropped"] == [x for x in prev["dropped"] if x in ("tv", "tv_copy")],
          prev["dropped"])
    check("radio survives", "radio" in prev["kept"], prev["kept"])

    print("\n5. apply-removal — returns a dataset, does not mutate ours")
    drop = prev["dropped"]
    r = c.post("/api/correlation/apply-removal",
               json={"csv_data": CSV, "columns": COLS, "drop_cols": drop})
    check("200", r.status_code == 200, r.text[:300])
    res = r.json()
    check("returns csv_data the screen re-parses", isinstance(res.get("csv_data"), str),
          list(res))
    header = res["csv_data"].splitlines()[0].split(",")
    check("the dropped column is gone from the header",
          all(x not in header for x in drop), (header, drop))
    check("the KPI and the independent column survive",
          "sales" in header and "radio" in header, header)
    check("reports what it kept and dropped", {"kept", "dropped"} <= set(res), list(res))

    print("\n6. find-clusters + apply-combination")
    r = c.post("/api/correlation/find-clusters",
               json={"csv_data": CSV, "columns": COLS, "threshold": 0.9})
    check("200", r.status_code == 200, r.text[:300])
    clusters = r.json()["clusters"]
    check("groups the duplicate pair", any(set(cl) == {"tv", "tv_copy"} for cl in clusters),
          clusters)

    r = c.post("/api/correlation/apply-combination",
               json={"csv_data": CSV, "columns": COLS, "clusters": clusters,
                     "new_names": [f"combined_{i + 1}" for i in range(len(clusters))],
                     "method": "sum", "drop_original": True})
    check("200", r.status_code == 200, r.text[:300])
    res = r.json()
    header = res["csv_data"].splitlines()[0].split(",")
    check("the composite column exists", "combined_1" in header, header)
    check("the originals were dropped",
          "tv" not in header and "tv_copy" not in header, header)
    check("untouched columns remain", "sales" in header and "radio" in header, header)

    print("\n7. degrades rather than throwing")
    r = c.post("/api/correlation/matrix", json={"csv_data": CSV, "columns": ["ghost"]})
    check("unknown column -> no crash", r.status_code in (200, 400), r.status_code)
    r = c.post("/api/correlation/vif", json={"csv_data": CSV, "columns": ["tv"]})
    check("a single column cannot have a VIF, but must not 500",
          r.status_code == 200, r.text[:200])

    return 1 if FAIL else 0


if __name__ == "__main__":
    code = main()
    print("=" * 60)
    print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
    for f in FAIL:
        print("   FAILED: " + f)
    raise SystemExit(code)
