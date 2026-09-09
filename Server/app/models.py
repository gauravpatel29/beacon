"""ORM mapping for the `workflow` table (migrations/001_create_workflow.sql)."""

import uuid

from sqlalchemy import CheckConstraint, String, text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Workflow(Base):
    __tablename__ = "workflow"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    workflow_name: Mapped[str] = mapped_column(String, nullable=False)
    state: Mapped[str] = mapped_column(
        String, nullable=False, server_default=text("'new'")
    )
    tag: Mapped[str | None] = mapped_column(String, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "length(btrim(workflow_name)) > 0", name="workflow_name_not_blank"
        ),
        CheckConstraint("length(btrim(state)) > 0", name="workflow_state_not_blank"),
    )
