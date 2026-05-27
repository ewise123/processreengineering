from fastapi import APIRouter

from app.api.v2 import claims, embeddings, inputs, process_maps, projects

router = APIRouter()
router.include_router(projects.router)
router.include_router(inputs.router)
router.include_router(embeddings.router)
router.include_router(claims.router)
router.include_router(process_maps.router)
