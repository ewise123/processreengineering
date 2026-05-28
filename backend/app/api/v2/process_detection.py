"""Phase 4 endpoints: multi-process detection for a project."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import DetectionRunStatus
from app.models.claim import Claim
from app.models.identity import User
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
from app.models.project import Project
from app.schemas.process_detection import (
    AcceptDetectionRunResult,
    ClaimRef,
    DetectionRunDetail,
    DetectionRunListRow,
    DetectionRunRead,
    DetectProcessesRequest,
    ProcessSegmentRead,
    SegmentCreate,
    SegmentMergeRequest,
    SegmentMoveClaimRequest,
    SegmentUpdate,
)
from app.services.process_detection import run_detection

router = APIRouter(prefix="/projects/{project_id}", tags=["process_detection"])


def _segment_to_read(
    db: Session, seg: ProcessSegment, include_claims: bool = True
) -> ProcessSegmentRead:
    claims: list[ClaimRef] = []
    if include_claims:
        rows = db.execute(
            select(Claim.id, Claim.kind, Claim.subject)
            .join(ClaimSegmentMembership, ClaimSegmentMembership.claim_id == Claim.id)
            .where(ClaimSegmentMembership.segment_id == seg.id)
            .order_by(Claim.kind, Claim.created_at)
        ).all()
        claims = [ClaimRef(id=r[0], kind=r[1], subject=r[2]) for r in rows]
    return ProcessSegmentRead(
        id=seg.id,
        detection_run_id=seg.detection_run_id,
        name=seg.name,
        description=seg.description,
        order_index=seg.order_index,
        claim_count=seg.claim_count,
        confidence=seg.confidence,
        is_unassigned=seg.is_unassigned,
        claims=claims,
    )


def _run_detail(db: Session, run: DetectionRun) -> DetectionRunDetail:
    segs = list(
        db.scalars(
            select(ProcessSegment)
            .where(ProcessSegment.detection_run_id == run.id)
            .order_by(ProcessSegment.order_index)
        ).all()
    )
    regular = [_segment_to_read(db, s) for s in segs if not s.is_unassigned]
    unassigned = next((s for s in segs if s.is_unassigned), None)
    if unassigned is None:
        raise HTTPException(
            status_code=500,
            detail="Detection run is missing its unassigned segment.",
        )
    return DetectionRunDetail(
        id=run.id,
        project_id=run.project_id,
        status=run.status,
        claim_count_at_run=run.claim_count_at_run,
        model_used=run.model_used,
        reasoning_summary=run.reasoning_summary,
        created_at=run.created_at,
        segments=regular,
        unassigned_segment=_segment_to_read(db, unassigned),
    )


@router.post(
    "/detect-processes",
    response_model=DetectionRunDetail,
    status_code=status.HTTP_201_CREATED,
)
def detect_processes(
    payload: DetectProcessesRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DetectionRunDetail:
    try:
        run = run_detection(
            db=db,
            project_id=project.id,
            scope_input_ids=payload.scope_input_ids,
            created_by=user.id,
        )
    except RuntimeError as e:
        msg = str(e)
        if msg.startswith("Draft already exists"):
            raise HTTPException(status_code=409, detail=msg)
        if "no claims" in msg.lower() or "could not identify" in msg.lower() or "no distinct processes" in msg.lower():
            raise HTTPException(status_code=422, detail=msg)
        if "caps at" in msg:
            raise HTTPException(status_code=422, detail=msg)
        raise HTTPException(status_code=503, detail=msg)

    return _run_detail(db, run)


def _get_run_in_project(
    db: Session, project_id: UUID, run_id: UUID
) -> DetectionRun:
    run = db.get(DetectionRun, run_id)
    if run is None or run.project_id != project_id:
        raise HTTPException(status_code=404, detail="Detection run not found")
    return run


@router.get(
    "/detection-runs/{run_id}",
    response_model=DetectionRunDetail,
)
def get_detection_run(
    run_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> DetectionRunDetail:
    run = _get_run_in_project(db, project.id, run_id)
    return _run_detail(db, run)


@router.get(
    "/detection-runs",
    response_model=list[DetectionRunListRow],
)
def list_detection_runs(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DetectionRunListRow]:
    rows = db.execute(
        select(
            DetectionRun.id,
            DetectionRun.status,
            DetectionRun.claim_count_at_run,
            DetectionRun.created_at,
            func.count(ProcessSegment.id).filter(
                ProcessSegment.is_unassigned.is_(False)
            ).label("segment_count"),
        )
        .outerjoin(ProcessSegment, ProcessSegment.detection_run_id == DetectionRun.id)
        .where(DetectionRun.project_id == project.id)
        .group_by(DetectionRun.id)
        .order_by(DetectionRun.created_at.desc())
    ).all()
    return [
        DetectionRunListRow(
            id=r[0],
            status=r[1],
            claim_count_at_run=r[2],
            segment_count=int(r[4] or 0),
            created_at=r[3],
        )
        for r in rows
    ]
