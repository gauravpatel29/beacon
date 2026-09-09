"""Apply migrations to Neon, in filename order, recording what has run.

    python/.venv/Scripts/python.exe python/scripts/migrate.py

Uses DATABASE_URL_UNPOOLED when available: pgbouncer breaks transactional DDL,
so migrations must not go through the pooler.
"""

import asyncio
import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PYTHON_DIR))

import asyncpg  # noqa: E402

from core.config import get_settings  # noqa: E402
from core.database import init_tables_sql  # noqa: E402

MIGRATIONS_DIR = PYTHON_DIR / "migrations"


async def main() -> int:
    s = get_settings()
    dsn = s.database_url_unpooled or s.database_url
    if not dsn:
        print("DATABASE_URL is not set. Copy python/.env.example to python/.env.")
        return 1

    conn = await asyncpg.connect(dsn, timeout=30)
    try:
        # Base tables (workflows / workflow_files / workflow_config_logs).
        await conn.execute(init_tables_sql())
        print("  base tables verified")

        await conn.execute(
            """
            create table if not exists schema_migrations (
                filename    text primary key,
                applied_at  timestamptz not null default now()
            );
            """
        )

        done = {
            r["filename"]
            for r in await conn.fetch("select filename from schema_migrations")
        }

        applied = 0
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                print(f"  skip    {path.name} (already applied)")
                continue
            sql = path.read_text(encoding="utf-8")
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "insert into schema_migrations (filename) values ($1)", path.name
                )
            print(f"  APPLIED {path.name}")
            applied += 1

        print(f"\n{applied} migration(s) applied.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
