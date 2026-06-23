"""Phase 2 — per-object history endpoints.

GET /projects/{project_id}/nodes/{node_id}/history  -> list[ChangeEventRead]
GET /projects/{project_id}/edges/{edge_id}/history  -> list[ChangeEventRead]
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.models.change_event import ChangeEvent
from app.models.process import ProcessEdge, ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.schemas.change_event import ChangeEventRead

router = APIRouter(prefix="/projects/{project_id}", tags=["change_log"])


def _node_project_id(node: ProcessNode, db: Session) -> UUID | None:
    """Return the project_id the node belongs to, or None if chain is broken."""
    version = db.get(ProcessVersion, node.version_id)
    if version is None:
        return None
    model = db.get(ProcessModel, version.model_id)
    if model is None:
        return None
    return model.project_id


def _edge_project_id(edge: ProcessEdge, db: Session) -> UUID | None:
    """Return the project_id the edge belongs to, or None if chain is broken."""
    version = db.get(ProcessVersion, edge.version_id)
    if version is None:
        return None
    model = db.get(ProcessModel, version.model_id)
    if model is None:
        return None
    return model.project_id


@router.get("/nodes/{node_id}/history", response_model=list[ChangeEventRead])
def get_node_history(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[ChangeEventRead]:
    """Return the ordered change history for a node (oldest → newest)."""
    node = db.get(ProcessNode, node_id)
    if node is None or _node_project_id(node, db) != project.id:
        raise HTTPException(status_code=404, detail="Node not found")

    events = list(
        db.scalars(
            select(ChangeEvent)
            .where(
                ChangeEvent.target_type == "node",
                ChangeEvent.target_id == node_id,
            )
            .order_by(ChangeEvent.created_at)
        ).all()
    )
    return [ChangeEventRead.from_event(ev) for ev in events]


@router.get("/edges/{edge_id}/history", response_model=list[ChangeEventRead])
def get_edge_history(
    project: Annotated[Project, Depends(get_project_or_404)],
    edge_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[ChangeEventRead]:
    """Return the ordered change history for an edge (oldest → newest)."""
    edge = db.get(ProcessEdge, edge_id)
    if edge is None or _edge_project_id(edge, db) != project.id:
        raise HTTPException(status_code=404, detail="Edge not found")

    events = list(
        db.scalars(
            select(ChangeEvent)
            .where(
                ChangeEvent.target_type == "edge",
                ChangeEvent.target_id == edge_id,
            )
            .order_by(ChangeEvent.created_at)
        ).all()
    )
    return [ChangeEventRead.from_event(ev) for ev in events]
