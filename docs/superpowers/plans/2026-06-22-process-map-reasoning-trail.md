# Process-map reasoning trail, change log & best-practices seeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every process-map node and edge a durable, per-object reasoning trail, surface it as both an in-context history panel and a model-wide change-log tab, and seed maps from best-practice knowledge with provenance from the first node.

**Architecture:** One append-only `change_event` table is the single source of truth. A `record_change(...)` helper, called inside every mutating endpoint within the caller's transaction, writes one event per semantic change. Cosmetic edits are never logged. Reads power a per-object history endpoint and a model-wide log feed. Best-practices generation and additive re-ingest ride on the existing generation + reconcile machinery, emitting events like any other change.

**Tech Stack:** Backend — FastAPI, SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Alembic, Postgres, pytest. Frontend — Next.js (App Router), React, TanStack Query, custom SVG canvas, Vitest, `tsc`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-22-process-map-reasoning-trail-design.md` — this plan implements it section-for-section.
- **No auth work.** `actor_id` stays NULL for now; the human/AI/system distinction lives in `actor_kind`. Nothing touches identity/OAuth/roles.
- **Out of scope:** chat-as-editor (item 3, Emory's), comments + triage (item 4), reviewer assignment, client view.
- **Alembic revision ids ≤ 32 chars** (version_num is VARCHAR(32)). Filenames may be longer.
- **Dev DB after a migration:** run `cd backend && .venv/bin/alembic upgrade head` against the dev `poet` DB or the hot-reloading backend 500s. Tests run their own `alembic upgrade head` against `poet_test` (see `backend/tests/conftest.py`); the test Postgres is on `localhost:5433` and needs Docker Desktop up.
- **Backend test invocation:** `cd backend && .venv/bin/pytest <path> -v`. Tests call endpoint functions directly (not over HTTP), passing `project=`, `db=`, and pydantic payloads; LLM calls are patched via `_get_client` / the service function.
- **Append-only:** `change_event` rows are never updated or deleted.
- **Frontend gates:** `npx tsc --noEmit` and `npx vitest run` must pass. `npm run lint` is advisory, not a gate.
- **Cosmetic fields, never logged:** node `position` (`x`/`relative_y`); edge `bend_x`/`bend_y`; lane `order_index`/`height_px`/`color`/`collapsed`. They still persist as today.
- **Kind priority (most→least semantic), for multi-field saves:** `delete` > `create` > `retype` > `relane` > `relabel` > `describe` > `reconnect` > `connect` > `unlink_claim` > `link_claim`.

---

## File Structure

**Backend — create**
- `backend/app/models/change_event.py` — the `ChangeEvent` model.
- `backend/app/services/change_log.py` — `record_change`, the semantic/cosmetic classification helpers, `pick_kind`, `model_id_for_version`, and `backfill_origin_events`.
- `backend/app/schemas/change_event.py` — `ChangeEventRead`, `ChangeLogPage`.
- `backend/app/api/v2/change_log.py` — the history + log read endpoints (new router).
- `backend/alembic/versions/0010_change_event.py` — table, indexes, backfill, drop `audit_events`/`ai_interactions`.
- `backend/tests/test_change_log_service.py`, `test_change_event_capture.py`, `test_change_event_migration.py`, `test_change_log_api.py`, `test_best_practices_seed.py`.

**Backend — modify**
- `backend/app/enums.py` — add `ChangeTargetType`, `ChangeActorKind`, `ChangeKind`, `ChangeSource`; extend nothing else.
- `backend/app/models/__init__.py` — register `ChangeEvent`; drop `AuditEvent`/`AiInteraction` exports.
- `backend/app/models/audit.py` — remove `AuditEvent` + `AiInteraction` classes (keep `GenerationJob`).
- `backend/app/schemas/process_map.py` — add `reason` to `NodeUpdate`, `EdgeUpdate`, `LaneUpdate`.
- `backend/app/api/v2/process_maps.py` — wire `record_change` into create/update/delete of nodes/edges/lanes, claim attach/detach, `apply_proposed_step`, and the generation path; add the best-practices seed endpoint.
- `backend/app/api/v2/processes.py` — wire `record_change` into `apply_suggestion` reconcile ops.
- `backend/app/api/v2/versions.py` — wire branch/restore event into `copy_version`.
- `backend/app/main.py` (or wherever routers are included) — include the new `change_log` router.

**Frontend — modify**
- `src/lib/types.ts` — `reason?` on `NodeUpdate`/`EdgeUpdate`/`LaneUpdate`; add `ChangeEvent`, `ChangeLogPage`, `ChangeActorKind`, `ChangeKind`, `ChangeSource`.
- `src/lib/api.ts` — `getNodeHistory`, `getEdgeHistory`, `getChangeLog`, `generateBestPractices`.
- `src/components/canvas/use-persistence.ts` — carry `reason` in coalesced node/lane patches.
- `src/components/canvas/properties-panel.tsx` — History section + semantic-edit reason capture.
- `src/components/canvas/right-panel.tsx` — new "Change Log" tab.
- `src/components/canvas/bpmn-canvas.tsx` — reason prompt on canvas-direct semantic actions (relane via drag, delete); thread `reason` into undo/redo callbacks.

---

# PHASE 1 — The change-event backbone

Records everything; no new UI. Ends with every semantic mutation writing exactly one event and cosmetic mutations writing none.

### Task 1: ChangeEvent model + enums

**Files:**
- Modify: `backend/app/enums.py`
- Create: `backend/app/models/change_event.py`
- Modify: `backend/app/models/__init__.py`, `backend/app/models/audit.py`

**Interfaces:**
- Produces: enums `ChangeTargetType`, `ChangeActorKind`, `ChangeKind`, `ChangeSource`; model `ChangeEvent` with columns per spec §4.1.

- [ ] **Step 1: Add the enums**

Append to `backend/app/enums.py`:

```python
class ChangeTargetType(StrEnum):
    NODE = "node"
    EDGE = "edge"
    LANE = "lane"
    VERSION = "version"


class ChangeActorKind(StrEnum):
    USER = "user"
    AI = "ai"
    SYSTEM = "system"


class ChangeKind(StrEnum):
    CREATE = "create"
    RELABEL = "relabel"
    DESCRIBE = "describe"
    RETYPE = "retype"
    RELANE = "relane"
    LINK_CLAIM = "link_claim"
    UNLINK_CLAIM = "unlink_claim"
    CONNECT = "connect"
    RECONNECT = "reconnect"
    DELETE = "delete"
    BRANCH = "branch"
    RESTORE = "restore"
    FLAG_STALE = "flag_stale"
    RECITE = "recite"


class ChangeSource(StrEnum):
    GENERATION = "generation"
    MANUAL = "manual"
    CHAT = "chat"
    RECONCILE = "reconcile"
    IMPORT = "import"
    MIGRATION = "migration"
```

- [ ] **Step 2: Create the model**

Create `backend/app/models/change_event.py`:

```python
from uuid import UUID

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin


class ChangeEvent(IdMixin, TimestampMixin, Base):
    """Append-only per-object reasoning trail. One row per semantic change to a
    node/edge/lane, plus version branch/restore. created_at is the event time.
    target_id is deliberately NOT a FK so the trail survives the target's
    deletion. See docs/superpowers/specs/2026-06-22-process-map-reasoning-trail-design.md."""

    __tablename__ = "change_events"
    __table_args__ = (
        Index("ix_change_events_target", "target_type", "target_id", "created_at"),
        Index("ix_change_events_model", "model_id", "created_at"),
    )

    target_type: Mapped[str] = mapped_column(String(20), nullable=False)
    target_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    model_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_models.id", ondelete="CASCADE"),
        nullable=False,
    )
    version_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    actor_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    actor_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    before: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    cited_claim_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    reasoning_trace: Mapped[list | dict | None] = mapped_column(JSONB, nullable=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    suggestion_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_suggestions.id", ondelete="SET NULL"),
        nullable=True,
    )
```

- [ ] **Step 3: Register the model, retire the dead ones**

In `backend/app/models/__init__.py`: add `from app.models.change_event import ChangeEvent`, add `"ChangeEvent"` to `__all__`. Change the audit import to `from app.models.audit import GenerationJob` and remove `"AiInteraction"` and `"AuditEvent"` from `__all__`.

In `backend/app/models/audit.py`: delete the `AuditEvent` and `AiInteraction` classes (keep `GenerationJob` and its imports; prune now-unused imports like `Boolean`/`Text` only if nothing else uses them — run the import check in Step 4).

- [ ] **Step 4: Verify it imports**

Run: `cd backend && .venv/bin/python -c "from app.models import ChangeEvent, GenerationJob; print('ok')"`
Expected: `ok` (and no ImportError for the removed classes).

- [ ] **Step 5: Commit**

```bash
git add backend/app/enums.py backend/app/models/change_event.py backend/app/models/__init__.py backend/app/models/audit.py
git commit -m "feat(change-log): ChangeEvent model + enums; retire AuditEvent/AiInteraction"
```

---

### Task 2: change_log service — record_change, classification, backfill

**Files:**
- Create: `backend/app/services/change_log.py`
- Create: `backend/tests/test_change_log_service.py`

**Interfaces:**
- Produces:
  - `record_change(db, *, target_type, target_id, model_id, version_id, kind, reason, actor_kind="user", actor_id=None, before=None, after=None, cited_claim_ids=None, reasoning_trace=None, source="manual", suggestion_id=None) -> ChangeEvent`
  - `model_id_for_version(db, version_id: UUID) -> UUID`
  - `NODE_SEMANTIC_FIELDS: dict[str, ChangeKind]` (keys: `name`,`description`,`type`,`lane_id`)
  - `pick_kind(kinds: set[ChangeKind]) -> ChangeKind`
  - `backfill_origin_events(db) -> int` (returns rows inserted)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_change_log_service.py`:

```python
from uuid import uuid4

import pytest

from app.enums import ChangeKind, ChangeSource, ChangeTargetType
from app.models.change_event import ChangeEvent
from app.services import change_log
from tests.test_ai_edit import _seed_version_for_endpoint  # reuse the seeder


def test_pick_kind_honors_priority():
    assert change_log.pick_kind({ChangeKind.DESCRIBE, ChangeKind.RELANE}) == ChangeKind.RELANE
    assert change_log.pick_kind({ChangeKind.RELABEL}) == ChangeKind.RELABEL


def test_pick_kind_empty_raises():
    with pytest.raises(ValueError):
        change_log.pick_kind(set())


def test_record_change_writes_row(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    model_id = change_log.model_id_for_version(db, version.id)
    ev = change_log.record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=n1.id,
        model_id=model_id,
        version_id=version.id,
        kind=ChangeKind.RELABEL.value,
        reason="Renamed per interview",
        before={"name": "Receive"},
        after={"name": "Receive PO"},
        cited_claim_ids=[claim.id],
        source=ChangeSource.MANUAL.value,
    )
    db.commit()
    row = db.get(ChangeEvent, ev.id)
    assert row.kind == "relabel"
    assert row.after == {"name": "Receive PO"}
    assert row.cited_claim_ids == [str(claim.id)]
    assert row.actor_kind == "user" and row.actor_id is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_change_log_service.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.change_log` (or AttributeError).

- [ ] **Step 3: Implement the service**

Create `backend/app/services/change_log.py`:

```python
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.enums import ChangeActorKind, ChangeKind, ChangeSource, ChangeTargetType
from app.models.change_event import ChangeEvent
from app.models.process import ProcessVersion

NODE_SEMANTIC_FIELDS: dict[str, ChangeKind] = {
    "name": ChangeKind.RELABEL,
    "description": ChangeKind.DESCRIBE,
    "type": ChangeKind.RETYPE,
    "lane_id": ChangeKind.RELANE,
}

_KIND_PRIORITY = [
    ChangeKind.DELETE,
    ChangeKind.CREATE,
    ChangeKind.RETYPE,
    ChangeKind.RELANE,
    ChangeKind.RELABEL,
    ChangeKind.DESCRIBE,
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
    skips objects that already have a change_event. Returns rows inserted."""
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
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node_id,
            model_id=model_id,
            version_id=version_id,
            kind=ChangeKind.CREATE.value,
            reason=reason,
            actor_kind=ChangeActorKind.SYSTEM.value,
            cited_claim_ids=cited,
            source=ChangeSource.MIGRATION.value,
        )
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
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge_id,
            model_id=model_id,
            version_id=version_id,
            kind=ChangeKind.CREATE.value,
            reason=reason,
            actor_kind=ChangeActorKind.SYSTEM.value,
            cited_claim_ids=cited,
            source=ChangeSource.MIGRATION.value,
        )
        inserted += 1
    db.flush()
    return inserted


def _origin_reason_for(db: Session, target_id: UUID, kind: str) -> tuple[str, list]:
    link_table = "node_claim_links" if kind == "node" else "edge_claim_links"
    fk = "node_id" if kind == "node" else "edge_id"
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
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest tests/test_change_log_service.py -v`
Expected: PASS (3 tests). Note: `record_change`/`backfill` need the `change_events` table — Task 3 creates it via migration; the conftest runs `alembic upgrade head` per session, so do Task 3 before running. If running this task standalone first, expect a "relation change_events does not exist" error until Task 3 lands; sequence Task 3 immediately after Step 3 here, then run.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/change_log.py backend/tests/test_change_log_service.py
git commit -m "feat(change-log): record_change + classification + backfill service"
```

---

### Task 3: Migration — create table, backfill, drop dead tables

**Files:**
- Create: `backend/alembic/versions/0010_change_event.py`
- Create: `backend/tests/test_change_event_migration.py`

**Interfaces:**
- Consumes: `change_log.backfill_origin_events`.
- Produces: `change_events` table at head; `audit_events`/`ai_interactions` dropped.

- [ ] **Step 1: Write the migration**

Create `backend/alembic/versions/0010_change_event.py`:

```python
"""change_events table + origin backfill; drop audit_events/ai_interactions.

Revision ID: 0010_change_event
Revises: 0009_process_inventory
Create Date: 2026-06-22

One-way for the dropped tables: audit_events/ai_interactions were never written
(no production data; auth stubbed), so downgrade recreates them EMPTY.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Session

revision: str = "0010_change_event"
down_revision: Union[str, None] = "0009_process_inventory"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "change_events",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=False),
        sa.Column("model_id", PgUUID(as_uuid=True), sa.ForeignKey("process_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_id", PgUUID(as_uuid=True), sa.ForeignKey("process_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("actor_kind", sa.String(length=10), nullable=False),
        sa.Column("actor_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("before", JSONB(), nullable=True),
        sa.Column("after", JSONB(), nullable=True),
        sa.Column("cited_claim_ids", JSONB(), nullable=True),
        sa.Column("reasoning_trace", JSONB(), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("suggestion_id", PgUUID(as_uuid=True), sa.ForeignKey("process_suggestions.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_change_events_target", "change_events", ["target_type", "target_id", "created_at"])
    op.create_index("ix_change_events_model", "change_events", ["model_id", "created_at"])

    # Backfill origin events for pre-existing nodes/edges.
    from app.services.change_log import backfill_origin_events

    bind = op.get_bind()
    session = Session(bind=bind)
    backfill_origin_events(session)
    session.commit()

    op.drop_table("ai_interactions")
    op.drop_table("audit_events")


def downgrade() -> None:
    # Recreate the dropped tables EMPTY (they were never written).
    op.create_table(
        "audit_events",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor_id", PgUUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("project_id", PgUUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("before", JSONB(), nullable=True),
        sa.Column("after", JSONB(), nullable=True),
    )
    op.create_table(
        "ai_interactions",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("project_id", PgUUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=True),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("response", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("proposed_patch", JSONB(), nullable=True),
        sa.Column("applied", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", PgUUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.drop_index("ix_change_events_model", table_name="change_events")
    op.drop_index("ix_change_events_target", table_name="change_events")
    op.drop_table("change_events")
```

- [ ] **Step 2: Apply to the test DB and the dev DB**

Run: `cd backend && DATABASE_URL=postgresql+psycopg://poet:poet@localhost:5433/poet_test .venv/bin/alembic upgrade head`
Expected: `Running upgrade 0009_process_inventory -> 0010_change_event`.
Then the dev DB: `cd backend && .venv/bin/alembic upgrade head`.

- [ ] **Step 3: Write the backfill test**

Create `backend/tests/test_change_event_migration.py`:

```python
from sqlalchemy import select

from app.enums import ChangeSource
from app.models.change_event import ChangeEvent
from app.services.change_log import backfill_origin_events
from tests.test_ai_edit import _seed_version_for_endpoint


def test_backfill_mines_claim_for_linked_node(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # n1 has a linked claim from the seeder. Remove the auto origin event that
    # create_node would write so we simulate a pre-existing node.
    db.query(ChangeEvent).delete()
    db.commit()

    inserted = backfill_origin_events(db)
    db.commit()
    assert inserted >= 1
    ev = db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n1.id)
    ).one()
    assert ev.source == ChangeSource.MIGRATION.value
    assert ev.actor_kind == "system"
    assert "Originated from claim" in ev.reason
    assert ev.cited_claim_ids == [str(claim.id)]


def test_backfill_is_idempotent(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    db.query(ChangeEvent).delete()
    db.commit()
    first = backfill_origin_events(db)
    db.commit()
    second = backfill_origin_events(db)
    db.commit()
    assert first >= 1
    assert second == 0  # nothing left without an event
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest tests/test_change_event_migration.py tests/test_change_log_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/alembic/versions/0010_change_event.py backend/tests/test_change_event_migration.py
git commit -m "feat(change-log): 0010 migration — change_events table + origin backfill"
```

---

### Task 4: Add `reason` to update schemas

**Files:**
- Modify: `backend/app/schemas/process_map.py`

**Interfaces:**
- Produces: `reason: str | None` on `NodeUpdate`, `EdgeUpdate`, `LaneUpdate`.

- [ ] **Step 1: Add the field**

In `backend/app/schemas/process_map.py`, add to each of `NodeUpdate`, `EdgeUpdate`, `LaneUpdate`:

```python
    reason: str | None = Field(default=None, max_length=2000)
```

- [ ] **Step 2: Verify import**

Run: `cd backend && .venv/bin/python -c "from app.schemas.process_map import NodeUpdate; print(NodeUpdate(reason='x').reason)"`
Expected: `x`

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/process_map.py
git commit -m "feat(change-log): add reason field to node/edge/lane update schemas"
```

---

### Task 5: Wire `update_node` — semantic detection, 422, one event

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (`update_node`, lines ~690-729)
- Create: `backend/tests/test_change_event_capture.py`

**Interfaces:**
- Consumes: `record_change`, `model_id_for_version`, `pick_kind`, `NODE_SEMANTIC_FIELDS`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_change_event_capture.py`:

```python
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.schemas.process_map import NodeUpdate
from tests.test_ai_edit import _seed_version_for_endpoint


def _events_for(db, target_id):
    return list(db.scalars(select(ChangeEvent).where(ChangeEvent.target_id == target_id)).all())


def test_update_node_semantic_requires_reason(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.update_node(project=project, node_id=n1.id,
                           payload=NodeUpdate(name="Receive PO"), db=db)
    assert exc.value.status_code == 422


def test_update_node_semantic_with_reason_logs_one_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="Receive PO", reason="Per interview"), db=db)
    events = _events_for(db, n1.id)
    assert len(events) == before + 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "relabel"
    assert ev.after == {"name": "Receive PO"}
    assert ev.reason == "Per interview"


def test_update_node_multifield_logs_single_event_highest_priority(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # change name (relabel) AND description (describe) -> one event, kind=relabel
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="X", description="Y", reason="r"), db=db)
    events = _events_for(db, n1.id)
    assert len(events) == before + 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "relabel"  # relabel > describe
    assert ev.before["name"] == "Receive" and ev.after["name"] == "X"
    assert "description" in ev.after


def test_update_node_cosmetic_only_logs_nothing_and_needs_no_reason(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(x=99.0, relative_y=10.0), db=db)
    assert len(_events_for(db, n1.id)) == before  # no new event


def test_update_node_noop_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="Receive", reason="r"), db=db)  # same name
    assert len(_events_for(db, n1.id)) == before  # value unchanged -> no event
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_change_event_capture.py -v`
Expected: FAIL (no reason enforcement / no events yet).

- [ ] **Step 3: Rewrite `update_node`**

Replace the body of `update_node` in `backend/app/api/v2/process_maps.py` with (add imports at top of file: `from app.enums import ChangeKind, ChangeSource, ChangeTargetType` and `from app.services.change_log import NODE_SEMANTIC_FIELDS, model_id_for_version, pick_kind, record_change`):

```python
@router.patch("/nodes/{node_id}", response_model=ProcessNodeRead)
def update_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessNode:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    def _semantic_snapshot() -> dict:
        return {
            "name": node.name,
            "type": node.type,
            "lane_id": str(node.lane_id) if node.lane_id else None,
            "description": (node.properties or {}).get("description"),
        }

    old = _semantic_snapshot()

    if payload.lane_id is not None:
        target_lane = db.get(ProcessLane, payload.lane_id)
        if target_lane is None or target_lane.version_id != node.version_id:
            raise HTTPException(
                status_code=422,
                detail="lane_id must reference a lane in the same version",
            )
        node.lane_id = payload.lane_id
    if payload.name is not None:
        node.name = payload.name
    if payload.type is not None:
        node.type = payload.type
    if payload.description is not None:
        new_props = dict(node.properties or {})
        new_props["description"] = payload.description
        node.properties = new_props
        flag_modified(node, "properties")
    if payload.x is not None or payload.relative_y is not None:
        new_position = dict(node.position or {})
        if payload.x is not None:
            new_position["x"] = payload.x
        if payload.relative_y is not None:
            new_position["relative_y"] = payload.relative_y
        node.position = new_position
        flag_modified(node, "position")

    new = _semantic_snapshot()
    changed = {f: (old[f], new[f]) for f in NODE_SEMANTIC_FIELDS if old[f] != new[f]}
    if changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(
                status_code=422,
                detail="A reason is required when changing a step's name, description, type, or lane.",
            )
        kind = pick_kind({NODE_SEMANTIC_FIELDS[f] for f in changed})
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=model_id_for_version(db, node.version_id),
            version_id=node.version_id,
            kind=kind.value,
            reason=payload.reason.strip(),
            before={f: changed[f][0] for f in changed},
            after={f: changed[f][1] for f in changed},
            source=ChangeSource.MANUAL.value,
        )
    db.commit()
    db.refresh(node)
    return node
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest tests/test_change_event_capture.py tests/test_ai_edit.py -v`
Expected: PASS. (`test_ai_edit.py` includes `test_update_node_writes_description_preserving_other_properties`, which calls `update_node` with `description=` and no reason — that test must be updated to pass `reason="..."`. Update it in this step and note it in the commit.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_change_event_capture.py backend/tests/test_ai_edit.py
git commit -m "feat(change-log): update_node logs semantic changes, enforces reason, ignores cosmetic"
```

---

### Task 6: Wire `update_edge`

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (`update_edge`, lines ~808-828)
- Modify: `backend/tests/test_change_event_capture.py`

- [ ] **Step 1: Write the failing tests** (append to `test_change_event_capture.py`)

```python
from app.schemas.process_map import EdgeCreate, EdgeUpdate


def _seed_edge(db, project, version, n1):
    # second node + edge n1->n2
    from app.models.process import ProcessNode, ProcessEdge
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task",
                     name="Approve", position={}, properties={})
    db.add(n2); db.flush()
    edge = ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id, label=None)
    db.add(edge); db.commit()
    return edge


def test_update_edge_label_requires_reason_and_logs(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    with pytest.raises(HTTPException) as exc:
        pm_api.update_edge(project=project, edge_id=edge.id,
                           payload=EdgeUpdate(label="if approved"), db=db)
    assert exc.value.status_code == 422
    pm_api.update_edge(project=project, edge_id=edge.id,
                       payload=EdgeUpdate(label="if approved", reason="branch label"), db=db)
    evs = _events_for(db, edge.id)
    assert any(e.kind == "relabel" and e.after.get("label") == "if approved" for e in evs)


def test_update_edge_bend_only_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    before = len(_events_for(db, edge.id))
    pm_api.update_edge(project=project, edge_id=edge.id,
                       payload=EdgeUpdate(bend_x=10.0, bend_y=20.0), db=db)
    assert len(_events_for(db, edge.id)) == before
```

- [ ] **Step 2: Run to verify failure** — `cd backend && .venv/bin/pytest tests/test_change_event_capture.py -k edge -v` → FAIL.

- [ ] **Step 3: Rewrite `update_edge`**

```python
@router.patch("/edges/{edge_id}", response_model=ProcessEdgeRead)
def update_edge(
    project: Annotated[Project, Depends(get_project_or_404)],
    edge_id: UUID,
    payload: EdgeUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessEdge:
    edge = db.get(ProcessEdge, edge_id)
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    _check_edge_in_project(edge, project.id, db)

    old_label = edge.label
    if "label" in payload.model_fields_set:
        edge.label = payload.label or None
    if "bend_x" in payload.model_fields_set:
        edge.bend_x = payload.bend_x
    if "bend_y" in payload.model_fields_set:
        edge.bend_y = payload.bend_y

    label_changed = "label" in payload.model_fields_set and (payload.label or None) != old_label
    if label_changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(status_code=422, detail="A reason is required to change an edge label.")
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge.id,
            model_id=model_id_for_version(db, edge.version_id),
            version_id=edge.version_id,
            kind=ChangeKind.RELABEL.value,
            reason=payload.reason.strip(),
            before={"label": old_label},
            after={"label": edge.label},
            source=ChangeSource.MANUAL.value,
        )
    db.commit()
    db.refresh(edge)
    return edge
```

- [ ] **Step 4: Run** — `cd backend && .venv/bin/pytest tests/test_change_event_capture.py -v` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): update_edge logs label changes, ignores bend"`

---

### Task 7: Wire `update_lane`

**Files:** Modify `update_lane` (process_maps.py ~875-899) + tests.

- [ ] **Step 1: Test** (append) — name change requires reason and logs `relabel` on the lane (`target_type=lane`); `order_index`/`color`/`height_px`/`collapsed`-only change logs nothing.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — snapshot `old_name = lane.name`; apply existing patch; if `payload.name is not None and payload.name != old_name`: require reason (422 else), `record_change(target_type=ChangeTargetType.LANE.value, target_id=lane.id, model_id=model_id_for_version(db, lane.version_id), version_id=lane.version_id, kind=ChangeKind.RELABEL.value, reason=..., before={"name": old_name}, after={"name": lane.name}, source=MANUAL)`. All other fields applied but never logged.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): update_lane logs name changes only"`

---

### Task 8: Wire create_node / create_edge / add_lane

**Files:** Modify `create_node` (~651), `create_edge` (~748), `add_lane` (~907) + tests.

**Behavior:** Creation always logs (no reason required — creation reason is implicit). `create_node` → `kind=create`, `target_type=node`, `after={"name","type","lane_id"}`. `create_edge` → `kind=connect`, `after={"source_node_id","target_node_id"}`. `add_lane` → `kind=create`, `target_type=lane`, `after={"name"}`. All `source=manual`.

- [ ] **Step 1: Tests** — after each create call, exactly one `create`/`connect` event exists for the new object with `source=manual`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — after `db.flush()` (id assigned) and before/after the existing `db.commit()`, insert the `record_change(...)` call. Example for `create_node`, inserted right after `node.properties = {**node.properties, LINEAGE_KEY: str(node.id)}`:

```python
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CREATE.value,
        reason="Added from the shape palette",
        after={"name": node.name, "type": node.type,
               "lane_id": str(node.lane_id) if node.lane_id else None},
        source=ChangeSource.MANUAL.value,
    )
    db.commit()
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): log node/edge/lane creation"`

---

### Task 9: Wire delete_node / delete_edge / delete_lane

**Files:** Modify `delete_node` (~845), `delete_edge` (~831), `delete_lane` (~1207) + tests.

**Behavior:** Deletes log a `delete` event BEFORE `db.delete(...)` (so we can snapshot `before`). `before` = the object's identifying fields. `source=manual`. Deletes do **not** require a typed reason from the API (the canvas supplies one in Phase 2, but the backend default is `"Deleted"`); since the event's `target_id` outlives the row (no FK), the trail persists.

- [ ] **Step 1: Tests** — after delete, a `delete` event exists for that `target_id`; querying the node returns None but the event remains.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `delete_node`, before `db.delete(node)`:

```python
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=model_id_for_version(db, node.version_id),
        version_id=node.version_id,
        kind=ChangeKind.DELETE.value,
        reason="Deleted",
        before={"name": node.name, "type": node.type},
        source=ChangeSource.MANUAL.value,
    )
```

Analogous for `delete_edge` (`target_type=edge`, before `{"source_node_id","target_node_id","label"}`) and `delete_lane` (`target_type=lane`, before `{"name"}`). Stringify UUIDs in `before`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): log node/edge/lane deletion"`

---

### Task 10: Wire claim attach/detach

**Files:** Modify `attach_node_claims` (~1036) and `detach_node_claim` (~1096) + tests.

**Behavior:** `attach_node_claims` logs one `link_claim` event on the node (`after={"claim_ids": [..added..]}`, `cited_claim_ids=added`) only if `added_count > 0`. `detach_node_claim` logs one `unlink_claim` event (`before={"claim_id": str(claim_id)}`, `cited_claim_ids=[claim_id]`). `source=manual`, no reason required (the act of citing evidence is self-justifying; reason defaults to `"Linked claim as evidence"` / `"Removed claim"`).

- [ ] **Step 1: Tests** — attach N new claims → one `link_claim` event with `cited_claim_ids` of length N; re-attaching already-linked claims (added_count 0) → no event; detach → one `unlink_claim` event.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — read the existing return shapes (`NodeClaimLinkResult.added_count`, `linked_claim_ids`) and gate the `record_change` on `added_count > 0`. Resolve `model_id` via `model_id_for_version(db, node.version_id)`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): log claim link/unlink on nodes"`

---

### Task 11: Wire apply_proposed_step

**Files:** Modify `apply_proposed_step` (~1584) + tests (`test_ai_edit.py` already exercises this endpoint).

**Behavior:** After `_create_proposed_step(...)` returns `(node, edge)` and before `db.commit()`, log a `create` event for the new node with `actor_kind=ai`, `source=reconcile` (AI-proposed step), `cited_claim_ids=payload.cited_claim_ids`, `reason="AI-proposed step accepted"`. (Reasoning trace isn't available at this endpoint — it lives with the original proposal; leave `reasoning_trace=None`.)

- [ ] **Step 1: Test** — after `apply_proposed_step`, the new node has a `create` event with `actor_kind="ai"`, `source="reconcile"`, and `cited_claim_ids` matching the real (existing) claim ids.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the `record_change` call (use `version.model_id` already in scope).
- [ ] **Step 4: Run → PASS** (`cd backend && .venv/bin/pytest tests/test_ai_edit.py -v`).
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): log accepted AI-proposed steps"`

---

### Task 12: Wire reconcile apply (`apply_suggestion`)

**Files:** Modify `backend/app/api/v2/processes.py` (`apply_suggestion`, ~490) + `backend/tests/test_reconcile_apply.py`.

**Behavior:** For the four reconcile ops (`add_step`, `recite_node`, `flag_stale_node`, `relabel_node`), on the APPLIED (not TARGET_GONE) path, call `record_change` with `actor_kind=ai`, `source=reconcile`, `suggestion_id=sug.id`, `version_id=sug.version_id`, `model_id=model_id_for_version(db, sug.version_id)`, `reason=sug.rationale or "<op> applied via reconcile"`. Map op→kind: `add_step`→`create`, `recite_node`→`recite`, `flag_stale_node`→`flag_stale`, `relabel_node`→`relabel`. Targets: `add_step` logs the new node id (capture from `_create_proposed_step` — change it to return the node, or re-query); `recite_node`/`flag_stale_node`/`relabel_node` log the existing `node.id`.

- [ ] **Step 1: Tests** (append to `test_reconcile_apply.py`) — accepting a `relabel_node` suggestion writes a `relabel` event with `source=reconcile` and `suggestion_id` set; a TARGET_GONE path writes no event.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `_create_proposed_step` already returns `(node, edge)` (verified in `apply_proposed_step`); capture it in the `add_step` branch. Add `record_change` before each APPLIED `return AcceptSuggestionResult(...)`. Add the imports at the top of `processes.py`.
- [ ] **Step 4: Run → PASS** (`cd backend && .venv/bin/pytest tests/test_reconcile_apply.py -v`).
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): reconcile ops write change events with suggestion back-link"`

---

### Task 13: Wire `copy_version` branch/restore

**Files:** Modify `backend/app/api/v2/versions.py` (`copy_version`, ~109) + `backend/tests/test_version_control.py`.

**Behavior:** `copy_version` clones a source version into a new version. After the new version is created and before commit, log ONE version-level event: `target_type=version`, `target_id=new_version.id`, `model_id=model.id`, `version_id=new_version.id`, `kind=branch` (or `restore` — see note), `reason=note or "Branched from v{source.version_number}"`, `before={"source_version_number": source.version_number}`, `after={"version_number": new_version.version_number}`, `source=manual`. Cloned nodes/edges get **no** per-object events (their lineage key links them to the source).

Note on branch vs restore: the endpoint takes a `note`; the frontend uses the same endpoint for both "Branch" and "Restore". Add an optional `kind` discriminator — read the request schema in `versions.py`; if it has no such field, default to `branch` and leave `restore` for a follow-up (record it as a one-line risk in the commit message). Do NOT invent a field the frontend doesn't send.

- [ ] **Step 1: Test** — after `copy_version`, exactly one `change_event` with `target_type=version` exists for the new version, and zero per-node `create` events were added for the cloned nodes beyond what already existed.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the single `record_change` call.
- [ ] **Step 4: Run → PASS** (`cd backend && .venv/bin/pytest tests/test_version_control.py -v`).
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): log version branch/restore as one version-level event"`

---

### Task 14: Wire the generation path

**Files:** Modify the map-generation service/endpoint (`generate_process_map` ~205 and `_create_model_and_version` ~129 in process_maps.py; follow where nodes/edges are first persisted) + `backend/tests/test_generate_map_with_process.py`.

**Behavior:** When a fresh map is generated from claims, write a `create` event per node and per edge with `actor_kind=ai`, `source=generation`, `cited_claim_ids` = the node's linked claim ids (if available at creation time), `reason="Generated from source claims"`. This is the forward-going origin trail (the migration backfill covers pre-existing maps).

- [ ] **Step 1: Test** — after generating a map (LLM patched as in existing generation tests), each created node has a `create` event with `source=generation`, `actor_kind=ai`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — locate the loop that persists generated nodes/edges; after each is flushed (id available), call `record_change`. If claim links are created in a later pass, log the event after links exist so `cited_claim_ids` is populated, or log node creation first and rely on the per-node history showing the subsequent `link_claim`. Pick whichever matches the generation code's ordering; document the choice in a code comment.
- [ ] **Step 4: Run → PASS** (`cd backend && .venv/bin/pytest tests/test_generate_map_with_process.py -v`).
- [ ] **Step 5: Commit** — `git commit -am "feat(change-log): generation writes origin events per node/edge"`

- [ ] **Phase 1 gate:** `cd backend && .venv/bin/pytest -q` → all green. Commit any test fixups.

---

# PHASE 2 — Item 1: per-object reasoning trail UI

### Task 15: History read endpoints

**Files:**
- Create: `backend/app/schemas/change_event.py`
- Create: `backend/app/api/v2/change_log.py`
- Modify: router registration (`backend/app/main.py` or `app/api/v2/__init__.py` — match how `process_maps`/`versions` routers are included)
- Create: `backend/tests/test_change_log_api.py`

**Interfaces:**
- Produces:
  - `GET /projects/{project_id}/nodes/{node_id}/history -> list[ChangeEventRead]`
  - `GET /projects/{project_id}/edges/{edge_id}/history -> list[ChangeEventRead]`
  - `ChangeEventRead` fields: `id, created_at, target_type, target_id, kind, reason, actor_kind, before, after, cited_claim_ids, has_thinking: bool, reasoning_trace, source, version_id`.

- [ ] **Step 1: Schema** — create `ChangeEventRead(BaseModel, from_attributes)` plus a `ChangeLogPage` (for Task 19). `has_thinking` is computed: `reasoning_trace is not None`.
- [ ] **Step 2: Failing test** — seed a node, make two semantic edits, GET its history; assert 2+ events oldest→newest with correct `kind`/`reason`.
- [ ] **Step 3: Implement** the router. History query: `select(ChangeEvent).where(target_type==..., target_id==...).order_by(ChangeEvent.created_at)`. Validate the node/edge belongs to the project (reuse `_check_node_in_project` pattern or resolve via model→project). Hydrate `cited_claim_ids` to subjects only if cheap; otherwise return ids and let the frontend reuse existing claim fetches (decide: return ids now, hydrate in Task 18 via existing `getNodeCitations`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(change-log): node/edge history endpoints"`

---

### Task 16: Frontend types + API client

**Files:** Modify `src/lib/types.ts`, `src/lib/api.ts`.

- [ ] **Step 1:** Add to `types.ts`:

```ts
export type ChangeActorKind = "user" | "ai" | "system";
export type ChangeSource = "generation" | "manual" | "chat" | "reconcile" | "import" | "migration";

export interface ChangeEvent {
  id: UUID;
  created_at: string;
  target_type: "node" | "edge" | "lane" | "version";
  target_id: UUID;
  kind: string;
  reason: string;
  actor_kind: ChangeActorKind;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  cited_claim_ids: UUID[] | null;
  has_thinking: boolean;
  reasoning_trace: unknown;
  source: ChangeSource;
  version_id: UUID | null;
}
```

Add `reason?: string` to `NodeUpdate`, `EdgeUpdate`, `LaneUpdate`.

- [ ] **Step 2:** Add to `api.ts` (mirror existing `request<T>` usage):

```ts
getNodeHistory(projectId: UUID, nodeId: UUID) {
  return request<ChangeEvent[]>(`/projects/${projectId}/nodes/${nodeId}/history`);
},
getEdgeHistory(projectId: UUID, edgeId: UUID) {
  return request<ChangeEvent[]>(`/projects/${projectId}/edges/${edgeId}/history`);
},
```

- [ ] **Step 3:** `cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit` → no errors.
- [ ] **Step 4: Commit** — `git commit -m "feat(change-log): frontend types + history API client"`

---

### Task 17: Thread `reason` through persistence + undo/redo + canvas semantic actions

**Files:** Modify `src/components/canvas/use-persistence.ts`, `src/components/canvas/bpmn-canvas.tsx`.

**Why:** Semantic edits now 422 without a `reason`. The debounced persistence layer and the undo/redo callbacks must supply one, or saves fail.

- [ ] **Step 1:** In `use-persistence.ts`, the dirty maps hold `NodeUpdate`/`LaneUpdate` which now include `reason?`. When the canvas marks a node dirty for a semantic field (name/description/type/lane), it must set `reason`. Add a `markNodeSemantic(id, patch, reason)` path (or require `reason` on the existing `markNode` when the patch contains semantic keys). Cosmetic-only marks (position) omit `reason`.
- [ ] **Step 2:** In `bpmn-canvas.tsx`, the semantic-edit entry points (rename commit, description save, relane-by-drag, type change, delete) call a small `promptReason(actionLabel)` helper (a lightweight inline prompt/modal) and pass the result through. Undo/redo `UndoAction` callbacks (which call the low-level API mutators) pass `reason: "Undo of " + description` / `"Redo of " + description` so replays satisfy the 422 rule.
- [ ] **Step 3:** Manual verification (see the `verify` skill or `/run`): rename a step → reason prompt appears → save succeeds; drag a node within a lane (cosmetic) → no prompt, no log; drag to another lane → prompt. Undo a rename → succeeds without 422.
- [ ] **Step 4:** `npx tsc --noEmit` and `npx vitest run` → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(change-log): capture edit reasons; thread through persistence and undo/redo"`

---

### Task 18: History section in the properties panel

**Files:** Modify `src/components/canvas/properties-panel.tsx`.

- [ ] **Step 1:** Add a collapsible "History" section beside the existing Provenance section (~line 353). Fetch with TanStack Query: `useQuery(["node-history", projectId, nodeId], () => api.getNodeHistory(projectId, nodeId))`. Render entries oldest→newest: actor icon (human/AI/system from `actor_kind`), `kind` label, `reason`, relative time, cited-claim chips (clickable → existing document viewer via the same handler the Provenance section uses), and for `has_thinking` a collapsed `<details>` "Show thinking" rendering `reasoning_trace`.
- [ ] **Step 2:** Invalidate `["node-history", ...]` after any successful node mutation (hook into the existing persistence success path).
- [ ] **Step 3:** `npx tsc --noEmit`; manual verify the panel shows the trail and "Show thinking" expands.
- [ ] **Step 4: Commit** — `git commit -m "feat(change-log): per-object History section in properties panel"`

- [ ] **Phase 2 gate:** backend `pytest -q`, frontend `tsc` + `vitest run` green; manual smoke of edit→reason→history.

---

# PHASE 3 — Item 2: Change Log tab

### Task 19: Model-wide log endpoint (filtered, cursor-paginated)

**Files:** Modify `backend/app/api/v2/change_log.py`, `backend/app/schemas/change_event.py`; add tests to `test_change_log_api.py`.

**Interfaces:**
- Produces: `GET /projects/{project_id}/models/{model_id}/log?target_id&actor_kind&source&since&cursor&limit -> ChangeLogPage` where `ChangeLogPage = { items: ChangeEventRead[], next_cursor: str | null }`. Reverse-chronological; cursor encodes `created_at` + `id`; `limit` defaults to 50, max 200.

- [ ] **Step 1: Failing tests** — seed several events across two nodes; assert: default feed is newest-first; `?target_id=` filters to one object; `?source=reconcile` filters; pagination returns a `next_cursor` and the second page continues without overlap.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — validate the model belongs to the project; build the filtered query `where(ChangeEvent.model_id == model_id)` + optional filters; order by `created_at DESC, id DESC`; apply keyset pagination on the cursor; return `next_cursor` when a full page is returned.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(change-log): model-wide log endpoint with filters + cursor pagination"`

---

### Task 20: Change Log tab

**Files:** Modify `src/lib/api.ts` (`getChangeLog`), `src/lib/types.ts` (`ChangeLogPage`), `src/components/canvas/right-panel.tsx`.

- [ ] **Step 1:** Add `getChangeLog(projectId, modelId, params)` to `api.ts` and `ChangeLogPage` to `types.ts`.
- [ ] **Step 2:** Add a "Change Log" tab to the existing tab set in `right-panel.tsx` (alongside Versions and Sources — do NOT merge them). Model-wide by default; when a node/edge is selected, pass `target_id` to filter. Render entries like the History section (reuse a shared `<ChangeEntry>` component extracted from Task 18 to stay DRY). Clicking an entry focuses the object on canvas using the same focus handler `ReviewTab` uses. Wire `useInfiniteQuery` for cursor pagination.
- [ ] **Step 3:** `npx tsc --noEmit`; manual verify the tab lists changes, filters on selection, and focuses on click.
- [ ] **Step 4: Commit** — `git commit -m "feat(change-log): Change Log tab in the canvas right panel"`

- [ ] **Phase 3 gate:** backend + frontend gates green; manual smoke of the tab.

---

# PHASE 4 — Item 5: best-practices seeding cadence

### Task 21: "Generate best-practices draft" endpoint

**Files:** Modify `backend/app/api/v2/process_maps.py` (new endpoint) + the generation service; create `backend/tests/test_best_practices_seed.py`.

**Behavior:** A new endpoint generates a starter map from generic best-practice knowledge (no client documents). It reuses the generation pipeline but with a best-practice prompt and no `scope_input_ids`. Each generated node/edge gets a `create` event with `source=generation`, `actor_kind=ai`, empty `cited_claim_ids`, and `reason="Best-practice assumption (no source document)"`.

- [ ] **Step 1: Failing test** — call the endpoint with the LLM patched (mirror `test_generate_map_with_process.py`'s patching); assert a model+version is created and each node has a `create` event with `source=generation` and empty `cited_claim_ids`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add the endpoint + a `best_practices=True` path in the generation service that swaps the prompt and skips claim scoping; reuse the Task 14 event-writing (the empty `cited_claim_ids` + best-practice reason is the only difference).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(best-practices): seed a draft map with origin provenance"`

---

### Task 22: Additive re-ingest

**Files:** Modify the re-ingest path (the endpoint that feeds a new transcript into an existing map) + `backend/tests/test_best_practices_seed.py`.

**Behavior:** Feeding a correction transcript into an existing map runs claim-extraction → reconcile **against the current map** (additive), not a fresh regeneration. Each accepted reconcile change already writes a `change_event` (`source=reconcile`, Task 12). This task ensures the re-ingest path routes through reconcile (not a destructive regenerate) so the trail accumulates.

- [ ] **Step 1: Test** — start from a seeded map with existing nodes (each with origin events); run re-ingest (reconcile path) with patched LLM proposing one `add_step`; accept it; assert the original nodes' events are untouched and the new node has a `source=reconcile` `create` event.
- [ ] **Step 2: Run → FAIL** (if the path currently regenerates) **or PASS** (if reconcile already covers it — then this task only adds the regression test).
- [ ] **Step 3: Implement** — confirm/route the re-ingest entry point through `reconcile_map` + `apply_suggestion`. If a destructive regenerate exists, gate it behind an explicit flag and default to additive.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(best-practices): additive re-ingest preserves the provenance trail"`

---

### Task 23: Best-practices UI

**Files:** Modify the maps/empty-canvas UI (`src/app/(canvas)/.../page.tsx` or the empty-state in `bpmn-canvas.tsx`), `src/lib/api.ts` (`generateBestPractices`).

- [ ] **Step 1:** Add `generateBestPractices(projectId, body)` to `api.ts`.
- [ ] **Step 2:** Add a "Generate best-practices draft" action to the empty-canvas state; on success navigate to the new version (reuse the existing post-generation navigation). Surface a re-ingest entry point if one isn't already present.
- [ ] **Step 3:** `npx tsc --noEmit`; manual verify generate-from-empty produces a map whose nodes show best-practice origin in their History.
- [ ] **Step 4: Commit** — `git commit -m "feat(best-practices): generate-draft action on empty canvas"`

- [ ] **Phase 4 gate:** backend + frontend gates green; end-to-end smoke: empty canvas → best-practices draft → re-ingest a transcript → every node shows an origin-to-now trail in both the History panel and the Change Log tab.

---

## Self-Review notes (for the executor)

- **Spec coverage:** §4 backbone → Tasks 1–3; §5 "what is a change" rules → Tasks 5–9 (semantic/cosmetic, no-op, one-event-per-save, kind priority), Task 13 (branch logs once), Task 17 (undo/redo reasons); §5.2 migration/backfill → Tasks 2–3; §6 item 1 → Tasks 15–18; §7 item 2 → Tasks 19–20; §8 item 5 → Tasks 21–23. Testing §9 → tests in each task. Phasing §10 → the four phase headers.
- **Known sequencing dependency:** Task 2's tests need Task 3's table — run Task 3 immediately after Task 2's implementation (called out in Task 2 Step 4).
- **Open decision deferred to code:** branch-vs-restore discriminator in Task 13 depends on the actual `copy_version` request schema; the task says default to `branch` and not to invent a field the frontend doesn't send.
- **`actor_id` is intentionally NULL** everywhere (no auth); `actor_kind` carries user/ai/system.
