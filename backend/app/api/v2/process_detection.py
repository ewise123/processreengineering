"""Phase 4 endpoints: multi-process detection for a project."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update as sql_update
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


def _get_draft_segment(
    db: Session, project_id: UUID, segment_id: UUID
) -> ProcessSegment:
    """Load a segment, enforce project scoping, draft-only mutation, and
    reject mutations on the Unassigned segment."""
    seg = db.get(ProcessSegment, segment_id)
    if seg is None or seg.project_id != project_id:
        raise HTTPException(status_code=404, detail="Segment not found")
    run = db.get(DetectionRun, seg.detection_run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if run.status != DetectionRunStatus.DRAFT.value:
        raise HTTPException(
            status_code=409, detail="Segment's run is not a draft."
        )
    if seg.is_unassigned:
        raise HTTPException(
            status_code=409,
            detail="The Unassigned segment cannot be renamed, deleted, or merged.",
        )
    return seg


@router.post(
    "/detection-runs/{run_id}/segments",
    response_model=ProcessSegmentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_segment(
    run_id: UUID,
    payload: SegmentCreate,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessSegmentRead:
    run = _get_run_in_project(db, project.id, run_id)
    if run.status != DetectionRunStatus.DRAFT.value:
        raise HTTPException(
            status_code=409, detail="Run is not a draft."
        )
    max_index = db.scalar(
        select(func.coalesce(func.max(ProcessSegment.order_index), 0)).where(
            ProcessSegment.detection_run_id == run.id,
            ProcessSegment.is_unassigned.is_(False),
        )
    ) or 0
    seg = ProcessSegment(
        detection_run_id=run.id,
        project_id=project.id,
        name=payload.name.strip(),
        description="",
        order_index=max_index + 1,
        claim_count=0,
        confidence=None,
        is_unassigned=False,
    )
    db.add(seg)
    db.commit()
    db.refresh(seg)
    return _segment_to_read(db, seg)


@router.patch(
    "/segments/{segment_id}",
    response_model=ProcessSegmentRead,
)
def update_segment(
    segment_id: UUID,
    payload: SegmentUpdate,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessSegmentRead:
    seg = _get_draft_segment(db, project.id, segment_id)
    if payload.name is not None:
        seg.name = payload.name.strip()
    if payload.description is not None:
        seg.description = payload.description
    db.commit()
    db.refresh(seg)
    return _segment_to_read(db, seg)


@router.post(
    "/segments/{segment_id}/merge",
    response_model=ProcessSegmentRead,
)
def merge_segment(
    segment_id: UUID,
    payload: SegmentMergeRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessSegmentRead:
    source = _get_draft_segment(db, project.id, segment_id)
    target = _get_draft_segment(db, project.id, payload.into_segment_id)
    if source.id == target.id:
        raise HTTPException(
            status_code=422, detail="Cannot merge a segment into itself"
        )
    if source.detection_run_id != target.detection_run_id:
        raise HTTPException(
            status_code=422,
            detail="Cannot merge segments from different detection runs",
        )

    db.execute(
        sql_update(ClaimSegmentMembership)
        .where(ClaimSegmentMembership.segment_id == source.id)
        .values(segment_id=target.id)
    )
    target.claim_count = target.claim_count + source.claim_count
    db.delete(source)
    db.commit()
    db.refresh(target)
    return _segment_to_read(db, target)


@router.delete(
    "/segments/{segment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_segment(
    segment_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    seg = _get_draft_segment(db, project.id, segment_id)
    unassigned = db.scalars(
        select(ProcessSegment).where(
            ProcessSegment.detection_run_id == seg.detection_run_id,
            ProcessSegment.is_unassigned.is_(True),
        ).limit(1)
    ).first()
    if unassigned is None:
        raise HTTPException(
            status_code=500, detail="Run has no Unassigned segment"
        )
    moved = seg.claim_count
    db.execute(
        sql_update(ClaimSegmentMembership)
        .where(ClaimSegmentMembership.segment_id == seg.id)
        .values(segment_id=unassigned.id)
    )
    unassigned.claim_count = unassigned.claim_count + moved
    db.delete(seg)
    db.commit()


@router.post(
    "/segments/{segment_id}/claims",
    response_model=ProcessSegmentRead,
)
def move_claim_to_segment(
    segment_id: UUID,
    payload: SegmentMoveClaimRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessSegmentRead:
    target = db.get(ProcessSegment, segment_id)
    if target is None or target.project_id != project.id:
        raise HTTPException(status_code=404, detail="Segment not found")
    run = db.get(DetectionRun, target.detection_run_id)
    if run is None or run.status != DetectionRunStatus.DRAFT.value:
        raise HTTPException(
            status_code=409, detail="Segment's run is not a draft."
        )

    membership = db.scalars(
        select(ClaimSegmentMembership).where(
            ClaimSegmentMembership.claim_id == payload.claim_id,
            ClaimSegmentMembership.detection_run_id == run.id,
        ).limit(1)
    ).first()
    if membership is None:
        raise HTTPException(
            status_code=422,
            detail="That claim is not part of this detection run.",
        )
    if membership.segment_id == target.id:
        return _segment_to_read(db, target)

    old_segment = db.get(ProcessSegment, membership.segment_id)
    if old_segment is not None:
        old_segment.claim_count = max(0, old_segment.claim_count - 1)
    membership.segment_id = target.id
    target.claim_count = target.claim_count + 1
    db.commit()
    db.refresh(target)
    return _segment_to_read(db, target)


@router.delete(
    "/detection-runs/{run_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def discard_detection_run(
    run_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Archive a draft detection run. Accepted or already-archived runs cannot
    be discarded (409). The run remains in the DB for audit, just with
    status=archived; segments and memberships are kept untouched."""
    run = _get_run_in_project(db, project.id, run_id)
    # Refresh to get the latest committed status — guarding against a shared
    # session (expire_on_commit=False) returning a stale cached instance.
    db.refresh(run)
    if run.status != DetectionRunStatus.DRAFT.value:
        raise HTTPException(
            status_code=409,
            detail="Only draft runs can be discarded.",
        )
    run.status = DetectionRunStatus.ARCHIVED.value
    db.commit()


@router.post(
    "/detection-runs/{run_id}/accept",
    response_model=AcceptDetectionRunResult,
)
def accept_detection_run(
    run_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> AcceptDetectionRunResult:
    run = _get_run_in_project(db, project.id, run_id)
    if run.status != DetectionRunStatus.DRAFT.value:
        raise HTTPException(
            status_code=409, detail="Only draft runs can be accepted."
        )

    segs = list(
        db.scalars(
            select(ProcessSegment).where(
                ProcessSegment.detection_run_id == run.id,
                ProcessSegment.is_unassigned.is_(False),
            )
        ).all()
    )
    bad_ids = [str(s.id) for s in segs if not (s.name and s.name.strip())]
    if bad_ids:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Every regular segment must have a non-blank name.",
                "segment_ids": bad_ids,
            },
        )
    seen: dict[str, list[str]] = {}
    for s in segs:
        seen.setdefault(s.name.strip().casefold(), []).append(str(s.id))
    dup = {k: v for k, v in seen.items() if len(v) > 1}
    if dup:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Segment names must be unique (case-insensitive).",
                "duplicates": dup,
            },
        )

    # Supersede any prior accepted run for the same project.
    prior = list(
        db.scalars(
            select(DetectionRun).where(
                DetectionRun.project_id == project.id,
                DetectionRun.status == DetectionRunStatus.ACCEPTED.value,
                DetectionRun.id != run.id,
            )
        ).all()
    )
    for p in prior:
        p.status = DetectionRunStatus.SUPERSEDED.value

    run.status = DetectionRunStatus.ACCEPTED.value
    db.commit()
    return AcceptDetectionRunResult(
        run_id=run.id, accepted_segment_count=len(segs)
    )
