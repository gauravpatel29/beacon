"""
Multi-step, Grain-Aware Dataset Stitching and Analytical Record Dataset (ARD) Engine.

Supports:
1. Sequential Relational Joins (left, inner, right, outer, cross)
2. Grain Rollup (Lower Grain -> Higher Grain aggregation with crosswalk mappings)
3. Metric Allocation (Higher Grain -> Lower Grain distribution using equal or weighted strategies)
4. Metric Conservation Verification & Lineage Auditing
"""

from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
import pandas as pd

from core.processing import _parse_dates_robust

DATE_KEY_HINTS = ("date", "week", "month", "time", "period", "day", "quarter", "year")
JOIN_TYPES = ("left", "inner", "right", "outer", "cross")
STEP_TYPES = ("join", "rollup", "allocate")
_SUBSTRING_ORDER = ("inner", "outer", "right", "left", "cross")

AGGREGATION_FUNCTIONS = {
    "sum": "sum",
    "avg": "mean",
    "mean": "mean",
    "min": "min",
    "max": "max",
    "count": "count",
    "distinct_count": "nunique",
    "first": "first",
    "last": "last",
}


class StitchError(Exception):
    """Raised when pipeline configuration or execution fails validation."""
    def __init__(self, step: Optional[int], code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.step = step
        self.code = code
        self.message = message
        self.extra = extra

    def as_error(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.step is not None:
            out["step"] = self.step
        out.update(self.extra)
        return out


def parse_join_type(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in JOIN_TYPES:
        return text
    for candidate in _SUBSTRING_ORDER:
        if candidate in text:
            return candidate
    return "left"


def clean_key_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(k).strip() for k in value if str(k).strip()]
    if isinstance(value, str):
        return [k.strip() for k in value.split(",") if k.strip()]
    return []


def find_column(df: pd.DataFrame, name: str) -> Optional[str]:
    if not name or df is None:
        return None
    wanted = str(name).strip().lower()
    for col in df.columns:
        if str(col).strip().lower() == wanted:
            return str(col)
    return None


def looks_like_date_key(name: str) -> bool:
    lowered = str(name).lower()
    return any(hint in lowered for hint in DATE_KEY_HINTS)


def normalize_key(series: pd.Series, is_date: bool = False) -> pd.Series:
    text = (
        series.astype(str)
        .str.strip()
        .str.replace(r"\.0$", "", regex=True)
        .replace({"nan": "", "None": "", "null": "", "<NA>": "", "NaN": "", "NaT": ""})
    )
    if not is_date:
        return text

    parsed = _parse_dates_robust(text)
    if parsed.notna().sum() == 0:
        return text
    return parsed.dt.strftime("%Y-%m-%d").fillna("")


def _aggregate_right(df: pd.DataFrame, keys: List[str]) -> pd.DataFrame:
    df = df.loc[:, ~df.columns.duplicated()].copy()
    others = [c for c in df.columns if c not in keys]
    if not others:
        return df.drop_duplicates(subset=keys)

    how: Dict[str, Any] = {}
    for col in others:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() > 0:
            df[col] = numeric.fillna(0)
            how[col] = "sum"
        else:
            how[col] = "first"
    return df.groupby(keys, as_index=False, dropna=False).agg(how)


def compute_metric_totals(df: pd.DataFrame, columns: List[str]) -> Dict[str, float]:
    totals: Dict[str, float] = {}
    for col in columns:
        real_col = find_column(df, col)
        if real_col:
            nums = pd.to_numeric(df[real_col], errors="coerce").fillna(0.0)
            totals[real_col] = float(nums.sum())
    return totals


def verify_metric_conservation(
    source_totals: Dict[str, float],
    target_totals: Dict[str, float],
    tolerance: float = 1e-3,
) -> Dict[str, Any]:
    conservation_report = {}
    passed = True

    for col, src_val in source_totals.items():
        tgt_val = target_totals.get(col, 0.0)
        variance = abs(tgt_val - src_val)
        rel_variance = (variance / abs(src_val)) if abs(src_val) > 1e-9 else variance
        col_passed = rel_variance <= tolerance or variance <= tolerance
        if not col_passed:
            passed = False

        conservation_report[col] = {
            "source_total": round(src_val, 4),
            "target_total": round(tgt_val, 4),
            "variance": round(variance, 4),
            "status": "PASS" if col_passed else "FAIL",
        }

    return {
        "status": "PASS" if passed else "FAIL",
        "tolerance": tolerance,
        "metrics": conservation_report,
    }


def execute_join_step(
    step_idx: int,
    step: Dict[str, Any],
    left: pd.DataFrame,
    right: pd.DataFrame,
    left_name: str,
    right_name: str,
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    left = left.loc[:, ~left.columns.duplicated()].copy()
    right = right.loc[:, ~right.columns.duplicated()].copy()
    before_rows = len(left)
    join_type = parse_join_type(step.get("join_type", "left"))
    suffix = f"_step{step_idx}"

    if join_type == "cross":
        current = pd.merge(left, right, how="cross", suffixes=("", suffix))
        current = current.loc[:, ~current.columns.duplicated()]
        lineage_entry = {
            "step": step_idx,
            "type": "join",
            "left": left_name,
            "right": right_name,
            "join": "cross",
            "keys": ["(cross join - no keys)"],
            "rows_in": before_rows,
            "rows_out": int(len(current)),
            "columns": [str(c) for c in current.columns],
        }
        return current, lineage_entry

    left_wanted = clean_key_list(step.get("left_key"))
    right_wanted = clean_key_list(step.get("right_key"))

    if not left_wanted or not right_wanted:
        raise StitchError(step_idx, "keys_missing", f"Step {step_idx}: choose join keys for both left and right datasets.")
    if len(left_wanted) != len(right_wanted):
        raise StitchError(
            step_idx,
            "key_count_mismatch",
            f"Step {step_idx}: {len(left_wanted)} key(s) on left but {len(right_wanted)} on right.",
        )

    left_keys = []
    right_keys = []
    for lk, rk in zip(left_wanted, right_wanted):
        real_l = find_column(left, lk)
        real_r = find_column(right, rk)
        if not real_l:
            raise StitchError(step_idx, "left_key_not_found", f'Step {step_idx}: Column "{lk}" not found in "{left_name}".')
        if not real_r:
            raise StitchError(step_idx, "right_key_not_found", f'Step {step_idx}: Column "{rk}" not found in "{right_name}".')
        left_keys.append(real_l)
        right_keys.append(real_r)

    for lk, rk in zip(left_keys, right_keys):
        is_date = looks_like_date_key(lk) or looks_like_date_key(rk)
        left[lk] = normalize_key(left[lk], is_date)
        right[rk] = normalize_key(right[rk], is_date)

    right = _aggregate_right(right, right_keys)

    renames = {rk: lk for lk, rk in zip(left_keys, right_keys) if lk != rk}
    if renames:
        clashes = [t for t in renames.values() if t in right.columns and t not in renames]
        if clashes:
            right = right.drop(columns=clashes)
        right = right.rename(columns=renames)

    right = right.loc[:, ~right.columns.duplicated()]
    left = left.loc[:, ~left.columns.duplicated()]

    current = pd.merge(left, right, on=left_keys, how=join_type, suffixes=("", suffix))

    for col in right.columns:
        if col in left_keys or col not in current.columns:
            continue
        if pd.api.types.is_numeric_dtype(current[col]):
            current[col] = current[col].fillna(0)

    current = current.loc[:, ~current.columns.duplicated()]

    lineage_entry = {
        "step": step_idx,
        "type": "join",
        "left": left_name,
        "right": right_name,
        "join": join_type,
        "keys": left_keys,
        "rows_in": before_rows,
        "rows_out": int(len(current)),
        "columns": [str(c) for c in current.columns],
    }
    return current, lineage_entry


def execute_rollup_step(
    step_idx: int,
    step: Dict[str, Any],
    source_df: pd.DataFrame,
    mapping_df: Optional[pd.DataFrame],
    source_name: str,
    mapping_name: Optional[str],
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    source_df = source_df.loc[:, ~source_df.columns.duplicated()].copy()
    rows_in = len(source_df)

    source_entity_keys = clean_key_list(step.get("source_entity_key") or step.get("source_key"))
    target_entity_keys = clean_key_list(step.get("target_entity_key") or step.get("target_key"))
    time_keys = clean_key_list(step.get("time_key") or step.get("date_key"))
    agg_rules = step.get("agg_rules") or step.get("numeric_aggregations") or {}

    if not target_entity_keys:
        raise StitchError(step_idx, "target_key_missing", f"Step {step_idx} (Rollup): Target grain key is required.")

    enriched_df = source_df
    if mapping_df is not None:
        mapping_df = mapping_df.loc[:, ~mapping_df.columns.duplicated()].copy()
        map_src_keys = clean_key_list(step.get("mapping_source_key") or source_entity_keys)

        if not map_src_keys:
            raise StitchError(step_idx, "mapping_keys_missing", f"Step {step_idx} (Rollup): Bridge mapping keys are required.")

        real_src = [find_column(source_df, k) for k in source_entity_keys]
        real_map_src = [find_column(mapping_df, k) for k in map_src_keys]

        if any(k is None for k in real_src) or any(k is None for k in real_map_src):
            raise StitchError(step_idx, "key_resolution_failed", f"Step {step_idx} (Rollup): Source entity keys not found in datasets.")

        for sk, mk in zip(real_src, real_map_src):
            enriched_df[sk] = normalize_key(enriched_df[sk], looks_like_date_key(sk))
            mapping_df[mk] = normalize_key(mapping_df[mk], looks_like_date_key(mk))

        # Only retain mapping keys and target grain keys from mapping dataset
        real_m_tgt = [find_column(mapping_df, k) for k in target_entity_keys if find_column(mapping_df, k)]
        needed_map_cols = list(set(real_map_src + real_m_tgt))
        mapping_clean = mapping_df[needed_map_cols].loc[:, ~mapping_df[needed_map_cols].columns.duplicated()].drop_duplicates(subset=real_map_src)

        rename_map = {mk: sk for sk, mk in zip(real_src, real_map_src) if mk != sk}
        if rename_map:
            mapping_clean = mapping_clean.rename(columns=rename_map)

        mapping_clean = mapping_clean.loc[:, ~mapping_clean.columns.duplicated()]
        enriched_df = pd.merge(enriched_df, mapping_clean, on=real_src, how="inner", suffixes=("", "_map"))
        enriched_df = enriched_df.loc[:, ~enriched_df.columns.duplicated()]

    group_cols = []
    for k in target_entity_keys:
        real_k = find_column(enriched_df, k)
        if not real_k:
            raise StitchError(step_idx, "target_col_missing", f"Step {step_idx} (Rollup): Target grain column '{k}' not found.")
        if real_k not in group_cols:
            group_cols.append(real_k)

    for tk in time_keys:
        real_tk = find_column(enriched_df, tk)
        if real_tk:
            enriched_df[real_tk] = normalize_key(enriched_df[real_tk], is_date=True)
            if real_tk not in group_cols:
                group_cols.append(real_tk)

    id_tokens = ["npi", "id", "zip", "fips", "code", "account", "dma", "state", "key"]
    exclude_from_agg = set(group_cols) | set(source_entity_keys)

    agg_dict: Dict[str, Any] = {}
    metric_cols = []

    for col in enriched_df.columns:
        if col in exclude_from_agg or col.endswith("_map"):
            continue

        col_lower = col.lower()
        is_id_col = any(tok == col_lower or col_lower.startswith(f"{tok}_") or col_lower.endswith(f"_{tok}") for tok in id_tokens)

        num_series = pd.to_numeric(enriched_df[col], errors="coerce")
        has_numeric_data = num_series.notna().sum() > 0

        if col in agg_rules:
            rule = agg_rules[col]
            enriched_df[col] = num_series.fillna(0.0)
            agg_dict[col] = AGGREGATION_FUNCTIONS.get(rule, "sum")
            metric_cols.append(col)
        elif has_numeric_data and not is_id_col:
            enriched_df[col] = num_series.fillna(0.0)
            agg_dict[col] = "sum"
            metric_cols.append(col)

    if not agg_dict:
        rolled_df = enriched_df[group_cols].drop_duplicates()
    else:
        rolled_df = enriched_df.groupby(group_cols, as_index=False, dropna=False).agg(agg_dict)

    rolled_df = rolled_df.loc[:, ~rolled_df.columns.duplicated()]

    sum_metrics = [c for c, r in agg_dict.items() if r == "sum" and c in metric_cols]
    pre_totals = compute_metric_totals(source_df, sum_metrics)
    post_totals = compute_metric_totals(rolled_df, sum_metrics)
    conservation = verify_metric_conservation(pre_totals, post_totals)

    lineage_entry = {
        "step": step_idx,
        "type": "rollup",
        "source": source_name,
        "mapping": mapping_name,
        "source_grain": step.get("source_grain", "unknown"),
        "target_grain": step.get("target_grain", "unknown"),
        "group_by": group_cols,
        "rows_in": rows_in,
        "rows_out": int(len(rolled_df)),
        "columns": [str(c) for c in rolled_df.columns],
        "metric_conservation": conservation,
    }
    return rolled_df, lineage_entry


def execute_allocation_step(
    step_idx: int,
    step: Dict[str, Any],
    source_df: pd.DataFrame,
    target_structure_df: pd.DataFrame,
    mapping_df: Optional[pd.DataFrame],
    weight_df: Optional[pd.DataFrame],
    source_name: str,
    target_name: str,
    mapping_name: Optional[str],
    weight_name: Optional[str],
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    source_df = source_df.loc[:, ~source_df.columns.duplicated()].copy()
    target_structure_df = target_structure_df.loc[:, ~target_structure_df.columns.duplicated()].copy()
    rows_in = len(target_structure_df)

    source_grain_keys = clean_key_list(
        step.get("source_grain_key") or step.get("source_entity_key") or step.get("source_key")
    )
    target_grain_keys = clean_key_list(
        step.get("target_grain_key") or step.get("target_entity_key") or step.get("target_key")
    )
    time_keys = clean_key_list(step.get("time_key") or step.get("date_key"))
    allocation_method = str(step.get("allocation_method", "equal")).lower()
    weight_column = step.get("weight_column")
    metrics_to_allocate = clean_key_list(step.get("metrics") or step.get("allocated_metrics"))

    if not source_grain_keys:
        raise StitchError(step_idx, "source_grain_key_missing", f"Step {step_idx} (Allocate): Source grain key (e.g. DMA) is required.")
    if not target_grain_keys:
        raise StitchError(step_idx, "target_grain_key_missing", f"Step {step_idx} (Allocate): Target entity key (e.g. NPI) is required.")

    enriched_target = target_structure_df
    real_target_source_key = [find_column(target_structure_df, k) for k in source_grain_keys]

    # Step 1: Attach Source Grain key to Target Structure using Crosswalk Mapping if needed
    if any(k is None for k in real_target_source_key):
        if mapping_df is None:
            raise StitchError(step_idx, "mapping_required", f"Step {step_idx} (Allocate): Mapping dataset is required to associate target entities with source grain.")
        
        mapping_df = mapping_df.loc[:, ~mapping_df.columns.duplicated()].copy()

        real_m_tgt = [find_column(mapping_df, k) for k in target_grain_keys if find_column(mapping_df, k)]
        real_t_tgt = [find_column(target_structure_df, k) for k in target_grain_keys if find_column(target_structure_df, k)]
        real_m_src = [find_column(mapping_df, k) for k in source_grain_keys if find_column(mapping_df, k)]

        if not real_m_src:
            for col in mapping_df.columns:
                if "dma" in col.lower() or "geo" in col.lower() or "market" in col.lower():
                    real_m_src.append(col)
                    break

        if not real_m_tgt or not real_t_tgt:
            raise StitchError(step_idx, "mapping_target_key_missing", f"Step {step_idx} (Allocate): Target entity key not found in mapping dataset.")
        if not real_m_src:
            raise StitchError(step_idx, "mapping_source_grain_key_missing", f"Step {step_idx} (Allocate): Source grain key not found in mapping dataset.")

        for tk, mk in zip(real_t_tgt, real_m_tgt):
            enriched_target[tk] = normalize_key(enriched_target[tk], looks_like_date_key(tk))
            mapping_df[mk] = normalize_key(mapping_df[mk], looks_like_date_key(mk))

        # Select only needed mapping columns to prevent duplicate column conflicts
        needed_map_cols = list(set(real_m_tgt + real_m_src))
        clean_map = mapping_df[needed_map_cols].loc[:, ~mapping_df[needed_map_cols].columns.duplicated()].drop_duplicates(subset=real_m_tgt)

        rename_map = {mk: tk for tk, mk in zip(real_t_tgt, real_m_tgt) if mk != tk}
        for sk, mk in zip(source_grain_keys, real_m_src):
            if mk != sk and mk not in rename_map:
                rename_map[mk] = sk

        if rename_map:
            drop_clashes = [t for t in rename_map.values() if t in clean_map.columns and t not in rename_map]
            if drop_clashes:
                clean_map = clean_map.drop(columns=drop_clashes)
            clean_map = clean_map.rename(columns=rename_map)

        clean_map = clean_map.loc[:, ~clean_map.columns.duplicated()]
        enriched_target = enriched_target.loc[:, ~enriched_target.columns.duplicated()]

        enriched_target = pd.merge(enriched_target, clean_map, on=real_t_tgt, how="left")
        enriched_target = enriched_target.loc[:, ~enriched_target.columns.duplicated()]

    # Step 2: Attach Weight Dataset if Weighted Allocation is selected
    if allocation_method == "weighted_column":
        if weight_df is not None:
            weight_df = weight_df.loc[:, ~weight_df.columns.duplicated()].copy()
            weight_join_keys = []

            for k in source_grain_keys + target_grain_keys:
                real_e_k = find_column(enriched_target, k)
                real_w_k = find_column(weight_df, k)
                if real_e_k and real_w_k and (real_e_k, real_w_k) not in weight_join_keys:
                    weight_join_keys.append((real_e_k, real_w_k))

            if not weight_join_keys:
                for col in weight_df.columns:
                    if "dma" in col.lower() or "geo" in col.lower() or "market" in col.lower():
                        for ecol in enriched_target.columns:
                            if ("dma" in ecol.lower() and "dma" in col.lower()) or ("npi" in ecol.lower() and "npi" in col.lower()):
                                weight_join_keys.append((ecol, col))
                                break
                        if weight_join_keys:
                            break

            if weight_join_keys:
                for ek, wk in weight_join_keys:
                    enriched_target[ek] = normalize_key(enriched_target[ek], looks_like_date_key(ek))
                    weight_df[wk] = normalize_key(weight_df[wk], looks_like_date_key(wk))

                real_weight_col = find_column(weight_df, weight_column)
                if not real_weight_col:
                    raise StitchError(step_idx, "weight_col_missing", f'Step {step_idx} (Allocate): Weight column "{weight_column}" not found in weight dataset "{weight_name}".')

                w_merge_keys = [wk for _, wk in weight_join_keys]
                needed_w_cols = list(set(w_merge_keys + [real_weight_col]))
                weight_clean = weight_df[needed_w_cols].loc[:, ~weight_df[needed_w_cols].columns.duplicated()].drop_duplicates(subset=w_merge_keys)

                rename_w = {wk: ek for ek, wk in weight_join_keys if wk != ek}
                if rename_w:
                    drop_clashes = [t for t in rename_w.values() if t in weight_clean.columns and t not in rename_w]
                    if drop_clashes:
                        weight_clean = weight_clean.drop(columns=drop_clashes)
                    weight_clean = weight_clean.rename(columns=rename_w)

                weight_clean = weight_clean.loc[:, ~weight_clean.columns.duplicated()]
                enriched_target = enriched_target.loc[:, ~enriched_target.columns.duplicated()]

                merge_on = [ek for ek, _ in weight_join_keys]
                enriched_target = pd.merge(enriched_target, weight_clean, on=merge_on, how="left", suffixes=("", "_wgt"))
                enriched_target = enriched_target.loc[:, ~enriched_target.columns.duplicated()]

        real_weight = find_column(enriched_target, weight_column)
        if not real_weight:
            raise StitchError(step_idx, "weight_col_missing", f'Step {step_idx} (Allocate): Weight column "{weight_column}" not found in enriched dataset.')
        enriched_target["__weight__"] = pd.to_numeric(enriched_target[real_weight], errors="coerce").fillna(0.0)
    else:
        enriched_target["__weight__"] = 1.0

    # Step 3: Compute Allocation Partition and Ratios
    dma_keys = [find_column(enriched_target, k) for k in source_grain_keys if find_column(enriched_target, k)]
    time_join_keys = [find_column(enriched_target, k) for k in time_keys if find_column(enriched_target, k)]
    partition_keys = list(set(dma_keys + time_join_keys))

    group_sum = enriched_target.groupby(partition_keys)["__weight__"].transform("sum")
    group_count = enriched_target.groupby(partition_keys)["__weight__"].transform("count")

    enriched_target["__alloc_ratio__"] = np.where(
        group_sum > 1e-9,
        enriched_target["__weight__"] / group_sum,
        1.0 / np.maximum(group_count, 1.0),
    )

    source_join_keys = [find_column(source_df, k) for k in source_grain_keys if find_column(source_df, k)]
    source_time_keys = [find_column(source_df, k) for k in time_keys if find_column(source_df, k)]
    src_merge_keys = list(set(source_join_keys + source_time_keys))

    for sk, tk in zip(src_merge_keys, partition_keys):
        is_date = looks_like_date_key(sk) or looks_like_date_key(tk)
        source_df[sk] = normalize_key(source_df[sk], is_date)
        enriched_target[tk] = normalize_key(enriched_target[tk], is_date)

    rename_src = {sk: tk for sk, tk in zip(src_merge_keys, partition_keys) if sk != tk}
    if rename_src:
        drop_clashes = [t for t in rename_src.values() if t in source_df.columns and t not in rename_src]
        if drop_clashes:
            source_df = source_df.drop(columns=drop_clashes)
        source_df = source_df.rename(columns=rename_src)

    source_df = source_df.loc[:, ~source_df.columns.duplicated()]
    enriched_target = enriched_target.loc[:, ~enriched_target.columns.duplicated()]

    if not metrics_to_allocate:
        metrics_to_allocate = [
            c for c in source_df.columns
            if c not in partition_keys and (pd.api.types.is_numeric_dtype(source_df[c]) or "spend" in c.lower() or "metric" in c.lower() or "email" in c.lower() or "sale" in c.lower())
        ]

    pre_totals = compute_metric_totals(source_df, metrics_to_allocate)

    needed_source_cols = list(set(partition_keys + metrics_to_allocate))
    source_clean = source_df[[c for c in needed_source_cols if c in source_df.columns]]
    source_clean = source_clean.loc[:, ~source_clean.columns.duplicated()]

    allocated_df = pd.merge(enriched_target, source_clean, on=partition_keys, how="left", suffixes=("", "_src"))
    allocated_df = allocated_df.loc[:, ~allocated_df.columns.duplicated()]

    for col in metrics_to_allocate:
        real_col = find_column(allocated_df, col)
        if real_col:
            allocated_df[real_col] = pd.to_numeric(allocated_df[real_col], errors="coerce").fillna(0.0) * allocated_df["__alloc_ratio__"]

    allocated_df.drop(columns=["__weight__", "__alloc_ratio__"], inplace=True, errors="ignore")
    allocated_df = allocated_df.loc[:, ~allocated_df.columns.duplicated()]

    post_totals = compute_metric_totals(allocated_df, metrics_to_allocate)
    conservation = verify_metric_conservation(pre_totals, post_totals)

    lineage_entry = {
        "step": step_idx,
        "type": "allocate",
        "source": source_name,
        "target": target_name,
        "mapping": mapping_name,
        "weight_dataset": weight_name,
        "source_grain": step.get("source_grain", "unknown"),
        "target_grain": step.get("target_grain", "unknown"),
        "method": allocation_method,
        "weight_column": weight_column if allocation_method != "equal" else "1/N (Equal)",
        "allocated_metrics": metrics_to_allocate,
        "rows_in": rows_in,
        "rows_out": int(len(allocated_df)),
        "columns": [str(c) for c in allocated_df.columns],
        "metric_conservation": conservation,
    }
    return allocated_df, lineage_entry


def execute_pipeline(
    steps: List[Dict[str, Any]],
    frames: Dict[str, pd.DataFrame],
    preview_rows: int = 100,
) -> Dict[str, Any]:
    if not steps:
        raise StitchError(None, "no_steps", "Add at least one transformation/join step.")
    if not frames:
        raise StitchError(None, "no_datasets", "No source datasets were provided.")

    registry: Dict[str, pd.DataFrame] = {}

    def register(name: str, df: pd.DataFrame) -> None:
        registry[str(name).strip().lower()] = df.loc[:, ~df.columns.duplicated()].copy()

    def lookup(name: str) -> Optional[pd.DataFrame]:
        return registry.get(str(name).strip().lower())

    for name, df in frames.items():
        if df is not None and not df.empty:
            register(name, df)

    if not registry:
        raise StitchError(None, "empty_datasets", "All provided source datasets are empty.")

    current: Optional[pd.DataFrame] = None
    lineage: List[Dict[str, Any]] = []

    for idx, step in enumerate(steps, start=1):
        step_type = str(step.get("step_type", step.get("type", "join"))).lower()

        if step_type == "rollup":
            src_name = str(step.get("source_file") or step.get("left_file", "")).strip()
            map_name = str(step.get("mapping_file", "")).strip()

            src_df = lookup(src_name)
            map_df = lookup(map_name) if map_name else None

            if src_df is None or src_df.empty:
                raise StitchError(idx, "source_not_found", f'Step {idx} (Rollup): Source dataset "{src_name}" not found.')
            if map_name and (map_df is None or map_df.empty):
                raise StitchError(idx, "mapping_not_found", f'Step {idx} (Rollup): Mapping dataset "{map_name}" not found.')

            current, entry = execute_rollup_step(idx, step, src_df, map_df, src_name, map_name)

        elif step_type == "allocate":
            src_name = str(step.get("source_file") or step.get("right_file", "")).strip()
            tgt_name = str(step.get("target_file") or step.get("left_file", "")).strip()
            map_name = str(step.get("mapping_file", "")).strip()
            wgt_name = str(step.get("weight_file", "")).strip()

            src_df = lookup(src_name)
            tgt_df = lookup(tgt_name)
            map_df = lookup(map_name) if map_name else None
            wgt_df = lookup(wgt_name) if wgt_name else None

            if src_df is None or src_df.empty:
                raise StitchError(idx, "source_not_found", f'Step {idx} (Allocate): Source dataset "{src_name}" not found.')
            if tgt_df is None or tgt_df.empty:
                raise StitchError(idx, "target_not_found", f'Step {idx} (Allocate): Target structure "{tgt_name}" not found.')
            if map_name and (map_df is None or map_df.empty):
                raise StitchError(idx, "mapping_not_found", f'Step {idx} (Allocate): Mapping dataset "{map_name}" not found.')
            if wgt_name and (wgt_df is None or wgt_df.empty):
                raise StitchError(idx, "weight_not_found", f'Step {idx} (Allocate): Weight dataset "{wgt_name}" not found.')

            current, entry = execute_allocation_step(idx, step, src_df, tgt_df, map_df, wgt_df, src_name, tgt_name, map_name, wgt_name)

        else:
            left_name = str(step.get("left_file", "")).strip()
            right_name = str(step.get("right_file", "")).strip()

            left_df = lookup(left_name)
            right_df = lookup(right_name)

            if left_df is None or left_df.empty:
                raise StitchError(idx, "left_not_found", f'Step {idx}: Left dataset "{left_name}" not found.')
            if right_df is None or right_df.empty:
                raise StitchError(idx, "right_not_found", f'Step {idx}: Right dataset "{right_name}" not found.')

            current, entry = execute_join_step(idx, step, left_df, right_df, left_name, right_name)

        register(f"Step {idx} Result", current.copy())
        lineage.append(entry)

    if current is None or current.empty:
        raise StitchError(None, "empty_result", "The pipeline produced 0 rows. Verify join/grain criteria.")

    out = current.replace({np.nan: None})
    return {
        "df": out,
        "rows": int(len(out)),
        "cols": int(len(out.columns)),
        "columns": [str(c) for c in out.columns],
        "preview": out.head(preview_rows).to_dict(orient="records"),
        "lineage": {"steps_executed": lineage},
    }