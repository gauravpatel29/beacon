from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Database Pool Manager
from core.database import get_db_pool

# Routers
from routers import (
    v1_workflows,
    v1_storage,
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5001", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Beacon v1 API Routes
app.include_router(v1_workflows.router, prefix="/v1/workflows", tags=["Beacon V1 Workflows"])
app.include_router(v1_storage.router, prefix="/v1/workflows", tags=["Beacon V1 Storage"])

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
def health():
    return {"status": "ok", "database": "connected"}