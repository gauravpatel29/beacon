from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import truststore
truststore.inject_into_ssl()
# Database Pool Manager
from core.config import get_settings
from core.database import get_db_pool
from core import objectstore

# Routers
from routers import (
    v1_workflows,
    v1_storage,
    v2_files,
    v2_ard,
    v2_review,
    ingestion,
    correlation,
    eda,
    transformation,
    modelling,
    results,
    response_curves,
    optimization,
    workflows,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect to Neon DB and create tables on startup
    await get_db_pool()
    yield


app = FastAPI(title="ProcTimize MMM & Beacon API", version="1.0.0", lifespan=lifespan)

# Open for development, including a frontend dev hitting this API over a tunnel
# from another machine.
#
# `allow_origin_regex` rather than `allow_origins=["*"]`: with credentials
# enabled, the literal "*" is returned on non-preflight responses, and browsers
# reject "*" the moment a request carries credentials. The regex makes Starlette
# echo the caller's Origin on both the preflight and the actual response, which
# stays valid either way.
#
# Tighten to an explicit origin list before this leaves a laptop.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# Beacon v1 API Routes
app.include_router(v1_workflows.router, prefix="/v1/workflows", tags=["Beacon V1 Workflows"])
app.include_router(v1_storage.router, prefix="/v1/workflows", tags=["Beacon V1 Storage"])

# Beacon v2 - manifest-driven ingestion on Neon Postgres + Object Storage
app.include_router(v2_files.router, prefix="/v2/workflows", tags=["Beacon V2 Datasets"])
app.include_router(v2_ard.router, prefix="/v2/workflows", tags=["Beacon V2 Stitching & ARD"])
app.include_router(v2_review.router, prefix="/v2/workflows", tags=["Beacon V2 Data Review"])

# MMM Modeling Routes
app.include_router(workflows.router, prefix="/api/workflows", tags=["Workflows Management"])
app.include_router(ingestion.router, prefix="/api/ingestion", tags=["Data Ingestion"])
app.include_router(correlation.router, prefix="/api/correlation", tags=["Correlation Analysis"])
app.include_router(eda.router, prefix="/api/eda", tags=["EDA"])
app.include_router(transformation.router, prefix="/api/transformation", tags=["Data Transformation"])
app.include_router(modelling.router, prefix="/api/modelling", tags=["Modelling"])
app.include_router(results.router, prefix="/api/results", tags=["Model Results"])
app.include_router(response_curves.router, prefix="/api/response-curves", tags=["Response Curves"])
app.include_router(optimization.router, prefix="/api/optimization", tags=["Optimization"])


@app.get("/health")
async def health():
    """Real probe. Never reports a dependency as healthy without touching it."""
    settings = get_settings()
    db = {"configured": settings.db_configured(), "ok": False}
    if db["configured"]:
        try:
            pool = await get_db_pool()
            if pool:
                async with pool.acquire() as conn:
                    await conn.fetchval("select 1")
                db["ok"] = True
            else:
                db["reason"] = "pool unavailable"
        except Exception as exc:
            db["reason"] = f"{type(exc).__name__}: {exc}"

    storage = objectstore.healthcheck()
    ok = db["ok"] and storage.get("ok", False)
    return {"status": "ok" if ok else "degraded", "database": db, "storage": storage}