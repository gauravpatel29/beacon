import sys
sys.path.insert(0, r"C:\Users\GauravPatel\procDNA-proj\Beacon branch\Aashika\beacon\python")
import pandas as pd
from core.profile import profile_frame

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {extra}" if extra and not cond else ""))
    ok += cond; fail += (not cond)

df = pd.DataFrame({
    "npi":        ["1234567893", "1245319599", "1234567890"],
    "zip":        ["07030", "02139", "10001"],
    "iso_date":   ["2026-02-04", "2026-02-11", "2026-03-15"],
    "dayfirst":   ["15-03-2026", "28-02-2026", "04-01-2026"],   # day>12 present -> unambiguous
    "ambiguous":  ["04-01-2026", "05-02-2026", "06-03-2026"],   # all days<=12 -> ambiguous
    "amount":     ["1234.56", "89.10", "42.00"],
    "qty":        ["3", "10", "7"],
    "active":     ["yes", "no", "yes"],
    "notes":      ["routine visit", "follow up", "n/a"],
    "empty":      ["", "", ""],
}, dtype=object)

p = {c["column"]: c for c in profile_frame(df)}

check("ISO date detected", p["iso_date"]["suggested_date_from"] == "%Y-%m-%d",
      p["iso_date"]["suggested_date_from"])
check("ISO date not ambiguous", p["iso_date"]["ambiguous_date"] is False)

check("day-first detected", p["dayfirst"]["suggested_date_from"] == "%d-%m-%Y",
      p["dayfirst"]["suggested_date_from"])
check("day-first not ambiguous (day>12 disambiguates)",
      p["dayfirst"]["ambiguous_date"] is False, p["dayfirst"]["date_candidates"])

check("genuinely ambiguous column IS flagged", p["ambiguous"]["ambiguous_date"] is True,
      p["ambiguous"]["date_candidates"])
check("ambiguity names both formats",
      set(p["ambiguous"].get("ambiguous_between", [])) == {"%d-%m-%Y", "%m-%d-%Y"},
      p["ambiguous"].get("ambiguous_between"))

check("npi kept as string (leading zeros / float drift)",
      p["npi"]["suggested_dtype"] == "string" and p["npi"].get("id_like") is True,
      p["npi"]["suggested_dtype"])
check("zip kept as string", p["zip"]["suggested_dtype"] == "string", p["zip"]["suggested_dtype"])
check("decimal -> float", p["amount"]["suggested_dtype"] == "float", p["amount"]["suggested_dtype"])
check("whole numbers -> integer", p["qty"]["suggested_dtype"] == "integer", p["qty"]["suggested_dtype"])
check("yes/no -> boolean", p["active"]["suggested_dtype"] == "boolean", p["active"]["suggested_dtype"])
check("free text -> string", p["notes"]["suggested_dtype"] == "string", p["notes"]["suggested_dtype"])
check("free text offers no date control", p["notes"]["date_candidates"] == [])
check("empty column safe", p["empty"]["non_null"] == 0 and p["empty"]["date_candidates"] == [])
check("samples returned", p["notes"]["samples"] == ["routine visit", "follow up", "n/a"],
      p["notes"]["samples"])
check("null_count counted", p["empty"]["null_count"] == 3, p["empty"]["null_count"])

print(f"\n{ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
