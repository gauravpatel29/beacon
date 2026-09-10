import base64
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from core.database import get_db_pool

router = APIRouter()


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


class WorkflowCreateRequest(BaseModel):
    workflow_name: str
    state: Optional[str] = "new"
    tag: Optional[str] = None


class WorkflowPatchRequest(BaseModel):
    workflow_name: Optional[str] = None
    state: Optional[str] = None
    tag: Optional[Any] = ...  # Allows distinguishing omitted vs explicit null


# ─── 1. POST /v1/workflows ───────────────────────────────────────────────────
@router.post("", status_code=status.HTTP_201_CREATED)
@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_workflow(payload: WorkflowCreateRequest):
    name = (payload.workflow_name or "").strip()
    if not name or len(name) > 200:
        return problem_json(
            422,
            "Validation failed",
            "workflow_name must be between 1 and 200 non-whitespace characters.",
            "/v1/workflows",
            errors=[{"field": "workflow_name", "message": "Invalid workflow_name length."}],
        )

    valid_states = {"new", "configured", "running", "complete", "failed"}
    state_val = (payload.state or "new").strip().lower()
    if state_val not in valid_states:
        return problem_json(
            422,
            "Validation failed",
            f"state must be one of: {', '.join(sorted(valid_states))}.",
            "/v1/workflows",
            errors=[{"field": "state", "message": f"Invalid state '{state_val}'."}],
        )

    tag_val = payload.tag.strip() if isinstance(payload.tag, str) else None
    if tag_val and len(tag_val) > 100:
        return problem_json(
            422,
            "Validation failed",
            "tag cannot exceed 100 characters.",
            "/v1/workflows",
            errors=[{"field": "tag", "message": "Tag exceeds maximum length."}],
        )

    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    wf_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    query = """
    INSERT INTO workflows (id, workflow_name, state, tag, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, workflow_name, state, tag, created_at, updated_at;
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, wf_id, name, state_val, tag_val, now, now)

    return {
        "id": row["id"],
        "workflow_name": row["workflow_name"],
        "state": row["state"],
        "tag": row["tag"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


# ─── 2. GET /v1/workflows ────────────────────────────────────────────────────
@router.get("")
@router.get("/")
async def list_workflows(
    state: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(None),
):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    conditions = []
    params = []

    if state:
        params.append(state.strip().lower())
        conditions.append(f"state = ${len(params)}")

    if tag:
        params.append(tag.strip())
        conditions.append(f"tag = ${len(params)}")

    if q:
        params.append(f"%{q.strip()}%")
        conditions.append(f"workflow_name ILIKE ${len(params)}")

    # Cursor pagination based on (created_at, id)
    if cursor:
        try:
            decoded = base64.b64decode(cursor.encode("utf-8")).decode("utf-8")
            c_created_at, c_id = decoded.split("|", 1)
            params.append(datetime.fromisoformat(c_created_at))
            params.append(c_id)
            conditions.append(
                f"(created_at, id) < (${len(params)-1}, ${len(params)})"
            )
        except Exception:
            return problem_json(400, "Malformed request", "Invalid pagination cursor.", "/v1/workflows")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit + 1)
    limit_clause = f"LIMIT ${len(params)}"

    sql = f"""
    SELECT id, workflow_name, state, tag, created_at, updated_at
    FROM workflows
    {where_clause}
    ORDER BY created_at DESC, id DESC
    {limit_clause};
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    items = []
    for r in rows[:limit]:
        items.append({
            "id": r["id"],
            "workflow_name": r["workflow_name"],
            "state": r["state"],
            "tag": r["tag"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })

    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        raw_cursor = f"{last['created_at'].isoformat()}|{last['id']}"
        next_cursor = base64.b64encode(raw_cursor.encode("utf-8")).decode("utf-8")

    return {"items": items, "next_cursor": next_cursor}


# ─── 3. GET /v1/workflows/{workflow_id} ──────────────────────────────────────
@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    sql = "SELECT id, workflow_name, state, tag, created_at, updated_at FROM workflows WHERE id = $1;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, workflow_id)

    if not row:
        return problem_json(404, "Workflow not found", f"Workflow '{workflow_id}' does not exist.", f"/v1/workflows/{workflow_id}")

    return {
        "id": row["id"],
        "workflow_name": row["workflow_name"],
        "state": row["state"],
        "tag": row["tag"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


# ─── 4. PATCH /v1/workflows/{workflow_id} ────────────────────────────────────
@router.patch("/{workflow_id}")
async def patch_workflow(workflow_id: str, payload: Dict[str, Any]):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    async with pool.acquire() as conn:
        existing = await conn.fetchrow("SELECT id FROM workflows WHERE id = $1;", workflow_id)
        if not existing:
            return problem_json(404, "Workflow not found", f"Workflow '{workflow_id}' does not exist.", f"/v1/workflows/{workflow_id}")

        updates = []
        params = [workflow_id]

        if "workflow_name" in payload:
            name = str(payload["workflow_name"]).strip()
            if not name or len(name) > 200:
                return problem_json(422, "Validation failed", "workflow_name must be 1-200 characters.", f"/v1/workflows/{workflow_id}")
            params.append(name)
            updates.append(f"workflow_name = ${len(params)}")

        if "state" in payload:
            st = str(payload["state"]).strip().lower()
            valid_states = {"new", "configured", "running", "complete", "failed"}
            if st not in valid_states:
                return problem_json(422, "Validation failed", f"Invalid state '{st}'.", f"/v1/workflows/{workflow_id}")
            params.append(st)
            updates.append(f"state = ${len(params)}")

        if "tag" in payload:
            tag_val = payload["tag"]
            if tag_val is not None:
                tag_val = str(tag_val).strip()
                if len(tag_val) > 100:
                    return problem_json(422, "Validation failed", "tag exceeds 100 characters.", f"/v1/workflows/{workflow_id}")
            params.append(tag_val)
            updates.append(f"tag = ${len(params)}")

        if not updates:
            row = await conn.fetchrow("SELECT id, workflow_name, state, tag, created_at, updated_at FROM workflows WHERE id = $1;", workflow_id)
        else:
            params.append(datetime.now(timezone.utc))
            updates.append(f"updated_at = ${len(params)}")
            set_clause = ", ".join(updates)
            sql = f"UPDATE workflows SET {set_clause} WHERE id = $1 RETURNING id, workflow_name, state, tag, created_at, updated_at;"
            row = await conn.fetchrow(sql, *params)

    return {
        "id": row["id"],
        "workflow_name": row["workflow_name"],
        "state": row["state"],
        "tag": row["tag"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


# ─── 5. DELETE /v1/workflows/{workflow_id} ───────────────────────────────────
@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(workflow_id: str, purge_objects: bool = Query(False)):
    pool = await get_db_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="Database connection pool unavailable.")

    async with pool.acquire() as conn:
        wf = await conn.fetchrow("SELECT id FROM workflows WHERE id = $1;", workflow_id)
        if not wf:
            return problem_json(404, "Workflow not found", f"Workflow '{workflow_id}' does not exist.", f"/v1/workflows/{workflow_id}")

        file_count = await conn.fetchval("SELECT count(*) FROM workflow_files WHERE workflow_id = $1;", workflow_id)

        if file_count > 0 and not purge_objects:
            return problem_json(
                409,
                "Conflict",
                f"Workflow owns {file_count} files. Use ?purge_objects=true to delete workflow and all stored objects.",
                f"/v1/workflows/{workflow_id}",
            )

        await conn.execute("DELETE FROM workflows WHERE id = $1;", workflow_id)

    return Response(status_code=status.HTTP_204_NO_CONTENT)