"""What is actually stored for one workflow?

    python/.venv/Scripts/python.exe python/scripts/inspect_workflow.py "22/09"

Read-only. Takes a workflow name (or id) and prints its files, the columns the
engine will see, and the parts of each spec that decide whether a screen can
draw anything: date formats, dtype casts, renames, drops and granularity.

Prints no credentials.
"""

import asyncio
import json
import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PYTHON_DIR))

import asyncpg  # noqa: E402

from core.config import get_settings  # noqa: E402


async def main() -> int:
    wanted = sys.argv[1] if len(sys.argv) > 1 else ""
    if not wanted:
        print('Usage: inspect_workflow.py "<workflow name or id>"')
        return 1

    s = get_settings()
    conn = await asyncpg.connect(s.database_url_unpooled or s.database_url, timeout=30)
    try:
        rows = await conn.fetch(
            "select id, workflow_name, current_stage, updated_at from workflows "
            "where id::text = $1 or workflow_name ilike $2 order by updated_at desc",
            wanted, f"%{wanted}%",
        )
        if not rows:
            print(f'No workflow matching "{wanted}".')
            names = await conn.fetch(
                "select workflow_name, updated_at from workflows order by updated_at desc limit 15"
            )
            print("\nMost recent workflows:")
            for n in names:
                print(f"  {n['workflow_name']!r}  (updated {n['updated_at']:%Y-%m-%d %H:%M})")
            return 1

        for wf in rows:
            print("=" * 70)
            print(f"{wf['workflow_name']!r}   id={wf['id']}")
            print(f"stage: {wf['current_stage']}   updated: {wf['updated_at']:%Y-%m-%d %H:%M}")

            files = await conn.fetch(
                "select filename, kind, row_count, columns, spec from workflow_files "
                "where workflow_id = $1 order by filename",
                wf["id"],
            )
            if not files:
                print("  (no files)")
                continue

            for f in files:
                cols = json.loads(f["columns"]) if isinstance(f["columns"], str) else (f["columns"] or [])
                spec = json.loads(f["spec"]) if isinstance(f["spec"], str) else (f["spec"] or {})
                lu = spec.get("live_updates") or {}
                meta = spec.get("config_metadata") or {}

                print(f"\n  -- {f['filename']}  [{f['kind']}]  {f['row_count']} rows")
                print(f"     columns ({len(cols)}): {', '.join(map(str, cols))[:200]}")

                # The trend needs a column the screen considers a date. That is
                # decided by dtype_changes, then by config_metadata roles, then
                # by a name match.
                casts = {c.get("column"): c.get("to") for c in lu.get("dtype_changes") or []}
                dates = [c for c, t in casts.items() if t == "date"]
                print(f"     typed as date : {dates or '(none)'}")
                print(f"     date_formats  : {[d.get('column') for d in lu.get('date_formats') or []] or '(none)'}")

                roles = meta.get("column_roles") or {}
                time_roles = [c for c, r in roles.items() if r == "Time Variable"]
                print(f"     role=Time     : {time_roles or '(none declared)'}")

                renames = {r.get("from"): r.get("to") for r in lu.get("column_renames") or []}
                if renames:
                    print(f"     renames       : {renames}")
                drops = lu.get("column_drops") or []
                if drops:
                    print(f"     drops         : {drops}")
                if spec.get("granularity"):
                    g = spec["granularity"]
                    print(f"     granularity   : {g.get('from')} -> {g.get('to')} "
                          f"on {g.get('date_column')} by {g.get('geo_column')}")
                if not spec:
                    print("     spec          : EMPTY (nothing applied yet)")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
