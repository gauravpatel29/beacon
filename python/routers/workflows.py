import os
import json
import uuid
from datetime import datetime
from typing import Optional, Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORAGE_DIR = os.path.join(BASE_DIR, "storage")
WORKFLOWS_FILE = os.path.join(STORAGE_DIR, "workflows.json")

_MEMORY_STORE: Dict[str, Any] = {}


def _ensure_storage():
    try:
        if not os.path.exists(STORAGE_DIR):
            os.makedirs(STORAGE_DIR, exist_ok=True)
        if not os.path.exists(WORKFLOWS_FILE):
            with open(WORKFLOWS_FILE, "w", encoding="utf-8") as f:
                json.dump({}, f)
    except Exception as e:
        print(f"Storage init warning: {e}")


def _load_workflows() -> Dict[str, Any]:
    global _MEMORY_STORE
    _ensure_storage()
    try:
        if os.path.exists(WORKFLOWS_FILE):
            with open(WORKFLOWS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    _MEMORY_STORE.update(data)
                    return _MEMORY_STORE
    except Exception as e:
        print(f"Could not read workflows file: {e}")
    return _MEMORY_STORE


def _save_workflows(data: Dict[str, Any]):
    global _MEMORY_STORE
    _MEMORY_STORE = data
    _ensure_storage()
    try:
        with open(WORKFLOWS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Could not persist workflows to disk: {e}")


class WorkflowCreatePayload(BaseModel):
    name: Optional[str] = None
    owner: Optional[str] = "default_user"
    current_stage: Optional[str] = "Data Ingestion"
    current_route: Optional[str] = "/ingestion"
    module_status: Optional[Dict[str, Any]] = None
    state_data: Optional[Dict[str, Any]] = None


class WorkflowUpdatePayload(BaseModel):
    name: Optional[str] = None
    owner: Optional[str] = None
    current_stage: Optional[str] = None
    current_route: Optional[str] = None
    module_status: Optional[Dict[str, Any]] = None
    state_data: Optional[Dict[str, Any]] = None


@router.get("", response_model=None)
@router.get("/", response_model=None)
async def list_workflows():
    workflows = _load_workflows()
    summary_list = []
    for wf_id, wf in workflows.items():
        summary_list.append({
            "id": wf_id,
            "name": wf.get("name", "Untitled Workflow"),
            "owner": wf.get("owner", "default_user"),
            "created_at": wf.get("created_at"),
            "updated_at": wf.get("updated_at"),
            "current_stage": wf.get("current_stage", "Data Ingestion"),
            "current_route": wf.get("current_route", "/ingestion"),
            "module_status": wf.get("module_status", {}),
        })
    summary_list.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return {"workflows": summary_list, "total": len(summary_list)}


@router.post("", response_model=None)
@router.post("/", response_model=None)
async def create_workflow(payload: WorkflowCreatePayload):
    try:
        workflows = _load_workflows()
        now_iso = datetime.utcnow().isoformat() + "Z"
        wf_id = f"wf_{uuid.uuid4().hex[:8]}"

        default_name = f"MMM Workflow — {datetime.now().strftime('%b %d, %H:%M')}"
        name = payload.name.strip() if payload.name and payload.name.strip() else default_name

        new_wf = {
            "id": wf_id,
            "name": name,
            "owner": payload.owner or "default_user",
            "created_at": now_iso,
            "updated_at": now_iso,
            "current_stage": payload.current_stage or "Data Ingestion",
            "current_route": payload.current_route or "/ingestion",
            "module_status": payload.module_status or {
                "ingestion": "in_progress",
                "eda": "pending",
                "transformation": "pending",
                "modelling": "pending",
                "results": "pending",
                "response_curves": "pending",
                "optimization": "pending",
            },
            "state_data": payload.state_data or {},
        }

        workflows[wf_id] = new_wf
        _save_workflows(workflows)
        return new_wf
    except Exception as e:
        print(f"Workflow create error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create workflow: {str(e)}")


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    workflows = _load_workflows()
    if workflow_id not in workflows:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    return workflows[workflow_id]


@router.put("/{workflow_id}")
async def update_workflow(workflow_id: str, payload: WorkflowUpdatePayload):
    workflows = _load_workflows()
    if workflow_id not in workflows:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")

    wf = workflows[workflow_id]
    now_iso = datetime.utcnow().isoformat() + "Z"

    if payload.name is not None and payload.name.strip():
        wf["name"] = payload.name.strip()
    if payload.owner is not None:
        wf["owner"] = payload.owner
    if payload.current_stage is not None:
        wf["current_stage"] = payload.current_stage
    if payload.current_route is not None:
        wf["current_route"] = payload.current_route
    if payload.module_status is not None:
        wf["module_status"] = payload.module_status
    if payload.state_data is not None:
        wf["state_data"] = payload.state_data

    wf["updated_at"] = now_iso
    workflows[workflow_id] = wf
    _save_workflows(workflows)
    return wf


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str):
    workflows = _load_workflows()
    if workflow_id not in workflows:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    deleted = workflows.pop(workflow_id)
    _save_workflows(workflows)
    return {"message": "Workflow deleted successfully", "id": workflow_id, "name": deleted.get("name")}