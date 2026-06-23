"""Phase 2 — per-object history endpoints.
Phase 3 (Task 19) — model-wide log endpoint with filters + cursor pagination.

GET /projects/{project_id}/nodes/{node_id}/history   -> list[ChangeEventRead]
GET /projects/{project_id}/edges/{edge_id}/history   -> list[ChangeEventRead]
GET /projects/{project_id}/models/{model_id}/log     -> ChangeLogPage
"""
import base64
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.models.change_event import ChangeEvent
from app.models.process import ProcessEdge, ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.schemas.change_event import ChangeEventRead, ChangeLogPage

router = APIRouter(prefix="/projects/{project_id}", tags=["change_log"])

# ---------------------------------------------------------------------------
# Cursor helpers
# ---------------------------------------------------------------------------

_CURSOR_SEP = "|"


def _encode_cursor(created_at: datetime, event_id: UUID) -> str:
    """Encode (created_at, id) into an opaque base64 token."""
    raw = f"{created_at.isoformat()}{_CURSOR_SEP}{event_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID] | None:
    """Decode the cursor token. Returns None if malformed."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_str, id_str = raw.rsplit(_CURSOR_SEP, 1)
        ts = datetime.fromisoformat(ts_str)
        uid = UUID(id_str)
        return ts, uid
    except Exception:
        return None


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


@router.get("/models/{model_id}/log", response_model=ChangeLogPage)
def get_model_log(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    target_id: Annotated[UUID | None, Query()] = None,
    actor_kind: Annotated[str | None, Query()] = None,
    source: Annotated[str | None, Query()] = None,
    since: Annotated[datetime | None, Query()] = None,
    cursor: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query()] = 50,
) -> ChangeLogPage:
    """Return the model-wide change log, newest-first, with optional filters
    and keyset cursor pagination.
    """
    # Ownership check
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Model not found")

    # Clamp limit
    limit = max(1, min(limit, 200))

    # Base query — model-scoped, reverse-chronological
    stmt = (
        select(ChangeEvent)
        .where(ChangeEvent.model_id == model_id)
        .order_by(ChangeEvent.created_at.desc(), ChangeEvent.id.desc())
    )

    # Optional filters
    if target_id is not None:
        stmt = stmt.where(ChangeEvent.target_id == target_id)
    if actor_kind is not None:
        stmt = stmt.where(ChangeEvent.actor_kind == actor_kind)
    if source is not None:
        stmt = stmt.where(ChangeEvent.source == source)
    if since is not None:
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        stmt = stmt.where(ChangeEvent.created_at >= since)

    # Cursor-based keyset pagination (desc order: next page has smaller values)
    if cursor is not None:
        decoded = _decode_cursor(cursor)
        if decoded is None:
            raise HTTPException(status_code=422, detail="Invalid cursor")
        c_ts, c_id = decoded
        # Keyset predicate: strictly before (c_ts, c_id) in desc ordering.
        # In descending order: (created_at, id) < (c_ts, c_id) means:
        #   created_at < c_ts  OR  (created_at == c_ts AND id < c_id)
        stmt = stmt.where(
            or_(
                ChangeEvent.created_at < c_ts,
                (ChangeEvent.created_at == c_ts) & (ChangeEvent.id < c_id),
            )
        )

    # Fetch one extra to detect whether there's a next page
    rows = list(db.scalars(stmt.limit(limit + 1)).all())

    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor: str | None = _encode_cursor(last.created_at, last.id)
    else:
        next_cursor = None

    return ChangeLogPage(
        items=[ChangeEventRead.from_event(ev) for ev in rows],
        next_cursor=next_cursor,
    )
