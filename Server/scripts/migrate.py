"""Apply migrations/*.sql in order.

Uses DATABASE_URL_UNPOOLED: pgbouncer does not handle transactional DDL well.
"""

import sys
from pathlib import Path

import psycopg
from dotenv import dotenv_values

SERVER_DIR = Path(__file__).resolve().parent.parent


def main() -> int:
    env = dotenv_values(SERVER_DIR / ".env.local")
    url = env.get("DATABASE_URL_UNPOOLED") or env.get("DATABASE_URL")
    if not url:
        print("No DATABASE_URL in .env.local; run `neon link` first.")
        return 1

    files = sorted((SERVER_DIR / "migrations").glob("*.sql"))
    if not files:
        print("No migrations found.")
        return 1

    with psycopg.connect(url) as conn:
        for path in files:
            print(f"applying {path.name} ...")
            with conn.cursor() as cur:
                cur.execute(path.read_text(encoding="utf-8"))
            conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select column_name, data_type, is_nullable, column_default "
                "from information_schema.columns where table_name = 'workflow' "
                "order by ordinal_position"
            )
            rows = cur.fetchall()

    if not rows:
        print("workflow table missing after migration")
        return 1

    print("\nworkflow table:")
    for name, dtype, nullable, default in rows:
        print(f"  {name:<14} {dtype:<10} null={nullable:<3} default={default or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
