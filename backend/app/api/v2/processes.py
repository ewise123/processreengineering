"""SP-7b: durable Process Inventory, claim curation, and the AI suggestion
inbox. Replaces the deleted process_detection router."""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import AssignedBy, ProcessStatus
from app.models.claim import Claim
from app.models.identity import User
from app.models.process import ProcessModel
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project
from app.schemas.process import (
    BulkAssignResult,
    BulkUnassignResult,
    ClaimIdList,
    ClaimRef,
    ProcessCreate,
    ProcessRead,
    ProcessUpdate,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["processes"])


def _get_process_in_project(db: Session, project_id: UUID, process_id: UUID) -> Process:
    proc = db.get(Process, process_id)
    if proc is None or proc.project_id != project_id or proc.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process not found")
    return proc


def _process_to_read(db: Session, proc: Process) -> ProcessRead:
    claim_count = db.scalar(
        select(func.count(ProcessClaimLink.id)).where(
            ProcessClaimLink.process_id == proc.id
        )
    ) or 0
    map_count = db.scalar(
        select(func.count(ProcessModel.id)).where(
            ProcessModel.process_id == proc.id,
            ProcessModel.deleted_at.is_(None),
        )
    ) or 0
    return ProcessRead(
        id=proc.id,
        project_id=proc.project_id,
        name=proc.name,
        description=proc.description,
        order_index=proc.order_index,
        status=proc.status,
        created_at=proc.created_at,
        updated_at=proc.updated_at,
        claim_count=int(claim_count),
        map_count=int(map_count),
    )


@router.get("/processes", response_model=list[ProcessRead])
def list_processes(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ProcessRead]:
    procs = list(
        db.scalars(
            select(Process)
            .where(Process.project_id == project.id, Process.deleted_at.is_(None))
            .order_by(Process.order_index, Process.created_at)
        ).all()
    )
    return [_process_to_read(db, p) for p in procs]


@router.post("/processes", response_model=ProcessRead, status_code=status.HTTP_201_CREATED)
def create_process(
    payload: ProcessCreate,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessRead:
    max_index = db.scalar(
        select(func.coalesce(func.max(Process.order_index), -1)).where(
            Process.project_id == project.id, Process.deleted_at.is_(None)
        )
    )
    proc = Process(
        project_id=project.id,
        name=payload.name.strip(),
        description=payload.description,
        order_index=(max_index if max_index is not None else -1) + 1,
        status=ProcessStatus.ACTIVE.value,
        created_by=user.id,
    )
    db.add(proc)
    db.commit()
    db.refresh(proc)
    return _process_to_read(db, proc)


@router.patch("/processes/{process_id}", response_model=ProcessRead)
def update_process(
    process_id: UUID,
    payload: ProcessUpdate,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessRead:
    proc = _get_process_in_project(db, project.id, process_id)
    if payload.name is not None:
        proc.name = payload.name.strip()
    if payload.description is not None:
        proc.description = payload.description
    if payload.order_index is not None:
        proc.order_index = payload.order_index
    if payload.status is not None:
        proc.status = payload.status
    db.commit()
    db.refresh(proc)
    return _process_to_read(db, proc)


@router.delete("/processes/{process_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_process(
    process_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    proc = _get_process_in_project(db, project.id, process_id)
    proc.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.post("/processes/{process_id}/claims", response_model=BulkAssignResult)
def assign_claims(
    process_id: UUID,
    payload: ClaimIdList,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BulkAssignResult:
    proc = _get_process_in_project(db, project.id, process_id)
    # Only assign claims that genuinely belong to this project.
    valid_ids = set(
        db.scalars(
            select(Claim.id).where(
                Claim.id.in_(payload.claim_ids), Claim.project_id == project.id
            )
        ).all()
    )
    existing = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == proc.id,
                ProcessClaimLink.claim_id.in_(valid_ids),
            )
        ).all()
    )
    linked = 0
    for cid in valid_ids - existing:
        db.add(
            ProcessClaimLink(
                process_id=proc.id, claim_id=cid, assigned_by=AssignedBy.USER.value
            )
        )
        linked += 1
    db.commit()
    return BulkAssignResult(
        process_id=proc.id, linked=linked, already_linked=len(existing)
    )


@router.delete("/processes/{process_id}/claims", response_model=BulkUnassignResult)
def unassign_claims(
    process_id: UUID,
    payload: ClaimIdList,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BulkUnassignResult:
    proc = _get_process_in_project(db, project.id, process_id)
    links = list(
        db.scalars(
            select(ProcessClaimLink).where(
                ProcessClaimLink.process_id == proc.id,
                ProcessClaimLink.claim_id.in_(payload.claim_ids),
            )
        ).all()
    )
    for link in links:
        db.delete(link)
    db.commit()
    return BulkUnassignResult(process_id=proc.id, removed=len(links))


@router.get("/claims/unassigned", response_model=list[ClaimRef])
def list_unassigned_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ClaimRef]:
    """Triage view: claims with zero process_claim_links. Left-join + IS NULL."""
    rows = db.execute(
        select(Claim.id, Claim.kind, Claim.subject, Claim.source)
        .outerjoin(ProcessClaimLink, ProcessClaimLink.claim_id == Claim.id)
        .where(
            Claim.project_id == project.id,
            ProcessClaimLink.id.is_(None),
        )
        .order_by(Claim.kind, Claim.created_at)
    ).all()
    return [ClaimRef(id=r[0], kind=r[1], subject=r[2], source=r[3]) for r in rows]
