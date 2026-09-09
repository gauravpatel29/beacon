"""Contract v2: manifest-driven ingestion over Neon Postgres + Object Storage.

The browser holds an id, not a CSV. Nothing here accepts a `csv_data` string.

    POST   /v2/workflows/{id}/files?dry_run=true    validate + preview, store nothing
    POST   /v2/workflows/{id}/files                 upload, transform, persist
    POST   /v2/workflows/{id}/files/{name}/preview  re-run a manifest against the
                                                    STORED raw bytes - no re-upload
    PATCH  /v2/workflows/{id}/files/{name}/spec     commit a manifest, re-derive
    GET    /v2/workflows/{id}/files                 list datasets
    GET    /v2/workflows/{id}/files/{name}          metadata + preview rows
    GET    /v2/workflows/{id}/files/{name}/download presigned URL
    DELETE /v2/workflows/{id}/files/{name}
    POST   /v2/workflows/{id}/merge                 join datasets into a new one

`dry_run` and the real apply share one code path (transform.apply_manifest), so
a preview that succeeds guarantees the commit succeeds on the same bytes.
"""

import json
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional

import pandas as pd
import polars as pl
from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core import datasets, objectstore as store, transform
from core.config import get_settings
from core.datasets import DatasetError
from core.manifest import Manifest, ResolvedSpec
from core.processing import detect_date_granularity
from core.profile import profile_frame
from core.transform import TransformError

router = APIRouter()

PROBLEM_BASE = "https://beacon.api/problems"


# ---------------------------------------------------------------------------
# RFC 9457 problem+json
# ---------------------------------------------------------------------------


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


def _validation_problem(request: Request, exc: ValidationError) -> JSONResponse:
    return problem(
        request, 422, "Validation failed",
        detail="The manifest does not match the contract.",
        kind=f"{PROBLEM_BASE}/validation-failed",
        errors=[{"pointer": "/" + "/".join(str(p) for p in e["loc"]),
                 "code": e["type"], "message": e["msg"]} for e in exc.errors()],
    )


def _dataset_problem(request: Request, exc: DatasetError) -> JSONResponse:
    return problem(request, exc.status, exc.title, exc.detail,
                   kind=f"{PROBLEM_BASE}/dataset")


def _transform_problem(request: Request, exc: TransformError, stored: bool) -> JSONResponse:
    return problem(
        request, 422, "Transformation failed",
        detail="Nothing was stored; the request was rolled back." if not stored
        else "The stored dataset is unchanged.",
        kind=f"{PROBLEM_BASE}/transformation-failed", errors=exc.errors,
    )


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
        return _dataset_problem(request, exc)
    return None


def _parse_manifest(raw: Optional[str]) -> Manifest:
    if not raw or not raw.strip():
        return Manifest()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"`manifest` is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("`manifest` must be a JSON object.")
    return Manifest.model_validate(data)


# ---------------------------------------------------------------------------
# upload  (+ dry_run)
# ---------------------------------------------------------------------------


@router.post("/{workflow_id}/files")
async def upload_files(
    request: Request,
    workflow_id: str,
    files: List[UploadFile] = File(...),
    manifest: Optional[str] = Form(None),
    dry_run: bool = Query(False, description="Validate and preview; store nothing."),
    overwrite: bool = Query(False),
    preview_rows: int = Query(100, ge=1, le=1000),
):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard

    try:
        parsed = _parse_manifest(manifest)
    except ValidationError as exc:
        return _validation_problem(request, exc)
    except ValueError as exc:
        return problem(request, 400, "Bad request", str(exc),
                       kind=f"{PROBLEM_BASE}/bad-request")

    if not files:
        return problem(request, 400, "Bad request", "At least one file part is required.")

    names = {(f.filename or "").strip() for f in files}
    unknown = [e.filename for e in parsed.files if e.filename not in names]
    if unknown:
        return problem(
            request, 422, "Validation failed",
            kind=f"{PROBLEM_BASE}/validation-failed",
            errors=[{"pointer": "/files", "code": "file_not_uploaded",
                     "message": f'Manifest references "{n}", which was not uploaded.'}
                    for n in unknown],
        )

    settings = get_settings()
    payloads: List[tuple] = []
    for uf in files:
        name = (uf.filename or "").strip()
        if not name:
            return problem(request, 400, "Bad request",
                           "Every file part must carry a filename.")
        ext = transform.suffix_of(name)
        if ext not in transform.SUPPORTED_EXT:
            return problem(request, 415, "Unsupported media type",
                           f'"{name}" has extension "{ext or "(none)"}"; supported: '
                           + ", ".join(sorted(transform.SUPPORTED_EXT)))
        raw = await uf.read()
        if len(raw) > settings.max_upload_bytes:
            return problem(request, 413, "Payload too large",
                           f'"{name}" is {len(raw)} bytes; limit is '
                           f"{settings.max_upload_bytes}.")
        if not dry_run and not overwrite:
            try:
                await datasets.get_dataset(workflow_id, name)
                return problem(request, 409, "Conflict",
                               f'"{name}" already exists in this workflow. '
                               f"Re-send with overwrite=true to replace it.",
                               kind=f"{PROBLEM_BASE}/conflict")
            except DatasetError as exc:
                if exc.status != 404:
                    return _dataset_problem(request, exc)
        payloads.append((name, raw, uf.content_type))

    # Validate every file BEFORE storing any of them, so a failure on file 3
    # cannot leave files 1 and 2 written.
    results: List[Dict[str, Any]] = []
    try:
        for name, raw, _ct in payloads:
            spec = parsed.for_file(name)
            df = transform.read_table(name, raw)
            out = transform.preview(name, df, spec, preview_rows)
            # Profile the RAW frame: the form configures against the file as
            # uploaded, so suggestions must describe pre-transform columns.
            out["profile"] = profile_frame(df)
            results.append(out)
    except TransformError as exc:
        return _transform_problem(request, exc, stored=False)

    if dry_run:
        return {"workflow_id": workflow_id, "dry_run": True, "files": results}

    stored: List[Dict[str, Any]] = []
    try:
        for (name, raw, ct), prev in zip(payloads, results):
            meta = await datasets.store_upload(
                workflow_id, name, raw, parsed.for_file(name), ct
            )
            meta["preview"] = prev["preview"]
            # Carried on the upload response so the configuration form can
            # pre-fill itself without a second round trip.
            meta["profile"] = prev["profile"]
            stored.append(meta)
    except TransformError as exc:
        for meta in stored:
            await datasets.delete_dataset(workflow_id, meta["filename"])
        return _transform_problem(request, exc, stored=False)
    except DatasetError as exc:
        for meta in stored:
            await datasets.delete_dataset(workflow_id, meta["filename"])
        return _dataset_problem(request, exc)

    return JSONResponse(status_code=201,
                        content={"workflow_id": workflow_id, "dry_run": False,
                                 "files": stored})


# ---------------------------------------------------------------------------
# preview / commit a manifest against ALREADY-STORED bytes
# ---------------------------------------------------------------------------


class SpecBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config_metadata: Dict[str, Any] = Field(default_factory=dict)
    live_updates: Optional[Dict[str, Any]] = None
    filters: Optional[List[Dict[str, Any]]] = None
    granularity: Optional[Dict[str, Any]] = None
    expected_version: Optional[int] = None

    def to_spec(self) -> ResolvedSpec:
        payload: Dict[str, Any] = {"config_metadata": self.config_metadata}
        if self.live_updates is not None:
            payload["live_updates"] = self.live_updates
        if self.filters is not None:
            payload["filters"] = self.filters
        if self.granularity is not None:
            payload["granularity"] = self.granularity
        return ResolvedSpec.model_validate(payload)


@router.post("/{workflow_id}/files/{filename}/preview")
async def preview_spec(
    request: Request, workflow_id: str, filename: str, body: SpecBody,
    preview_rows: int = Query(100, ge=1, le=1000),
):
    """Dry-run a manifest against the stored raw bytes. Nothing is written.

    This is what the ingestion screen calls while the user is still choosing
    options - no re-upload, no `csv_data` in the request.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        spec = body.to_spec()
    except ValidationError as exc:
        return _validation_problem(request, exc)
    try:
        df = await datasets.raw_frame(workflow_id, filename)
        return transform.preview(filename, df, spec, preview_rows)
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)


@router.patch("/{workflow_id}/files/{filename}/spec")
async def commit_spec(request: Request, workflow_id: str, filename: str, body: SpecBody):
    """Persist the manifest and re-derive from the immutable raw bytes."""
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        spec = body.to_spec()
    except ValidationError as exc:
        return _validation_problem(request, exc)
    try:
        meta = await datasets.reapply(workflow_id, filename, spec,
                                      expect_version=body.expected_version)
        df = await datasets.resolve_frame(workflow_id, filename)
        meta["preview"] = transform.to_records(df, 100)
        return meta
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)


# ---------------------------------------------------------------------------
# read / delete
# ---------------------------------------------------------------------------


@router.get("/{workflow_id}/files")
async def list_files(request: Request, workflow_id: str):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        return {"workflow_id": workflow_id, "items": await datasets.list_datasets(workflow_id)}
    except DatasetError as exc:
        return _dataset_problem(request, exc)


@router.get("/{workflow_id}/files/{filename}")
async def get_file(request: Request, workflow_id: str, filename: str,
                   preview_rows: int = Query(100, ge=1, le=1000)):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        meta = await datasets.get_dataset(workflow_id, filename)
        df = await datasets.resolve_frame(workflow_id, filename)
        meta["preview"] = transform.to_records(df, preview_rows)
        return meta
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)


class DetectGrainBody(BaseModel):
    """The draft manifest so far, plus the date column to inspect."""

    model_config = ConfigDict(extra="forbid")

    date_column: str = Field(min_length=1)
    live_updates: Optional[Dict[str, Any]] = None
    filters: Optional[List[Dict[str, Any]]] = None


@router.post("/{workflow_id}/files/{filename}/detect-granularity")
async def detect_granularity(request: Request, workflow_id: str, filename: str,
                             body: DetectGrainBody):
    """What time grain does this column already sit at?

    Runs the draft `live_updates`/`filters` first, so detection sees the dates
    as the user has configured them rather than as raw text. Nothing is stored.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard

    payload: Dict[str, Any] = {}
    if body.live_updates is not None:
        payload["live_updates"] = body.live_updates
    if body.filters is not None:
        payload["filters"] = body.filters
    try:
        spec = ResolvedSpec.model_validate(payload)
    except ValidationError as exc:
        return _validation_problem(request, exc)

    try:
        df = await datasets.raw_frame(workflow_id, filename)
        if not spec.live_updates.is_empty() or spec.filters:
            df, _ = transform.apply_manifest(filename, df, spec)
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)

    if body.date_column not in df.columns:
        return problem(request, 422, "Column not found",
                       f'"{body.date_column}" is not present after the current '
                       f"configuration.", kind=f"{PROBLEM_BASE}/validation-failed",
                       errors=[{"filename": filename, "column": body.date_column,
                                "code": "column_not_found",
                                "message": f'Column "{body.date_column}" does not exist.'}])

    # Parse with the format `date_formats` wrote, not by inference.
    fmt = transform.output_date_formats(spec.live_updates).get(body.date_column)
    parsed = transform._parse_dates(df[body.date_column], fmt)
    valid = parsed.dropna()
    if valid.empty:
        return problem(
            request, 422, "Could not detect granularity",
            f'No value in "{body.date_column}" parses as a date. Set its source '
            f"format on the Columns & Types tab first.",
            kind=f"{PROBLEM_BASE}/validation-failed",
            errors=[{"filename": filename, "column": body.date_column,
                     "code": "date_parse_failed",
                     "message": "No parseable dates in this column."}],
        )

    # Reuse the detector the pre-v2 screen used, so the answer matches what
    # users saw before. It wants a Polars frame of ISO date strings.
    iso = valid.dt.strftime("%Y-%m-%d").tolist()
    grain = detect_date_granularity(pl.DataFrame({body.date_column: iso}), body.date_column)

    if grain is None:
        return problem(
            request, 422, "Could not detect granularity",
            f'"{body.date_column}" has too few distinct dates to infer a grain.',
            kind=f"{PROBLEM_BASE}/validation-failed",
            errors=[{"filename": filename, "column": body.date_column,
                     "code": "granularity_undetectable",
                     "message": "At least two distinct dates are required."}],
        )

    return {
        "filename": filename,
        "date_column": body.date_column,
        "granularity": grain,
        "distinct_dates": int(valid.dt.strftime("%Y-%m-%d").nunique()),
        "min_date": valid.min().strftime("%Y-%m-%d"),
        "max_date": valid.max().strftime("%Y-%m-%d"),
    }


@router.get("/{workflow_id}/files/{filename}/profile")
async def get_profile(request: Request, workflow_id: str, filename: str):
    """Per-column suggestions for the configuration form.

    Describes the RAW upload, not the derived output, because the form
    configures against the file as it arrived. Suggestions are defaults for the
    UI to pre-fill - the manifest still has to state `from` explicitly, so
    nothing here is ever applied without a human having seen it.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        df = await datasets.raw_frame(workflow_id, filename)
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)
    return {
        "filename": filename,
        "row_count_sampled": int(min(len(df), 500)),
        "columns": [str(c) for c in df.columns],
        "profile": profile_frame(df),
    }


@router.get("/{workflow_id}/files/{filename}/csv")
async def get_csv(request: Request, workflow_id: str, filename: str):
    """The resolved dataset as raw CSV text.

    TRANSITIONAL. Downstream screens (EDA onward) still take a `csv_data`
    string; this hands them one without the browser ever having held the file.
    Delete it once those routers resolve datasets by id via
    `datasets.resolve_frame`.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        df = await datasets.resolve_frame(workflow_id, filename)
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)
    return Response(content=df.to_csv(index=False), media_type="text/csv")


@router.get("/{workflow_id}/files/{filename}/download")
async def download(request: Request, workflow_id: str, filename: str,
                   which: str = Query("derived", pattern="^(raw|derived)$")):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        meta = await datasets.get_dataset(workflow_id, filename)
    except DatasetError as exc:
        return _dataset_problem(request, exc)
    key = meta["object_key"] if which == "raw" else (meta.get("derived_key") or meta["object_key"])
    url, expires = store.presign_get(key)
    return {"filename": filename, "which": which, "object_key": key,
            "download_url": url, "download_url_expires_at": expires}


@router.delete("/{workflow_id}/files/{filename}", status_code=204)
async def delete_file(request: Request, workflow_id: str, filename: str):
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard
    try:
        await datasets.delete_dataset(workflow_id, filename)
    except DatasetError as exc:
        return _dataset_problem(request, exc)
    # A 204 must carry no body: JSONResponse would write "null" and break the
    # connection with "Too much data for declared Content-Length".
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


class MergeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inputs: List[str] = Field(min_length=2)
    on: List[str] = Field(min_length=1)
    how: str = Field(default="outer", pattern="^(inner|outer|left|right)$")
    output: str = Field(default="__merged__.csv", min_length=1)
    suffixes: bool = Field(
        default=True,
        description="Suffix overlapping non-key columns with their source filename.",
    )


@router.post("/{workflow_id}/merge")
async def merge(request: Request, workflow_id: str, body: MergeBody,
                dry_run: bool = Query(False), preview_rows: int = Query(100, ge=1, le=1000)):
    """Join several datasets on shared keys into a new first-class dataset.

    The result is its own row with `kind='merge'` and a `derived_from` record,
    so it can never be silently overwritten by a later edit to an input.
    """
    if (guard := await _guard(request, workflow_id)) is not None:
        return guard

    frames: List[tuple] = []
    try:
        for name in body.inputs:
            frames.append((name, await datasets.resolve_frame(workflow_id, name)))
    except TransformError as exc:
        return _transform_problem(request, exc, stored=True)
    except DatasetError as exc:
        return _dataset_problem(request, exc)

    missing = [{"filename": n, "code": "join_key_missing", "column": k,
                "message": f'Join key "{k}" is not present in "{n}".'}
               for n, df in frames for k in body.on if k not in df.columns]
    if missing:
        return problem(request, 422, "Merge failed",
                       detail="Every input must carry every join key.",
                       kind=f"{PROBLEM_BASE}/merge-failed", errors=missing)

    base_name, out = frames[0]
    # Join keys are compared as trimmed text: one file's 1234567893 read as an
    # int must still match another's "1234567893".
    for k in body.on:
        out[k] = out[k].astype(str).str.strip()

    for name, df in frames[1:]:
        df = df.copy()
        for k in body.on:
            df[k] = df[k].astype(str).str.strip()
        overlap = (set(out.columns) & set(df.columns)) - set(body.on)
        if overlap and body.suffixes:
            df = df.rename(columns={c: f"{c}__{PurePosixPath(name).stem}"
                                    for c in overlap})
        elif overlap:
            df = df.drop(columns=list(overlap))
        out = out.merge(df, on=body.on, how=body.how)

    out = out.reset_index(drop=True)

    if dry_run:
        return {"workflow_id": workflow_id, "dry_run": True, "output": body.output,
                "row_count": int(len(out)), "columns": [str(c) for c in out.columns],
                "inputs": body.inputs, "how": body.how, "on": body.on,
                "preview": transform.to_records(out, preview_rows)}

    try:
        meta = await datasets.store_merged(workflow_id, body.output, out,
                                           body.inputs, body.how, body.on)
    except DatasetError as exc:
        return _dataset_problem(request, exc)
    meta["preview"] = transform.to_records(out, preview_rows)
    return JSONResponse(status_code=201, content=meta)
