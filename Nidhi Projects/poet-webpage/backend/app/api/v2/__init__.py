from fastapi import APIRouter

from app.api.v2 import inputs, projects

router = APIRouter()
router.include_router(projects.router)
router.include_router(inputs.router)
