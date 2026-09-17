"""What state is this database actually in?

    python/.venv/Scripts/python.exe python/scripts/schema_report.py

Read-only. Prints which of the v2 columns exist on `workflow_files` and which
migrations have been recorded, so "the URL is right but it still 500s" can be
answered with the schema rather than a guess.

Prints no credentials: the DSN is used, never echoed.
"""

import asyncio
import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PYTHON_DIR))

import asyncpg  # noqa: E402

from core.config import get_settings  # noqa: E402

# Everything migrations 002 and 003 add. `datasets.list_datasets` selects all
# of these by name, so a single missing one makes every /v2/files call fail.
EXPECTED = ["derived_key", "derived_at", "spec", "derived_from", "kind", "version"]


async def main() -> int:
    s = get_settings()
    dsn = s.database_url_unpooled or s.database_url
    if not dsn:
        print("DATABASE_URL is not set.")
        return 1

    conn = await asyncpg.connect(dsn, timeout=30)
    try:
        print("database :", await conn.fetchval("select current_database()"))

        rows = await conn.fetch(
            "select column_name from information_schema.columns "
            "where table_name = 'workflow_files' order by ordinal_position"
        )
        cols = [r["column_name"] for r in rows]
        if not cols:
            print("workflow_files : TABLE DOES NOT EXIST")
            return 1

        print("workflow_files columns :", ", ".join(cols))
        missing = [c for c in EXPECTED if c not in cols]
        for name in EXPECTED:
            print(f"  {name:<13}: {'present' if name in cols else 'MISSING'}")

        try:
            done = await conn.fetch("select filename from schema_migrations order by filename")
            print("migrations recorded :", [r["filename"] for r in done] or "(none)")
        except asyncpg.PostgresError:
            print("migrations recorded : schema_migrations table does not exist")

        print()
        if missing:
            print(f"VERDICT: {len(missing)} column(s) missing -> run scripts/migrate.py")
            return 1
        print("VERDICT: schema is up to date")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
