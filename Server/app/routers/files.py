"""Contract 2: object-storage CRUD, scoped to a workflow.

Uploads are multipart rather than presigned because `live_updates` must be
applied before the bytes are stored - a presigned PUT would go browser ->
bucket without the backend ever seeing the file.
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app import storage, transform
from app.config import get_settings
from app.db import get_session
from app.errors import ProblemError, bad_request, conflict, not_found, unprocessable
from app.routers.workflows import load_workflow
from app.schemas import (
    AppliedCounts,
    ConfigMetadataPatch,
    FileConfigResponse,
    FileListResponse,
    Sidecars,
    StoredFile,
    StoredFileWithUrl,
    UploadManifest,
    UploadResponse,
)
from app.transform import TransformError

router = APIRouter(prefix="/workflows/{workflow_id}/files", tags=["files"])


def _parse_manifest(raw: str) -> UploadManifest:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise bad_request(f"`manifest` is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise bad_request("`manifest` must be a JSON object.")
    try:
        return UploadManifest.model_validate(data)
    except ValidationError as exc:
        raise unprocessable(
            "Validation failed",
            errors=[
                {
                    "pointer": "/" + "/".join(str(p) for p in e["loc"]),
                    "code": e["type"],
                    "message": e["msg"],
                }
                for e in exc.errors()
            ],
        ) from exc


async def _process_one(
    workflow_id: uuid.UUID,
    upload: UploadFile,
    manifest: UploadManifest,
    overwrite: bool,
    written: list[str],
) -> StoredFile:
    filename = (upload.filename or "").strip()
    if not filename:
        raise bad_request("Every file part must carry a filename.")

    ext = transform.suffix_of(filename)
    if ext not in transform.SUPPORTED_EXT:
        raise ProblemError(
            415,
            "Unsupported media type",
            detail=(
                f'"{filename}" has extension "{ext or "(none)"}"; supported: '
                + ", ".join(sorted(transform.SUPPORTED_EXT))
            ),
        )

    raw = await upload.read()
    settings = get_settings()
    if len(raw) > settings.max_upload_bytes:
        raise ProblemError(
            413,
            "Payload too large",
            detail=f'"{filename}" is {len(raw)} bytes; limit is '
            f"{settings.max_upload_bytes}.",
        )

    key = storage.data_key(str(workflow_id), filename)
    if not overwrite and storage.exists(key):
        raise conflict(
            f'"{filename}" already exists for this workflow. '
            f"Re-send with overwrite=true to replace it."
        )

    config_metadata, live_updates = manifest.for_file(filename)

    df = transform.read_table(filename, raw)
    df, counts = transform.apply_live_updates(filename, df, live_updates)
    body = transform.write_table(filename, df)

    stored_at = datetime.now(timezone.utc).isoformat()

    storage.put_bytes(key, body, transform.content_type_for(filename))
    written.append(key)

    # One `_log.json` / `_struct_updates.json` per workflow: merge this file's
    # entries in rather than writing a pair of sidecars beside the data file.
    log_k, struct_k = storage.write_sidecar_entries(
        str(workflow_id),
        filename,
        config_metadata,
        live_updates.model_dump(by_alias=True, mode="json"),
    )

    return StoredFile(
        filename=filename,
        object_key=key,
        size_bytes=len(body),
        content_type=transform.content_type_for(filename),
        checksum_sha256=hashlib.sha256(body).hexdigest(),
        stored_at=stored_at,
        row_count=int(len(df)),
        columns=[str(c) for c in df.columns],
        sidecars=Sidecars(config_metadata=log_k, live_updates=struct_k),
        applied=counts,
    )


@router.post("", response_model=UploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_files(
    workflow_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    manifest: Annotated[str, Form()],
    files: Annotated[list[UploadFile], File()],
    overwrite: bool = Query(default=False),
) -> Any:
    await load_workflow(session, workflow_id)

    if not files:
        raise bad_request("At least one file part is required.")

    parsed = _parse_manifest(manifest)

    # Manifest entries must correspond to real parts, otherwise a typo in a
    # filename silently falls back to the request-level blocks.
    uploaded_names = {(f.filename or "").strip() for f in files}
    unknown = [e.filename for e in parsed.files if e.filename not in uploaded_names]
    if unknown:
        raise unprocessable(
            "Validation failed",
            errors=[
                {
                    "pointer": "/files",
                    "code": "file_not_uploaded",
                    "message": f'Manifest references "{name}", which was not uploaded.',
                }
                for name in unknown
            ],
        )

    written: list[str] = []
    results: list[StoredFile] = []
    try:
        for upload in files:
            results.append(
                await _process_one(workflow_id, upload, parsed, overwrite, written)
            )
    except TransformError as exc:
        # All-or-nothing: object storage has no transactions, so undo by hand.
        storage.delete_keys(written)
        raise transform.transform_failed(exc.errors) from exc
    except Exception:
        storage.delete_keys(written)
        raise

    return UploadResponse(workflow_id=workflow_id, files=results)


@router.get("", response_model=FileListResponse)
async def list_files(
    workflow_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    include_sidecars: bool = Query(default=False),
) -> Any:
    await load_workflow(session, workflow_id)

    items: list[StoredFile] = []
    for obj in storage.list_prefix(f"{workflow_id}/"):
        key = obj["Key"]
        if not include_sidecars and storage.is_sidecar(key):
            continue
        filename = key.split("/", 1)[1]
        items.append(
            StoredFile(
                filename=filename,
                object_key=key,
                size_bytes=obj.get("Size", 0),
                content_type=transform.content_type_for(filename),
                stored_at=obj["LastModified"].isoformat()
                if obj.get("LastModified")
                else None,
            )
        )
    return FileListResponse(items=items)


@router.get("/{filename}", response_model=StoredFileWithUrl)
async def get_file(
    workflow_id: uuid.UUID,
    filename: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    await load_workflow(session, workflow_id)

    key = storage.data_key(str(workflow_id), filename)
    meta = storage.head(key)
    if meta is None:
        raise not_found(f'"{filename}" does not exist for this workflow.')

    url, expires = storage.presign_get(key)
    return StoredFileWithUrl(
        filename=filename,
        object_key=key,
        size_bytes=meta.get("ContentLength", 0),
        content_type=meta.get("ContentType", transform.content_type_for(filename)),
        stored_at=meta["LastModified"].isoformat() if meta.get("LastModified") else None,
        sidecars=Sidecars(
            config_metadata=storage.log_key(str(workflow_id)),
            live_updates=storage.struct_key(str(workflow_id)),
        ),
        download_url=url,
        download_url_expires_at=expires,
    )


@router.put("/{filename}", response_model=StoredFile)
async def replace_file(
    workflow_id: uuid.UUID,
    filename: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    manifest: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
) -> Any:
    await load_workflow(session, workflow_id)

    parsed = _parse_manifest(manifest)
    written: list[str] = []
    try:
        # PUT targets a known key, so replacing is the point: overwrite=True.
        return await _process_one(workflow_id, file, parsed, True, written)
    except TransformError as exc:
        storage.delete_keys(written)
        raise transform.transform_failed(exc.errors) from exc
    except Exception:
        storage.delete_keys(written)
        raise


@router.delete("/{filename}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    workflow_id: uuid.UUID,
    filename: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    await load_workflow(session, workflow_id)

    key = storage.data_key(str(workflow_id), filename)
    if not storage.exists(key):
        raise not_found(f'"{filename}" does not exist for this workflow.')

    # The sidecars are shared by the whole workflow, so drop this file's
    # entries rather than deleting the sidecar objects themselves.
    storage.delete_keys([key])
    storage.remove_sidecar_entries(str(workflow_id), filename)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{filename}/config", response_model=FileConfigResponse)
async def get_file_config(
    workflow_id: uuid.UUID,
    filename: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    await load_workflow(session, workflow_id)

    # Reads this file's slice out of the workflow-wide sidecars.
    log = storage.read_sidecar(str(workflow_id), storage.LOG_NAME)
    struct = storage.read_sidecar(str(workflow_id), storage.STRUCT_NAME)
    if filename not in log.get("files", {}) and filename not in struct.get("files", {}):
        raise not_found(f'No sidecar entries stored for "{filename}".')
    return FileConfigResponse(
        config_metadata=log.get("files", {}).get(filename, {}),
        live_updates=struct.get("files", {}).get(filename, {}),
    )


@router.patch("/{filename}/config", response_model=ConfigMetadataPatch)
async def update_file_config(
    workflow_id: uuid.UUID,
    filename: str,
    payload: ConfigMetadataPatch,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    """Rewrites this file's entry inside the workflow's `_log.json`.

    `live_updates` is deliberately not accepted: it describes a transformation
    already baked into the stored bytes, so editing the sidecar alone would
    leave it lying about the data. Structural change means re-uploading.
    """
    await load_workflow(session, workflow_id)

    key = storage.data_key(str(workflow_id), filename)
    if not storage.exists(key):
        raise not_found(f'"{filename}" does not exist for this workflow.')

    log = storage.read_sidecar(str(workflow_id), storage.LOG_NAME)
    log["files"][filename] = payload.config_metadata
    log["updated_at"] = datetime.now(timezone.utc).isoformat()
    storage.put_json(storage.log_key(str(workflow_id)), log)
    return payload
