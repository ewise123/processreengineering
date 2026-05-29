"""SP-3: stakeholder review endpoints. Reuses the Review model — per-node
decisions (target_type=process_node) plus one version-level request row."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import ProcessVersionStatus, ReviewStatus, ReviewTargetType
from app.models.identity import User
from app.models.process import ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.models.workflow import Review
from app.schemas.review import (
    NodeReviewRead,
    NodeReviewUpdate,
    ReviewCounts,
    ReviewStateRead,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["reviews"])


def _version_or_404(db: Session, model_id: UUID, version_id: UUID, project_id: UUID) -> ProcessVersion:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    return version


def _node_or_404(db: Session, node_id: UUID, project_id: UUID) -> ProcessNode:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    version = db.get(ProcessVersion, node.version_id)
    model = db.get(ProcessModel, version.model_id) if version else None
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


def _node_review(db: Session, node_id: UUID) -> Review | None:
    return db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == node_id,
        )
    ).first()


def _version_review(db: Session, version_id: UUID) -> Review | None:
    return db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_VERSION.value,
            Review.target_id == version_id,
        )
    ).first()


def _build_review_state(db: Session, version: ProcessVersion) -> ReviewStateRead:
    node_ids = list(
        db.scalars(select(ProcessNode.id).where(ProcessNode.version_id == version.id)).all()
    )
    total = len(node_ids)
    nodes: list[NodeReviewRead] = []
    approved = changes = 0
    if node_ids:
        rows = db.scalars(
            select(Review).where(
                Review.target_type == ReviewTargetType.PROCESS_NODE.value,
                Review.target_id.in_(node_ids),
            )
        ).all()
        for r in rows:
            nodes.append(NodeReviewRead(node_id=r.target_id, status=r.status, note=r.notes))
            if r.status == ReviewStatus.APPROVED.value:
                approved += 1
            elif r.status == ReviewStatus.CHANGES_REQUESTED.value:
                changes += 1
    vr = _version_review(db, version.id)
    return ReviewStateRead(
        version_id=version.id,
        version_status=version.status,
        request_status=vr.status if vr else None,
        nodes=nodes,
        counts=ReviewCounts(
            approved=approved,
            changes_requested=changes,
            pending=total - approved - changes,
            total=total,
        ),
    )


def _recompute_version_status(db: Session, version: ProcessVersion) -> None:
    node_ids = list(
        db.scalars(select(ProcessNode.id).where(ProcessNode.version_id == version.id)).all()
    )
    total = len(node_ids)
    approved = 0
    if node_ids:
        approved = db.scalar(
            select(func.count())
            .select_from(Review)
            .where(
                Review.target_type == ReviewTargetType.PROCESS_NODE.value,
                Review.target_id.in_(node_ids),
                Review.status == ReviewStatus.APPROVED.value,
            )
        ) or 0
    vr = _version_review(db, version.id)
    if total > 0 and approved == total and vr is not None:
        version.status = ProcessVersionStatus.APPROVED.value
        if vr is not None:
            vr.status = ReviewStatus.APPROVED.value
    elif vr is not None:
        version.status = ProcessVersionStatus.REVIEW.value
        vr.status = ReviewStatus.REQUESTED.value


@router.get(
    "/process-maps/{model_id}/versions/{version_id}/review",
    response_model=ReviewStateRead,
)
def get_review_state(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ReviewStateRead:
    version = _version_or_404(db, model_id, version_id, project.id)
    return _build_review_state(db, version)


@router.patch("/nodes/{node_id}/review", response_model=NodeReviewRead)
def set_node_review(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeReviewUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> NodeReviewRead:
    node = _node_or_404(db, node_id, project.id)
    review = _node_review(db, node_id)
    if review is None:
        review = Review(
            project_id=project.id,
            target_type=ReviewTargetType.PROCESS_NODE.value,
            target_id=node_id,
            requested_by=user.id,
            status=payload.status,
            notes=payload.note,
        )
        db.add(review)
    else:
        review.status = payload.status
        review.notes = payload.note
    db.flush()
    version = db.get(ProcessVersion, node.version_id)
    _recompute_version_status(db, version)
    db.commit()
    return NodeReviewRead(node_id=node_id, status=review.status, note=review.notes)


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/review/request",
    response_model=ReviewStateRead,
)
def request_review(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> ReviewStateRead:
    version = _version_or_404(db, model_id, version_id, project.id)
    vr = _version_review(db, version.id)
    if vr is None:
        vr = Review(
            project_id=project.id,
            target_type=ReviewTargetType.PROCESS_VERSION.value,
            target_id=version.id,
            requested_by=user.id,
            status=ReviewStatus.REQUESTED.value,
        )
        db.add(vr)
    else:
        vr.status = ReviewStatus.REQUESTED.value
    version.status = ProcessVersionStatus.REVIEW.value
    db.commit()
    db.refresh(version)
    return _build_review_state(db, version)
