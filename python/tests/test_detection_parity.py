"""Does the v2 profiler flag the SAME date columns as the original pipeline?"""
import sys
sys.path.insert(0, r"C:\Users\GauravPatel\procDNA-proj\Beacon branch\Aashika\beacon\python")
import pandas as pd, polars as pl
from core.processing import detect_date_columns_by_sampling
from core.profile import profile_frame, date_columns

CASES = {
    "iso":          ["2026-02-04", "2026-02-11", "2026-03-15"],
    "dayfirst":     ["15-03-2026", "28-02-2026", "04-01-2026"],
    "slash_day":    ["15/03/2026", "28/02/2026", "04/01/2026"],
    "us_slash":     ["03/15/2026", "02/28/2026", "01/04/2026"],
    "ambiguous":    ["04-01-2026", "05-02-2026", "06-03-2026"],
    "npi":          ["1234567893", "1245319599", "1234567890"],
    "zip":          ["07030", "02139", "10001"],
    "amount":       ["1234.56", "89.10", "42.00"],
    "notes":        ["routine visit", "follow up", "n/a"],
    "short":        ["ab", "cd", "ef"],
    "year_only":    ["2024", "2025", "2026"],
    "empty":        ["", "", ""],
    "mixed_junk":   ["2026-02-04", "not a date", "2026-03-15"],
}
df_pd = pd.DataFrame(CASES, dtype=object)

# Original: operates on a polars frame of Utf8 columns
df_pl = pl.DataFrame({k: pl.Series(v, dtype=pl.Utf8) for k, v in CASES.items()})
legacy = set(detect_date_columns_by_sampling(df_pl))
new = set(date_columns(profile_frame(df_pd)))

print("  original detection :", sorted(legacy))
print("  v2 profile         :", sorted(new))
only_legacy, only_new = legacy - new, new - legacy
if only_legacy: print("  MISSING in v2      :", sorted(only_legacy))
if only_new:    print("  EXTRA in v2        :", sorted(only_new))

ok = legacy == new
print(("\n  PASS  " if ok else "\n  FAIL  ") + "v2 flags exactly the same date columns as the original")
raise SystemExit(0 if ok else 1)
