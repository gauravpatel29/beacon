"""Contract 1: CRUD over the `workflow` table."""

import base64
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import storage
from app.db import get_session
from app.errors import bad_request, conflict, not_found
from app.models import Workflow
from app.schemas import WorkflowCreate, WorkflowOut, WorkflowPage, WorkflowUpdate

router = APIRouter(prefix="/workflows", tags=["workflows"])


def _encode_cursor(value: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(str(value).encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> uuid.UUID:
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        return uuid.UUID(base64.urlsafe_b64decode(padded.encode()).decode())
    except Exception as exc:  # noqa: BLE001
        raise bad_request(f"Invalid cursor: {cursor!r}") from exc


async def load_workflow(session: AsyncSession, workflow_id: uuid.UUID) -> Workflow:
    wf = await session.get(Workflow, workflow_id)
    if wf is None:
        raise not_found(f"Workflow {workflow_id} does not exist.")
    return wf


@router.post("", response_model=WorkflowOut, status_code=status.HTTP_201_CREATED)
async def create_workflow(
    payload: WorkflowCreate,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    wf = Workflow(
        workflow_name=payload.workflow_name, state=payload.state, tag=payload.tag
    )
    session.add(wf)
    await session.commit()
    await session.refresh(wf)

    response.headers["Location"] = f"/v1/workflows/{wf.id}"
    return WorkflowOut.model_validate(wf).model_dump(mode="json")


@router.get("", response_model=WorkflowPage)
async def list_workflows(
    session: Annotated[AsyncSession, Depends(get_session)],
    state: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
) -> Any:
    stmt = select(Workflow).order_by(Workflow.id)
    if state:
        stmt = stmt.where(Workflow.state == state)
    if tag:
        stmt = stmt.where(Workflow.tag == tag)
    if q:
        stmt = stmt.where(Workflow.workflow_name.ilike(f"%{q}%"))
    if cursor:
        stmt = stmt.where(Workflow.id > _decode_cursor(cursor))

    rows = (await session.execute(stmt.limit(limit + 1))).scalars().all()
    has_more = len(rows) > limit
    page = rows[:limit]
    return WorkflowPage(
        items=[WorkflowOut.model_validate(r) for r in page],
        next_cursor=_encode_cursor(page[-1].id) if has_more and page else None,
    )


@router.get("/{workflow_id}", response_model=WorkflowOut)
async def get_workflow(
    workflow_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    return await load_workflow(session, workflow_id)


@router.patch("/{workflow_id}", response_model=WorkflowOut)
async def update_workflow(
    workflow_id: uuid.UUID,
    payload: WorkflowUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Any:
    wf = await load_workflow(session, workflow_id)
    # exclude_unset keeps `tag: null` (clear it) distinct from an absent `tag`.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(wf, field, value)
    await session.commit()
    await session.refresh(wf)
    return wf


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    workflow_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    purge_objects: bool = False,
) -> Response:
    await load_workflow(session, workflow_id)

    objects = storage.list_prefix(f"{workflow_id}/")
    if objects and not purge_objects:
        raise conflict(
            f"Workflow {workflow_id} still has {len(objects)} stored object(s). "
            f"Re-send with purge_objects=true to delete them."
        )
    if objects:
        storage.delete_keys([o["Key"] for o in objects])

    await session.execute(sa_delete(Workflow).where(Workflow.id == workflow_id))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
