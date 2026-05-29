"""SP-4: version control endpoints. A ProcessVersion is a full graph
snapshot; copy backs both Branch and Restore (non-destructive), and diff
compares two versions using node lineage ids stamped in properties."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import ProcessVersionStatus
from app.models.identity import User
from app.models.process import (
    EdgeClaimLink,
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
from app.schemas.process_map import ProcessVersionRead
from app.schemas.version import VersionCopyRequest, VersionSummaryRead

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


@router.post(
    "/process-maps/{model_id}/versions/{source_version_id}/copy",
    response_model=ProcessVersionRead,
)
def copy_version(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    source_version_id: UUID,
    payload: VersionCopyRequest,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> ProcessVersion:
    """Snapshot a source version into a brand-new version. Backs both
    Branch (source = current) and Restore (source = an older version).
    Non-destructive: the source is never modified; claim links are copied."""
    model = _model_or_404(db, model_id, project.id)
    source = _version_or_404(db, model, source_version_id)

    next_number = (
        db.scalar(
            select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
                ProcessVersion.model_id == model.id
            )
        )
        + 1
    )
    note = payload.note or f"Copied from v{source.version_number}"

    new_version = ProcessVersion(
        model_id=model.id,
        version_number=next_number,
        parent_version_id=source.id,
        status=ProcessVersionStatus.DRAFT.value,
        notes=note,
        bpmn_xml=source.bpmn_xml,
        created_by=user.id,
    )
    db.add(new_version)
    db.flush()

    # Lanes
    src_lanes = db.scalars(
        select(ProcessLane).where(ProcessLane.version_id == source.id)
    ).all()
    lane_map: dict[UUID, UUID] = {}
    for lane in src_lanes:
        new_lane = ProcessLane(
            version_id=new_version.id,
            name=lane.name,
            entity_id=lane.entity_id,
            order_index=lane.order_index,
            height_px=lane.height_px,
            color=lane.color,
            collapsed=lane.collapsed,
        )
        db.add(new_lane)
        db.flush()
        lane_map[lane.id] = new_lane.id

    # Nodes (seed/inherit lineage)
    src_nodes = db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == source.id)
    ).all()
    node_map: dict[UUID, UUID] = {}
    for node in src_nodes:
        props = dict(node.properties or {})
        props[LINEAGE_KEY] = props.get(LINEAGE_KEY) or str(node.id)
        new_node = ProcessNode(
            version_id=new_version.id,
            lane_id=lane_map.get(node.lane_id) if node.lane_id else None,
            type=node.type,
            name=node.name,
            position=dict(node.position or {}),
            properties=props,
        )
        db.add(new_node)
        db.flush()
        node_map[node.id] = new_node.id

    # Edges
    src_edges = db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == source.id)
    ).all()
    edge_map: dict[UUID, UUID] = {}
    for edge in src_edges:
        new_edge = ProcessEdge(
            version_id=new_version.id,
            source_node_id=node_map[edge.source_node_id],
            target_node_id=node_map[edge.target_node_id],
            label=edge.label,
            condition_text=edge.condition_text,
            condition_claim_id=edge.condition_claim_id,
            bend_x=edge.bend_x,
            bend_y=edge.bend_y,
        )
        db.add(new_edge)
        db.flush()
        edge_map[edge.id] = new_edge.id

    # Node claim links (provenance preserved)
    node_links = (
        db.scalars(
            select(NodeClaimLink).where(NodeClaimLink.node_id.in_(list(node_map.keys())))
        ).all()
        if node_map
        else []
    )
    for link in node_links:
        db.add(NodeClaimLink(
            node_id=node_map[link.node_id],
            claim_id=link.claim_id,
            link_kind=link.link_kind,
        ))

    # Edge claim links
    edge_links = (
        db.scalars(
            select(EdgeClaimLink).where(EdgeClaimLink.edge_id.in_(list(edge_map.keys())))
        ).all()
        if edge_map
        else []
    )
    for link in edge_links:
        db.add(EdgeClaimLink(
            edge_id=edge_map[link.edge_id],
            claim_id=link.claim_id,
            link_kind=link.link_kind,
        ))

    db.commit()
    db.refresh(new_version)
    return new_version
