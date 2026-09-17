"""Datasets: raw bytes in the bucket, metadata + manifest in Postgres.

The invariant everything else depends on:

    raw object  = the upload, written once, never rewritten
    spec        = the manifest, the source of truth for what to do to it
    derived     = a CACHE of replaying spec against raw

So `derived` can always be deleted and rebuilt. Editing a manifest re-derives
from the original rather than compounding on an already-transformed frame -
which is the bug the old rawCsv/workingCsv split had in the browser.

`resolve_frame()` is the single entry point every downstream router (EDA,
transformation, modelling, ...) uses to get a DataFrame from an id, replacing
the `csv_data` string that used to be posted on every request.
"""

import hashlib
import io
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from core import objectstore as store
from core import transform
from core.database import get_db_pool
from core.manifest import ResolvedSpec


class DatasetError(Exception):
    def __init__(self, status: int, title: str, detail: str = "") -> None:
        super().__init__(title)
        self.status = status
        self.title = title
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_dt(value: Any) -> Optional[datetime]:
    """Accept a datetime or the ISO string `_row_to_dict` produces.

    Reads serialise timestamps to strings for JSON; writes go back through
    asyncpg, which requires real datetimes. Round-tripping a row (read -> edit
    -> write, as `reapply` does) therefore has to convert back here.
    """
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


async def _pool():
    pool = await get_db_pool()
    if not pool:
        raise DatasetError(503, "Database unavailable",
                           "DATABASE_URL is not set or the pool could not start.")
    return pool


async def workflow_exists(workflow_id: str) -> bool:
    pool = await _pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "select 1 from workflows where id = $1", workflow_id
        ) is not None


# ---------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------

_COLS = """
    workflow_id, filename, object_key, derived_key, size_bytes, content_type,
    checksum_sha256, stored_at, derived_at, row_count, columns, applied, spec,
    derived_from, kind, version
"""


def _row_to_dict(r) -> Dict[str, Any]:
    out = dict(r)
    for key in ("columns", "applied", "spec", "derived_from"):
        val = out.get(key)
        if isinstance(val, str):
            out[key] = json.loads(val)
    for key in ("stored_at", "derived_at"):
        if out.get(key) is not None:
            out[key] = out[key].isoformat()
    return out


async def list_datasets(workflow_id: str) -> List[Dict[str, Any]]:
    pool = await _pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"select {_COLS} from workflow_files where workflow_id = $1 "
            f"order by stored_at, filename",
            workflow_id,
        )
    return [_row_to_dict(r) for r in rows]


async def get_dataset(workflow_id: str, filename: str) -> Dict[str, Any]:
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"select {_COLS} from workflow_files where workflow_id = $1 and filename = $2",
            workflow_id, filename,
        )
    if not row:
        raise DatasetError(404, "Dataset not found",
                           f'"{filename}" does not exist in workflow {workflow_id}.')
    return _row_to_dict(row)


async def read_raw(workflow_id: str, filename: str) -> Tuple[bytes, Dict[str, Any]]:
    meta = await get_dataset(workflow_id, filename)
    raw = store.get_bytes(meta["object_key"])
    if raw is None:
        raise DatasetError(
            410, "Raw object missing",
            f'The stored object for "{filename}" is gone from the bucket '
            f'({meta["object_key"]}). Re-upload the file.',
        )
    return raw, meta


async def raw_frame(workflow_id: str, filename: str) -> pd.DataFrame:
    """The original upload, parsed. Never transformed."""
    raw, meta = await read_raw(workflow_id, filename)
    return transform.read_table(filename, raw)


async def resolve_frame(workflow_id: str, filename: str) -> pd.DataFrame:
    """The dataset as downstream stages should see it.

    Serves the derived cache when present; otherwise replays the stored
    manifest against the raw bytes (and does not persist - a read must not
    write).
    """
    meta = await get_dataset(workflow_id, filename)

    if meta.get("derived_key"):
        body = store.get_bytes(meta["derived_key"])
        if body is not None:
            return transform.read_table(filename, body)

    raw, _ = await read_raw(workflow_id, filename)
    df = transform.read_table(filename, raw)
    spec_raw = meta.get("spec") or {}
    if spec_raw:
        spec = ResolvedSpec.model_validate(spec_raw)
        df, _counts = transform.apply_manifest(filename, df, spec)
    return df


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------


async def _upsert(
    workflow_id: str, filename: str, fields: Dict[str, Any], expect_version: Optional[int] = None
) -> Dict[str, Any]:
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if expect_version is not None:
                current = await conn.fetchval(
                    "select version from workflow_files where workflow_id=$1 and filename=$2",
                    workflow_id, filename,
                )
                if current is not None and current != expect_version:
                    raise DatasetError(
                        409, "Version conflict",
                        f'"{filename}" was modified by someone else '
                        f"(expected version {expect_version}, found {current}). "
                        f"Re-read the dataset and retry.",
                    )
            row = await conn.fetchrow(
                f"""
                insert into workflow_files (
                    workflow_id, filename, object_key, derived_key, size_bytes,
                    content_type, checksum_sha256, stored_at, derived_at,
                    row_count, columns, applied, spec, derived_from, kind, version
                ) values (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                    $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,1
                )
                on conflict (workflow_id, filename) do update set
                    object_key      = excluded.object_key,
                    derived_key     = excluded.derived_key,
                    size_bytes      = excluded.size_bytes,
                    content_type    = excluded.content_type,
                    checksum_sha256 = excluded.checksum_sha256,
                    derived_at      = excluded.derived_at,
                    row_count       = excluded.row_count,
                    columns         = excluded.columns,
                    applied         = excluded.applied,
                    spec            = excluded.spec,
                    derived_from    = excluded.derived_from,
                    kind            = excluded.kind,
                    version         = workflow_files.version + 1
                returning {_COLS}
                """,
                workflow_id, filename,
                fields["object_key"], fields.get("derived_key"),
                fields["size_bytes"], fields.get("content_type"),
                fields.get("checksum_sha256"), _as_dt(fields.get("stored_at")) or _now(),
                _as_dt(fields.get("derived_at")), fields.get("row_count"),
                json.dumps(fields.get("columns") or []),
                json.dumps(fields.get("applied") or {}),
                json.dumps(fields.get("spec") or {}),
                json.dumps(fields["derived_from"]) if fields.get("derived_from") else None,
                fields.get("kind", "upload"),
            )
    return _row_to_dict(row)


async def store_upload(
    workflow_id: str, filename: str, raw: bytes, spec: ResolvedSpec,
    content_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Write raw + derived to the bucket and upsert the row.

    The caller must have already validated the manifest via `preview`; any
    TransformError raised here propagates and the caller compensates.
    """
    written: List[str] = []
    try:
        df = transform.read_table(filename, raw)
        out, counts = transform.apply_manifest(filename, df, spec)

        rkey = store.raw_key(workflow_id, filename)
        dkey = store.derived_key(workflow_id, filename)
        ctype = content_type or transform.content_type_for(filename)

        store.put_bytes(rkey, raw, ctype)
        written.append(rkey)
        store.put_bytes(dkey, transform.write_table(filename, out), ctype)
        written.append(dkey)

        return await _upsert(workflow_id, filename, {
            "object_key": rkey,
            "derived_key": dkey,
            "size_bytes": len(raw),
            "content_type": ctype,
            "checksum_sha256": hashlib.sha256(raw).hexdigest(),
            "stored_at": _now(),
            "derived_at": _now(),
            "row_count": int(len(out)),
            "columns": [str(c) for c in out.columns],
            "applied": counts.model_dump(),
            "spec": spec.model_dump(by_alias=True, mode="json"),
            "kind": "upload",
        })
    except Exception:
        store.delete_keys(written)
        raise


async def reapply(
    workflow_id: str, filename: str, spec: ResolvedSpec, expect_version: Optional[int] = None
) -> Dict[str, Any]:
    """Re-derive from the IMMUTABLE raw bytes under a new manifest."""
    raw, meta = await read_raw(workflow_id, filename)
    df = transform.read_table(filename, raw)
    out, counts = transform.apply_manifest(filename, df, spec)

    dkey = store.derived_key(workflow_id, filename)
    store.put_bytes(dkey, transform.write_table(filename, out),
                    meta.get("content_type") or transform.content_type_for(filename))

    return await _upsert(workflow_id, filename, {
        "object_key": meta["object_key"],
        "derived_key": dkey,
        "size_bytes": meta["size_bytes"],
        "content_type": meta.get("content_type"),
        "checksum_sha256": meta.get("checksum_sha256"),
        "stored_at": meta.get("stored_at"),
        "derived_at": _now(),
        "row_count": int(len(out)),
        "columns": [str(c) for c in out.columns],
        "applied": counts.model_dump(),
        "spec": spec.model_dump(by_alias=True, mode="json"),
        "kind": meta.get("kind", "upload"),
        "derived_from": meta.get("derived_from"),
    }, expect_version=expect_version)


async def store_derived(
    workflow_id: str,
    filename: str,
    df: pd.DataFrame,
    kind: str,
    derived_from: Dict[str, Any],
) -> Dict[str, Any]:
    """Persist a computed frame (a merge, an ARD) as a dataset in its own right.

    Such a dataset has no uploaded source of its own: its "raw" object is the
    computed result, and `derived_from` records what produced it. Storing it
    like any other dataset means preview, download, the CSV handoff and
    `resolve_frame` all work on it without special cases downstream.
    """
    body = transform.write_table(filename, df)
    rkey = store.raw_key(workflow_id, filename)
    dkey = store.derived_key(workflow_id, filename)
    ctype = transform.content_type_for(filename)

    written: List[str] = []
    try:
        store.put_bytes(rkey, body, ctype)
        written.append(rkey)
        store.put_bytes(dkey, body, ctype)
        written.append(dkey)

        return await _upsert(workflow_id, filename, {
            "object_key": rkey,
            "derived_key": dkey,
            "size_bytes": len(body),
            "content_type": ctype,
            "checksum_sha256": hashlib.sha256(body).hexdigest(),
            "stored_at": _now(),
            "derived_at": _now(),
            "row_count": int(len(df)),
            "columns": [str(c) for c in df.columns],
            "applied": {"rows_out": int(len(df))},
            "spec": {},
            "derived_from": derived_from,
            "kind": kind,
        })
    except Exception:
        store.delete_keys(written)
        raise


async def store_merged(
    workflow_id: str, filename: str, df: pd.DataFrame, inputs: List[str], how: str, on: List[str]
) -> Dict[str, Any]:
    """Persist a merge output. Thin wrapper over `store_derived`."""
    return await store_derived(
        workflow_id, filename, df, "merge",
        {"inputs": inputs, "how": how, "on": on},
    )


async def delete_dataset(workflow_id: str, filename: str) -> None:
    meta = await get_dataset(workflow_id, filename)
    store.delete_keys([k for k in (meta["object_key"], meta.get("derived_key")) if k])
    pool = await _pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "delete from workflow_files where workflow_id = $1 and filename = $2",
            workflow_id, filename,
        )
