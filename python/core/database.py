"""
Neon DB (PostgreSQL) Async Database Manager
Automatically connects to Neon and handles all database operations.
"""
import os
import json
import logging
import asyncpg
from pathlib import Path
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

from core.config import get_settings

# Explicitly load python/.env regardless of current working directory
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)

logger = logging.getLogger("proctimize.db")

_pool: Optional[asyncpg.Pool] = None


async def get_db_pool() -> Optional[asyncpg.Pool]:
    """Creates and returns an asyncpg connection pool to Neon DB."""
    global _pool
    if _pool is not None:
        return _pool

    settings = get_settings()
    dsn = (
        settings.database_url
        or os.getenv("DATABASE_URL")
        or os.getenv("NEON_DATABASE_URL")
        or ""
    )

    if not dsn:
        print("❌ DATABASE_URL is not set in python/.env")
        return None

    try:
        # Ensure sslmode=require for Neon Cloud PostgreSQL
        if "sslmode=" not in dsn:
            dsn += "?sslmode=require" if "?" not in dsn else "&sslmode=require"

        _pool = await asyncpg.create_pool(
            dsn=dsn,
            min_size=1,
            max_size=10,
            timeout=30.0,
            command_timeout=60.0,
        )
        print("✅ Connected successfully to Neon DB (PostgreSQL)!")
        await init_tables()
    except Exception as e:
        print(f"⚠️ Could not connect to Neon DB: {e}")
        _pool = None

    return _pool


_CREATE_TABLES_SQL = """
    -- 1. Workflows Table
    CREATE TABLE IF NOT EXISTS workflows (
        id VARCHAR(64) PRIMARY KEY,
        workflow_name VARCHAR(255) NOT NULL,
        state VARCHAR(50) DEFAULT 'new',
        tag VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        current_stage VARCHAR(100) DEFAULT 'Data Ingestion',
        current_route VARCHAR(100) DEFAULT '/ingestion',
        module_status JSONB DEFAULT '{}'::jsonb,
        state_data JSONB DEFAULT '{}'::jsonb
    );

    -- 2. Ingested & Transformed Files Table
    CREATE TABLE IF NOT EXISTS workflow_files (
        id SERIAL PRIMARY KEY,
        workflow_id VARCHAR(64) REFERENCES workflows(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        object_key VARCHAR(500) NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        content_type VARCHAR(100),
        checksum_sha256 VARCHAR(64),
        stored_at TIMESTAMPTZ DEFAULT NOW(),
        row_count BIGINT DEFAULT 0,
        columns JSONB DEFAULT '[]'::jsonb,
        sidecars JSONB DEFAULT '{}'::jsonb,
        applied JSONB DEFAULT '{}'::jsonb,
        raw_csv TEXT,
        UNIQUE(workflow_id, filename)
    );

    -- 3. File Config & Transformation Logs
    CREATE TABLE IF NOT EXISTS workflow_config_logs (
        workflow_id VARCHAR(64) REFERENCES workflows(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        config_metadata JSONB DEFAULT '{}'::jsonb,
        live_updates JSONB DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY(workflow_id, filename)
    );
"""


def init_tables_sql() -> str:
    return _CREATE_TABLES_SQL


async def init_tables():
    pool = await get_db_pool()
    if not pool:
        return

    async with pool.acquire() as conn:
        await conn.execute(_CREATE_TABLES_SQL)
        print("✅ Neon DB Tables Verified & Initialized!")