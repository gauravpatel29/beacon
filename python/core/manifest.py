"""Pydantic models for the upload/transform manifest.

The manifest is the single declarative description of everything done to an
uploaded file. It is the source of truth: the raw bytes are stored once and
never mutated, and the transformed output is *derived* by replaying this
manifest. Re-applying the same manifest is therefore idempotent, and editing
one field re-derives from the original rather than compounding on top of an
already-transformed frame.

Three groups, applied in a fixed order:

    live_updates  ->  filters  ->  granularity
    (column-shaped)   (row-shaped)  (grain-shaped)

`extra="forbid"` throughout: a misspelled key is a validation error, not a
silently ignored no-op.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# live_updates - column-shaped operations
# ---------------------------------------------------------------------------


class ColumnRename(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)


class DtypeChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str = Field(min_length=1)
    to: Literal[
        "string", "integer", "bigint", "float", "decimal",
        "boolean", "date", "timestamp",
    ]
    precision: Optional[int] = None
    scale: Optional[int] = None
    on_error: Literal["fail", "null_out"] = "fail"

    @model_validator(mode="after")
    def _decimal_args(self) -> "DtypeChange":
        if self.to == "decimal" and self.scale is None:
            raise ValueError("decimal requires `scale`")
        return self


class DateFormatChange(BaseModel):
    """`from` is REQUIRED.

    Inferring a date format is how day and month get silently transposed for
    every day-of-month <= 12 (pandas guesses `%Y-%d-%m` under dayfirst=True on
    ISO input). The caller must state the format the file actually uses.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    column: str = Field(min_length=1)
    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)


class LiveUpdates(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    # Columns to discard, named as they appear in the uploaded file. Applied
    # FIRST, so everything after it works on the surviving columns only.
    # Absent means keep everything - dropping is always explicit.
    column_drops: List[str] = Field(default_factory=list)
    date_formats: List[DateFormatChange] = Field(default_factory=list)
    dtype_changes: List[DtypeChange] = Field(default_factory=list)
    column_renames: List[ColumnRename] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.column_drops or self.date_formats
                    or self.dtype_changes or self.column_renames)


# ---------------------------------------------------------------------------
# filters - row-shaped operations
# ---------------------------------------------------------------------------


class NpiLuhnFilter(BaseModel):
    """Keep only rows whose NPI passes the official CMS Luhn check."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["npi_luhn"]
    column: str = Field(min_length=1)


class DateRangeFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["date_range"]
    column: str = Field(min_length=1)
    # Bounds are inclusive. ISO `YYYY-MM-DD` only - the same reasoning as
    # DateFormatChange.from_: no guessing at the caller's intent.
    start: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def _at_least_one_bound(self) -> "DateRangeFilter":
        if self.start is None and self.end is None:
            raise ValueError("date_range requires `start`, `end`, or both")
        if self.start and self.end and self.start > self.end:
            raise ValueError("`start` must not be after `end`")
        return self


class ValueFilter(BaseModel):
    """Categorical include/exclude on an exact-match column."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["value_in", "value_not_in"]
    column: str = Field(min_length=1)
    values: List[Any] = Field(min_length=1)


class RangeFilter(BaseModel):
    """Numeric bounds. Inclusive."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["range"]
    column: str = Field(min_length=1)
    min: Optional[float] = None
    max: Optional[float] = None

    @model_validator(mode="after")
    def _at_least_one_bound(self) -> "RangeFilter":
        if self.min is None and self.max is None:
            raise ValueError("range requires `min`, `max`, or both")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("`min` must not exceed `max`")
        return self


class NotNullFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["not_null"]
    column: str = Field(min_length=1)


Filter = NpiLuhnFilter | DateRangeFilter | ValueFilter | RangeFilter | NotNullFilter


# ---------------------------------------------------------------------------
# granularity - grain-shaped operation
# ---------------------------------------------------------------------------

GRAIN_ORDER = {"Daily": 0, "Weekly": 1, "Monthly": 2, "Yearly": 3}


class Granularity(BaseModel):
    """Roll rows up to a coarser period.

    Unlike the legacy `/api/ingestion/modify-granularity`, categorical columns
    are not silently dropped: any column not named in `numeric` or
    `categorical` is reported by `unhandled_columns` so the caller can decide.
    """

    model_config = ConfigDict(extra="forbid")

    from_: Literal["Daily", "Weekly", "Monthly"] = Field(alias="from")
    to: Literal["Weekly", "Monthly", "Yearly"]
    date_column: str = Field(min_length=1)
    geo_column: str = Field(min_length=1)
    numeric: Dict[str, Literal["sum", "average", "min", "max", "product"]] = Field(
        default_factory=dict
    )
    categorical: Dict[str, Literal["first", "last", "count", "distinct_count", "mode"]] = Field(
        default_factory=dict
    )

    @model_validator(mode="after")
    def _coarser_only(self) -> "Granularity":
        if GRAIN_ORDER[self.to] <= GRAIN_ORDER[self.from_]:
            raise ValueError(
                f"cannot change granularity from {self.from_} to {self.to}: "
                f"the target must be coarser"
            )
        return self


# ---------------------------------------------------------------------------
# the manifest itself
# ---------------------------------------------------------------------------


class FileOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1)
    config_metadata: Optional[Dict[str, Any]] = None
    live_updates: Optional[LiveUpdates] = None
    filters: Optional[List[Filter]] = None
    granularity: Optional[Granularity] = None


class Manifest(BaseModel):
    """Request-level defaults, with optional per-file overrides.

    A per-file override *replaces* the request-level block for that key; it
    never merges. Partial merging would make it impossible to express "this
    file has no filters" once a request-level filter exists.
    """

    model_config = ConfigDict(extra="forbid")

    config_metadata: Dict[str, Any] = Field(default_factory=dict)
    live_updates: LiveUpdates = Field(default_factory=LiveUpdates)
    filters: List[Filter] = Field(default_factory=list)
    granularity: Optional[Granularity] = None
    files: List[FileOverride] = Field(default_factory=list)

    @field_validator("files")
    @classmethod
    def _unique_filenames(cls, v: List[FileOverride]) -> List[FileOverride]:
        seen = set()
        for entry in v:
            if entry.filename in seen:
                raise ValueError(f'duplicate override for "{entry.filename}"')
            seen.add(entry.filename)
        return v

    def for_file(self, filename: str) -> "ResolvedSpec":
        for entry in self.files:
            if entry.filename == filename:
                return ResolvedSpec(
                    config_metadata=(
                        entry.config_metadata
                        if entry.config_metadata is not None
                        else self.config_metadata
                    ),
                    live_updates=(
                        entry.live_updates
                        if entry.live_updates is not None
                        else self.live_updates
                    ),
                    filters=entry.filters if entry.filters is not None else self.filters,
                    granularity=(
                        entry.granularity
                        if entry.granularity is not None
                        else self.granularity
                    ),
                )
        return ResolvedSpec(
            config_metadata=self.config_metadata,
            live_updates=self.live_updates,
            filters=self.filters,
            granularity=self.granularity,
        )


class ResolvedSpec(BaseModel):
    """What actually runs for one file, after override resolution."""

    model_config = ConfigDict(extra="forbid")

    config_metadata: Dict[str, Any] = Field(default_factory=dict)
    live_updates: LiveUpdates = Field(default_factory=LiveUpdates)
    filters: List[Filter] = Field(default_factory=list)
    # How several filters combine. "all" keeps a row only if every filter
    # accepts it; "any" keeps it if at least one does.
    #
    # Defaults to "all", which is what the engine did before this field
    # existed - so a spec saved without it replays exactly as it used to.
    filter_mode: Literal["all", "any"] = "all"
    granularity: Optional[Granularity] = None


# ---------------------------------------------------------------------------
# result telemetry
# ---------------------------------------------------------------------------


class AppliedCounts(BaseModel):
    """Returned to the caller so the UI can show what actually happened."""

    column_renames: int = 0
    columns_dropped: int = 0
    dtype_changes: int = 0
    date_formats: int = 0
    nulled_values: int = 0
    filters_applied: int = 0
    rows_in: int = 0
    rows_out: int = 0
    rows_removed: int = 0
    granularity_applied: bool = False
    unhandled_columns: List[str] = Field(default_factory=list)
