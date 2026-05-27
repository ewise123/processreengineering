from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.models.input import Chunk, DocumentSection, Input
from app.models.project import Project
from app.schemas.claim import EmbedResult
from app.services.embeddings import embed_texts

router = APIRouter(
    prefix="/projects/{project_id}/inputs/{input_id}",
    tags=["embeddings"],
)


@router.post("/embed", response_model=EmbedResult)
def embed_input(
    project: Annotated[Project, Depends(get_project_or_404)],
    input_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> EmbedResult:
    inp = db.get(Input, input_id)
    if inp is None or inp.project_id != project.id:
        raise HTTPException(status_code=404, detail="Input not found")

    chunks = list(
        db.scalars(
            select(Chunk)
            .join(DocumentSection)
            .where(DocumentSection.input_id == input_id)
            .order_by(DocumentSection.order_index, Chunk.char_start)
        ).all()
    )
    if not chunks:
        return EmbedResult(input_id=input_id, embedded_count=0, skipped_count=0)

    todo = [c for c in chunks if c.embedding is None]
    skipped = len(chunks) - len(todo)
    if not todo:
        return EmbedResult(input_id=input_id, embedded_count=0, skipped_count=skipped)

    try:
        vectors = embed_texts([c.text for c in todo])
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    for chunk, vec in zip(todo, vectors):
        chunk.embedding = vec
    db.commit()
    return EmbedResult(
        input_id=input_id, embedded_count=len(todo), skipped_count=skipped
    )
