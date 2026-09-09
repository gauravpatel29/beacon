from fastapi import APIRouter, HTTPException
from core.processing import create_response_curve
import pandas as pd
import numpy as np

router = APIRouter()


@router.post("/summary")
async def results_summary(payload: dict):
    """Accepts previously-computed regression results and returns structured summary."""
    try:
        iterations = payload.get("iterations", [])
        return {"iterations": iterations, "count": len(iterations)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
