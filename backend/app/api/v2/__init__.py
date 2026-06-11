from fastapi import APIRouter

from app.api.v2 import (
    claims,
    embeddings,
    inputs,
    process_maps,
    processes,
    projects,
    reviews,
    versions,
)

router = APIRouter()
router.include_router(projects.router)
router.include_router(inputs.router)
router.include_router(embeddings.router)
router.include_router(claims.router)
router.include_router(process_maps.router)
router.include_router(processes.router)
router.include_router(reviews.router)
router.include_router(versions.router)
