from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import InputStatus, InputType
from app.models.claim import ClaimCitation
from app.models.identity import User
from app.models.input import Chunk, DocumentSection, Input
from app.models.project import Project
from app.schemas.common import Page
from app.schemas.input import InputParseResult, InputRead
from app.services.chunking import chunk_sections
from app.services.parsing import parse_file
from app.services.storage import resolve_path, save_upload

router = APIRouter(prefix="/projects/{project_id}/inputs", tags=["inputs"])

ALLOWED_INPUT_TYPES = {t.value for t in InputType}
MAX_BYTES = 50 * 1024 * 1024  # 50 MB


@router.post("", response_model=InputRead, status_code=status.HTTP_201_CREATED)
async def upload_input(
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    type: Annotated[str, Form()],
    file: UploadFile = File(...),
) -> Input:
    if type not in ALLOWED_INPUT_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown input type: {type}")
    body = await file.read()
    if len(body) == 0:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_BYTES} bytes")

    rel_path, mime = save_upload(project.id, file.filename or "upload.bin", body)
    inp = Input(
        project_id=project.id,
        type=type,
        name=file.filename or "upload.bin",
        file_path=str(rel_path),
        file_size=len(body),
        mime_type=mime,
        status=InputStatus.UPLOADED.value,
        uploaded_by=user.id,
    )
    db.add(inp)
    db.commit()
    db.refresh(inp)
    return inp


@router.get("", response_model=Page[InputRead])
def list_inputs(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Page[InputRead]:
    base = select(Input).where(Input.project_id == project.id)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    items = list(
        db.scalars(
            base.order_by(Input.created_at.desc()).limit(limit).offset(offset)
        ).all()
    )

    # Compute distinct claim counts per input via citations → chunks → sections
    counts: dict = {}
    if items:
        input_ids = [i.id for i in items]
        rows = db.execute(
            select(
                DocumentSection.input_id,
                func.count(func.distinct(ClaimCitation.claim_id)),
            )
            .join(Chunk, Chunk.section_id == DocumentSection.id)
            .join(ClaimCitation, ClaimCitation.chunk_id == Chunk.id)
            .where(DocumentSection.input_id.in_(input_ids))
            .group_by(DocumentSection.input_id)
        ).all()
        counts = {row[0]: row[1] for row in rows}

    return Page[InputRead](
        items=[
            InputRead.model_validate(i).model_copy(
                update={"claim_count": counts.get(i.id, 0)}
            )
            for i in items
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/{input_id}/parse", response_model=InputParseResult)
def parse_input(
    project: Annotated[Project, Depends(get_project_or_404)],
    input_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> InputParseResult:
    inp = db.get(Input, input_id)
    if inp is None or inp.project_id != project.id:
        raise HTTPException(status_code=404, detail="Input not found")
    if not inp.file_path:
        raise HTTPException(status_code=422, detail="Input has no file_path")

    inp.status = InputStatus.PARSING.value
    db.commit()

    try:
        full_path = resolve_path(inp.file_path)
        if not full_path.is_file():
            raise FileNotFoundError(str(full_path))

        sections = parse_file(full_path, inp.mime_type)

        # Wipe any prior parse for this input (sections cascade-delete chunks)
        db.execute(delete(DocumentSection).where(DocumentSection.input_id == inp.id))
        db.flush()

        section_rows: list[DocumentSection] = []
        for s in sections:
            row = DocumentSection(
                input_id=inp.id,
                kind=s.kind,
                order_index=s.order_index,
                ref=s.ref,
                text=s.text,
            )
            db.add(row)
            section_rows.append(row)
        db.flush()

        chunk_specs = chunk_sections(section_rows)
        for c in chunk_specs:
            db.add(
                Chunk(
                    section_id=c.section_id,
                    char_start=c.char_start,
                    char_end=c.char_end,
                    text=c.text,
                    tokens=c.tokens,
                )
            )

        inp.status = InputStatus.PARSED.value
        inp.raw_content = "\n\n".join(s.text for s in sections)[:20000]
        db.commit()

        return InputParseResult(
            input_id=inp.id,
            section_count=len(section_rows),
            chunk_count=len(chunk_specs),
            status=inp.status,
        )
    except Exception as e:
        db.rollback()
        retry = db.get(Input, input_id)
        if retry is not None:
            retry.status = InputStatus.FAILED.value
            db.commit()
        raise HTTPException(status_code=500, detail=f"Parse failed: {e}")
