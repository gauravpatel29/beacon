import json
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from core.processing import execute_ard_pipeline
from core.database import get_db_pool

router = APIRouter()


@router.post("/build-ard-pipeline")
async def build_ard_pipeline(payload: dict):
    """
    Thin API Router: Calls core processing logic and persists ARD snapshot to Neon DB.
    """
    try:
        workflow_id = payload.get("workflow_id", "wf_default")
        target_grain = payload.get("target_grain", "hcp").lower()
        steps = payload.get("steps", [])
        files_map = payload.get("files_map", {})

        # 1. Delegate business logic to processing.py
        result = execute_ard_pipeline(steps, files_map, target_grain)

        # 2. Database persistence
        pool = await get_db_pool()
        version = 1
        if pool:
            try:
                async with pool.acquire() as conn:
                    version = await conn.fetchval(
                        "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_ards WHERE workflow_id = $1 AND grain = $2;",
                        workflow_id, target_grain
                    ) or 1
                    await conn.execute(
                        """
                        INSERT INTO workflow_ards (workflow_id, grain, version, status, row_count, column_count, columns, lineage, csv_data)
                        VALUES ($1, $2, $3, 'complete', $4, $5, $6::jsonb, $7::jsonb, $8);
                        """,
                        workflow_id, target_grain, version, result["rows"], result["cols"],
                        json.dumps(result["columns"]), json.dumps(result["lineage"]), result["csv_data"]
                    )
            except Exception as db_err:
                print(f"Warning: Database write failed: {db_err}")

        return {
            "grain": target_grain,
            "version": int(version),
            "rows": result["rows"],
            "cols": result["cols"],
            "columns": result["columns"],
            "preview": result["preview"],
            "csv_data": result["csv_data"],
            "high_null_warning": False,
            "lineage": result["lineage"],
        }
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal pipeline error: {str(e)}")