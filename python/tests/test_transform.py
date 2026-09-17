"""Engine tests: manifest validation, transformation, filters, granularity, dry-run.

Run:  python/.venv/Scripts/python.exe -m pytest python/tests -q
  or: python/.venv/Scripts/python.exe python/tests/test_transform.py
"""

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
from pydantic import ValidationError

from core.manifest import Manifest
from core.transform import (
    TransformError,
    apply_manifest,
    preview,
    read_table,
    write_table,
)

# 1234567893 / 1245319599 are Luhn-valid CMS NPIs; 1234567890 is not.
CSV = (
    "npi,txn_date,region,amount,active\n"
    "1234567893,15-03-2026,East,1234.567,yes\n"
    "1234567893,04-03-2026,East,10.5,no\n"
    "1245319599,02-11-2026,West,89.1,no\n"
    "1234567890,31-12-2026,East,42,yes\n"
).encode("utf-8")

BASE = {
    "live_updates": {
        "date_formats": [{"column": "txn_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d"}],
        "dtype_changes": [
            {"column": "amount", "to": "decimal", "precision": 18, "scale": 2},
            {"column": "active", "to": "boolean"},
        ],
        "column_renames": [{"from": "npi", "to": "provider_id"}],
    }
}

PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


def spec_for(manifest_dict, filename="t.csv"):
    return Manifest.model_validate(manifest_dict).for_file(filename)


def frame():
    return read_table("t.csv", CSV)


def run(manifest_dict):
    return apply_manifest("t.csv", frame(), spec_for(manifest_dict))


def expect_error(label, manifest_dict, code):
    try:
        run(manifest_dict)
        check(label, False, "no TransformError raised")
    except TransformError as exc:
        codes = [e["code"] for e in exc.errors]
        check(label, code in codes, f"codes={codes}")


# ── 1. read fidelity ────────────────────────────────────────────────────────
print("\n[1] read_table preserves source text")
df = frame()
check("no dtype coercion", str(df["amount"].iloc[0]) == "1234.567", df["amount"].iloc[0])
check("dates stay as written", df["txn_date"].iloc[0] == "15-03-2026", df["txn_date"].iloc[0])
check("row count", len(df) == 4, len(df))

# ── 2. live_updates ─────────────────────────────────────────────────────────
print("\n[2] live_updates")
out, counts = run(BASE)
check("date reformatted", out["txn_date"].iloc[0] == "2026-03-15", out["txn_date"].iloc[0])
check("day<=12 not transposed", out["txn_date"].iloc[1] == "2026-03-04", out["txn_date"].iloc[1])
check("decimal quantized", str(out["amount"].iloc[0]) == "1234.57", out["amount"].iloc[0])
check("boolean cast", out["active"].tolist() == [True, False, False, True], out["active"].tolist())
check("rename applied", "provider_id" in out.columns and "npi" not in out.columns)
check("counts", (counts.date_formats, counts.dtype_changes, counts.column_renames) == (1, 2, 1),
      counts.model_dump())

# ── 3. validation refuses before mutating ───────────────────────────────────
print("\n[3] up-front validation")
expect_error("missing column", {"live_updates": {"column_renames": [{"from": "nope", "to": "x"}]}},
             "column_not_found")
expect_error("rename collision", {"live_updates": {"column_renames": [{"from": "npi", "to": "region"}]}},
             "rename_collision")
expect_error("two renames onto one name",
             {"live_updates": {"column_renames": [{"from": "npi", "to": "z"}, {"from": "region", "to": "z"}]}},
             "rename_collision")
expect_error("filter names unknown column",
             {"filters": [{"type": "not_null", "column": "ghost"}]}, "column_not_found")
expect_error("filter must use post-rename name",
             {"live_updates": {"column_renames": [{"from": "npi", "to": "provider_id"}]},
              "filters": [{"type": "npi_luhn", "column": "npi"}]}, "column_not_found")

try:
    run({"live_updates": {"date_formats": [{"column": "txn_date", "from": "%Y-%m-%d", "to": "%d/%m/%Y"}]}})
    check("wrong date format reports row", False, "no error")
except TransformError as exc:
    msg = exc.errors[0]["message"]
    check("wrong date format reports value+row", "15-03-2026" in msg and "row 2" in msg, msg)

try:
    run({"live_updates": {"dtype_changes": [{"column": "region", "to": "integer"}]}})
    check("bad cast reports row", False, "no error")
except TransformError as exc:
    check("bad cast reports value+row", "row 2" in exc.errors[0]["message"], exc.errors[0]["message"])

out2, c2 = run({"live_updates": {"dtype_changes": [
    {"column": "region", "to": "integer", "on_error": "null_out"}]}})
check("on_error=null_out nulls instead of failing", c2.nulled_values == 4, c2.nulled_values)

# ── 4. schema rejects malformed manifests ───────────────────────────────────
print("\n[4] manifest schema")
for label, bad in [
    ("date_formats requires `from`", {"live_updates": {"date_formats": [{"column": "txn_date", "to": "%Y-%m-%d"}]}}),
    ("unknown key rejected", {"live_updates": {"column_rename": []}}),
    ("bad dtype rejected", {"live_updates": {"dtype_changes": [{"column": "amount", "to": "flooat"}]}}),
    ("decimal needs scale", {"live_updates": {"dtype_changes": [{"column": "amount", "to": "decimal"}]}}),
    ("date_range needs a bound", {"filters": [{"type": "date_range", "column": "txn_date"}]}),
    ("date_range start>end", {"filters": [{"type": "date_range", "column": "txn_date",
                                           "start": "2026-12-01", "end": "2026-01-01"}]}),
    ("granularity must coarsen", {"granularity": {"from": "Monthly", "to": "Weekly",
                                                  "date_column": "txn_date", "geo_column": "npi"}}),
    ("duplicate file override", {"files": [{"filename": "a.csv"}, {"filename": "a.csv"}]}),
]:
    try:
        Manifest.model_validate(bad)
        check(label, False, "accepted a malformed manifest")
    except ValidationError:
        check(label, True)

# ── 5. filters ──────────────────────────────────────────────────────────────
print("\n[5] filters")
out, counts = run({**BASE, "filters": [{"type": "npi_luhn", "column": "provider_id"}]})
check("luhn drops invalid NPI", len(out) == 3 and "1234567890" not in out["provider_id"].astype(str).tolist(),
      out["provider_id"].tolist())
check("rows_removed counted", counts.rows_removed == 1, counts.rows_removed)

out, _ = run({**BASE, "filters": [{"type": "date_range", "column": "txn_date",
                                   "start": "2026-03-01", "end": "2026-03-31"}]})
check("date_range inclusive", sorted(out["txn_date"]) == ["2026-03-04", "2026-03-15"], out["txn_date"].tolist())

out, _ = run({**BASE, "filters": [{"type": "value_in", "column": "region", "values": ["West"]}]})
check("value_in", out["region"].tolist() == ["West"], out["region"].tolist())

out, _ = run({**BASE, "filters": [{"type": "value_not_in", "column": "region", "values": ["West"]}]})
check("value_not_in", out["region"].tolist() == ["East"] * 3, out["region"].tolist())

out, _ = run({**BASE, "filters": [{"type": "range", "column": "amount", "min": 50}]})
check("numeric range", len(out) == 2, out["amount"].tolist())

out, _ = run({**BASE, "filters": [
    {"type": "npi_luhn", "column": "provider_id"},
    {"type": "value_in", "column": "region", "values": ["East"]}]})
check("filters compose (AND)", len(out) == 2, out["provider_id"].tolist())

expect_error("luhn on wrong column warns rather than emptying",
             {"filters": [{"type": "npi_luhn", "column": "region"}]}, "npi_luhn_no_matches")

# ── 6. granularity ──────────────────────────────────────────────────────────
print("\n[6] granularity")
out, counts = run({**BASE, "granularity": {
    "from": "Daily", "to": "Monthly", "date_column": "txn_date", "geo_column": "provider_id",
    "numeric": {"amount": "sum"}, "categorical": {"region": "first"}}})
check("rolls up to one row per geo+period", len(out) == 3, len(out))
check("period start dates", set(out["txn_date"]) == {"2026-03-01", "2026-11-01", "2026-12-01"},
      out["txn_date"].tolist())
march = out[(out["provider_id"] == "1234567893") & (out["txn_date"] == "2026-03-01")]
check("numeric summed", float(march["amount"].iloc[0]) == 1245.07, march["amount"].tolist())
check("categorical kept", "region" in out.columns)
check("granularity_applied flag", counts.granularity_applied is True)

out, counts = run({**BASE, "granularity": {
    "from": "Daily", "to": "Monthly", "date_column": "txn_date", "geo_column": "provider_id",
    "numeric": {"amount": "sum"}}})
check("unhandled columns REPORTED not silently dropped",
      counts.unhandled_columns == ["region", "active"], counts.unhandled_columns)

expect_error("rollup on unparsed dates fails loudly",
             {"granularity": {"from": "Daily", "to": "Monthly", "date_column": "region",
                              "geo_column": "npi", "numeric": {"amount": "sum"}}},
             "date_parse_failed")

# ── 7. dry-run preview == real apply ────────────────────────────────────────
print("\n[7] dry_run preview")
full = {**BASE, "filters": [{"type": "npi_luhn", "column": "provider_id"}],
        "granularity": {"from": "Daily", "to": "Monthly", "date_column": "txn_date",
                        "geo_column": "provider_id", "numeric": {"amount": "sum"},
                        "categorical": {"region": "first"}}}
prev = preview("t.csv", frame(), spec_for(full))
real, real_counts = run(full)
check("preview row_count matches apply", prev["row_count"] == len(real), prev["row_count"])
check("preview columns match apply", prev["columns"] == [str(c) for c in real.columns])
check("preview is JSON-safe", all(
    v is None or isinstance(v, (str, int, float, bool))
    for row in prev["preview"] for v in row.values()), prev["preview"][:1])
check("preview flags dry_run", prev["dry_run"] is True)
check("preview reports applied counts", prev["applied"]["rows_in"] == 4, prev["applied"])

try:
    preview("t.csv", frame(), spec_for({"live_updates": {"column_renames": [{"from": "ghost", "to": "x"}]}}))
    check("preview surfaces the same errors as apply", False, "no error")
except TransformError as exc:
    check("preview surfaces the same errors as apply", exc.errors[0]["code"] == "column_not_found")

# ── 8. per-file overrides ───────────────────────────────────────────────────
print("\n[8] per-file overrides")
m = Manifest.model_validate({
    "live_updates": {"column_renames": [{"from": "npi", "to": "global_id"}]},
    "filters": [{"type": "not_null", "column": "region"}],
    "files": [{"filename": "special.csv",
               "live_updates": {"column_renames": [{"from": "npi", "to": "special_id"}]}}],
})
check("override replaces its own key", m.for_file("special.csv").live_updates.column_renames[0].to == "special_id")
check("override inherits untouched keys", len(m.for_file("special.csv").filters) == 1)
check("non-overridden file uses defaults", m.for_file("other.csv").live_updates.column_renames[0].to == "global_id")

# ── 9. idempotence & round-trip ─────────────────────────────────────────────
print("\n[9] idempotence")
once, _ = run(BASE)
twice, _ = apply_manifest("t.csv", frame(), spec_for(BASE))
check("same manifest, same result", once.equals(twice))
rt = read_table("t.csv", write_table("t.csv", once))
check("write->read round-trips", list(rt.columns) == list(once.columns), list(rt.columns))

print("\n" + "=" * 62)
print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
for f in FAIL:
    print("   FAILED: " + f)
raise SystemExit(1 if FAIL else 0)
