"""Data Stitching and ARD creation, on top of the v2 dataset store.

    POST /v2/workflows/{id}/ard/build?dry_run=true   run the pipeline, store nothing
    POST /v2/workflows/{id}/ard/build                run it and save the ARD
    GET  /v2/workflows/{id}/ard                      list the ARDs built so far

The prototype this replaces took `files_map` - every source file's CSV text in
the request body. Here the steps name datasets and the server resolves them from
object storage, so an ARD build is not capped by request size and the browser
never carries the data.

The result is stored as a first-class dataset (`kind='ard'`), which means it
immediately has everything a dataset has: preview, download, CSV handoff, and
`resolve_frame` for the modelling stages downstream.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core import datasets, stitching, transform
from core.config import get_settings
from core.datasets import DatasetError
from core.stitching import StitchError
from core.transform import TransformError

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


class StitchStep(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    left_file: str = Field(min_length=1)
    right_file: str = Field(min_length=1)
    # Accepts a list or a comma-separated string; `clean_key_list` normalises
    # it. Optional because a cross join pairs every row with every row and so
    # has no keys at all.
    left_key: Any = None
    right_key: Any = None
    # left | inner | right | outer | cross. Matched by substring, so the UI can
    # send its own label text; anything unrecognised falls back to left.
    join_type: str = Field(default="left")


class BuildArdBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    steps: List[StitchStep] = Field(min_length=1)
    target_grain: str = Field(default="hcp", pattern="^(?i)(hcp|dma|geo|zip|national)$")
    output: Optional[str] = None
    preview_rows: int = Field(default=100, ge=1, le=1000)


def _ard_filename(body: BuildArdBody) -> str:
    if body.output:
        return body.output if body.output.lower().endswith(".csv") else f"{body.output}.csv"
    return f"__ard_{body.target_grain.lower()}__.csv"


@router.post("/{workflow_id}/ard/build")
async def build_ard(request: Request, workflow_id: str, body: BuildArdBody,
                    dry_run: bool = Query(False)):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard

    grain = body.target_grain.lower()
    output = _ard_filename(body)

    # Resolve only the datasets the steps actually name. "Step N Result" is
    # produced by the pipeline itself, so it is never looked up here.
    wanted = {s.left_file for s in body.steps} | {s.right_file for s in body.steps}
    wanted = {n for n in wanted if not n.strip().lower().startswith("step ")}

    frames = {}
    missing = []
    for name in sorted(wanted):
        try:
            frames[name] = await datasets.resolve_frame(workflow_id, name)
        except DatasetError as exc:
            if exc.status == 404:
                missing.append(name)
            else:
                return problem(request, exc.status, exc.title, exc.detail,
                               kind=f"{PROBLEM_BASE}/dataset")
        except TransformError as exc:
            return problem(request, 422, "Source dataset could not be built",
                           f'"{name}" has a stored configuration that no longer applies.',
                           kind=f"{PROBLEM_BASE}/transformation-failed", errors=exc.errors)

    if missing:
        try:
            known = [d["filename"] for d in await datasets.list_datasets(workflow_id)]
        except DatasetError:
            known = []
        return problem(
            request, 422, "Source dataset not found",
            "Every step must reference a dataset in this workflow.",
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
        return problem(request, 422, "Stitching failed",
                       "Nothing was stored." if not dry_run else "",
                       kind=f"{PROBLEM_BASE}/stitching-failed", errors=[exc.as_error()])

    if dry_run:
        # Same field names as the committed response, so the UI reads one shape
        # whichever it called.
        return {
            "workflow_id": workflow_id, "dry_run": True, "grain": grain,
            "filename": output, "row_count": result["rows"],
            "columns": result["columns"], "preview": result["preview"],
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
        return problem(request, exc.status, exc.title, exc.detail,
                       kind=f"{PROBLEM_BASE}/dataset")

    meta["preview"] = result["preview"]
    meta["grain"] = grain
    meta["lineage"] = result["lineage"]
    return JSONResponse(status_code=201, content=meta)


@router.get("/{workflow_id}/ard")
async def list_ards(request: Request, workflow_id: str):
    """Every ARD built for this workflow, newest first."""
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        items = [d for d in await datasets.list_datasets(workflow_id) if d.get("kind") == "ard"]
    except DatasetError as exc:
        return problem(request, exc.status, exc.title, exc.detail,
                       kind=f"{PROBLEM_BASE}/dataset")

    for item in items:
        item["grain"] = (item.get("derived_from") or {}).get("grain")
    items.sort(key=lambda d: d.get("derived_at") or "", reverse=True)
    return {"workflow_id": workflow_id, "items": items}
