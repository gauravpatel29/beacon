"""Settings, loaded from python/.env (gitignored). See .env.example.

Everything is optional at import time so the app still boots with no
credentials - `configured()` reports what is actually usable, and the routers
return a clear 503 rather than crashing on startup.
"""

import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

PYTHON_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = PYTHON_DIR / ".env"

load_dotenv(ENV_FILE, override=False)


class Settings:
    def __init__(self) -> None:
        self.database_url: str = (
            os.getenv("DATABASE_URL") or os.getenv("NEON_DATABASE_URL") or ""
        )
        self.database_url_unpooled: str = os.getenv("DATABASE_URL_UNPOOLED", "")

        self.aws_access_key_id: str = os.getenv("AWS_ACCESS_KEY_ID", "")
        self.aws_secret_access_key: str = os.getenv("AWS_SECRET_ACCESS_KEY", "")
        self.aws_endpoint_url_s3: str = os.getenv("AWS_ENDPOINT_URL_S3", "")
        self.aws_region: str = os.getenv("AWS_REGION", "us-east-2")
        self.bucket: str = os.getenv("NEON_BUCKET", "data")

        # This project's bucket is shared with the reference Beacon/Server
        # implementation, so every key this app writes lives under one prefix.
        self.storage_prefix: str = os.getenv("STORAGE_PREFIX", "beacon").strip("/")

        self.max_upload_bytes: int = int(
            os.getenv("MAX_UPLOAD_BYTES", str(200 * 1024 * 1024))
        )
        self.presign_expiry_seconds: int = int(os.getenv("PRESIGN_EXPIRY_SECONDS", "900"))

    # -- readiness -----------------------------------------------------------

    def db_configured(self) -> bool:
        return bool(self.database_url)

    def storage_configured(self) -> bool:
        return bool(
            self.aws_access_key_id
            and self.aws_secret_access_key
            and self.aws_endpoint_url_s3
        )

    def missing(self) -> list[str]:
        out = []
        if not self.database_url:
            out.append("DATABASE_URL")
        if not self.aws_access_key_id:
            out.append("AWS_ACCESS_KEY_ID")
        if not self.aws_secret_access_key:
            out.append("AWS_SECRET_ACCESS_KEY")
        if not self.aws_endpoint_url_s3:
            out.append("AWS_ENDPOINT_URL_S3")
        return out


@lru_cache
def get_settings() -> Settings:
    return Settings()
