import json
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db.mixins import uuid7
from app.enums import ChangeActorKind, ChangeKind, ChangeSource, ChangeTargetType
from app.models.change_event import ChangeEvent
from app.models.process import ProcessVersion

NODE_SEMANTIC_FIELDS: dict[str, ChangeKind] = {
    "name": ChangeKind.RELABEL,
    "description": ChangeKind.DESCRIBE,
    "type": ChangeKind.RETYPE,
    "lane_id": ChangeKind.RELANE,
}

# The reason a change carries when the user chose to explain it later. An
# `explain` event pointing at it supplies the real reason.
PENDING_REASON = "Awaiting reason"

_KIND_PRIORITY = [
    ChangeKind.DELETE,
    ChangeKind.CREATE,
    ChangeKind.RETYPE,
    ChangeKind.RELANE,
    ChangeKind.RELABEL,
    ChangeKind.DESCRIBE,
    ChangeKind.SET_CONDITION,
    ChangeKind.RECONNECT,
    ChangeKind.CONNECT,
    ChangeKind.UNLINK_CLAIM,
    ChangeKind.LINK_CLAIM,
]


def pick_kind(kinds: set[ChangeKind]) -> ChangeKind:
    """Pick the most-semantic kind for a multi-field save (spec §5)."""
    for k in _KIND_PRIORITY:
        if k in kinds:
            return k
    raise ValueError("pick_kind requires at least one kind")


def model_id_for_version(db: Session, version_id: UUID) -> UUID:
    version = db.get(ProcessVersion, version_id)
    if version is None:
        raise ValueError(f"version {version_id} not found")
    return version.model_id


def _jsonable_claim_ids(ids) -> list[str] | None:
    if not ids:
        return None
    return [str(i) for i in ids]


def record_change(
    db: Session,
    *,
    target_type: str,
    target_id: UUID,
    model_id: UUID,
    version_id: UUID | None,
    kind: str,
    reason: str,
    actor_kind: str = ChangeActorKind.USER.value,
    actor_id: UUID | None = None,
    before: dict | None = None,
    after: dict | None = None,
    cited_claim_ids=None,
    reasoning_trace=None,
    source: str = ChangeSource.MANUAL.value,
    suggestion_id: UUID | None = None,
) -> ChangeEvent:
    """Append one change event INSIDE the caller's transaction. The caller is
    responsible for db.commit(). Never call this for cosmetic-only edits."""
    ev = ChangeEvent(
        target_type=target_type,
        target_id=target_id,
        model_id=model_id,
        version_id=version_id,
        actor_kind=actor_kind,
        actor_id=actor_id,
        kind=kind,
        reason=reason,
        before=before,
        after=after,
        cited_claim_ids=_jsonable_claim_ids(cited_claim_ids),
        reasoning_trace=reasoning_trace,
        source=source,
        suggestion_id=suggestion_id,
    )
    db.add(ev)
    db.flush()
    return ev


def backfill_origin_events(db: Session) -> int:
    """Insert one MIGRATION origin event per existing node/edge that has none.
    Reason is mined from the object's linked claims where present. Idempotent:
    each insert runs at once, so the NOT EXISTS guards see prior inserts
    within the same session. Returns rows inserted.

    Migration 0010 runs this, so it names only the columns 0010 created
    (`_origin_insert`). Going through the ORM model would also name columns
    added later (explains_id, 0014), which don't exist yet at 0010."""
    inserted = 0
    node_rows = db.execute(
        text(
            """
            SELECT n.id, n.version_id, v.model_id
            FROM process_nodes n
            JOIN process_versions v ON v.id = n.version_id
            WHERE NOT EXISTS (
                SELECT 1 FROM change_events ce
                WHERE ce.target_type = 'node' AND ce.target_id = n.id
            )
            """
        )
    ).all()
    for node_id, version_id, model_id in node_rows:
        reason, cited = _origin_reason_for(db, node_id, "node")
        _origin_insert(db, ChangeTargetType.NODE.value, node_id, model_id, version_id, reason, cited)
        inserted += 1

    edge_rows = db.execute(
        text(
            """
            SELECT e.id, e.version_id, v.model_id
            FROM process_edges e
            JOIN process_versions v ON v.id = e.version_id
            WHERE NOT EXISTS (
                SELECT 1 FROM change_events ce
                WHERE ce.target_type = 'edge' AND ce.target_id = e.id
            )
            """
        )
    ).all()
    for edge_id, version_id, model_id in edge_rows:
        reason, cited = _origin_reason_for(db, edge_id, "edge")
        _origin_insert(db, ChangeTargetType.EDGE.value, edge_id, model_id, version_id, reason, cited)
        inserted += 1
    return inserted


def _origin_insert(db: Session, target_type: str, target_id, model_id, version_id, reason, cited) -> None:
    """One origin event, naming only columns that exist from migration 0010 on."""
    db.execute(
        text(
            """
            INSERT INTO change_events
                (id, target_type, target_id, model_id, version_id, actor_kind, kind,
                 reason, cited_claim_ids, source)
            VALUES
                (:id, :target_type, :target_id, :model_id, :version_id, :actor_kind, :kind,
                 :reason, CAST(:cited AS JSONB), :source)
            """
        ),
        {
            "id": uuid7(),
            "target_type": target_type,
            "target_id": target_id,
            "model_id": model_id,
            "version_id": version_id,
            "actor_kind": ChangeActorKind.SYSTEM.value,
            "kind": ChangeKind.CREATE.value,
            "reason": reason,
            "cited": json.dumps(_jsonable_claim_ids(cited)) if cited else None,
            "source": ChangeSource.MIGRATION.value,
        },
    )


def _origin_reason_for(db: Session, target_id: UUID, kind: str) -> tuple[str, list]:
    link_table = "node_claim_links" if kind == "node" else "edge_claim_links"
    fk = "node_id" if kind == "node" else "edge_id"
    # link_table and fk are hardcoded constants (not user input) — safe to interpolate
    rows = db.execute(
        text(
            f"""
            SELECT c.id, c.subject
            FROM {link_table} l
            JOIN claims c ON c.id = l.claim_id
            WHERE l.{fk} = :tid
            ORDER BY l.created_at
            """
        ),
        {"tid": target_id},
    ).all()
    if not rows:
        return "Created before provenance tracking", []
    first_subject = rows[0][1]
    extra = f" (+{len(rows) - 1} more)" if len(rows) > 1 else ""
    return f"Originated from claim: '{first_subject}'{extra}", [r[0] for r in rows]
