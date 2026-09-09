"""Neon Object Storage (S3-compatible, via boto3).

Key layout - everything under STORAGE_PREFIX so this bucket can be shared with
the reference Beacon/Server implementation without collisions:

    {prefix}/{workflow_id}/raw/{filename}        original upload, immutable
    {prefix}/{workflow_id}/derived/{filename}    output of replaying the manifest

The raw object is written exactly once. The derived object is a cache: it is
rewritten whenever the manifest changes, and can always be reconstructed by
replaying the manifest against the raw bytes. That split is what makes editing
a manifest idempotent instead of compounding on already-transformed data.
"""

import io
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from core.config import get_settings

NOT_FOUND_CODES = {"NoSuchKey", "404", "NotFound"}


class StorageUnavailable(RuntimeError):
    """Raised when the bucket credentials are absent or rejected."""


@lru_cache
def _client():
    s = get_settings()
    if not s.storage_configured():
        raise StorageUnavailable(
            "Object storage is not configured. Missing: " + ", ".join(s.missing())
        )
    return boto3.client(
        "s3",
        endpoint_url=s.aws_endpoint_url_s3,
        aws_access_key_id=s.aws_access_key_id,
        aws_secret_access_key=s.aws_secret_access_key,
        region_name=s.aws_region,
        # Neon Object Storage requires path-style addressing.
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


# -- keys --------------------------------------------------------------------


def _prefix() -> str:
    p = get_settings().storage_prefix
    return f"{p}/" if p else ""


def raw_key(workflow_id: str, filename: str) -> str:
    return f"{_prefix()}{workflow_id}/raw/{filename}"


def derived_key(workflow_id: str, filename: str) -> str:
    return f"{_prefix()}{workflow_id}/derived/{filename}"


def workflow_prefix(workflow_id: str) -> str:
    return f"{_prefix()}{workflow_id}/"


# -- io ----------------------------------------------------------------------


def put_bytes(key: str, body: bytes, content_type: str) -> None:
    _client().put_object(
        Bucket=get_settings().bucket, Key=key, Body=body, ContentType=content_type
    )


def get_bytes(key: str) -> Optional[bytes]:
    try:
        obj = _client().get_object(Bucket=get_settings().bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in NOT_FOUND_CODES:
            return None
        raise
    return obj["Body"].read()


def exists(key: str) -> bool:
    try:
        _client().head_object(Bucket=get_settings().bucket, Key=key)
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] in NOT_FOUND_CODES:
            return False
        raise


def delete_keys(keys: List[str]) -> None:
    """Best-effort compensating cleanup. Never raises."""
    bucket = get_settings().bucket
    for key in keys:
        try:
            _client().delete_object(Bucket=bucket, Key=key)
        except ClientError:
            continue


def list_prefix(prefix: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    paginator = _client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=get_settings().bucket, Prefix=prefix):
        out.extend(page.get("Contents", []))
    return out


def presign_get(key: str) -> Tuple[str, str]:
    """Bucket `data` is private, so downloads go out as presigned URLs."""
    s = get_settings()
    url = _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": s.bucket, "Key": key},
        ExpiresIn=s.presign_expiry_seconds,
    )
    expires = datetime.now(timezone.utc) + timedelta(seconds=s.presign_expiry_seconds)
    return url, expires.isoformat()


def healthcheck() -> Dict[str, Any]:
    """Real probe - lists one key. Never reports 'ok' without touching the bucket."""
    s = get_settings()
    if not s.storage_configured():
        return {"ok": False, "reason": "not configured", "missing": s.missing()}
    try:
        _client().list_objects_v2(Bucket=s.bucket, MaxKeys=1)
        return {"ok": True, "bucket": s.bucket, "prefix": s.storage_prefix}
    except Exception as exc:
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
