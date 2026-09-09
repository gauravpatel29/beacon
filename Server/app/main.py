"""Beacon API - see contracts/openapi.yaml."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.errors import register_error_handlers
from app.routers import files, workflows

app = FastAPI(
    title="Beacon API",
    version="1.0.0",
    description="Workflow CRUD and workflow-scoped object storage.",
    openapi_url="/v1/openapi.json",
    docs_url="/docs",
)

# Wide open for local development; tighten before this leaves a laptop.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)

app.include_router(workflows.router, prefix="/v1")
app.include_router(files.router, prefix="/v1")


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
