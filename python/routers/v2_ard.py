"""
Data Stitching, Cross-Grain Transformations, and ARD Creation API Router.

Endpoints:
- POST /v2/workflows/{id}/ard/build
- GET  /v2/workflows/{id}/ard
"""

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core import datasets, stitching
from core.config import get_settings
from core.datasets import DatasetError
from core.stitching import StitchError
from core.transform import TransformError

router = APIRouter()
PROBLEM_BASE = "https://beacon.api/problems"


def problem(
    request: Request,
    status: int,
    title: str,
    detail: str = "",
    errors: Optional[List[Dict[str, Any]]] = None,
    kind: str = "about:blank",
) -> JSONResponse:
    body: Dict[str, Any] = {
        "type": kind,
        "title": title,
        "status": status,
        "instance": str(request.url.path),
    }
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    return JSONResponse(status_code=status, content=body, media_type="application/problem+json")


async def _guard(request: Request, workflow_id: str) -> Optional[JSONResponse]:
    s = get_settings()
    if not s.db_configured() or not s.storage_configured():
        return problem(
            request, 503, "Backend not configured",
            "Missing: " + ", ".join(s.missing()),
            kind=f"{PROBLEM_BASE}/not-configured"
        )
    try:
        if not await datasets.workflow_exists(workflow_id):
            return problem(
                request, 404, "Workflow not found",
                f"Workflow '{workflow_id}' does not exist.",
                kind=f"{PROBLEM_BASE}/not-found"
            )
    except DatasetError as exc:
        return problem(request, exc.status, exc.title, exc.detail, kind=f"{PROBLEM_BASE}/dataset")
    return None


class StitchStep(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    step_type: str = Field(default="join")
    left_file: Optional[str] = None
    right_file: Optional[str] = None
    source_file: Optional[str] = None
    target_file: Optional[str] = None
    mapping_file: Optional[str] = None
    weight_file: Optional[str] = None

    left_key: Any = None
    right_key: Any = None
    join_type: str = Field(default="left")

    source_grain: Optional[str] = None
    target_grain: Optional[str] = None
    source_grain_key: Any = None
    target_grain_key: Any = None
    source_entity_key: Any = None
    target_entity_key: Any = None
    mapping_source_key: Any = None
    mapping_target_key: Any = None
    time_key: Any = None
    agg_rules: Optional[Dict[str, str]] = None
    allocation_method: Optional[str] = "equal"
    weight_column: Optional[str] = None
    allocated_metrics: Any = None


class BuildArdBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    steps: List[StitchStep] = Field(min_length=1)
    target_grain: str = Field(default="hcp")
    output: Optional[str] = None
    preview_rows: int = Field(default=100, ge=1, le=1000)


def _ard_filename(body: BuildArdBody) -> str:
    if body.output:
        return body.output if body.output.lower().endswith(".csv") else f"{body.output}.csv"
    return f"__ard_{body.target_grain.lower()}__.csv"


@router.post("/{workflow_id}/ard/build")
async def build_ard(
    request: Request,
    workflow_id: str,
    body: BuildArdBody,
    dry_run: bool = Query(False),
):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard

    grain = body.target_grain.lower()
    output = _ard_filename(body)

    wanted = set()
    for s in body.steps:
        for fname in [s.left_file, s.right_file, s.source_file, s.target_file, s.mapping_file, s.weight_file]:
            if fname and not str(fname).strip().lower().startswith("step "):
                wanted.add(str(fname).strip())

    frames = {}
    missing = []
    for name in sorted(wanted):
        try:
            frames[name] = await datasets.resolve_frame(workflow_id, name)
        except DatasetError as exc:
            if exc.status == 404:
                missing.append(name)
            else:
                return problem(request, exc.status, exc.title, exc.detail, kind=f"{PROBLEM_BASE}/dataset")
        except TransformError as exc:
            return problem(
                request, 422, "Source dataset could not be built",
                f'"{name}" has a stored configuration that no longer applies.',
                kind=f"{PROBLEM_BASE}/transformation-failed", errors=exc.errors
            )

    if missing:
        try:
            known = [d["filename"] for d in await datasets.list_datasets(workflow_id)]
        except DatasetError:
            known = []
        return problem(
            request, 422, "Source dataset not found",
            "Every step must reference an active dataset in this workflow.",
            kind=f"{PROBLEM_BASE}/validation-failed",
            errors=[{"code": "dataset_not_found", "filename": n,
                     "message": f'"{n}" is not a dataset in this workflow.',
                     "available": known} for n in missing],
        )

    try:
        result = stitching.execute_pipeline(
            [s.model_dump() for s in body.steps], frames, body.preview_rows
        )
    except StitchError as exc:
        return problem(
            request, 422, "Stitching failed",
            "Nothing was stored." if not dry_run else "",
            kind=f"{PROBLEM_BASE}/stitching-failed", errors=[exc.as_error()]
        )

    if dry_run:
        return {
            "workflow_id": workflow_id,
            "dry_run": True,
            "grain": grain,
            "filename": output,
            "row_count": result["rows"],
            "columns": result["columns"],
            "preview": result["preview"],
            "lineage": result["lineage"],
        }

    try:
        meta = await datasets.store_derived(
            workflow_id, output, result["df"], kind="ard",
            derived_from={
                "grain": grain,
                "inputs": sorted(wanted),
                **result["lineage"],
            },
        )
    except DatasetError as exc:
        return problem(request, exc.status, exc.title, exc.detail, kind=f"{PROBLEM_BASE}/dataset")

    meta["preview"] = result["preview"]
    meta["grain"] = grain
    meta["lineage"] = result["lineage"]
    return JSONResponse(status_code=201, content=meta)


@router.get("/{workflow_id}/ard")
async def list_ards(request: Request, workflow_id: str):
    """List every ARD built for this workflow with version lineage."""
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        items = [d for d in await datasets.list_datasets(workflow_id) if d.get("kind") == "ard"]
    except DatasetError as exc:
        return problem(request, exc.status, exc.title, exc.detail, kind=f"{PROBLEM_BASE}/dataset")

    for item in items:
        item["grain"] = (item.get("derived_from") or {}).get("grain")
    items.sort(key=lambda d: d.get("derived_at") or "", reverse=True)
    return {"workflow_id": workflow_id, "items": items}