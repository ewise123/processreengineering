"""SP-4: version control endpoints. A ProcessVersion is a full graph
snapshot; copy backs both Branch and Restore (non-destructive), and diff
compares two versions using node lineage ids stamped in properties."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.models.process import (
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
from app.schemas.version import VersionSummaryRead

LINEAGE_KEY = "_lineage_id"

router = APIRouter(prefix="/projects/{project_id}", tags=["versions"])


def _model_or_404(db: Session, model_id: UUID, project_id: UUID) -> ProcessModel:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Process model not found")
    return model


def _version_or_404(db: Session, model: ProcessModel, version_id: UUID) -> ProcessVersion:
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    return version


def _counts(db: Session, version_ids: list[UUID], table) -> dict[UUID, int]:
    """Return {version_id: count} for `table` grouped by its version_id.
    `table` is ProcessNode / ProcessLane / ProcessEdge — each has version_id."""
    if not version_ids:
        return {}
    col = table.version_id
    rows = db.execute(
        select(col, func.count()).where(col.in_(version_ids)).group_by(col)
    ).all()
    return {vid: n for vid, n in rows}


@router.get(
    "/process-maps/{model_id}/versions",
    response_model=list[VersionSummaryRead],
)
def list_versions(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[VersionSummaryRead]:
    model = _model_or_404(db, model_id, project.id)
    versions = list(
        db.scalars(
            select(ProcessVersion)
            .where(ProcessVersion.model_id == model.id)
            .order_by(ProcessVersion.version_number)
        ).all()
    )
    ids = [v.id for v in versions]
    node_counts = _counts(db, ids, ProcessNode)
    lane_counts = _counts(db, ids, ProcessLane)
    edge_counts = _counts(db, ids, ProcessEdge)
    return [
        VersionSummaryRead(
            id=v.id,
            version_number=v.version_number,
            parent_version_id=v.parent_version_id,
            status=v.status,
            notes=v.notes,
            created_at=v.created_at,
            node_count=node_counts.get(v.id, 0),
            lane_count=lane_counts.get(v.id, 0),
            edge_count=edge_counts.get(v.id, 0),
        )
        for v in versions
    ]
