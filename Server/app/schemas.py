"""Pydantic models mirroring contracts/openapi.yaml."""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import DEFAULT_WORKFLOW_STATE, WORKFLOW_STATES

# ---------------------------------------------------------------- workflows


def _validate_state(v: str) -> str:
    if v not in WORKFLOW_STATES:
        allowed = ", ".join(sorted(WORKFLOW_STATES))
        raise ValueError(f"state must be one of: {allowed}")
    return v


class WorkflowCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workflow_name: str = Field(min_length=1, max_length=200)
    state: str = DEFAULT_WORKFLOW_STATE
    tag: str | None = Field(default=None, max_length=100)

    @field_validator("workflow_name")
    @classmethod
    def _trim_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("workflow_name must not be blank")
        return v

    @field_validator("state")
    @classmethod
    def _check_state(cls, v: str) -> str:
        return _validate_state(v)

    @field_validator("tag")
    @classmethod
    def _trim_tag(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class WorkflowUpdate(BaseModel):
    """All fields optional. `tag: null` clears; an absent `tag` leaves it alone."""

    model_config = ConfigDict(extra="forbid")

    workflow_name: str | None = Field(default=None, min_length=1, max_length=200)
    state: str | None = None
    tag: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def _at_least_one(self) -> "WorkflowUpdate":
        if not self.model_fields_set:
            raise ValueError("supply at least one field to update")
        return self

    @field_validator("workflow_name")
    @classmethod
    def _trim_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("workflow_name must not be blank")
        return v

    @field_validator("state")
    @classmethod
    def _check_state(cls, v: str | None) -> str | None:
        return None if v is None else _validate_state(v)


class WorkflowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workflow_name: str
    state: str
    tag: str | None


class WorkflowPage(BaseModel):
    items: list[WorkflowOut]
    next_cursor: str | None = None


# ------------------------------------------------------------- live_updates


class ColumnRename(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)


class DtypeChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str = Field(min_length=1)
    to: Literal[
        "string", "integer", "bigint", "float", "decimal", "boolean", "date", "timestamp"
    ]
    precision: int | None = None
    scale: int | None = None
    on_error: Literal["fail", "null_out"] = "fail"

    @model_validator(mode="after")
    def _decimal_args(self) -> "DtypeChange":
        if self.to == "decimal" and self.scale is None:
            raise ValueError("decimal requires `scale`")
        return self


class DateFormatChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str = Field(min_length=1)
    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)


class LiveUpdates(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    column_renames: list[ColumnRename] = Field(default_factory=list)
    dtype_changes: list[DtypeChange] = Field(default_factory=list)
    date_formats: list[DateFormatChange] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.column_renames or self.dtype_changes or self.date_formats)


class FileOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1)
    config_metadata: dict[str, Any] | None = None
    live_updates: LiveUpdates | None = None


class UploadManifest(BaseModel):
    """The single JSON part sent alongside the files."""

    model_config = ConfigDict(extra="forbid")

    config_metadata: dict[str, Any] = Field(default_factory=dict)
    live_updates: LiveUpdates = Field(default_factory=LiveUpdates)
    files: list[FileOverride] = Field(default_factory=list)

    def for_file(self, filename: str) -> tuple[dict[str, Any], LiveUpdates]:
        """Per-file override *replaces* the request-level blocks, never merges."""
        for entry in self.files:
            if entry.filename == filename:
                return (
                    entry.config_metadata
                    if entry.config_metadata is not None
                    else self.config_metadata,
                    entry.live_updates
                    if entry.live_updates is not None
                    else self.live_updates,
                )
        return self.config_metadata, self.live_updates


# ----------------------------------------------------------------- storage


class Sidecars(BaseModel):
    config_metadata: str
    live_updates: str


class AppliedCounts(BaseModel):
    column_renames: int = 0
    dtype_changes: int = 0
    date_formats: int = 0
    nulled_values: int = 0


class StoredFile(BaseModel):
    filename: str
    object_key: str
    size_bytes: int
    content_type: str
    checksum_sha256: str | None = None
    stored_at: str | None = None
    row_count: int | None = None
    columns: list[str] = Field(default_factory=list)
    sidecars: Sidecars | None = None
    applied: AppliedCounts | None = None


class StoredFileWithUrl(StoredFile):
    download_url: str
    download_url_expires_at: str


class UploadResponse(BaseModel):
    workflow_id: uuid.UUID
    files: list[StoredFile]


class FileListResponse(BaseModel):
    items: list[StoredFile]


class FileConfigResponse(BaseModel):
    config_metadata: dict[str, Any]
    live_updates: dict[str, Any]


class ConfigMetadataPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config_metadata: dict[str, Any]
