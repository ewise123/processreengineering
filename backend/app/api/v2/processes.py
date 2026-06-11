"""SP-7b: durable Process Inventory, claim curation, and the AI suggestion
inbox. Replaces the deleted process_detection router."""
from fastapi import APIRouter

router = APIRouter(prefix="/projects/{project_id}", tags=["processes"])
