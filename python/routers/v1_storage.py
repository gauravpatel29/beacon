import decimal
import hashlib
import io
import json
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse
from core.database import get_db_pool

router = APIRouter()

ALLOWED_EXTENSIONS = (".csv", ".tsv", ".txt", ".xlsx", ".xlsm")
MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024  # 200MB


def problem_json(status_code: int, title: str, detail: str, instance: str, errors: list = None, type_uri: str = None):
    content = {
        "type": type_uri or f"https://beacon.api/problems/{title.lower().replace(' ', '-')}",
        "title": title,
        "status": status_code,
        "detail": detail,
        "instance": instance,
    }
    if errors:
        content["errors"] = errors
    return JSONResponse(
        status_code=status_code,
        content=content,
        media_type="application/problem+json",
    )


def apply_live_updates(df: pd.DataFrame, filename: str, updates: Dict[str, Any]) -> tuple[pd.DataFrame, Dict[str, int]]:
    applied_counts = {
        "column_renames": 0,
        "dtype_changes": 0,
        "date_formats": 0,
        "nulled_values": 0,
    }
    errors = []

    # 1. Date Formats (runs FIRST)
    for dfmt in updates.get("date_formats", []):
        col = dfmt.get("column")
        from_fmt = dfmt.get("from")
        to_fmt = dfmt.get("to", "%Y-%m-%d")

        if col not in df.columns:
            errors.append({
                "filename": filename,
                "column": col,
                "code": "column_not_found",
                "message": f"Column \"{col}\" is not present in the uploaded file.",
            })
            continue

        try:
            if from_fmt:
                parsed = pd.to_datetime(df[col].astype(str).str.strip(), format=from_fmt, errors="coerce")
            else:
                parsed = pd.to_datetime(df[col].astype(str).str.strip(), errors="coerce")

            df[col] = parsed.dt.strftime(to_fmt).fillna("")
            applied_counts["date_formats"] += 1
        except Exception as e:
            errors.append({
                "filename": filename,
                "column": col,
                "code": "date_parse_failed",
                "message": f"Failed to format date column '{col}': {str(e)}",
            })

    # 2. Dtype Changes (runs SECOND)
    for dtc in updates.get("dtype_changes", []):
        col = dtc.get("column")
        target = (dtc.get("to") or "").lower()
        on_error = dtc.get("on_error", "fail")

        if col not in df.columns:
            errors.append({
                "filename": filename,
                "column": col,
                "code": "column_not_found",
                "message": f"Column \"{col}\" is not present in the uploaded file.",
            })
            continue

        try:
            orig_nulls = df[col].isna().sum()
            if target in ("integer", "bigint"):
                converted = pd.to_numeric(df[col], errors="coerce")
                if on_error == "fail" and converted.isna().sum() > orig_nulls:
                    errors.append({
                        "filename": filename,
                        "column": col,
                        "code": "cast_failed",
                        "message": f"Unconvertible integer values encountered in '{col}'.",
                    })
                else:
                    new_nulls = converted.isna().sum() - orig_nulls
                    if new_nulls > 0:
                        applied_counts["nulled_values"] += int(new_nulls)
                    df[col] = converted
                    applied_counts["dtype_changes"] += 1

            elif target in ("float", "decimal"):
                converted = pd.to_numeric(df[col], errors="coerce")
                if target == "decimal" and "scale" in dtc:
                    scale = int(dtc["scale"])
                    converted = converted.round(scale)
                if on_error == "fail" and converted.isna().sum() > orig_nulls:
                    errors.append({
                        "filename": filename,
                        "column": col,
                        "code": "cast_failed",
                        "message": f"Unconvertible numeric values in '{col}'.",
                    })
                else:
                    new_nulls = converted.isna().sum() - orig_nulls
                    if new_nulls > 0:
                        applied_counts["nulled_values"] += int(new_nulls)
                    df[col] = converted
                    applied_counts["dtype_changes"] += 1

            elif target in ("string", "text"):
                df[col] = df[col].astype(str).replace({"nan": "", "None": ""})
                applied_counts["dtype_changes"] += 1

            elif target == "boolean":
                df[col] = df[col].astype(bool)
                applied_counts["dtype_changes"] += 1

        except Exception as e:
            errors.append({
                "filename": filename,
                "column": col,
                "code": "cast_error",
                "message": str(e),
            })

    # 3. Column Renames (runs LAST)
    renames = {}
    for r in updates.get("column_renames", []):
        f = r.get("from")
        t = r.get("to")
        if f not in df.columns:
            errors.append({
                "filename": filename,
                "column": f,
                "code": "column_not_found",
                "message": f"Column \"{f}\" is not present in the uploaded file.",
            })
            continue
        renames[f] = t
        applied_counts["column_renames"] += 1

    if renames:
        df = df.rename(columns=renames)

    if errors:
        raise ValueError(errors)

    return df, applied_counts


# ─── 1. POST /v1/workflows/{workflow_id}/files ──────────────────────────────
@router.post("/{workflow_id}/files", status_code=status.HTTP_201_CREATED)
async def upload_workflow_files(
    workflow_id: str,
    manifest: Optional[str] = Form(None),
    files: List[UploadFile] = File(...),
):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    # 1. Verify workflow exists
    async with pool.acquire() as conn:
        wf = await conn.fetchrow("SELECT id FROM workflows WHERE id = $1;", workflow_id)
        if not wf:
            return problem_json(404, "Workflow not found", f"Workflow '{workflow_id}' does not exist.", f"/v1/workflows/{workflow_id}/files")

    # 2. Parse Manifest
    parsed_manifest = {}
    if manifest:
        try:
            parsed_manifest = json.loads(manifest)
        except Exception:
            return problem_json(400, "Malformed request", "The 'manifest' field must be a valid JSON string.", f"/v1/workflows/{workflow_id}/files")

    req_config_metadata = parsed_manifest.get("config_metadata", {})
    req_live_updates = parsed_manifest.get("live_updates", {})
    per_file_overrides = {f.get("filename"): f for f in parsed_manifest.get("files", []) if f.get("filename")}

    # 3. Process each file in-memory (All-or-Nothing validation)
    processed_results = []
    all_errors = []

    for upload_file in files:
        fname = upload_file.filename
        if not fname.lower().endswith(ALLOWED_EXTENSIONS):
            all_errors.append({
                "filename": fname,
                "code": "unsupported_file_type",
                "message": f"File extension not allowed. Accepted: {', '.join(ALLOWED_EXTENSIONS)}",
            })
            continue

        raw_bytes = await upload_file.read()
        if len(raw_bytes) > MAX_FILE_SIZE_BYTES:
            all_errors.append({
                "filename": fname,
                "code": "file_too_large",
                "message": "File exceeds maximum size of 200 MB.",
            })
            continue

        checksum = hashlib.sha256(raw_bytes).hexdigest()

        # Parse dataframe
        try:
            if fname.lower().endswith((".xlsx", ".xlsm")):
                df = pd.read_excel(io.BytesIO(raw_bytes))
            elif fname.lower().endswith(".tsv"):
                df = pd.read_csv(io.BytesIO(raw_bytes), sep="\t", encoding="latin-1", on_bad_lines="skip")
            else:
                df = pd.read_csv(io.BytesIO(raw_bytes), encoding="latin-1", on_bad_lines="skip")
        except Exception as e:
            all_errors.append({
                "filename": fname,
                "code": "parse_failed",
                "message": f"Could not parse file content: {str(e)}",
            })
            continue

        # Get configuration for this file
        file_override = per_file_overrides.get(fname)
        file_config_meta = file_override.get("config_metadata", req_config_metadata) if file_override else req_config_metadata
        file_live_updates = file_override.get("live_updates", req_live_updates) if file_override else req_live_updates

        # Apply transformations
        try:
            df_transformed, applied_stats = apply_live_updates(df, fname, file_live_updates)
        except ValueError as val_err:
            all_errors.extend(val_err.args[0])
            continue

        transformed_csv = df_transformed.to_csv(index=False)
        obj_key = f"{workflow_id}/{fname}"
        now_iso = datetime.now(timezone.utc)

        processed_results.append({
            "filename": fname,
            "object_key": obj_key,
            "size_bytes": len(raw_bytes),
            "content_type": upload_file.content_type or "text/csv",
            "checksum_sha256": checksum,
            "stored_at": now_iso,
            "row_count": len(df_transformed),
            "columns": list(df_transformed.columns),
            "sidecars": {
                "config_metadata": f"{workflow_id}/_log.json",
                "live_updates": f"{workflow_id}/_struct_updates.json",
            },
            "applied": applied_stats,
            "raw_csv": transformed_csv,
            "config_metadata": file_config_meta,
            "live_updates": file_live_updates,
        })

    # All-or-Nothing: Rollback if any errors exist
    if all_errors:
        return problem_json(
            422,
            "Transformation failed",
            "No object was written; the request was rolled back.",
            f"/v1/workflows/{workflow_id}/files",
            errors=all_errors,
        )

    # 4. Save atomic records to Neon PostgreSQL
    async with pool.acquire() as conn:
        async with conn.transaction():
            for p in processed_results:
                # Upsert file record
                file_query = """
                INSERT INTO workflow_files (
                    workflow_id, filename, object_key, size_bytes, content_type,
                    checksum_sha256, stored_at, row_count, columns, sidecars, applied, raw_csv
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
                ON CONFLICT (workflow_id, filename) DO UPDATE SET
                    object_key = EXCLUDED.object_key,
                    size_bytes = EXCLUDED.size_bytes,
                    content_type = EXCLUDED.content_type,
                    checksum_sha256 = EXCLUDED.checksum_sha256,
                    stored_at = EXCLUDED.stored_at,
                    row_count = EXCLUDED.row_count,
                    columns = EXCLUDED.columns,
                    sidecars = EXCLUDED.sidecars,
                    applied = EXCLUDED.applied,
                    raw_csv = EXCLUDED.raw_csv;
                """
                await conn.execute(
                    file_query,
                    workflow_id,
                    p["filename"],
                    p["object_key"],
                    p["size_bytes"],
                    p["content_type"],
                    p["checksum_sha256"],
                    p["stored_at"],
                    p["row_count"],
                    json.dumps(p["columns"]),
                    json.dumps(p["sidecars"]),
                    json.dumps(p["applied"]),
                    p["raw_csv"],
                )

                # Upsert logs & sidecar config
                log_query = """
                INSERT INTO workflow_config_logs (workflow_id, filename, config_metadata, live_updates, updated_at)
                VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
                ON CONFLICT (workflow_id, filename) DO UPDATE SET
                    config_metadata = EXCLUDED.config_metadata,
                    live_updates = EXCLUDED.live_updates,
                    updated_at = EXCLUDED.updated_at;
                """
                await conn.execute(
                    log_query,
                    workflow_id,
                    p["filename"],
                    json.dumps(p["config_metadata"]),
                    json.dumps(p["live_updates"]),
                    p["stored_at"],
                )

    # 5. Format response
    response_files = []
    for p in processed_results:
        response_files.append({
            "filename": p["filename"],
            "object_key": p["object_key"],
            "size_bytes": p["size_bytes"],
            "content_type": p["content_type"],
            "checksum_sha256": p["checksum_sha256"],
            "stored_at": p["stored_at"].isoformat(),
            "row_count": p["row_count"],
            "columns": p["columns"],
            "sidecars": p["sidecars"],
            "applied": p["applied"],
        })

    return {"workflow_id": workflow_id, "files": response_files}


# ─── 2. GET /v1/workflows/{workflow_id}/files ───────────────────────────────
@router.get("/{workflow_id}/files")
async def list_workflow_files(workflow_id: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    sql = """
    SELECT filename, object_key, size_bytes, content_type, checksum_sha256,
           stored_at, row_count, columns, sidecars, applied
    FROM workflow_files
    WHERE workflow_id = $1
    ORDER BY stored_at ASC;
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, workflow_id)

    items = []
    for r in rows:
        items.append({
            "filename": r["filename"],
            "object_key": r["object_key"],
            "size_bytes": r["size_bytes"],
            "content_type": r["content_type"],
            "checksum_sha256": r["checksum_sha256"],
            "stored_at": r["stored_at"].isoformat() if r["stored_at"] else None,
            "row_count": r["row_count"],
            "columns": json.loads(r["columns"]) if isinstance(r["columns"], str) else r["columns"],
            "sidecars": json.loads(r["sidecars"]) if isinstance(r["sidecars"], str) else r["sidecars"],
            "applied": json.loads(r["applied"]) if isinstance(r["applied"], str) else r["applied"],
        })

    return {"items": items}


# ─── 3. GET /v1/workflows/{workflow_id}/files/{filename} ────────────────────
@router.get("/{workflow_id}/files/{filename}")
async def get_file_metadata(workflow_id: str, filename: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    sql = """
    SELECT filename, object_key, size_bytes, content_type, checksum_sha256,
           stored_at, row_count, columns, sidecars, applied
    FROM workflow_files
    WHERE workflow_id = $1 AND filename = $2;
    """
    async with pool.acquire() as conn:
        r = await conn.fetchrow(sql, workflow_id, filename)

    if not r:
        return problem_json(404, "File not found", f"File '{filename}' not found for workflow '{workflow_id}'.", f"/v1/workflows/{workflow_id}/files/{filename}")

    # Return metadata and download endpoint
    return {
        "filename": r["filename"],
        "object_key": r["object_key"],
        "size_bytes": r["size_bytes"],
        "content_type": r["content_type"],
        "checksum_sha256": r["checksum_sha256"],
        "stored_at": r["stored_at"].isoformat() if r["stored_at"] else None,
        "row_count": r["row_count"],
        "columns": json.loads(r["columns"]) if isinstance(r["columns"], str) else r["columns"],
        "download_url": f"/v1/workflows/{workflow_id}/files/{filename}/download",
        "download_url_expires_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── Download File Contents ──────────────────────────────────────────────────
@router.get("/{workflow_id}/files/{filename}/download")
async def download_file_bytes(workflow_id: str, filename: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    sql = "SELECT raw_csv FROM workflow_files WHERE workflow_id = $1 AND filename = $2;"
    async with pool.acquire() as conn:
        r = await conn.fetchrow(sql, workflow_id, filename)

    if not r or not r["raw_csv"]:
        return problem_json(404, "File not found", f"File content '{filename}' not found.", f"/v1/workflows/{workflow_id}/files/{filename}/download")

    return StreamingResponse(
        io.BytesIO(r["raw_csv"].encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── 4. DELETE /v1/workflows/{workflow_id}/files/{filename} ──────────────────
@router.delete("/{workflow_id}/files/{filename}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(workflow_id: str, filename: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    async with pool.acquire() as conn:
        async with conn.transaction():
            res = await conn.execute("DELETE FROM workflow_files WHERE workflow_id = $1 AND filename = $2;", workflow_id, filename)
            await conn.execute("DELETE FROM workflow_config_logs WHERE workflow_id = $1 AND filename = $2;", workflow_id, filename)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ─── 5. GET /v1/workflows/{workflow_id}/files/{filename}/config ─────────────
@router.get("/{workflow_id}/files/{filename}/config")
async def get_file_config(workflow_id: str, filename: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    sql = "SELECT config_metadata, live_updates FROM workflow_config_logs WHERE workflow_id = $1 AND filename = $2;"
    async with pool.acquire() as conn:
        r = await conn.fetchrow(sql, workflow_id, filename)

    if not r:
        return {"config_metadata": {}, "live_updates": {}}

    return {
        "config_metadata": json.loads(r["config_metadata"]) if isinstance(r["config_metadata"], str) else r["config_metadata"],
        "live_updates": json.loads(r["live_updates"]) if isinstance(r["live_updates"], str) else r["live_updates"],
    }


# ─── 6. PATCH /v1/workflows/{workflow_id}/files/{filename}/config ───────────
@router.patch("/{workflow_id}/files/{filename}/config")
async def patch_file_config(workflow_id: str, filename: str, payload: Dict[str, Any]):
    # live_updates cannot be patched after upload
    if "live_updates" in payload:
        return problem_json(
            422,
            "Validation failed",
            "live_updates cannot be modified after upload; re-upload with PUT to change transformations.",
            f"/v1/workflows/{workflow_id}/files/{filename}/config",
        )

    config_meta = payload.get("config_metadata", {})
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    now = datetime.now(timezone.utc)
    sql = """
    INSERT INTO workflow_config_logs (workflow_id, filename, config_metadata, live_updates, updated_at)
    VALUES ($1, $2, $3::jsonb, '{}'::jsonb, $4)
    ON CONFLICT (workflow_id, filename) DO UPDATE SET
        config_metadata = EXCLUDED.config_metadata,
        updated_at = EXCLUDED.updated_at
    RETURNING config_metadata, live_updates;
    """

    async with pool.acquire() as conn:
        r = await conn.fetchrow(sql, workflow_id, filename, json.dumps(config_meta), now)

    return {
        "config_metadata": json.loads(r["config_metadata"]) if isinstance(r["config_metadata"], str) else r["config_metadata"],
        "live_updates": json.loads(r["live_updates"]) if isinstance(r["live_updates"], str) else r["live_updates"],
    }