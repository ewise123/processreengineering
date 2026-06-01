from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v2 import router as v2_router
from app.db.session import SessionLocal
from app.services.render_pdf import libreoffice_available
from app.services.startup import sweep_stale_extracting_inputs


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: clean up any rows stuck in 'extracting' from a prior crash.
    with SessionLocal() as db:
        swept = sweep_stale_extracting_inputs(db)
        if swept:
            print(f"[startup] swept {swept} stale extracting input(s) to failed")
    if not libreoffice_available():
        print(
            "[startup] WARNING: LibreOffice (soffice) not found on PATH — "
            "non-PDF source documents cannot be rendered; the viewer will fall "
            "back to the cited quote."
        )
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="POET API", version="1.0.0", lifespan=lifespan)
    # NOTE: `allow_credentials` intentionally omitted (defaults to False).
    # Combining `allow_origins=["*"]` with `allow_credentials=True` is rejected
    # by browsers per the CORS spec — credentialed wildcard requests fail. The
    # frontend does not send credentials anywhere today, so the wildcard is
    # legal. When auth/cookies land, swap `["*"]` for an env-driven origin
    # allowlist and re-enable credentials.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )
    app.include_router(v2_router, prefix="/api/v2")
    return app
