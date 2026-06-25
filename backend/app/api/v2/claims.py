from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.enums import ConflictStatus, InputStatus
from app.models.claim import Claim, ClaimCitation, ClaimConflict
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import NodeClaimLink, ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.schemas.claim import (
    ClaimConflictRead,
    ClaimCreate,
    ClaimExtractionResult,
    ClaimImpact,
    ClaimImpactMap,
    ClaimRead,
    ClaimUpdate,
    ConflictDetectionResult,
    ConflictResolve,
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

    # Wipe any prior claims for this input via citations. Committed eagerly
    # so the failure path doesn't resurrect the old claims.
    chunk_ids = [c.id for c in chunks]
    prior_claim_ids = list(
        db.scalars(
            select(ClaimCitation.claim_id)
            .where(ClaimCitation.chunk_id.in_(chunk_ids))
            .distinct()
        ).all()
    )
    if prior_claim_ids:
        # Only wipe claims this extractor produced — manual claims that happen
        # to cite the same chunk must survive a re-extraction.
        db.execute(
            delete(Claim).where(
                Claim.id.in_(prior_claim_ids),
                Claim.source == "extracted",
            )
        )
    inp.status = InputStatus.EXTRACTING.value
    inp.chunks_total = len(chunks)
    inp.chunks_processed = 0
    inp.extraction_started_at = datetime.now(timezone.utc)
    inp.extraction_error = None
    db.commit()

    claim_count = 0
    citation_count = 0
    try:
        for chunk in chunks:
            extracted = extract_claims_from_text(chunk.text)
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
            inp.chunks_processed += 1
            db.commit()
    except RuntimeError as e:
        # Anthropic key missing or similar service error → 503
        db.rollback()
        inp_refresh = db.get(Input, input_id)
        if inp_refresh is not None:
            inp_refresh.status = InputStatus.FAILED.value
            inp_refresh.extraction_error = str(e)
            db.commit()
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        db.rollback()
        inp_refresh = db.get(Input, input_id)
        if inp_refresh is not None:
            inp_refresh.status = InputStatus.FAILED.value
            inp_refresh.extraction_error = str(e)
            db.commit()
        raise HTTPException(status_code=500, detail=f"Extraction failed: {e}")

    inp.status = InputStatus.PARSED.value
    inp.extraction_error = None
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


@router.post(
    "/claims", response_model=ClaimRead, status_code=status.HTTP_201_CREATED
)
def create_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    payload: ClaimCreate,
    db: Annotated[Session, Depends(get_db)],
) -> Claim:
    """Create a manual claim. No citation required; source is 'manual' so the
    extraction wipe never deletes it."""
    claim = Claim(
        project_id=project.id,
        kind=payload.kind,
        subject=payload.subject,
        normalized=payload.normalized,
        confidence=None,
        source="manual",
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return claim


def _get_project_claim_or_404(claim_id: UUID, project: Project, db: Session) -> Claim:
    claim = db.get(Claim, claim_id)
    if claim is None or claim.project_id != project.id:
        raise HTTPException(status_code=404, detail="Claim not found")
    return claim


@router.patch("/claims/{claim_id}", response_model=ClaimRead)
def update_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    payload: ClaimUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> Claim:
    claim = _get_project_claim_or_404(claim_id, project, db)
    if payload.kind is not None:
        claim.kind = payload.kind
    if payload.subject is not None:
        claim.subject = payload.subject
    if payload.normalized is not None:
        claim.normalized = payload.normalized
    db.commit()
    db.refresh(claim)
    return claim


@router.get("/claims/{claim_id}/impact", response_model=ClaimImpact)
def get_claim_impact(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimImpact:
    """Which process maps would have node evidence emptied if this claim were
    deleted. Drives the frontend delete-confirm dialog."""
    claim = _get_project_claim_or_404(claim_id, project, db)
    rows = list(
        db.execute(
            select(ProcessModel.id, ProcessModel.name)
            .join(ProcessVersion, ProcessVersion.model_id == ProcessModel.id)
            .join(ProcessNode, ProcessNode.version_id == ProcessVersion.id)
            .join(NodeClaimLink, NodeClaimLink.node_id == ProcessNode.id)
            .where(
                NodeClaimLink.claim_id == claim.id,
                ProcessModel.project_id == project.id,
                ProcessModel.deleted_at.is_(None),
            )
            .distinct()
        ).all()
    )
    link_count = (
        db.scalar(
            select(func.count(NodeClaimLink.id)).where(
                NodeClaimLink.claim_id == claim.id
            )
        )
        or 0
    )
    return ClaimImpact(
        claim_id=claim.id,
        node_link_count=link_count,
        maps=[ClaimImpactMap(model_id=r[0], name=r[1]) for r in rows],
    )


@router.delete("/claims/{claim_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    claim = _get_project_claim_or_404(claim_id, project, db)
    db.delete(claim)
    db.commit()


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
                detection_reason=d.reason,
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


@router.patch(
    "/conflicts/{conflict_id}", response_model=ClaimConflictRead
)
def resolve_conflict(
    project: Annotated[Project, Depends(get_project_or_404)],
    conflict_id: UUID,
    payload: ConflictResolve,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimConflict:
    conflict = db.get(ClaimConflict, conflict_id)
    if conflict is None:
        raise HTTPException(status_code=404, detail="Conflict not found")
    # Project scope: claim_a must belong to this project.
    claim_a = db.get(Claim, conflict.claim_a_id)
    if claim_a is None or claim_a.project_id != project.id:
        raise HTTPException(status_code=404, detail="Conflict not found")
    conflict.resolution_status = payload.resolution_status
    if "resolution_notes" in payload.model_fields_set:
        conflict.resolution_notes = payload.resolution_notes
    db.commit()
    db.refresh(conflict)
    return conflict
