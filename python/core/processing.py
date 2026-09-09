"""
Core processing utilities – pure Python/Polars/Pandas logic.
"""
import re
import math
from datetime import datetime, timedelta, date
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import polars as pl
import statsmodels.api as sm
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_squared_error
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

# ---------------------------------------------------------------------------
# Strict Official CMS US NPI Validation
# ---------------------------------------------------------------------------
RE_CMS_NPI = re.compile(r"^[12]\d{9}$")


def luhn_valid_npi(npi) -> bool:
    """
    Official CMS (Centers for Medicare & Medicaid Services) NPI Validator.
    1. Must be exactly 10 digits starting with 1 (individual) or 2 (organization).
    2. Must satisfy ISO/IEC 7812 Luhn checksum with fixed prefix '80840'.
    """
    if npi is None:
        return False
    npi_str = str(npi).strip().replace(".0", "")
    if not RE_CMS_NPI.fullmatch(npi_str):
        return False

    base = npi_str[:9]
    chk = ord(npi_str[9]) - 48
    s = 24  # Pre-computed Luhn sum contribution for prefix '80840'

    for i in range(9):
        d = ord(base[8 - i]) - 48
        if i % 2 == 0:  # Even positions from right (weights of 2)
            d *= 2
            if d > 9:
                d -= 9
        s += d

    return ((10 - (s % 10)) % 10) == chk


# ---------------------------------------------------------------------------
# Date formatting & parsing
# ---------------------------------------------------------------------------
# Candidate date formats in priority order: ISO first (unambiguous by
# convention), then day-first, then month-first. "%Y-%d-%m" is deliberately
# absent - it is not a real-world convention, and letting pandas infer it from
# dayfirst=True is what silently transposes day and month on ISO input.
_DATE_FORMATS = [
    "%Y-%m-%d", "%Y/%m/%d", "%Y%m%d",
    "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",
    "%m/%d/%Y", "%m-%d-%Y",
    "%d-%b-%Y", "%d %b %Y", "%b %d, %Y", "%d-%B-%Y", "%B %d, %Y",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
    "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S",
]


def _parse_dates_robust(s_clean: pd.Series) -> pd.Series:
    """
    Parse a cleaned string Series into datetimes deterministically.

    Picks an explicit format by how many values it parses (ties broken by the
    priority order of _DATE_FORMATS) rather than relying on pandas' dayfirst
    inference. Genuinely ambiguous columns (every day-of-month <= 12) resolve
    day-first, matching the UI's default "%d/%m/%Y".
    """
    non_empty = s_clean[s_clean != ""]
    if non_empty.empty:
        return pd.Series(pd.NaT, index=s_clean.index, dtype="datetime64[ns]")

    # Score candidates against distinct values only - far cheaper on long columns.
    uniques = pd.Series(non_empty.unique())
    total = len(uniques)

    best_fmt, best_hits = None, 0
    for fmt in _DATE_FORMATS:
        hits = int(pd.to_datetime(uniques, format=fmt, errors="coerce").notna().sum())
        if hits > best_hits:
            best_fmt, best_hits = fmt, hits
        if hits == total:
            break

    if best_fmt is None:
        parsed = pd.Series(pd.NaT, index=s_clean.index, dtype="datetime64[ns]")
    else:
        parsed = pd.to_datetime(s_clean, format=best_fmt, errors="coerce")

    # Mixed-format column: fill remaining gaps with the other candidates.
    if parsed.isna().any():
        for fmt in _DATE_FORMATS:
            if fmt == best_fmt:
                continue
            if not parsed.isna().any():
                break
            parsed = parsed.fillna(pd.to_datetime(s_clean, format=fmt, errors="coerce"))

    # Anything still unparsed is exotic (month names, offsets); let pandas try.
    if parsed.isna().any():
        leftover = s_clean.where(parsed.isna(), "")
        parsed = parsed.fillna(pd.to_datetime(leftover, errors="coerce", dayfirst=True))

    return parsed


def format_date_column(series: pd.Series, target_format: str = "%d/%m/%Y") -> pd.Series:
    orig_series = series.copy()
    s_clean = orig_series.astype(str).str.strip()
    s_clean = s_clean.replace({"nan": "", "None": "", "NaT": "", "<NA>": "", "null": ""})

    parsed = _parse_dates_robust(s_clean)

    fmt = target_format if target_format else "%d/%m/%Y"
    out = parsed.dt.strftime(fmt).fillna("")
    out[s_clean == ""] = ""
    return out


def parse_date_series_polars(df: pl.DataFrame, date_column: str) -> pl.DataFrame:
    if date_column not in df.columns:
        return df

    s = df.get_column(date_column)
    if s.dtype == pl.Date:
        return df
    elif s.dtype == pl.Datetime:
        return df.with_columns(pl.col(date_column).cast(pl.Date).alias(date_column))

    s_clean = s.to_pandas().astype(str).str.strip()
    s_clean = s_clean.replace({"nan": "", "None": "", "NaT": "", "<NA>": "", "null": ""})
    parsed = _parse_dates_robust(s_clean)

    iso_strs = parsed.dt.strftime("%Y-%m-%d").fillna("")

    return df.with_columns(
        pl.Series(date_column, iso_strs).str.strptime(pl.Date, format="%Y-%m-%d", strict=False).alias(date_column)
    )


def detect_date_granularity(df: pl.DataFrame, date_column: str) -> Optional[str]:
    if date_column not in df.columns:
        return None

    df2 = parse_date_series_polars(df, date_column)
    df2 = (
        df2.filter(pl.col(date_column).is_not_null())
        .select(pl.col(date_column))
        .unique()
        .sort(date_column)
    )
    if df2.height < 2:
        return None

    df2 = df2.with_columns(
        (pl.col(date_column) - pl.col(date_column).shift(1)).dt.total_days().alias("_gap_days")
    ).filter(pl.col("_gap_days").is_not_null() & (pl.col("_gap_days") > 0))

    if df2.height == 0:
        return None

    gaps = df2.get_column("_gap_days").to_list()
    min_gap = min(gaps)
    median_gap = float(df2.get_column("_gap_days").median())

    if min_gap <= 2 and median_gap <= 3:
        return "Daily"

    weekly_multiples = [g for g in gaps if g % 7 == 0 or (5 <= g <= 9)]
    if len(weekly_multiples) / len(gaps) >= 0.4 or (5 <= min_gap <= 9):
        return "Weekly"

    monthly_gaps = [g for g in gaps if 25 <= g <= 35]
    if len(monthly_gaps) / len(gaps) >= 0.4 or (25 <= min_gap <= 35):
        return "Monthly"

    if min_gap >= 350:
        return "Yearly"

    return "Weekly" if min_gap <= 14 else ("Monthly" if min_gap <= 60 else "Yearly")


def detect_date_columns_by_sampling(
    df: pl.DataFrame,
    sample_size: int = 200,
    threshold: float = 0.8,
    formats: Optional[List[str]] = None,
) -> List[str]:

    if formats is None:
        formats = [
            "%d/%m/%Y", "%Y/%m/%d", "%Y/%d/%m", "%m/%d/%Y",
            "%m-%d-%Y", "%d-%m-%Y", "%Y-%d-%m", "%Y-%m-%d",
        ]

    if df.height == 0:
        return []

    n = min(sample_size, df.height)
    try:
        samp = df.sample(n=n, with_replacement=False)
    except Exception:
        samp = df.head(n)

    date_cols: List[str] = []

    for col, dt in df.schema.items():
        if dt in (pl.Date, pl.Datetime):
            date_cols.append(col)
            continue

        if dt != pl.Utf8:
            continue

        try:
            s_vals = samp.get_column(col).drop_nulls().to_pandas().astype(str).str.strip()
            s_vals = s_vals[s_vals.str.len() >= 6]
            if len(s_vals) == 0:
                continue

            for fmt in formats:
                try:
                    parsed = pd.to_datetime(s_vals, format=fmt, errors="coerce")
                    success = parsed.notna().sum() / len(s_vals)
                    if success >= threshold:
                        date_cols.append(col)
                        break
                except Exception:
                    continue
        except Exception:
            continue

    return date_cols


# ---------------------------------------------------------------------------
# Robust Time Granularity Modification
# ---------------------------------------------------------------------------
def modify_granularity(
    df: pl.DataFrame,
    geo_column: str,
    date_column: str,
    granularity_level_df: str,
    granularity_level_user_input: str,
    work_days: int = 7,
    numerical_config_dict: Dict[str, str] = None,
    categorical_config_dict: Dict[str, str] = None,
) -> Tuple[pl.DataFrame, str]:
    """
    Safely rolls up granularity (Daily->Weekly, Daily->Monthly, Weekly->Monthly)
    using Polars native month/week start dates.
    """
    numerical_config_dict = numerical_config_dict or {}
    categorical_config_dict = categorical_config_dict or {}

    base = parse_date_series_polars(df, date_column)
    base = base.with_columns(pl.col(date_column).cast(pl.Date).alias(date_column))

    exclude = {geo_column, date_column, "_group_date", "week_date", "month_date"}

    # Build aggregation expressions
    agg_exprs = []
    seen = set()
    for col, op in numerical_config_dict.items():
        if col in base.columns and col not in exclude and col not in seen:
            seen.add(col)
            if op == "sum":       agg_exprs.append(pl.col(col).sum().alias(col))
            elif op == "average": agg_exprs.append(pl.col(col).mean().alias(col))
            elif op == "min":     agg_exprs.append(pl.col(col).min().alias(col))
            elif op == "max":     agg_exprs.append(pl.col(col).max().alias(col))
            elif op == "product": agg_exprs.append(pl.col(col).drop_nulls().product().alias(col))

    for col, op in categorical_config_dict.items():
        if col in base.columns and col not in exclude and col not in seen:
            seen.add(col)
            if op == "count":            agg_exprs.append(pl.col(col).count().alias(col))
            elif op == "distinct count": agg_exprs.append(pl.col(col).n_unique().alias(col))

    # Auto-aggregate numeric columns if none were explicitly supplied
    if not agg_exprs:
        for col, dtype in base.schema.items():
            if col not in exclude and dtype.is_numeric():
                agg_exprs.append(pl.col(col).sum().alias(col))

    # 1. Same granularity (e.g. Weekly -> Weekly, Monthly -> Monthly)
    if granularity_level_df == granularity_level_user_input:
        seen_cols = set()
        selected_cols = []
        for col in [geo_column, date_column] + list(numerical_config_dict.keys()) + list(categorical_config_dict.keys()):
            if col in base.columns and col not in seen_cols:
                seen_cols.add(col)
                selected_cols.append(col)
        for col in base.columns:
            if col not in seen_cols:
                seen_cols.add(col)
                selected_cols.append(col)
        return base.select(selected_cols), date_column

    # 2. Daily -> Weekly
    if granularity_level_df == "Daily" and granularity_level_user_input == "Weekly":
        base = base.with_columns(
            (pl.col(date_column) - pl.duration(days=pl.col(date_column).dt.weekday())).alias("_group_date")
        )
        out = base.group_by([geo_column, "_group_date"]).agg(agg_exprs)
        out = out.rename({"_group_date": date_column})
        return out, date_column

    # 3. Weekly -> Monthly OR Daily -> Monthly
    if granularity_level_user_input == "Monthly":
        # Group to the 1st of every month
        base = base.with_columns(
            pl.col(date_column).dt.month_start().alias("_group_date")
        )
        out = base.group_by([geo_column, "_group_date"]).agg(agg_exprs)
        out = out.rename({"_group_date": date_column})
        return out, date_column

    return base, date_column


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def normalize_columns_pl(df: pl.DataFrame, columns: List[str], method: str = "zscore") -> pl.DataFrame:
    out = df.clone()
    cols = [c for c in columns if c in out.columns and out.schema[c].is_numeric()]
    if method == "zscore":
        means = out.select([pl.col(c).mean().alias(c) for c in cols]).to_dicts()[0] if cols else {}
        stds = out.select([pl.col(c).std().alias(c) for c in cols]).to_dicts()[0] if cols else {}
        exprs = []
        for c in cols:
            mu, sd = means.get(c), stds.get(c)
            if sd and sd != 0 and mu is not None:
                exprs.append(((pl.col(c) - pl.lit(mu)) / pl.lit(sd)).alias(f"{c}_z"))
        if exprs:
            out = out.with_columns(exprs)
    elif method == "iqr":
        q1s = out.select([pl.col(c).quantile(0.25).alias(c) for c in cols]).to_dicts()[0] if cols else {}
        q3s = out.select([pl.col(c).quantile(0.75).alias(c) for c in cols]).to_dicts()[0] if cols else {}
        exprs = []
        for c in cols:
            q1, q3 = q1s.get(c), q3s.get(c)
            if q1 is not None and q3 is not None:
                iqr = q3 - q1
                if iqr != 0:
                    exprs.append(((pl.col(c) - pl.lit(q1)) / pl.lit(iqr)).alias(f"{c}_iqr"))
        if exprs:
            out = out.with_columns(exprs)
    return out


# ---------------------------------------------------------------------------
# Generic Column Semantic Inference & Comprehensive EDA Statistics
# ---------------------------------------------------------------------------
def infer_column_semantic_type(
    series: pd.Series,
    col_name: str,
    date_col: Optional[str] = None,
    geo_col: Optional[str] = None,
    dep_var: Optional[str] = None,
) -> str:
    if date_col and col_name == date_col:
        return "Date"
    if geo_col and col_name == geo_col:
        return "Dimension"
    if dep_var and col_name == dep_var:
        return "Metric"

    if pd.api.types.is_datetime64_any_dtype(series):
        return "Date"

    if not pd.api.types.is_numeric_dtype(series):
        s_clean = series.dropna().astype(str).str.strip()
        if len(s_clean) > 0 and s_clean.str.len().mean() >= 8:
            sample_parsed = pd.to_datetime(s_clean.head(50), errors="coerce")
            if sample_parsed.notna().sum() / len(sample_parsed) > 0.8:
                return "Date"
        return "Dimension"

    name_lower = col_name.lower().strip()
    id_tokens = ["id", "code", "zip", "postal", "fips", "key", "account", "phone", "npi", "num"]
    if any(tok in name_lower for tok in id_tokens):
        return "Dimension"

    valid_nums = series.dropna()
    if len(valid_nums) > 0:
        is_all_int = (valid_nums % 1 == 0).all()
        if is_all_int:
            min_v, max_v = valid_nums.min(), valid_nums.max()
            if min_v >= 1000 and max_v >= 9999 and any(p in name_lower for p in ["zip", "post", "area"]):
                return "Dimension"

    return "Metric"


def compute_eda_stats(
    df: pd.DataFrame,
    date_column: str,
    geo_column: str,
    dependent_variable: str,
) -> dict:
    df = df.copy()
    total_rows = len(df)

    summary_stats = []
    metric_cols = []

    for col in df.columns:
        raw_s = df[col]

        s_str = raw_s.astype(str).str.strip()
        is_missing = raw_s.isna() | s_str.isin(["", "nan", "None", "NaT", "<NA>", "null"])
        missing_count = int(is_missing.sum())
        missing_pct = round((missing_count / total_rows) * 100, 2) if total_rows > 0 else 0.0

        valid_raw = raw_s[~is_missing]
        unique_count = int(valid_raw.nunique())

        col_type = infer_column_semantic_type(
            raw_s, col, date_column, geo_column, dependent_variable
        )

        if col_type == "Metric":
            metric_cols.append(col)
            valid_nums = pd.to_numeric(valid_raw, errors="coerce").dropna()
            if len(valid_nums) > 0:
                summary_stats.append({
                    "variable": col,
                    "type": "Metric",
                    "is_numeric": True,
                    "unique_count": unique_count,
                    "min": round(float(valid_nums.min()), 2),
                    "max": round(float(valid_nums.max()), 2),
                    "mean": round(float(valid_nums.mean()), 2),
                    "median": round(float(valid_nums.median()), 2),
                    "std": round(float(valid_nums.std()), 2) if len(valid_nums) > 1 else 0.0,
                    "p75": round(float(valid_nums.quantile(0.75)), 2),
                    "p95": round(float(valid_nums.quantile(0.95)), 2),
                    "missing_count": missing_count,
                    "missing_pct": missing_pct,
                })
            else:
                summary_stats.append({
                    "variable": col, "type": "Metric", "is_numeric": True,
                    "unique_count": unique_count, "min": None, "max": None,
                    "mean": None, "median": None, "std": None, "p75": None, "p95": None,
                    "missing_count": missing_count, "missing_pct": missing_pct,
                })

        elif col_type == "Date":
            parsed_d = pd.to_datetime(valid_raw, errors="coerce", dayfirst=True)
            if parsed_d.isna().sum() > 0:
                parsed_d0 = pd.to_datetime(valid_raw, errors="coerce", dayfirst=False)
                parsed_d = parsed_d.fillna(parsed_d0)

            min_d = str(parsed_d.min().date()) if parsed_d.notna().any() else "—"
            max_d = str(parsed_d.max().date()) if parsed_d.notna().any() else "—"

            summary_stats.append({
                "variable": col,
                "type": "Date",
                "is_numeric": False,
                "unique_count": unique_count,
                "min": min_d,
                "max": max_d,
                "mean": None,
                "median": None,
                "std": None,
                "p75": None,
                "p95": None,
                "missing_count": missing_count,
                "missing_pct": missing_pct,
            })

        else:
            min_val = str(valid_raw.min()) if len(valid_raw) > 0 else "—"
            max_val = str(valid_raw.max()) if len(valid_raw) > 0 else "—"

            summary_stats.append({
                "variable": col,
                "type": "Dimension",
                "is_numeric": False,
                "unique_count": unique_count,
                "min": min_val,
                "max": max_val,
                "mean": None,
                "median": None,
                "std": None,
                "p75": None,
                "p95": None,
                "missing_count": missing_count,
                "missing_pct": missing_pct,
            })

    trend_data = []
    if date_column in df.columns and len(metric_cols) > 0:
        parsed_date_series = pd.to_datetime(df[date_column], dayfirst=True, errors="coerce")
        if parsed_date_series.isna().sum() > 0:
            parsed_d0 = pd.to_datetime(df[date_column], dayfirst=True, errors="coerce")
            parsed_date_series = parsed_date_series.fillna(parsed_d0)

        df["_parsed_date_str"] = parsed_date_series.dt.strftime("%Y-%m-%d")
        valid_trend_df = df[df["_parsed_date_str"].notna()]

        if len(valid_trend_df) > 0:
            trend_agg = (
                valid_trend_df.groupby("_parsed_date_str")[metric_cols]
                .sum()
                .reset_index()
                .sort_values("_parsed_date_str")
            )
            trend_agg.rename(columns={"_parsed_date_str": "date"}, inplace=True)
            trend_data = trend_agg.to_dict(orient="records")

    by_geo = []
    if geo_column in df.columns and dependent_variable in df.columns:
        valid_geo = df.dropna(subset=[geo_column, dependent_variable])
        geo_agg = (
            valid_geo.groupby(geo_column)[dependent_variable]
            .sum()
            .reset_index()
            .rename(columns={geo_column: "geo", dependent_variable: "value"})
            .sort_values("value", ascending=False)
        )
        by_geo = geo_agg.head(20).to_dict(orient="records")

    return {
        "summary_stats": summary_stats,
        "trend_data": trend_data,
        "by_geo": by_geo,
        "numeric_cols": metric_cols,
        "all_cols": df.columns.tolist(),
        "total_rows": total_rows,
        "date_column": date_column,
        "geo_column": geo_column,
        "dependent_variable": dependent_variable,
    }


# ---------------------------------------------------------------------------
# Multicollinearity Analysis & Treatment
# ---------------------------------------------------------------------------
def compute_correlation_matrix(df: pd.DataFrame, columns: List[str], method: str = "pearson") -> dict:
    sub = df[columns].apply(pd.to_numeric, errors='coerce').dropna()
    corr = sub.corr(method=method)
    return corr.fillna(0).to_dict()


def compute_corr_pairs(df: pd.DataFrame, feature_cols: List[str], threshold: float) -> Tuple[List[Tuple], pd.DataFrame]:
    feature_cols = [c for c in feature_cols if c in df.columns]
    if len(feature_cols) < 2:
        return [], pd.DataFrame()

    sub = df[feature_cols].apply(pd.to_numeric, errors='coerce').dropna()
    corr_matrix = sub.corr().abs().fillna(0)
    pairs = []
    for i in range(len(feature_cols)):
        for j in range(i + 1, len(feature_cols)):
            f1, f2 = feature_cols[i], feature_cols[j]
            if f1 in corr_matrix.index and f2 in corr_matrix.columns:
                corr_val = float(corr_matrix.loc[f1, f2])
                if corr_val >= threshold and not np.isnan(corr_val):
                    pairs.append((f1, f2, corr_val))
    pairs.sort(key=lambda x: x[2], reverse=True)
    return pairs, corr_matrix


def preview_removal_reasons(
    df: pd.DataFrame,
    feature_cols: List[str],
    dependent_variable: Optional[str],
    threshold: float,
) -> dict:
    feature_cols = [c for c in feature_cols if c in df.columns]
    if len(feature_cols) < 2:
        return {
            "pairs": [], "dropped": [], "kept": feature_cols,
            "total_pairs": 0, "total_dropped": 0, "total_kept": len(feature_cols)
        }

    pairs, _ = compute_corr_pairs(df, feature_cols, threshold)
    to_drop = set()
    kept = set(feature_cols)

    target_corr = {}
    if dependent_variable and dependent_variable in df.columns:
        try:
            sub = df[feature_cols + [dependent_variable]].apply(pd.to_numeric, errors='coerce')
            t_corr = sub.corr()[dependent_variable].abs()
            target_corr = t_corr.to_dict()
        except Exception:
            target_corr = {}

    preview_rows = []
    for f1, f2, corr_val in pairs:
        r1 = float(target_corr.get(f1, 0.0) or 0.0)
        r2 = float(target_corr.get(f2, 0.0) or 0.0)

        if r1 >= r2:
            drop_col, keep_col = f2, f1
            drop_r, keep_r = r2, r1
        else:
            drop_col, keep_col = f1, f2
            drop_r, keep_r = r1, r2

        to_drop.add(drop_col)
        kept.discard(drop_col)

        dep_name = dependent_variable or "KPI"
        reason = (
            f"{keep_col} kept (r={keep_r:.3f} with {dep_name}) vs {drop_col} dropped (r={drop_r:.3f} with {dep_name})"
        )

        preview_rows.append({
            "feature1": f1,
            "feature2": f2,
            "correlation": round(corr_val, 4),
            "will_drop": drop_col,
            "will_keep": keep_col,
            "reason": reason,
        })

    return {
        "pairs": preview_rows,
        "dropped": sorted(list(to_drop)),
        "kept": sorted(list(kept)),
        "total_pairs": len(preview_rows),
        "total_dropped": len(to_drop),
        "total_kept": len(kept),
    }


def remove_correlated_features(
    df: pd.DataFrame,
    feature_cols: List[str],
    dependent_variable: Optional[str],
    threshold: float,
) -> Tuple[pd.DataFrame, List[str], List[str]]:
    preview = preview_removal_reasons(df, feature_cols, dependent_variable, threshold)
    df_reduced = df.drop(columns=preview["dropped"])
    return df_reduced, preview["kept"], preview["dropped"]


def find_corr_clusters(df: pd.DataFrame, feature_cols: List[str], threshold: float) -> List[List[str]]:
    feature_cols = [c for c in feature_cols if c in df.columns]
    if len(feature_cols) < 2:
        return []

    sub = df[feature_cols].apply(pd.to_numeric, errors='coerce').dropna()
    corr_matrix = sub.corr().abs().fillna(0)
    adj = {f: set() for f in feature_cols}
    for i in range(len(feature_cols)):
        for j in range(i + 1, len(feature_cols)):
            f1, f2 = feature_cols[i], feature_cols[j]
            if f1 in corr_matrix.index and f2 in corr_matrix.columns:
                if corr_matrix.loc[f1, f2] >= threshold:
                    adj[f1].add(f2)
                    adj[f2].add(f1)

    visited = set()
    clusters = []
    for f in feature_cols:
        if f not in visited and adj[f]:
            stack = [f]
            cluster = set()
            while stack:
                node = stack.pop()
                if node not in visited:
                    visited.add(node)
                    cluster.add(node)
                    stack.extend(list(adj[node] - visited))
            if len(cluster) > 1:
                clusters.append(sorted(list(cluster)))
    return clusters


def preview_combination_details(
    df: pd.DataFrame,
    clusters: List[List[str]],
    new_names: List[str],
    method: str = "sum",
    weights_per_cluster: Optional[List[Dict]] = None,
) -> dict:
    cluster_previews = []
    for idx, cluster in enumerate(clusters):
        c_name = new_names[idx] if idx < len(new_names) else f"COMBO_{idx + 1}"
        formula = ""
        if method == "mean":
            series = df[cluster].mean(axis=1)
            formula = f"{c_name} = Mean({', '.join(cluster)})"
        elif method == "weighted_sum":
            w_dict = weights_per_cluster[idx] if weights_per_cluster and idx < len(weights_per_cluster) else {}
            series = pd.Series(0.0, index=df.index)
            terms = []
            for col in cluster:
                w = float(w_dict.get(col, 1.0))
                series += w * df[col]
                terms.append(f"{w}×{col}")
            formula = f"{c_name} = {' + '.join(terms)}"
        else:
            series = df[cluster].sum(axis=1)
            formula = f"{c_name} = Sum({', '.join(cluster)})"

        sample_table = pd.concat([df[cluster].head(5), series.head(5).rename(c_name)], axis=1)
        cluster_previews.append({
            "combo_name": c_name,
            "features": cluster,
            "formula": formula,
            "sample_rows": sample_table.to_dict(orient="records"),
        })

    return {"clusters": cluster_previews}


def combine_clusters(
    df: pd.DataFrame,
    feature_cols: List[str],
    clusters: List[List[str]],
    new_names: List[str],
    method: str = "sum",
    drop_original: bool = True,
    weights_per_cluster: Optional[List[Dict]] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    df_combined = df.copy()
    new_cols_info = []

    for idx, cluster in enumerate(clusters):
        user_col_name = new_names[idx] if idx < len(new_names) else f"COMBO_{idx + 1}"
        if method == "mean":
            combined_series = df_combined[cluster].mean(axis=1)
            method_str = "mean"
        elif method == "weighted_sum":
            w_dict = weights_per_cluster[idx] if weights_per_cluster and idx < len(weights_per_cluster) else {}
            combined_series = pd.Series(0.0, index=df_combined.index)
            for col in cluster:
                w = float(w_dict.get(col, 1.0))
                combined_series += w * df_combined[col]
            weight_strs = ", ".join(f"{col}×{w_dict.get(col, 1.0):.2f}" for col in cluster)
            method_str = f"weighted_sum ({weight_strs})"
        else:
            combined_series = df_combined[cluster].sum(axis=1)
            method_str = "sum"

        df_combined[user_col_name] = combined_series
        new_cols_info.append({"combo_name": user_col_name, "features": cluster, "method": method_str})
        if drop_original:
            df_combined = df_combined.drop(columns=[c for c in cluster if c in df_combined.columns and c != user_col_name])

    return df_combined, pd.DataFrame(new_cols_info)


def apply_weighted_sum_columns(
    df: pd.DataFrame,
    configs: List[Dict],
    drop_original: bool = False,
) -> Tuple[pd.DataFrame, List[Dict]]:
    df_out = df.copy()
    applied_info = []
    for cfg in configs:
        col_name = cfg["column_name"]
        sel_cols = cfg["columns"]
        w_dict = cfg.get("weights", {})
        series = sum(float(w_dict.get(c, 1.0)) * df_out[c] for c in sel_cols)
        df_out[col_name] = series
        weight_detail = ", ".join(f"{c}×{w_dict.get(c, 1.0):.2f}" for c in sel_cols)
        applied_info.append({
            "New column": col_name,
            "Source columns": ", ".join(sel_cols),
            "Weights": weight_detail,
        })
        if drop_original:
            existing = [c for c in sel_cols if c in df_out.columns and c != col_name]
            df_out = df_out.drop(columns=existing)
    return df_out, applied_info


def apply_pca_treatment(
    df: pd.DataFrame,
    feature_cols: List[str],
    variance_threshold: float = 0.9,
) -> dict:
    X = df[feature_cols].values
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    pca = PCA()
    X_pca = pca.fit_transform(X_scaled)
    explained_var = pca.explained_variance_ratio_
    cumulative_var = np.cumsum(explained_var)

    n_components = int(np.searchsorted(cumulative_var, variance_threshold) + 1)
    n_components = max(1, min(n_components, len(feature_cols)))

    pc_cols = [f"PC{i + 1}" for i in range(n_components)]
    pcs_df = pd.DataFrame(X_pca[:, :n_components], columns=pc_cols, index=df.index)

    non_feature_cols = [c for c in df.columns if c not in feature_cols]
    df_pca = pd.concat([df[non_feature_cols], pcs_df], axis=1)

    explained_df = pd.DataFrame({
        "Component": [f"PC{i + 1}" for i in range(len(explained_var))],
        "Explained_Variance_Ratio": explained_var,
        "Cumulative_Variance": cumulative_var,
    })

    loadings = pca.components_[:n_components]
    squared_loadings = loadings ** 2
    contrib_pct = squared_loadings / squared_loadings.sum(axis=1, keepdims=True)
    contrib_df = pd.DataFrame(contrib_pct, columns=feature_cols, index=pc_cols)

    top3_dict = {}
    for pc in contrib_df.index:
        top3 = contrib_df.loc[pc].sort_values(ascending=False).head(3)
        top3_dict[pc] = pd.DataFrame({
            "Channel": top3.index.tolist(),
            "Contribution (%)": (top3.values * 100).round(2).tolist(),
        })

    return {
        "df_pca": df_pca,
        "explained_variance": explained_df.to_dict(orient="records"),
        "n_components": n_components,
        "contributions": contrib_df.reset_index().rename(columns={"index": "Component"}).to_dict(orient="records"),
        "top3": {pc: tbl.to_dict(orient="records") for pc, tbl in top3_dict.items()},
    }


def get_candidate_features(
    df: pd.DataFrame,
    geo_column: Optional[str],
    date_column: Optional[str],
    zip_column: Optional[str],
    dma_column: Optional[str],
    dependent_variable: Optional[str],
) -> Tuple[List[str], List[str]]:
    non_feature_cols = {
        col for col in [geo_column, date_column, zip_column, dma_column, dependent_variable]
        if col is not None
    }
    candidate_cols = []
    for c in df.columns:
        if c in non_feature_cols:
            continue
        c_type = infer_column_semantic_type(df[c], c, date_column, geo_column, dependent_variable)
        if c_type == "Metric":
            candidate_cols.append(c)

    return candidate_cols, list(non_feature_cols)


def run_pca(df: pd.DataFrame, columns: List[str], n_components: int = 2) -> dict:
    sub = df[columns].dropna()
    scaler = StandardScaler()
    scaled = scaler.fit_transform(sub)
    pca = PCA(n_components=n_components)
    components = pca.fit_transform(scaled)
    return {
        "explained_variance_ratio": pca.explained_variance_ratio_.tolist(),
        "components": components.tolist(),
        "loadings": pd.DataFrame(pca.components_, columns=columns).to_dict(orient="records"),
    }


# ---------------------------------------------------------------------------
# Optuna, Transformations & Modelling
# ---------------------------------------------------------------------------
def _apply_adstock_simple(series, decay, lag):
    result = np.array(series, dtype=np.float64)
    arr = np.array(series, dtype=np.float64)
    for l in range(1, lag + 1):
        shifted = np.concatenate([np.zeros(l), arr[:-l]]) if l < len(arr) else np.zeros(len(arr))
        result += (decay ** l) * shifted
    return result


def _transform_for_optuna(df, geo_column, channels_cfg, params):
    df = df.copy()
    for cfg in channels_cfg:
        ch = cfg["name"]
        has_ads = cfg["has_adstock"]
        sat_method = cfg.get("sat_method")

        if ch not in df.columns:
            continue

        decay = params.get(f"{ch}_decay", 0.5)
        lag = int(params.get(f"{ch}_lag", 1))
        power = params.get(f"{ch}_power", 0.5)

        if has_ads:
            transformed = df.groupby(geo_column)[ch].transform(
                lambda x: _apply_adstock_simple(x.values, decay, lag)
            )
        else:
            transformed = df[ch].copy()

        if sat_method == "Power":
            df[f"{ch}_transformed"] = np.power(np.abs(transformed), power)
        elif sat_method == "Log":
            df[f"{ch}_transformed"] = np.log1p(np.abs(transformed))
        else:
            df[f"{ch}_transformed"] = transformed

    return df


def sign_penalty(betas, negative_channels):
    penalty = 0.0
    for name, beta in betas.items():
        if name in negative_channels:
            if beta > 0:
                penalty += abs(beta)
        else:
            if beta < 0:
                penalty += abs(beta)
    return penalty


def magnitude_penalty(betas):
    return sum(b ** 2 for b in betas.values())


def stability_penalty(beta_list):
    if len(beta_list) < 2:
        return 0.0
    beta_df = pd.DataFrame(beta_list)
    return float(beta_df.var().mean())


def run_optuna_optimization(
    df: pd.DataFrame,
    geo_column: str,
    dependent_variable: str,
    channels_cfg: List[Dict],
    channel_feature_names: List[str],
    n_trials: int,
    cv_splits: int,
    use_sign_pen: bool,
    use_mag_pen: bool,
    use_stab_pen: bool,
    lambda_sign: float,
    lambda_mag: float,
    lambda_stab: float,
    negative_channels: set,
    power_choices: List[float],
    decay_choices: List[float],
    lag_choices: List[int],
) -> dict:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    tscv = TimeSeriesSplit(n_splits=cv_splits)

    def objective(trial):
        params = {}
        for cfg in channels_cfg:
            ch = cfg["name"]
            if cfg["has_adstock"]:
                params[f"{ch}_decay"] = trial.suggest_categorical(f"{ch}_decay", decay_choices)
                params[f"{ch}_lag"] = trial.suggest_categorical(f"{ch}_lag", lag_choices)
            if cfg.get("sat_method") == "Power":
                params[f"{ch}_power"] = trial.suggest_categorical(f"{ch}_power", power_choices)

        df_temp = _transform_for_optuna(df, geo_column, channels_cfg, params)
        feat_cols = [c for c in channel_feature_names if c in df_temp.columns]
        df_model = df_temp.dropna(subset=[dependent_variable] + feat_cols)

        if df_model.empty or len(df_model) < cv_splits * 2:
            return float("inf")

        X = sm.add_constant(df_model[feat_cols].astype(float))
        y = df_model[dependent_variable].astype(float)

        errors = []
        beta_list = []
        for train_idx, test_idx in tscv.split(X):
            try:
                X_tr, X_te = X.iloc[train_idx], X.iloc[test_idx]
                y_tr, y_te = y.iloc[train_idx], y.iloc[test_idx]
                m = sm.OLS(y_tr, X_tr).fit()
                preds = m.predict(X_te)
                errors.append(float(np.sqrt(mean_squared_error(y_te, preds))))
                b = m.params.to_dict()
                b.pop("const", None)
                beta_list.append(b)
            except Exception:
                errors.append(float("inf"))

        base_error = float(np.mean(errors))
        if not np.isfinite(base_error):
            return float("inf")

        avg_betas = pd.DataFrame(beta_list).mean().to_dict() if beta_list else {}
        total_loss = base_error
        if use_sign_pen and avg_betas:
            total_loss += lambda_sign * sign_penalty(avg_betas, negative_channels)
        if use_mag_pen and avg_betas:
            total_loss += lambda_mag * magnitude_penalty(avg_betas)
        if use_stab_pen and beta_list:
            total_loss += lambda_stab * stability_penalty(beta_list)
        return total_loss

    sampler = optuna.samplers.TPESampler(seed=42)
    study = optuna.create_study(direction="minimize", sampler=sampler)
    study.optimize(objective, n_trials=n_trials)

    return {
        "best_params": study.best_params,
        "best_value": float(study.best_value) if study.best_value != float("inf") else None,
        "n_trials": n_trials,
    }


def optuna_params_to_transform_rows(channels_cfg: List[Dict], best_params: Dict) -> List[Dict]:
    rows = []
    for cfg in channels_cfg:
        ch = cfg["name"]
        row = {"Channel Name": ch}
        if cfg["has_adstock"]:
            row["Adstock"] = round(float(best_params.get(f"{ch}_decay", 0.5)), 2)
            row["Lags"] = int(best_params.get(f"{ch}_lag", 1))
        else:
            row["Adstock"] = None
            row["Lags"] = None
        if cfg.get("sat_method") == "Power":
            row["Saturation Function"] = "Power"
            row["Power (k)"] = round(float(best_params.get(f"{ch}_power", 0.5)), 2)
        else:
            row["Saturation Function"] = None
            row["Power (k)"] = None
        rows.append(row)
    return rows


def transform_edited_df(df: pd.DataFrame, edited_df: pd.DataFrame, geo_column: str, dependent_variable: str) -> pd.DataFrame:
    transformed_df = df.copy()
    for _, row in edited_df.iterrows():
        channel = row["Channel Name"]
        lags = int(row["Lags"]) if pd.notna(row.get("Lags")) else None
        adstock_coeff = float(row["Adstock"]) if pd.notna(row.get("Adstock")) else None
        sat_function = row.get("Saturation Function")
        power_k = float(row["Power (k)"]) if sat_function == "Power" and pd.notna(row.get("Power (k)")) else 0.5

        if channel not in transformed_df.columns:
            continue

        if sat_function is None and adstock_coeff is None and lags is None:
            transformed_df[f"{channel}_transformed"] = transformed_df[channel]
        elif sat_function is None and lags is None and adstock_coeff is not None:
            raise ValueError("Lag required when Adstock is set")
        elif sat_function is None and lags is not None and adstock_coeff is None:
            transformed_df[f"{channel}_transformed"] = (
                transformed_df.groupby(geo_column)[channel].shift(lags, fill_value=0).fillna(0)
            )
        elif sat_function is None and lags is not None and adstock_coeff is not None:
            transformed_df[f"{channel}_transformed"] = (
                transformed_df.groupby(geo_column)[channel].transform(lambda x: geometric_adstock(x, lags, adstock_coeff))
            )
        elif sat_function is not None and lags is None and adstock_coeff is None:
            transformed_df[f"{channel}_transformed"] = (
                transformed_df.groupby(geo_column)[channel].transform(lambda x: apply_saturation(x, sat_function, power_k))
            )
        elif sat_function is not None and lags is not None and adstock_coeff is None:
            lagged_series = transformed_df.groupby(geo_column, as_index=False)[channel].shift(lags, fill_value=0).fillna(0)
            transformed_df[f"{channel}_transformed"] = (
                lagged_series.groupby(transformed_df[geo_column]).transform(lambda x: apply_saturation(x, sat_function, power_k))
            )
        else:
            transformed_df[f"{channel}_transformed"] = (
                transformed_df.groupby(geo_column)[channel].transform(
                    lambda x: apply_saturation(geometric_adstock(x, lags, adstock_coeff), sat_function, power_k)
                )
            )
    return transformed_df


def geometric_adstock(series: np.ndarray, lags: int, adstock_coeff: float) -> np.ndarray:
    series = np.array(series, dtype=np.float64)
    adstocked = np.zeros_like(series)
    for i in range(len(series)):
        for j in range(lags + 1):
            if i - j >= 0:
                adstocked[i] += (adstock_coeff ** j) * series[i - j]
    return adstocked


def apply_saturation(series: np.ndarray, method: str, power_k: float = 0.5) -> np.ndarray:
    series = np.array(series, dtype=np.float64)
    if method.lower() == "log":
        return np.log1p(series)
    elif method.lower() == "power":
        return np.power(series, power_k)
    return series


def run_ols_regression(
    transformed_df: pd.DataFrame,
    granular_df: pd.DataFrame,
    date_column: str,
    geo_column: str,
    dependent_variable: str,
    dependent_variable_user_input: str,
    selected_channels: List[str],
    start_date,
    end_date,
) -> dict:
    transformed_df[date_column] = pd.to_datetime(transformed_df[date_column], dayfirst=True)
    granular_df[date_column] = pd.to_datetime(granular_df[date_column], dayfirst=True)

    modeling_duration_days = (pd.to_datetime(end_date, dayfirst=True) - pd.to_datetime(start_date, dayfirst=True)).days + 1
    prior_end_date = pd.to_datetime(start_date, dayfirst=True) - pd.Timedelta(days=1)
    prior_start_date = prior_end_date - pd.Timedelta(days=modeling_duration_days - 1)

    tdf = transformed_df[(transformed_df[date_column] >= pd.to_datetime(start_date, dayfirst=True)) & (transformed_df[date_column] <= pd.to_datetime(end_date, dayfirst=True))]
    gdf = granular_df[(granular_df[date_column] >= pd.to_datetime(start_date, dayfirst=True)) & (granular_df[date_column] <= pd.to_datetime(end_date, dayfirst=True))]
    gdf_prior = granular_df[(granular_df[date_column] >= prior_start_date) & (granular_df[date_column] <= prior_end_date)]

    tdf_filtered = tdf[[date_column, geo_column, dependent_variable_user_input] + selected_channels]
    y = tdf_filtered[dependent_variable_user_input]
    X = tdf_filtered[selected_channels]
    X = sm.add_constant(X)
    model = sm.OLS(y, X).fit()

    sum_sales = tdf_filtered[dependent_variable_user_input].sum()
    sum_raw_sales = gdf[dependent_variable].sum()
    sum_raw_sales_prior = gdf_prior[dependent_variable].sum() if len(gdf_prior) > 0 else 1

    coefficients = pd.DataFrame({"Variable": model.params.index, "Coefficient": model.params.values})
    tdf_filtered = tdf_filtered.copy()
    tdf_filtered["const"] = 1
    gdf = gdf.copy()
    gdf["const"] = 1

    transformed_to_raw = {col: "const" if col == "const" else col.replace("_transformed", "") for col in coefficients["Variable"]}
    coefficients["Raw Variable"] = coefficients["Variable"].map(transformed_to_raw)
    coefficients["Raw Activity"] = coefficients["Variable"].apply(
        lambda var: gdf[var.replace("_transformed", "")].sum() if var.replace("_transformed", "") in gdf.columns else 0
    )
    coefficients["Modelled Activity"] = coefficients["Variable"].apply(
        lambda var: tdf_filtered[var].sum() if var in tdf_filtered.columns else 0
    )
    no_spend_vars = ["const", "Carryover"]
    coefficients["Spend"] = coefficients["Raw Variable"].apply(
        lambda var: 0 if var in no_spend_vars else (
            gdf[var].sum() if "Spend" in var and var in gdf.columns else (
                gdf[var + " Spend"].sum() if var + " Spend" in gdf.columns else 0
            )
        )
    )
    coefficients["Impactable %"] = coefficients.apply(
        lambda row: (row["Coefficient"] * row["Modelled Activity"] * 100) / sum_sales if sum_sales != 0 else 0, axis=1
    )
    coefficients["Impactable (%)"] = coefficients["Impactable %"].map(lambda x: f"{x:.2f}%")
    coefficients["Impactable Sales"] = coefficients["Impactable %"] * sum_raw_sales / 100
    coefficients["ROI"] = coefficients.apply(lambda row: row["Impactable Sales"] / row["Spend"] if row["Spend"] != 0 else 0, axis=1)
    coefficients["Note"] = coefficients["Raw Variable"].apply(
        lambda var: "Intercept" if var == "const" else ("Carryover" if var == "Carryover" else "")
    )

    long_term_factor = None
    carryover_pct = coefficients[coefficients["Note"] == "Carryover"]["Impactable %"]
    if not carryover_pct.empty:
        cp = carryover_pct.iloc[0] / 100
        carryover_rate = (cp * sum_raw_sales) / sum_raw_sales_prior
        long_term_factor = (3 + 2 * carryover_rate + carryover_rate ** 2) / 3
        coefficients["Long Term ROI"] = long_term_factor * coefficients["ROI"]
    else:
        coefficients["Long Term ROI"] = 0

    coefficients = coefficients.drop(columns=["Raw Variable"], errors="ignore")
    return {
        "summary": model.summary().as_text(),
        "coefficients": coefficients.to_dict(orient="records"),
        "long_term_factor": long_term_factor,
        "start_date": str(start_date),
        "end_date": str(end_date),
        "r_squared": model.rsquared,
        "adj_r_squared": model.rsquared_adj,
    }


def get_original_scale_coefficients(model, scaler, selected_channels, prior_weights, use_custom_penalties):
    coef_scaled = model.coef_[1:]
    intercept_scaled = model.coef_[0]
    coef_original = np.empty(len(selected_channels))
    for i, col in enumerate(selected_channels):
        std = scaler.scale_[i]
        w = prior_weights.get(col, 1.0) if use_custom_penalties else 1.0
        coef_original[i] = coef_scaled[i] / (std * w)
    intercept_original = intercept_scaled - float(np.sum(coef_original * scaler.mean_))
    return intercept_original, coef_original


def _build_coefficients_table(
    params_series, transformed_df_channel_filtered, granular_df_date_filtered,
    granular_df_prior_date_filtered, dependent_variable, dependent_variable_user_input
):
    transformed_df_channel_filtered = transformed_df_channel_filtered.copy()
    granular_df_date_filtered = granular_df_date_filtered.copy()
    y = transformed_df_channel_filtered[dependent_variable_user_input]
    sum_sales = y.sum()
    transformed_df_channel_filtered["const"] = 1
    granular_df_date_filtered["const"] = 1

    coefficients = pd.DataFrame({"Variable": params_series.index, "Coefficient": params_series.values})
    coefficients["Raw Activity"] = coefficients["Variable"].apply(
        lambda var: (
            granular_df_date_filtered[var.replace("_transformed", "")].sum()
            if var.replace("_transformed", "") in granular_df_date_filtered.columns else 0
        )
    )
    coefficients["Modelled Activity"] = coefficients["Variable"].apply(
        lambda var: transformed_df_channel_filtered[var].sum() if var in transformed_df_channel_filtered.columns else 0
    )
    lagged_col = "Carryover"
    coefficients["Note"] = coefficients["Variable"].apply(
        lambda var: "Intercept" if var == "const" else ("Carryover" if var.replace("_transformed", "") == lagged_col else "")
    )
    coefficients["Contribution"] = coefficients["Coefficient"] * coefficients["Modelled Activity"]
    total_contribution = coefficients["Contribution"].sum()
    coefficients["Impactable %"] = coefficients["Contribution"].apply(
        lambda c: ((c / total_contribution) * 100) if total_contribution != 0 else 0
    )
    coefficients["Impactable (%)"] = coefficients["Impactable %"].map(lambda x: f"{x:.2f}%")
    coefficients["Impactable Sales"] = coefficients["Impactable %"] * sum_sales / 100
    return coefficients.drop(columns=["Contribution"])


def _build_stage2_coefficients_table(
    params_series, transformed_df_full, granular_df_date_filtered,
    parent_channel_var, parent_coeff, parent_impactable_sales, s2_channels
):
    df = transformed_df_full.copy()
    gran = granular_df_date_filtered.copy()
    df["const"] = 1
    gran["const"] = 1
    coefficients = pd.DataFrame({"Variable": params_series.index, "Coefficient": params_series.values})
    coefficients["Raw Activity"] = coefficients["Variable"].apply(
        lambda var: gran[var.replace("_transformed", "")].sum() if var.replace("_transformed", "") in gran.columns else 0
    )
    coefficients["Modelled Activity"] = coefficients["Variable"].apply(
        lambda var: df[var].sum() if var in df.columns else 0
    )
    coefficients["Note"] = coefficients["Variable"].apply(lambda var: "Intercept" if var == "const" else "")
    coefficients["Contribution"] = coefficients["Coefficient"] * coefficients["Modelled Activity"]
    total_contribution = coefficients["Contribution"].sum()
    coefficients["Impactable %"] = coefficients["Contribution"].apply(
        lambda c: ((c / total_contribution) * 100) if total_contribution != 0 else 0
    )
    coefficients["Impactable (%)"] = coefficients["Impactable %"].map(lambda x: f"{x:.2f}%")
    coefficients["Impactable Sales"] = coefficients["Impactable %"] * parent_impactable_sales / 100
    return coefficients.drop(columns=["Contribution"])


def _filter_modelling_frames(transformed_df, granular_df, date_column, start_date, end_date):
    transformed_df = transformed_df.copy()
    granular_df = granular_df.copy()
    transformed_df[date_column] = pd.to_datetime(transformed_df[date_column], dayfirst=True)
    granular_df[date_column] = pd.to_datetime(granular_df[date_column], dayfirst=True)

    modeling_duration_days = (pd.to_datetime(end_date, dayfirst=True) - pd.to_datetime(start_date, dayfirst=True)).days + 1
    prior_end_date = pd.to_datetime(start_date, dayfirst=True) - pd.Timedelta(days=1)
    prior_start_date = prior_end_date - pd.Timedelta(days=modeling_duration_days - 1)

    tdf = transformed_df[
        (transformed_df[date_column] >= pd.to_datetime(start_date, dayfirst=True)) &
        (transformed_df[date_column] <= pd.to_datetime(end_date, dayfirst=True))
    ]
    gdf = granular_df[
        (granular_df[date_column] >= pd.to_datetime(start_date, dayfirst=True)) &
        (granular_df[date_column] <= pd.to_datetime(end_date, dayfirst=True))
    ]
    gdf_prior = granular_df[
        (granular_df[date_column] >= prior_start_date) &
        (granular_df[date_column] <= prior_end_date)
    ]
    return tdf, gdf, gdf_prior


def run_ols_stage2(
    transformed_df, granular_df, date_column, geo_column,
    dependent_variable, dependent_variable_user_input,
    selected_channels, start_date, end_date,
    parent_channel, s2_channels, stage1_coefficients,
) -> dict:
    tdf, gdf, gdf_prior = _filter_modelling_frames(transformed_df, granular_df, date_column, start_date, end_date)
    stage1_coeff_df = pd.DataFrame(stage1_coefficients)
    parent_row = stage1_coeff_df[stage1_coeff_df["Variable"] == parent_channel]
    parent_coeff = float(stage1_coeff_df.loc[stage1_coeff_df["Variable"] == parent_channel, "Coefficient"].iloc[0]) if len(parent_row) > 0 else 0.0
    parent_impactable_sales = float(parent_row["Impactable Sales"].values[0]) if len(parent_row) > 0 else 0.0

    if parent_channel not in tdf.columns:
        raise ValueError(f"Parent channel '{parent_channel}' not found in filtered data")

    y_s2 = tdf[parent_channel] * parent_coeff
    X_s2 = sm.add_constant(tdf[s2_channels])
    model_s2 = sm.OLS(y_s2, X_s2).fit()
    coeff_s2 = _build_stage2_coefficients_table(
        model_s2.params, tdf, gdf, parent_channel, parent_coeff, parent_impactable_sales, s2_channels
    )

    return {
        "model_type": "OLS Stage 2",
        "summary": model_s2.summary().as_text(),
        "coefficients": coeff_s2.to_dict(orient="records"),
        "parent_channel": parent_channel,
        "r_squared": float(model_s2.rsquared),
        "adj_r_squared": float(model_s2.rsquared_adj),
        "rmse": float(np.sqrt(model_s2.mse_resid)),
        "start_date": str(start_date),
        "end_date": str(end_date),
    }


def _ridge_scale_and_weight(X_df, scaler_obj, channels, prior_weights, use_custom_penalties, fit=True):
    X_s = scaler_obj.fit_transform(X_df) if fit else scaler_obj.transform(X_df)
    if use_custom_penalties:
        for i, col in enumerate(channels):
            w = prior_weights.get(col, 1.0)
            if w > 0:
                X_s[:, i] *= (1.0 / w)
    return X_s


def run_ridge_regression(
    transformed_df, granular_df, date_column, geo_column,
    dependent_variable, dependent_variable_user_input,
    selected_channels, start_date, end_date,
    alpha_mode: str = "auto", manual_alpha: float = 1.0, cv_splits: int = 3,
    positive_coef: bool = False, use_custom_penalties: bool = False,
    prior_weights: Optional[Dict] = None, stage: int = 1,
    parent_channel: Optional[str] = None, s2_channels: Optional[List[str]] = None,
    stage1_coefficients: Optional[List[Dict]] = None,
) -> dict:
    prior_weights = prior_weights or {}
    tdf, gdf, gdf_prior = _filter_modelling_frames(transformed_df, granular_df, date_column, start_date, end_date)

    if stage == 1:
        channels = selected_channels
        tdf_ch = tdf[[date_column, geo_column, dependent_variable_user_input] + channels]
        y_raw = tdf_ch[dependent_variable_user_input].values
        X_raw = tdf_ch[channels].copy()
    else:
        if not parent_channel or not s2_channels or not stage1_coefficients:
            raise ValueError("Stage 2 requires parent_channel, s2_channels, and stage1_coefficients")
        stage1_coeff_df = pd.DataFrame(stage1_coefficients)
        parent_coeff = float(stage1_coeff_df.loc[stage1_coeff_df["Variable"] == parent_channel, "Coefficient"].iloc[0])
        parent_row = stage1_coeff_df[stage1_coeff_df["Variable"] == parent_channel]
        parent_impactable_sales = float(parent_row["Impactable Sales"].values[0]) if len(parent_row) > 0 else 0.0
        if parent_channel not in tdf.columns:
            raise ValueError(f"Parent channel '{parent_channel}' not found")
        channels = s2_channels
        y_raw = (tdf[parent_channel] * parent_coeff).values
        X_raw = tdf[channels].copy()

    def scale_fn(X_df, scaler_obj, fit=True):
        return _ridge_scale_and_weight(X_df, scaler_obj, channels, prior_weights, use_custom_penalties, fit)

    alphas = [0.001, 0.01, 0.1, 1, 2, 4, 8, 10, 20, 50, 100]
    cv_results = []
    if alpha_mode == "auto":
        tscv = TimeSeriesSplit(n_splits=cv_splits)
        min_rmse = float("inf")
        best_alpha = alphas[0]
        for alpha in alphas:
            rmse_list = []
            for train_idx, test_idx in tscv.split(X_raw):
                scaler_cv = StandardScaler()
                X_tr = scale_fn(X_raw.iloc[train_idx], scaler_cv, fit=True)
                X_te = scale_fn(X_raw.iloc[test_idx], scaler_cv, fit=False)
                X_tr = sm.add_constant(X_tr, has_constant="add")
                X_te = sm.add_constant(X_te, has_constant="add")
                r = Ridge(alpha=alpha, positive=positive_coef, fit_intercept=False)
                r.fit(X_tr, y_raw[train_idx])
                rmse_list.append(float(np.sqrt(mean_squared_error(y_raw[test_idx], r.predict(X_te)))))
            avg = float(np.mean(rmse_list))
            cv_results.append({"Alpha": alpha, "Mean CV RMSE": round(avg, 4)})
            if avg < min_rmse:
                min_rmse, best_alpha = avg, alpha
    else:
        best_alpha = manual_alpha

    scaler_final = StandardScaler()
    X_scaled = scale_fn(X_raw, scaler_final, fit=True)
    X_scaled = sm.add_constant(X_scaled, has_constant="add")

    ridge_final = Ridge(alpha=best_alpha, positive=positive_coef, fit_intercept=False)
    ridge_final.fit(X_scaled, y_raw)

    intercept_orig, coef_orig = get_original_scale_coefficients(
        ridge_final, scaler_final, channels, prior_weights, use_custom_penalties
    )
    params_series = pd.Series([intercept_orig] + list(coef_orig), index=["const"] + channels)
    y_pred = ridge_final.predict(X_scaled)
    rmse = float(np.sqrt(mean_squared_error(y_raw, y_pred)))
    ss_tot = float(np.sum((y_raw - np.mean(y_raw)) ** 2))
    r2 = (1.0 - float(np.sum((y_raw - y_pred) ** 2)) / ss_tot) if ss_tot else 0.0
    n, k = len(y_raw), len(channels)
    adj_r2 = 1.0 - (1.0 - r2) * (n - 1) / (n - k - 1) if (n - k - 1) > 0 else float("nan")
    y_recon = intercept_orig + (X_raw.values * coef_orig).sum(axis=1)
    recon_rmse = float(np.sqrt(mean_squared_error(y_raw, y_recon)))

    if stage == 1:
        tdf_ch = tdf[[date_column, geo_column, dependent_variable_user_input] + channels]
        coefficients = _build_coefficients_table(
            params_series, tdf_ch, gdf, gdf_prior, dependent_variable, dependent_variable_user_input
        )
        model_type = "Ridge Stage 1"
    else:
        parent_coeff = float(pd.DataFrame(stage1_coefficients).loc[pd.DataFrame(stage1_coefficients)["Variable"] == parent_channel, "Coefficient"].iloc[0])
        parent_impactable_sales = float(pd.DataFrame(stage1_coefficients).loc[pd.DataFrame(stage1_coefficients)["Variable"] == parent_channel, "Impactable Sales"].iloc[0])
        coefficients = _build_stage2_coefficients_table(
            params_series, tdf, gdf, parent_channel, parent_coeff, parent_impactable_sales, channels
        )
        model_type = "Ridge Stage 2"

    ridge_summary = f"{model_type} Summary\n{'─' * 54}\nAlpha: {best_alpha} | R²: {r2:.4f} | Adj R²: {adj_r2:.4f} | RMSE: {rmse:,.2f}"

    result = {
        "model_type": model_type,
        "summary": ridge_summary,
        "coefficients": coefficients.to_dict(orient="records"),
        "alpha": best_alpha,
        "r_squared": r2,
        "adj_r_squared": adj_r2,
        "rmse": rmse,
        "recon_rmse": recon_rmse,
        "cv_results": cv_results,
        "positive_coef": positive_coef,
        "prior_weights": prior_weights if use_custom_penalties else {},
        "start_date": str(start_date),
        "end_date": str(end_date),
        "params": {k: float(v) for k, v in params_series.items()},
    }
    if stage == 2:
        result["parent_channel"] = parent_channel
    return result


def build_combined_table(s1_coeff_df: pd.DataFrame, s2_coeff_df: pd.DataFrame, parent_channel: str) -> pd.DataFrame:
    rows = []
    parent_s1_row = s1_coeff_df[s1_coeff_df["Variable"] == parent_channel]
    parent_s1_pct = float(parent_s1_row["Impactable %"].values[0]) if len(parent_s1_row) > 0 else 0.0

    s1_const_row = s1_coeff_df[s1_coeff_df["Variable"] == "const"]
    s1_const_pct = float(s1_const_row["Impactable %"].values[0]) if len(s1_const_row) > 0 else 0.0
    s1_const_sales = float(s1_const_row["Impactable Sales"].values[0]) if len(s1_const_row) > 0 else 0.0

    s2_const_row = s2_coeff_df[s2_coeff_df["Variable"] == "const"]
    s2_const_pct = float(s2_const_row["Impactable %"].values[0]) if len(s2_const_row) > 0 else 0.0
    s2_const_sales = float(s2_const_row["Impactable Sales"].values[0]) if len(s2_const_row) > 0 else 0.0

    combined_const_pct = s1_const_pct + s2_const_pct * (parent_s1_pct / 100.0)
    combined_const_sales = s1_const_sales + s2_const_sales

    rows.append({
        "Variable": "Constant (Baseline)",
        "Source": "Stage 1 + Stage 2",
        "Impactable %": combined_const_pct,
        "Impactable (%)": f"{combined_const_pct:.2f}%",
        "Impactable Sales": combined_const_sales,
    })

    for _, row in s1_coeff_df.iterrows():
        var = row["Variable"]
        if var == "const" or var == parent_channel:
            continue
        rows.append({
            "Variable": var,
            "Source": "Stage 1",
            "Impactable %": float(row["Impactable %"]),
            "Impactable (%)": row["Impactable (%)"],
            "Impactable Sales": float(row["Impactable Sales"]),
        })

    for _, row in s2_coeff_df.iterrows():
        var = row["Variable"]
        if var == "const":
            continue
        s2_pct = float(row["Impactable %"])
        s2_sales = float(row["Impactable Sales"])
        combined_pct = s2_pct * (parent_s1_pct / 100.0)
        rows.append({
            "Variable": f"{var}  ← via {parent_channel}",
            "Source": "Stage 2",
            "Impactable %": combined_pct,
            "Impactable (%)": f"{combined_pct:.2f}%",
            "Impactable Sales": s2_sales,
        })

    return pd.DataFrame(rows)


def build_waterfall_chart_data(combined_df: pd.DataFrame, dep_var_label: str = "Sales") -> dict:
    df = combined_df.copy()
    const_rows = df[df["Variable"].str.startswith("Constant")]
    other_rows = df[~df["Variable"].str.startswith("Constant")].copy()
    other_rows = other_rows.sort_values("Impactable Sales", ascending=False)
    df_sorted = pd.concat([const_rows, other_rows], ignore_index=True)

    labels = df_sorted["Variable"].tolist()
    values = df_sorted["Impactable Sales"].tolist()
    sources = df_sorted["Source"].tolist()
    measure = ["relative"] * len(values)

    labels.append(f"Total {dep_var_label}")
    values.append(sum(df_sorted["Impactable Sales"].tolist()))
    sources.append("Total")
    measure.append("total")

    display_labels = [
        lbl.split("  ←")[0].replace("_transformed", "").replace("_", " ").title()
        for lbl in labels
    ]

    return {
        "labels": display_labels,
        "values": values,
        "measure": measure,
        "sources": sources,
        "dep_var_label": dep_var_label,
    }


def calc_calibration_factor(impactable_sales_nation, beta_coeff, spend_nation, saturation_function, power_value, num_time=12, num_geo=2614):
    if saturation_function == "log":
        return (impactable_sales_nation / (num_time * num_geo)) / (beta_coeff * np.log(1 + (spend_nation / (num_time * num_geo))))
    elif saturation_function == "power":
        return (impactable_sales_nation / (num_time * num_geo)) / (beta_coeff * np.power(spend_nation / (num_time * num_geo), power_value))
    return 1.0


def create_response_curve(channel_name, impactable_sales_nation, beta_coeff, spend_nation, start, stop, step, price, saturation_function, power_value, num_time=12, num_geo=2614):
    calibration_factor = calc_calibration_factor(impactable_sales_nation, beta_coeff, spend_nation, saturation_function, power_value, num_time, num_geo)
    spend_values = list(range(start, stop + 1, step))
    rows = []
    prev_impactable = None
    for i, spend in enumerate(spend_values):
        if saturation_function == "log":
            impactable_geo_time = calibration_factor * beta_coeff * np.log(1 + (spend / (num_time * num_geo)))
        else:
            impactable_geo_time = calibration_factor * beta_coeff * np.power(spend / (num_time * num_geo), power_value)
        impactable_nation = impactable_geo_time * num_time * num_geo
        impactable_nation_currency = impactable_nation * price
        roi = impactable_nation_currency / spend if spend > 0 else 0
        mroi = ((impactable_nation - prev_impactable) * price / step) if prev_impactable is not None and spend > 0 else 0
        rows.append({"spend": spend, "impactable_geo_time": impactable_geo_time, "impactable_nation": impactable_nation, "impactable_nation_currency": impactable_nation_currency, "roi": roi, "mroi": mroi})
        prev_impactable = impactable_nation
    return pd.DataFrame(rows)