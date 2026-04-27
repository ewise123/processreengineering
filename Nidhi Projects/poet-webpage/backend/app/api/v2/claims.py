from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.enums import ConflictStatus
from app.models.claim import Claim, ClaimCitation, ClaimConflict
from app.models.input import Chunk, DocumentSection, Input
from app.models.project import Project
from app.schemas.claim import (
    ClaimConflictRead,
    ClaimExtractionResult,
    ClaimRead,
    ConflictDetectionResult,
)
from app.schemas.common import Page
from app.services.claims_extraction import extract_claims_from_text
from app.services.conflict_detection import detect_conflicts

router = APIRouter(prefix="/projects/{project_id}", tags=["claims"])


@router.post(
    "/inputs/{input_id}/extract-claims", response_model=ClaimExtractionResult
)
def extract_input_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    input_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimExtractionResult:
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
        return ClaimExtractionResult(
            input_id=input_id, claim_count=0, citation_count=0
        )

    # Wipe any prior claims linked to this input via citations
    chunk_ids = [c.id for c in chunks]
    prior_claim_ids = list(
        db.scalars(
            select(ClaimCitation.claim_id)
            .where(ClaimCitation.chunk_id.in_(chunk_ids))
            .distinct()
        ).all()
    )
    if prior_claim_ids:
        db.execute(delete(Claim).where(Claim.id.in_(prior_claim_ids)))
        db.flush()

    claim_count = 0
    citation_count = 0
    for chunk in chunks:
        try:
            extracted = extract_claims_from_text(chunk.text)
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        for ec in extracted:
            claim = Claim(
                project_id=project.id,
                kind=ec.kind,
                subject=ec.subject,
                normalized=ec.normalized,
                confidence=ec.confidence,
            )
            db.add(claim)
            db.flush()
            db.add(
                ClaimCitation(
                    claim_id=claim.id,
                    chunk_id=chunk.id,
                    quote=ec.quote,
                    confidence=ec.confidence,
                )
            )
            claim_count += 1
            citation_count += 1
    db.commit()
    return ClaimExtractionResult(
        input_id=input_id, claim_count=claim_count, citation_count=citation_count
    )


@router.get("/claims", response_model=Page[ClaimRead])
def list_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
    kind: str | None = Query(default=None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Page[ClaimRead]:
    base = select(Claim).where(Claim.project_id == project.id)
    if kind is not None:
        base = base.where(Claim.kind == kind)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    items = db.scalars(
        base.order_by(Claim.created_at.desc()).limit(limit).offset(offset)
    ).all()
    return Page[ClaimRead](
        items=[ClaimRead.model_validate(c) for c in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/detect-conflicts", response_model=ConflictDetectionResult)
def run_conflict_detection(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ConflictDetectionResult:
    claims = list(
        db.scalars(
            select(Claim)
            .where(Claim.project_id == project.id)
            .order_by(Claim.kind, Claim.created_at)
        ).all()
    )
    if len(claims) < 2:
        return ConflictDetectionResult(
            project_id=project.id, claim_count=len(claims), new_conflict_count=0
        )

    summaries = [f"{c.kind}: {c.subject}" for c in claims]

    try:
        detected = detect_conflicts(summaries)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    new_count = 0
    for d in detected:
        if not (0 <= d.claim_a_index < len(claims)):
            continue
        if not (0 <= d.claim_b_index < len(claims)):
            continue
        a = claims[d.claim_a_index]
        b = claims[d.claim_b_index]
        if a.id == b.id:
            continue
        existing = db.scalar(
            select(func.count(ClaimConflict.id)).where(
                or_(
                    (ClaimConflict.claim_a_id == a.id)
                    & (ClaimConflict.claim_b_id == b.id),
                    (ClaimConflict.claim_a_id == b.id)
                    & (ClaimConflict.claim_b_id == a.id),
                )
            )
        )
        if existing:
            continue
        db.add(
            ClaimConflict(
                claim_a_id=a.id,
                claim_b_id=b.id,
                kind=d.kind,
                detected_by="ai",
                resolution_status=ConflictStatus.DETECTED.value,
                resolution_notes=d.reason,
            )
        )
        new_count += 1
    db.commit()
    return ConflictDetectionResult(
        project_id=project.id, claim_count=len(claims), new_conflict_count=new_count
    )


@router.get("/conflicts", response_model=Page[ClaimConflictRead])
def list_conflicts(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
    resolution_status: str | None = Query(default=None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Page[ClaimConflictRead]:
    base = (
        select(ClaimConflict)
        .join(Claim, ClaimConflict.claim_a_id == Claim.id)
        .where(Claim.project_id == project.id)
    )
    if resolution_status is not None:
        base = base.where(ClaimConflict.resolution_status == resolution_status)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    items = db.scalars(
        base.order_by(ClaimConflict.created_at.desc()).limit(limit).offset(offset)
    ).all()
    return Page[ClaimConflictRead](
        items=[ClaimConflictRead.model_validate(c) for c in items],
        total=total,
        limit=limit,
        offset=offset,
    )
