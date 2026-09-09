"""Neon Object Storage access (S3-compatible, via boto3).

Layout, per the contract - ONE pair of sidecars per workflow folder, not per
file:

    data/{workflow_id}/{filename}          each uploaded data file
    data/{workflow_id}/_log.json           config_metadata, keyed by filename
    data/{workflow_id}/_struct_updates.json  live_updates, keyed by filename

Both sidecars accumulate: uploading a second file adds an entry rather than
replacing the first file's. Deleting a file removes only its entry.
"""

import json
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Any

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import get_settings

LOG_NAME = "_log.json"
STRUCT_NAME = "_struct_updates.json"
SIDECAR_NAMES = frozenset({LOG_NAME, STRUCT_NAME})


@lru_cache
def _client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.aws_endpoint_url_s3,
        aws_access_key_id=s.aws_access_key_id,
        aws_secret_access_key=s.aws_secret_access_key,
        region_name=s.aws_region,
        config=Config(signature_version="s3v4"),
    )


def basename(filename: str) -> str:
    return PurePosixPath(filename).stem


def data_key(workflow_id: str, filename: str) -> str:
    return f"{workflow_id}/{filename}"


def log_key(workflow_id: str) -> str:
    """One `_log.json` for the whole workflow."""
    return f"{workflow_id}/{LOG_NAME}"


def struct_key(workflow_id: str) -> str:
    """One `_struct_updates.json` for the whole workflow."""
    return f"{workflow_id}/{STRUCT_NAME}"


def is_sidecar(key: str) -> bool:
    return key.rsplit("/", 1)[-1] in SIDECAR_NAMES


def put_bytes(key: str, body: bytes, content_type: str) -> None:
    _client().put_object(
        Bucket=get_settings().bucket, Key=key, Body=body, ContentType=content_type
    )


def put_json(key: str, payload: dict[str, Any]) -> None:
    put_bytes(
        key,
        json.dumps(payload, indent=2, default=str).encode("utf-8"),
        "application/json",
    )


def get_json(key: str) -> dict[str, Any] | None:
    try:
        obj = _client().get_object(Bucket=get_settings().bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise
    return json.loads(obj["Body"].read().decode("utf-8"))


def head(key: str) -> dict[str, Any] | None:
    try:
        return _client().head_object(Bucket=get_settings().bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def exists(key: str) -> bool:
    return head(key) is not None


def list_prefix(prefix: str) -> list[dict[str, Any]]:
    paginator = _client().get_paginator("list_objects_v2")
    out: list[dict[str, Any]] = []
    for page in paginator.paginate(Bucket=get_settings().bucket, Prefix=prefix):
        out.extend(page.get("Contents", []))
    return out


def delete_keys(keys: list[str]) -> None:
    """Best-effort; used for compensating cleanup after a failed upload."""
    bucket = get_settings().bucket
    for key in keys:
        try:
            _client().delete_object(Bucket=bucket, Key=key)
        except ClientError:
            continue


def presign_get(key: str) -> tuple[str, str]:
    s = get_settings()
    url = _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": s.bucket, "Key": key},
        ExpiresIn=s.presign_expiry_seconds,
    )
    expires = datetime.now(timezone.utc) + timedelta(seconds=s.presign_expiry_seconds)
    return url, expires.isoformat()


# ------------------------------------------------- workflow-level sidecars
#
# Both sidecars share one shape: an envelope with a `files` map keyed by
# filename. One file per workflow means a second upload has to merge into what
# is already there, so every write is a read-modify-write.
#
# Caveat: object storage offers no compare-and-set, so two uploads landing on
# the same workflow at the same instant can lose one entry. Serialise per
# workflow before running concurrent uploads in anger (see README).


def _empty_envelope(workflow_id: str) -> dict[str, Any]:
    return {"workflow_id": workflow_id, "updated_at": None, "files": {}}


def read_sidecar(workflow_id: str, which: str) -> dict[str, Any]:
    key = log_key(workflow_id) if which == LOG_NAME else struct_key(workflow_id)
    return get_json(key) or _empty_envelope(workflow_id)


def write_sidecar_entries(
    workflow_id: str, filename: str, config_metadata: Any, live_updates: Any
) -> tuple[str, str]:
    """Merge one file's entries into the workflow's two shared sidecars."""
    stamp = datetime.now(timezone.utc).isoformat()

    log = read_sidecar(workflow_id, LOG_NAME)
    log["files"][filename] = config_metadata
    log["updated_at"] = stamp
    put_json(log_key(workflow_id), log)

    struct = read_sidecar(workflow_id, STRUCT_NAME)
    struct["files"][filename] = live_updates
    struct["updated_at"] = stamp
    put_json(struct_key(workflow_id), struct)

    return log_key(workflow_id), struct_key(workflow_id)


def remove_sidecar_entries(workflow_id: str, filename: str) -> None:
    """Drop one file's entries, leaving the other files' intact."""
    stamp = datetime.now(timezone.utc).isoformat()

    for name, key in ((LOG_NAME, log_key(workflow_id)),
                      (STRUCT_NAME, struct_key(workflow_id))):
        envelope = get_json(key)
        if not envelope:
            continue
        if envelope.get("files", {}).pop(filename, None) is not None:
            envelope["updated_at"] = stamp
            put_json(key, envelope)
