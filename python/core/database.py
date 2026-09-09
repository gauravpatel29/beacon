"""
Neon DB (PostgreSQL) Async Database Manager
Automatically connects to Neon and handles all database operations.
"""
import os
import json
import logging
import asyncpg
from datetime import datetime
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv

# Load .env file
load_dotenv()

logger = logging.getLogger("proctimize.db")

DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("NEON_DATABASE_URL") or ""

_pool: Optional[asyncpg.Pool] = None


async def get_db_pool() -> Optional[asyncpg.Pool]:
    """Creates and returns an asyncpg connection pool to Neon DB."""
    global _pool
    if _pool is None and DATABASE_URL:
        try:
            dsn = DATABASE_URL
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
            print(" Connected successfully to Neon DB (PostgreSQL)!")
            await init_tables()
        except Exception as e:
            print(f"⚠️ Could not connect to Neon DB: {e}")
            _pool = None
    return _pool


async def init_tables():
    """Automatically creates all necessary tables in your Neon DB."""
    pool = await get_db_pool()
    if not pool:
        return

    create_tables_sql = """
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
    async with pool.acquire() as conn:
        await conn.execute(create_tables_sql)
        print(" Neon DB Tables Verified & Initialized!")