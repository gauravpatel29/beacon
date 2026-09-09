"""Settings, loaded from the .env.local that `neon link` writes."""

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = SERVER_DIR / ".env.local"

load_dotenv(ENV_FILE, override=False)

# `state` is text in Postgres precisely so this list can grow without a
# migration. Adding a value here is the whole change.
WORKFLOW_STATES: set[str] = {"new", "configured", "running", "complete", "failed"}

DEFAULT_WORKFLOW_STATE = "new"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # Written by `neon link`. The pooled URL serves requests; the unpooled one
    # is for migrations, where pgbouncer breaks transactional DDL.
    database_url: str
    database_url_unpooled: str | None = None
    neon_branch: str | None = None

    # Neon Object Storage is S3-compatible, so these are plain AWS names.
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_endpoint_url_s3: str
    aws_region: str = "us-east-2"

    bucket: str = "data"

    max_upload_bytes: int = 200 * 1024 * 1024
    presign_expiry_seconds: int = 900

    @property
    def sqlalchemy_url(self) -> str:
        """SQLAlchemy needs the driver named in the scheme; Neon does not set it."""
        url = self.database_url
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        elif url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg://", 1)
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
