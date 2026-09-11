"""Data Review (EDA) on top of the v2 dataset store.

    POST /v2/workflows/{id}/review/{filename}/stats
    POST /v2/workflows/{id}/review/{filename}/histogram
    POST /v2/workflows/{id}/review/{filename}/scatter
    POST /v2/workflows/{id}/review/{filename}/sparsity
    POST /v2/workflows/{id}/review/{filename}/poor-mans-curve
    POST /v2/workflows/{id}/review/{filename}/detect-outliers
    POST /v2/workflows/{id}/review/{filename}/remove-outliers
    POST /v2/workflows/{id}/review/{filename}/trend-rollup

Two differences from the `/api/eda` route this replaces, both consequences of
the dataset store rather than preferences:

  * The dataset is named, not posted. A review of a large ARD is not capped by
    request size and the browser never holds the file.
  * The date format comes from the stored manifest. The upstream trend rollup
    inferred it with `dayfirst=True`, which transposes day and month for every
    day-of-month <= 12 - the bug this backend exists to prevent.

Correlation is deliberately not part of this router.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core import datasets
from core.config import get_settings
from core.datasets import DatasetError
from core.manifest import ResolvedSpec
from core.processing import (
    compute_eda_stats,
    compute_poor_mans_curve_data,
    compute_sparsity_stats,
    compute_trend_rollup,
    detect_outliers_engine,
    remove_outliers_engine,
)
from core.review import analysis_frame, histogram_of, scatter_of
from core.transform import TransformError, output_date_formats

router = APIRouter()

PROBLEM_BASE = "https://beacon.api/problems"


def problem(
    request: Request, status: int, title: str, detail: str = "",
    errors: Optional[List[Dict[str, Any]]] = None, kind: str = "about:blank",
) -> JSONResponse:
    body: Dict[str, Any] = {"type": kind, "title": title, "status": status,
                            "instance": str(request.url.path)}
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    return JSONResponse(status_code=status, content=body,
                        media_type="application/problem+json")


async def _guard(request: Request, workflow_id: str) -> Optional[JSONResponse]:
    s = get_settings()
    if not s.db_configured() or not s.storage_configured():
        return problem(request, 503, "Backend not configured",
                       "Missing: " + ", ".join(s.missing()),
                       kind=f"{PROBLEM_BASE}/not-configured")
    try:
        if not await datasets.workflow_exists(workflow_id):
            return problem(request, 404, "Workflow not found",
                           f"Workflow '{workflow_id}' does not exist.",
                           kind=f"{PROBLEM_BASE}/not-found")
    except DatasetError as exc:
        return problem(request, exc.status, exc.title, exc.detail,
                       kind=f"{PROBLEM_BASE}/dataset")
    return None


async def _load(request: Request, workflow_id: str, filename: str):
    """Resolve the dataset, or the JSONResponse explaining why not.

    Returns `(df, date_formats, None)` or `(None, None, response)`.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return None, None, guard
    try:
        df = await datasets.resolve_frame(workflow_id, filename)
        meta = await datasets.get_dataset(workflow_id, filename)
    except TransformError as exc:
        return None, None, problem(request, 422, "Stored configuration failed", str(exc),
                                   kind=f"{PROBLEM_BASE}/transform")
    except DatasetError as exc:
        return None, None, problem(request, exc.status, exc.title, exc.detail,
                                   kind=f"{PROBLEM_BASE}/dataset")

    spec_raw = meta.get("spec") or {}
    spec = ResolvedSpec.model_validate(spec_raw) if spec_raw else None
    fmts = output_date_formats(spec.live_updates) if spec else {}
    # Real dtypes before analysis - see `core.review.analysis_frame`.
    return analysis_frame(df, spec), fmts, None


def _missing_columns(request: Request, df, names: List[str]) -> Optional[JSONResponse]:
    absent = [n for n in names if n and n not in df.columns]
    if not absent:
        return None
    return problem(
        request, 422, "Unknown column",
        f"Not a column of this dataset: {', '.join(absent)}.",
        errors=[{"code": "column_not_found", "column": n,
                 "message": f'"{n}" is not a column of this dataset.'} for n in absent],
        kind=f"{PROBLEM_BASE}/column",
    )


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------

class StatsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date_column: str = Field(min_length=1)
    geo_column: str = Field(min_length=1)
    dependent_variable: str = Field(min_length=1)


class ColumnBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str = Field(min_length=1)


class PairBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x_column: str = Field(min_length=1)
    y_column: str = Field(min_length=1)
    n_bins: int = Field(default=12, ge=2, le=50)


class SparsityBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metric_columns: Optional[List[str]] = None


class OutlierBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str = Field(min_length=1)
    method: str = Field(default="iqr", pattern="^(?i)(iqr|zscore)$")
    threshold: float = Field(default=1.5, gt=0)


class TrendBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date_column: str = Field(min_length=1)
    metric_columns: List[str] = Field(default_factory=list)
    period: str = Field(default="week", pattern="^(week|month)$")


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@router.post("/{workflow_id}/review/{filename}/stats")
async def review_stats(request: Request, workflow_id: str, filename: str, body: StatsBody):
    """Summary table with control totals, trends and geo breakdown."""
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df,
                               [body.date_column, body.geo_column, body.dependent_variable])):
        return bad
    return compute_eda_stats(df, body.date_column, body.geo_column, body.dependent_variable)


@router.post("/{workflow_id}/review/{filename}/histogram")
async def review_histogram(request: Request, workflow_id: str, filename: str, body: ColumnBody):
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.column])):
        return bad
    return histogram_of(df, body.column)


@router.post("/{workflow_id}/review/{filename}/scatter")
async def review_scatter(request: Request, workflow_id: str, filename: str, body: PairBody):
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.x_column, body.y_column])):
        return bad
    return scatter_of(df, body.x_column, body.y_column)


@router.post("/{workflow_id}/review/{filename}/sparsity")
async def review_sparsity(request: Request, workflow_id: str, filename: str, body: SparsityBody):
    """Non-zero share per tactic - which channels are too sparse to model."""
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if body.metric_columns and (bad := _missing_columns(request, df, body.metric_columns)):
        return bad
    return {"sparsity_table": compute_sparsity_stats(df, body.metric_columns)}


@router.post("/{workflow_id}/review/{filename}/poor-mans-curve")
async def review_poor_mans_curve(request: Request, workflow_id: str, filename: str, body: PairBody):
    """Binned average of Y against X - the response shape before any model."""
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.x_column, body.y_column])):
        return bad
    return compute_poor_mans_curve_data(df, body.x_column, body.y_column, body.n_bins)


@router.post("/{workflow_id}/review/{filename}/detect-outliers")
async def review_detect_outliers(request: Request, workflow_id: str, filename: str, body: OutlierBody):
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.column])):
        return bad
    return detect_outliers_engine(df, body.column, body.method, body.threshold)


@router.post("/{workflow_id}/review/{filename}/remove-outliers")
async def review_remove_outliers(request: Request, workflow_id: str, filename: str, body: OutlierBody):
    """Preview of the dataset with flagged rows removed.

    Returns CSV; it does NOT write. Removing outliers is a decision that belongs
    in the manifest, where it is inspectable and reversible - not a side effect
    of looking at a chart.
    """
    df, _fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.column])):
        return bad
    return remove_outliers_engine(df, body.column, body.method, body.threshold)


@router.post("/{workflow_id}/review/{filename}/trend-rollup")
async def review_trend_rollup(request: Request, workflow_id: str, filename: str, body: TrendBody):
    """Metrics aggregated by week or month.

    The date format comes from the manifest, so a column already reformatted to
    day-first text is read as day-first rather than inferred.
    """
    df, fmts, err = await _load(request, workflow_id, filename)
    if err:
        return err
    if (bad := _missing_columns(request, df, [body.date_column])):
        return bad
    return {
        "trend_data": compute_trend_rollup(
            df, body.date_column, body.metric_columns, body.period,
            date_format=fmts.get(body.date_column),
        )
    }
