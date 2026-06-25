# SP-7b — Process Inventory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI-first detection-run lifecycle with a durable Process Inventory. Consultants create/rename/archive processes anytime, curate claims into them with multi-select bulk assignment, ask AI to "Suggest processes" as a per-item accept/reject inbox, and generate maps scoped to a process. The `DetectionRun` / `ProcessSegment` / `ClaimSegmentMembership` model and its entire endpoint+UI surface are deleted, not deprecated.

**Architecture:** Three new tables — `processes` (durable inventory entity), `process_claim_links` (durable many-to-many claim↔process; "unassigned" = zero links), and `process_suggestions` (unified accept/reject inbox keyed by `batch_id`, carrying op + JSONB payload). `process_models.process_id` (FK→processes, nullable) replaces the `process_versions.source_segment_id` stamp; a process has many maps. A data migration carries accepted-run segments → processes and their memberships → links, re-links maps, then drops `source_segment_id` and the three detection tables. The pure clustering function `detect_segments_from_claims` is kept and rewired to write `process_discovery` suggestion rows; `run_detection` and all run persistence are deleted. One `apply_suggestion` dispatcher handles accepts (Phase 2 implements `create_process` and `assign_claims`; reconcile ops are Phase 3 / sp7c).

**Tech Stack:** Backend — FastAPI, SQLAlchemy 2.0, Alembic, Anthropic SDK, pytest against a dockerized Postgres `poet_test` DB on `localhost:5433`. Frontend — Next.js 16 App Router, React 19, TanStack Query, shadcn/radix, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-sp7-process-inventory-design.md` (Phase 2 only). Assumes sp7a (Phase 1 quick wins) has landed: `claims.source` column, claim CRUD, conflict PATCH, node↔claim link endpoints, blank-map `POST /process-maps` via an extracted `_create_model_and_version` helper, and migration `0008`. This plan's migration is `0009`.

---

## File structure

### Backend — new files

- `backend/alembic/versions/0009_process_inventory.py` — create `processes`, `process_claim_links`, `process_suggestions`; add `process_models.process_id`; raw-SQL data migration (accepted runs' non-unassigned segments → processes, memberships → links with `assigned_by='inherited'`, re-link maps via any version's `source_segment_id`); drop `process_versions.source_segment_id` and the three detection tables. Lossy downgrade recreates empty tables.
- `backend/app/models/process_inventory.py` — SQLAlchemy models `Process`, `ProcessClaimLink`, `ProcessSuggestion`.
- `backend/app/schemas/process.py` — Pydantic shapes for the inventory/suggestion surface (distinct from `schemas/process_map.py`, which keeps map shapes).
- `backend/app/api/v2/processes.py` — router: inventory CRUD, bulk assign/unassign, `GET /claims/unassigned`, `POST /suggest-processes`, suggestion list/accept/reject + batch-accept, and the `apply_suggestion` dispatcher.
- `backend/tests/test_processes_api.py` — integration tests for inventory CRUD, bulk assign/unassign idempotency, unassigned triage.
- `backend/tests/test_suggestions_api.py` — integration tests for suggest-processes (mocked Claude), list/accept/reject, batch-accept, and `apply_suggestion` dispatch incl. stale-target no-ops and 422 on unknown op kinds.
- `backend/tests/test_inventory_migration.py` — Postgres-backed migration test: seed detection data via SQLAlchemy against the test DB, downgrade to `0008`, upgrade to `0009`, assert segment→process / membership→link / map-relink counts. Skips if Postgres is unreachable.

### Backend — modified files

- `backend/app/enums.py` — add `ProcessStatus`, `SuggestionStatus`, `SuggestionKind`, `SuggestionOutcome`, `AssignedBy` enums (StrEnum, mirroring existing repo style); remove `DetectionRunStatus`.
- `backend/app/models/__init__.py` — register `Process`, `ProcessClaimLink`, `ProcessSuggestion`; drop `DetectionRun`, `ProcessSegment`, `ClaimSegmentMembership`.
- `backend/app/models/process.py` — remove `ProcessVersion.source_segment_id`; add `ProcessModel.process_id` FK.
- `backend/app/services/process_detection.py` — keep `detect_segments_from_claims`, `render_claim_lines`, `DetectionResult`, `DetectedSegment`, `SEGMENT_TOOL`, `SYSTEM_PROMPT`, `_get_client`, `_load_claims_for_detection`, `_chunk_ref_for_claim`; delete `run_detection`, `inherited_name_for_segment`, `INHERITANCE_OVERLAP_THRESHOLD`, and all imports of the detection models.
- `backend/app/api/v2/process_maps.py` — `generate_process_map` takes `process_id` (removes `segment_id`); scopes claims via `process_claim_links`; stamps `process_models.process_id`; new `PATCH /process-maps/{model_id}` attach/detach; `list_process_maps` join rewritten to surface process info + `unreconciled_claim_count`.
- `backend/app/schemas/process_map.py` — `ProcessMapGenerateRequest.segment_id` → `process_id`; `ProcessModelRead` drops `latest_source_segment_id` / `latest_source_run_status`, gains `process_id`, `process_name`, `unreconciled_claim_count`; add `ProcessMapAttachRequest`.
- `backend/app/api/v2/__init__.py` — replace `process_detection` router include with `processes`.

### Backend — deleted files

- `backend/app/api/v2/process_detection.py` — entire router.
- `backend/app/models/process_detection.py` — entire models file.
- `backend/app/schemas/process_detection.py` — entire schemas file.
- `backend/tests/test_process_detection_api.py`, `backend/tests/test_process_detection_service.py`, `backend/tests/test_process_detection_heuristic.py`, `backend/tests/test_detection_end_to_end.py`, `backend/tests/test_generate_map_with_segment.py` — removed (replaced by `test_processes_api.py`, `test_suggestions_api.py`, and the rewired `test_generate_map_with_process.py`).
- `backend/tests/test_migration_round_trip.py` — removed (its assertions reference dropped tables; replaced by `test_inventory_migration.py`).

### Frontend — new files

- `src/components/inventory/process-list.tsx` — durable inventory list with inline create/rename/archive.
- `src/components/inventory/claim-triage-panel.tsx` — unassigned-claims panel with multi-select.
- `src/components/inventory/bulk-assign-popover.tsx` — assign selected claims to one or more processes.
- `src/components/inventory/suggestion-inbox.tsx` — reusable per-item accept/reject diff surface grouped by batch.
- `src/components/inventory/triage-selection.ts` — pure selection-state logic (toggle/selectAll/clear).
- `src/components/inventory/triage-selection.test.ts` — Vitest for the above.
- `src/components/inventory/inbox-grouping.ts` — pure grouping of suggestions by batch.
- `src/components/inventory/inbox-grouping.test.ts` — Vitest for the above.

### Frontend — modified files

- `src/app/(app)/projects/[id]/processes/page.tsx` — full rewrite: inventory list + triage panel + Suggest button + suggestion inbox. `resolveCurrentRun` deleted.
- `src/app/(app)/projects/[id]/maps/page.tsx` — group maps by process; "Unlinked maps" section with attach control; the superseded stale badge replaced by a live "N unreconciled claims" count.
- `src/components/generate-map-form.tsx` — segment picker → process picker.
- `src/lib/api.ts` — remove 9 detection methods; add inventory/suggestion/attach surface; `generateProcessMap` uses `process_id`.
- `src/lib/types.ts` — remove detection types; add `Process`, `ProcessSuggestion`, suggestion request/result, attach types; update `ProcessModel`.

### Frontend — deleted files

- `src/components/detect/segment-card.tsx`, `merge-popover.tsx`, `move-claim-popover.tsx`, `new-empty-cluster-button.tsx`, `post-accept-panel.tsx` — entire `src/components/detect/` directory.
- `src/components/detect-processes-button.tsx`.

The `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` redirect shim stays (the spec keeps it).

---

## Task 1: Enums — add inventory/suggestion enums, drop DetectionRunStatus

**Files:**
- Modify: `backend/app/enums.py`

- [ ] **Step 1: Replace the `DetectionRunStatus` block**

In `backend/app/enums.py`, delete:

```python
class DetectionRunStatus(StrEnum):
    DRAFT = "draft"
    ACCEPTED = "accepted"
    ARCHIVED = "archived"
    SUPERSEDED = "superseded"
```

and append in its place:

```python
class ProcessStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class AssignedBy(StrEnum):
    USER = "user"
    AI_ACCEPTED = "ai_accepted"
    INHERITED = "inherited"


class SuggestionKind(StrEnum):
    PROCESS_DISCOVERY = "process_discovery"
    MAP_RECONCILE = "map_reconcile"


class SuggestionStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class SuggestionOutcome(StrEnum):
    """Resolution detail for an accepted suggestion. APPLIED is the normal
    path; TARGET_GONE is the graceful no-op when the suggestion's target
    process/claim was deleted before accept."""

    APPLIED = "applied"
    TARGET_GONE = "target_gone"
```

- [ ] **Step 2: Verify the module imports and the old enum is gone**

Run from repo root:

```
cd backend && python -c "from app.enums import ProcessStatus, AssignedBy, SuggestionKind, SuggestionStatus, SuggestionOutcome; print(ProcessStatus.ACTIVE.value, SuggestionKind.PROCESS_DISCOVERY.value)"
```

Expected stdout: `active process_discovery`

Then confirm the old enum is removed:

```
cd backend && python -c "import app.enums as e; print(hasattr(e, 'DetectionRunStatus'))"
```

Expected stdout: `False`

- [ ] **Step 3: Commit**

```bash
git add backend/app/enums.py
git commit -m "feat(sp7b): inventory/suggestion enums; drop DetectionRunStatus"
```

---

## Task 2: SQLAlchemy models — Process, ProcessClaimLink, ProcessSuggestion

**Files:**
- Create: `backend/app/models/process_inventory.py`

This task creates the models only. Registration in `__init__.py`, the `process.py` edits, and deleting `process_detection.py` happen in Task 4 (after the migration is in place, so the model registry never references tables that exist in neither the DB nor a migration mid-task).

- [ ] **Step 1: Create the models file**

Create `backend/app/models/process_inventory.py`:

```python
from uuid import UUID

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, SoftDeleteMixin, TimestampMixin
from app.enums import (
    AssignedBy,
    ProcessStatus,
    SuggestionStatus,
)


class Process(IdMixin, TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "processes"

    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ProcessStatus.ACTIVE.value
    )
    created_by: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class ProcessClaimLink(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_claim_links"
    __table_args__ = (
        UniqueConstraint(
            "process_id", "claim_id", name="uq_process_claim_links_process_claim"
        ),
    )

    process_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("processes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assigned_by: Mapped[str] = mapped_column(
        String(20), nullable=False, default=AssignedBy.USER.value
    )


class ProcessSuggestion(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_suggestions"

    batch_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, index=True
    )
    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    process_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("processes.id", ondelete="SET NULL"),
        nullable=True,
    )
    version_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    op: Mapped[str] = mapped_column(String(40), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    rationale: Mapped[str] = mapped_column(Text, nullable=False, default="")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=SuggestionStatus.PENDING.value
    )
    outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    resolved_at: Mapped[None] = mapped_column(  # set on accept/reject
        __import__("sqlalchemy").DateTime(timezone=True), nullable=True
    )
```

> Note: `resolved_at` is written as a deferred-import column to keep the import block tidy; if your style guide prefers it, replace the last column with an explicit `from datetime import datetime` import at the top and `resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)` plus `from sqlalchemy import DateTime`. The migration in Task 3 creates `resolved_at` as `TIMESTAMP WITH TIME ZONE NULL` either way. **Implement the explicit-import form** — it is clearer:

Replace the import block top and the final column with:

```python
from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
```

and the final column with:

```python
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

- [ ] **Step 2: Smoke-import the models (standalone — not yet registered)**

```
cd backend && python -c "from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion; print(Process.__tablename__, ProcessClaimLink.__tablename__, ProcessSuggestion.__tablename__)"
```

Expected stdout: `processes process_claim_links process_suggestions`

- [ ] **Step 3: Commit**

```bash
git add backend/app/models/process_inventory.py
git commit -m "feat(sp7b): Process, ProcessClaimLink, ProcessSuggestion models"
```

---

## Task 3: Migration 0009 — create tables, data migration, drop detection tables

**Files:**
- Create: `backend/alembic/versions/0009_process_inventory.py`

- [ ] **Step 1: Write the migration**

Create `backend/alembic/versions/0009_process_inventory.py`:

```python
"""process inventory: processes, process_claim_links, process_suggestions;
re-home maps onto processes; drop detection tables.

Revision ID: 0009_process_inventory
Revises: 0008_claim_source_and_conflict_reason
Create Date: 2026-06-11

This migration is intentionally one-way (lossy downgrade). It carries data out
of the accepted detection runs into the durable inventory, then drops the
detection tables. The downgrade recreates the three tables EMPTY — accepted
curation is not recoverable. This is acceptable: no production data exists
(auth is stubbed). Called out in the PR.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID

revision: str = "0009_process_inventory"
down_revision: Union[str, None] = "0008_claim_source_and_conflict_reason"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the three new tables and the process_models.process_id column.
    op.create_table(
        "processes",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column(
            "created_by",
            PgUUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_processes_project_id", "processes", ["project_id"])

    op.create_table(
        "process_claim_links",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "claim_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("claims.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("assigned_by", sa.String(length=20), nullable=False, server_default="user"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "process_id", "claim_id", name="uq_process_claim_links_process_claim"
        ),
    )
    op.create_index(
        "ix_process_claim_links_process_id", "process_claim_links", ["process_id"]
    )
    op.create_index(
        "ix_process_claim_links_claim_id", "process_claim_links", ["claim_id"]
    )

    op.create_table(
        "process_suggestions",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", PgUUID(as_uuid=True), nullable=False),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "version_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_versions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("op", sa.String(length=40), nullable=False),
        sa.Column("payload", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("rationale", sa.Text(), nullable=False, server_default=""),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("outcome", sa.String(length=20), nullable=True),
        sa.Column("model_used", sa.String(length=120), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_process_suggestions_batch_id", "process_suggestions", ["batch_id"]
    )
    op.create_index(
        "ix_process_suggestions_project_id", "process_suggestions", ["project_id"]
    )

    op.add_column(
        "process_models",
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_process_models_process_id", "process_models", ["process_id"])

    # 2. DATA MIGRATION (raw SQL). Each non-unassigned segment of an ACCEPTED
    #    run becomes one process; each of its memberships becomes a link with
    #    assigned_by='inherited'. Segment ids and process ids are 1:1, so we
    #    reuse the segment's own uuid as the process id to make re-linking
    #    trivial in step 3.
    op.execute(
        """
        INSERT INTO processes (
            id, project_id, name, description, order_index, status,
            created_by, deleted_at, created_at, updated_at
        )
        SELECT
            ps.id,
            ps.project_id,
            ps.name,
            ps.description,
            ps.order_index,
            'active',
            NULL,
            NULL,
            ps.created_at,
            ps.updated_at
        FROM process_segments ps
        JOIN detection_runs dr ON dr.id = ps.detection_run_id
        WHERE dr.status = 'accepted'
          AND ps.is_unassigned = false
        """
    )
    op.execute(
        """
        INSERT INTO process_claim_links (
            id, process_id, claim_id, assigned_by, created_at, updated_at
        )
        SELECT
            uuid_generate_v4(),
            csm.segment_id,
            csm.claim_id,
            'inherited',
            now(),
            now()
        FROM claim_segment_memberships csm
        JOIN process_segments ps ON ps.id = csm.segment_id
        JOIN detection_runs dr ON dr.id = ps.detection_run_id
        WHERE dr.status = 'accepted'
          AND ps.is_unassigned = false
        ON CONFLICT (process_id, claim_id) DO NOTHING
        """
    )

    # 3. Re-link maps. A ProcessModel is linked to the process whose id equals
    #    the source_segment_id of ANY of the model's versions that points at a
    #    segment we migrated (i.e. now present in `processes`). Unresolvable
    #    models keep process_id = NULL ("unlinked maps", attachable in the UI).
    op.execute(
        """
        UPDATE process_models pm
        SET process_id = sub.process_id
        FROM (
            SELECT DISTINCT ON (pv.model_id)
                pv.model_id,
                pv.source_segment_id AS process_id
            FROM process_versions pv
            JOIN processes p ON p.id = pv.source_segment_id
            WHERE pv.source_segment_id IS NOT NULL
            ORDER BY pv.model_id, pv.version_number DESC
        ) AS sub
        WHERE pm.id = sub.model_id
        """
    )

    # 4. Drop the source_segment_id column, then the three detection tables.
    op.drop_column("process_versions", "source_segment_id")
    op.drop_table("claim_segment_memberships")
    op.drop_table("process_segments")
    op.execute("DROP INDEX IF EXISTS uq_detection_runs_one_draft_per_project")
    op.drop_table("detection_runs")


def downgrade() -> None:
    # LOSSY: recreate the three detection tables EMPTY and re-add the column.
    # Migrated processes/links/suggestions are NOT carried back.
    op.create_table(
        "detection_runs",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("claim_count_at_run", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("claim_id_set", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("model_used", sa.String(length=120), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_summary", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            PgUUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_detection_runs_project_id", "detection_runs", ["project_id"])
    op.execute(
        "CREATE UNIQUE INDEX uq_detection_runs_one_draft_per_project "
        "ON detection_runs(project_id) WHERE status='draft'"
    )
    op.create_table(
        "process_segments",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "detection_run_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("detection_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("claim_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("is_unassigned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_process_segments_detection_run_id", "process_segments", ["detection_run_id"]
    )
    op.create_index("ix_process_segments_project_id", "process_segments", ["project_id"])
    op.create_table(
        "claim_segment_memberships",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "claim_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("claims.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "segment_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_segments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "detection_run_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("detection_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "claim_id",
            "detection_run_id",
            name="uq_claim_segment_memberships_claim_id_detection_run_id",
        ),
    )
    op.create_index(
        "ix_claim_segment_memberships_segment_id", "claim_segment_memberships", ["segment_id"]
    )
    op.create_index(
        "ix_claim_segment_memberships_detection_run_id",
        "claim_segment_memberships",
        ["detection_run_id"],
    )

    op.add_column(
        "process_versions",
        sa.Column(
            "source_segment_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_segments.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    op.drop_index("ix_process_models_process_id", table_name="process_models")
    op.drop_column("process_models", "process_id")
    op.drop_index("ix_process_suggestions_project_id", table_name="process_suggestions")
    op.drop_index("ix_process_suggestions_batch_id", table_name="process_suggestions")
    op.drop_table("process_suggestions")
    op.drop_index("ix_process_claim_links_claim_id", table_name="process_claim_links")
    op.drop_index("ix_process_claim_links_process_id", table_name="process_claim_links")
    op.drop_table("process_claim_links")
    op.drop_index("ix_processes_project_id", table_name="processes")
    op.drop_table("processes")
```

> The link insert uses `uuid_generate_v4()` — migration `0001_enable_extensions` enables the `uuid-ossp` extension that provides it (it does NOT enable `pgcrypto`/`gen_random_uuid`). Verify before running with `grep -n "uuid-ossp\|pgcrypto" backend/alembic/versions/0001_enable_extensions.py`; expect `uuid-ossp`.

- [ ] **Step 2: Verify `0001` enables the extension the data step needs**

```
cd backend && grep -n "pgcrypto\|uuid-ossp\|uuid_generate_v4" alembic/versions/0001_enable_extensions.py
```

Expected: a line enabling `uuid-ossp` (provides `uuid_generate_v4()`, which the link-insert uses). The repo does NOT enable `pgcrypto`, so do not use `gen_random_uuid()`.

- [ ] **Step 3: Apply against the dev DB, then round-trip**

The dev DB is `poet`. Run from `backend/`:

```
alembic upgrade head
```

Expected: success.

```
alembic downgrade -1 && alembic upgrade head
```

Expected: both succeed (downgrade recreates empty detection tables; upgrade re-runs cleanly because the source tables are empty so the data steps are no-ops).

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/0009_process_inventory.py
git commit -m "feat(sp7b): migration 0009 — process inventory tables + data migration"
```

---

## Task 4: Register new models, edit process.py, delete detection model/schema files

**Files:**
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/models/process.py`
- Delete: `backend/app/models/process_detection.py`
- Delete: `backend/app/schemas/process_detection.py`
- Modify: `backend/app/services/process_detection.py`

- [ ] **Step 1: Edit `process.py` — drop `source_segment_id`, add `ProcessModel.process_id`**

In `backend/app/models/process.py`, inside `ProcessModel`, after the `parent_model_id` column, add:

```python
    process_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("processes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
```

In `ProcessVersion`, delete the `source_segment_id` column entirely:

```python
    source_segment_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_segments.id", ondelete="SET NULL"),
        nullable=True,
    )
```

- [ ] **Step 2: Edit `models/__init__.py`**

Delete the detection import block:

```python
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
```

and add, after the `from app.models.process import (...)` block:

```python
from app.models.process_inventory import (
    Process,
    ProcessClaimLink,
    ProcessSuggestion,
)
```

In `__all__`, delete `"DetectionRun"`, `"ProcessSegment"`, `"ClaimSegmentMembership"` and add `"Process"`, `"ProcessClaimLink"`, `"ProcessSuggestion"`.

- [ ] **Step 3: Trim the service to the pure clustering function**

In `backend/app/services/process_detection.py`, delete everything from the `INHERITANCE_OVERLAP_THRESHOLD = 0.70` line to the end of file (the orchestrator section and `inherited_name_for_segment`), and delete these imports at the top:

```python
from app.enums import DetectionRunStatus
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
```

Keep `from app.models.claim import Claim, ClaimCitation`, `from app.models.input import Chunk, DocumentSection`, `from sqlalchemy import select`, `from sqlalchemy.orm import Session`, `_load_claims_for_detection`, and `_chunk_ref_for_claim` (the suggest endpoint reuses them).

- [ ] **Step 4: Delete the detection model and schema files**

```bash
git rm backend/app/models/process_detection.py backend/app/schemas/process_detection.py
```

- [ ] **Step 5: Smoke-import the whole model registry**

```
cd backend && python -c "from app.models import Process, ProcessClaimLink, ProcessSuggestion, ProcessModel; from app.models.process import ProcessVersion; print(ProcessModel.process_id, hasattr(ProcessVersion, 'source_segment_id'))"
```

Expected stdout: a column expression for `process_id` and `False` for the `source_segment_id` attribute. (It will report `True` only if you forgot to delete the column — SQLAlchemy attributes are always present once declared; if it prints `True`, re-check Step 1.)

> The model registry will fail to import at this point ONLY if some other module still imports the deleted detection models — `process_maps.py` (the `segment_id` branch and `list_process_maps`) and `process_detection.py` router still do. Those are fixed in Tasks 8–9 and the router is unregistered in Task 5. To keep this task's smoke import green, run it with the registrations only; if it errors on `app.api`, that is expected and resolved by Task 5. Run the narrower import above (it imports `app.models`, not `app.api`).

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/__init__.py backend/app/models/process.py backend/app/services/process_detection.py
git commit -m "feat(sp7b): register inventory models; trim detection service to pure clustering"
```

---

## Task 5: Delete the detection router; register the processes router (stub)

**Files:**
- Delete: `backend/app/api/v2/process_detection.py`
- Create: `backend/app/api/v2/processes.py` (empty router so the package imports)
- Modify: `backend/app/api/v2/__init__.py`

- [ ] **Step 1: Create the stub router**

Create `backend/app/api/v2/processes.py`:

```python
"""SP-7b: durable Process Inventory, claim curation, and the AI suggestion
inbox. Replaces the deleted process_detection router."""
from fastapi import APIRouter

router = APIRouter(prefix="/projects/{project_id}", tags=["processes"])
```

- [ ] **Step 2: Delete the old router and re-wire `__init__.py`**

```bash
git rm backend/app/api/v2/process_detection.py
```

In `backend/app/api/v2/__init__.py`, in the import tuple replace `process_detection,` with `processes,`, and replace `router.include_router(process_detection.router)` with `router.include_router(processes.router)`.

- [ ] **Step 3: Smoke-import the API package**

```
cd backend && python -c "from app.api.v2 import router; print('ok')"
```

Expected: this will FAIL with an ImportError from `process_maps.py` (it still imports the deleted detection models in the `segment_id` branch and `list_process_maps`). That is expected — Tasks 8–9 fix `process_maps.py`. To unblock the rest of this task, the import is only re-verified at the end of Task 9. For now, confirm the failure is exactly the `process_maps`/`process_detection` import and nothing else:

```
cd backend && python -c "from app.api.v2 import processes; print('processes ok')"
```

Expected stdout: `processes ok`

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/v2/__init__.py backend/app/api/v2/processes.py
git commit -m "feat(sp7b): delete detection router; register processes router stub"
```

---

## Task 6: Pydantic schemas for the inventory/suggestion surface

**Files:**
- Create: `backend/app/schemas/process.py`

- [ ] **Step 1: Write the schemas file**

Create `backend/app/schemas/process.py`:

```python
"""Pydantic shapes for the Process Inventory and AI suggestion inbox.

Distinct from schemas/process_map.py (which owns map/version/node shapes).
`Process` here is the durable inventory entity, not a ProcessModel/map.
"""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProcessRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    name: str
    description: str
    order_index: int
    status: str
    created_at: datetime
    updated_at: datetime
    claim_count: int = 0
    map_count: int = 0


class ProcessCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=4000)


class ProcessUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    order_index: int | None = Field(default=None, ge=0)
    status: str | None = Field(default=None, pattern=r"^(active|archived)$")


class ClaimRef(BaseModel):
    """Lightweight claim shape for triage lists and process claim views."""

    id: UUID
    kind: str
    subject: str
    source: str


class ClaimIdList(BaseModel):
    claim_ids: list[UUID] = Field(min_length=1)


class BulkAssignResult(BaseModel):
    process_id: UUID
    linked: int
    already_linked: int


class BulkUnassignResult(BaseModel):
    process_id: UUID
    removed: int


class SuggestProcessesRequest(BaseModel):
    scope_input_ids: list[UUID] | None = None


class SuggestionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    batch_id: UUID
    project_id: UUID
    kind: str
    process_id: UUID | None
    version_id: UUID | None
    op: str
    payload: dict
    rationale: str
    confidence: float | None
    status: str
    outcome: str | None
    created_at: datetime
    resolved_at: datetime | None


class SuggestBatchResult(BaseModel):
    batch_id: UUID
    suggestion_count: int


class AcceptSuggestionResult(BaseModel):
    suggestion_id: UUID
    status: str
    outcome: str
    process_id: UUID | None = None
    linked: int = 0


class BatchAcceptResult(BaseModel):
    batch_id: UUID
    accepted: int
    skipped: int
```

- [ ] **Step 2: Smoke import**

```
cd backend && python -c "from app.schemas.process import ProcessRead, ProcessCreate, SuggestionRead, AcceptSuggestionResult; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/process.py
git commit -m "feat(sp7b): pydantic schemas for inventory + suggestions"
```

---

## Task 7: Inventory CRUD + bulk assign/unassign + unassigned triage

**Files:**
- Modify: `backend/app/api/v2/processes.py`
- Create: `backend/tests/test_processes_api.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_processes_api.py`:

```python
"""Integration tests for the Process Inventory CRUD + curation endpoints."""
import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    c1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9, source="extracted")
    c2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9, source="manual")
    db.add_all([c1, c2]); db.commit()
    return proj, [c1, c2]


def test_create_list_patch_delete_process(client, db):
    proj, _ = _seed(db)
    r = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "Order to Cash"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert r.json()["claim_count"] == 0
    assert r.json()["map_count"] == 0

    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.status_code == 200
    assert [p["name"] for p in r.json()] == ["Order to Cash"]

    r = client.patch(f"/api/v2/projects/{proj.id}/processes/{pid}", json={"name": "O2C"})
    assert r.status_code == 200
    assert r.json()["name"] == "O2C"

    r = client.delete(f"/api/v2/projects/{proj.id}/processes/{pid}")
    assert r.status_code == 204
    # Soft-deleted → absent from list.
    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.json() == []


def test_bulk_assign_is_idempotent_and_counts(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    body = {"claim_ids": [str(claims[0].id), str(claims[1].id)]}

    r = client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"process_id": pid, "linked": 2, "already_linked": 0}

    # Re-assign the same claims — idempotent, no duplicate rows.
    r = client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)
    assert r.json() == {"process_id": pid, "linked": 0, "already_linked": 2}

    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.json()[0]["claim_count"] == 2


def test_bulk_unassign(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    body = {"claim_ids": [str(claims[0].id), str(claims[1].id)]}
    client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)

    r = client.request("DELETE", f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json={"claim_ids": [str(claims[0].id)]})
    assert r.status_code == 200, r.text
    assert r.json() == {"process_id": pid, "removed": 1}
    assert client.get(f"/api/v2/projects/{proj.id}/processes").json()[0]["claim_count"] == 1


def test_unassigned_lists_only_unlinked_claims(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json={"claim_ids": [str(claims[0].id)]})

    r = client.get(f"/api/v2/projects/{proj.id}/claims/unassigned")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert ids == {str(claims[1].id)}
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_processes_api.py -v
```

Expected: 404s / route-not-found (the router has no endpoints yet), tests fail.

- [ ] **Step 3: Implement the endpoints**

Append to `backend/app/api/v2/processes.py` (after the existing `router = ...` line, and add imports to the top):

Replace the top of the file with:

```python
"""SP-7b: durable Process Inventory, claim curation, and the AI suggestion
inbox. Replaces the deleted process_detection router."""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, func, select
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
```

Then append:

```python
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
```

> `Claim.source` is the sp7a column. If sp7a is not yet merged in your branch, the `ClaimRef.source` field and the `.source` reads must be removed; but this plan assumes sp7a has landed.

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_processes_api.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/processes.py backend/tests/test_processes_api.py
git commit -m "feat(sp7b): inventory CRUD, bulk assign/unassign, unassigned triage"
```

---

## Task 8: Suggest-processes + suggestion inbox + apply_suggestion dispatcher

**Files:**
- Modify: `backend/app/api/v2/processes.py`
- Create: `backend/tests/test_suggestions_api.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_suggestions_api.py`:

```python
"""Suggestion inbox: suggest-processes (mocked Claude), list/accept/reject,
batch-accept, apply_suggestion dispatch incl. stale no-ops and bad-op 422."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    c1 = Claim(project_id=proj.id, kind="task", subject="AP", normalized={}, confidence=0.9, source="extracted")
    c2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9, source="extracted")
    db.add_all([c1, c2]); db.commit()
    return proj, [c1, c2]


def test_suggest_processes_writes_discovery_rows(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("Accounts Payable", "ap", [0], 0.9),
            DetectedSegment("Onboarding", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="grouped",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        r = client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["suggestion_count"] == 2
    batch_id = body["batch_id"]

    r = client.get(f"/api/v2/projects/{proj.id}/process-suggestions?status=pending&kind=process_discovery")
    rows = r.json()
    assert len(rows) == 2
    assert all(s["op"] == "create_process" for s in rows)
    assert all(s["batch_id"] == batch_id for s in rows)
    # Each create_process payload names the claim_ids it would assign.
    ap = next(s for s in rows if s["payload"]["name"] == "Accounts Payable")
    assert ap["payload"]["claim_ids"] == [str(claims[0].id)]


def test_accept_create_process_creates_process_and_links(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[DetectedSegment("Accounts Payable", "ap", [0, 1], 0.9)],
        unassigned_claim_refs=[], reasoning_summary="", model_used="m",
        prompt_tokens=1, output_tokens=1,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={})
    sid = client.get(f"/api/v2/projects/{proj.id}/process-suggestions").json()[0]["id"]

    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sid}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    assert r.json()["outcome"] == "applied"
    assert r.json()["linked"] == 2

    procs = db.query(Process).filter(Process.project_id == proj.id).all()
    assert len(procs) == 1 and procs[0].name == "Accounts Payable"
    links = db.query(ProcessClaimLink).filter(ProcessClaimLink.process_id == procs[0].id).all()
    assert len(links) == 2
    assert all(l.assigned_by == "ai_accepted" for l in links)


def test_accept_assign_claims_to_existing_process(client, db):
    proj, claims = _seed(db)
    proc = Process(project_id=proj.id, name="Existing", status="active")
    db.add(proc); db.commit()
    sug = ProcessSuggestion(
        batch_id=claims[0].id,  # any uuid works as a batch id for the test
        project_id=proj.id, kind="process_discovery",
        process_id=proc.id, op="assign_claims",
        payload={"process_id": str(proc.id), "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()

    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "applied"
    links = db.query(ProcessClaimLink).filter(ProcessClaimLink.process_id == proc.id).all()
    assert len(links) == 1


def test_accept_with_deleted_target_is_graceful_no_op(client, db):
    proj, claims = _seed(db)
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="process_discovery",
        process_id=None, op="assign_claims",
        payload={"process_id": "00000000-0000-0000-0000-000000000000", "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    assert r.json()["outcome"] == "target_gone"
    assert db.query(ProcessClaimLink).count() == 0


def test_accept_unknown_op_kind_is_422(client, db):
    proj, claims = _seed(db)
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="map_reconcile",
        process_id=None, op="recite_node",
        payload={"node_id": "x"}, rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 422
    assert "recite_node" in r.json()["detail"]
    # Status untouched on failure.
    db.refresh(sug)
    assert sug.status == "pending"


def test_reject_marks_rejected_without_side_effects(client, db):
    proj, claims = _seed(db)
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="process_discovery",
        process_id=None, op="create_process",
        payload={"name": "X", "description": "", "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/reject")
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"
    assert db.query(Process).count() == 0


def test_batch_accept_accepts_all_pending_in_batch(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[], reasoning_summary="", model_used="m",
        prompt_tokens=1, output_tokens=1,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        batch_id = client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={}).json()["batch_id"]
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestion-batches/{batch_id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] == 2
    assert db.query(Process).filter(Process.project_id == proj.id).count() == 2
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_suggestions_api.py -v
```

Expected: route-not-found / import errors — endpoints not implemented yet.

- [ ] **Step 3: Implement**

In `backend/app/api/v2/processes.py`, extend the imports at the top:

```python
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import (
    AssignedBy,
    ProcessStatus,
    SuggestionKind,
    SuggestionOutcome,
    SuggestionStatus,
)
from app.models.claim import Claim
from app.models.identity import User
from app.models.process import ProcessModel
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project
from app.schemas.process import (
    AcceptSuggestionResult,
    BatchAcceptResult,
    BulkAssignResult,
    BulkUnassignResult,
    ClaimIdList,
    ClaimRef,
    ProcessCreate,
    ProcessRead,
    ProcessUpdate,
    SuggestBatchResult,
    SuggestionRead,
    SuggestProcessesRequest,
)
from app.services.process_detection import (
    detect_segments_from_claims,
    _chunk_ref_for_claim,
    _load_claims_for_detection,
)
```

Then append the suggestion surface:

```python
# ---------------------------------------------------------------------------
# Suggest processes — runs the pure clustering, writes process_discovery rows.
# ---------------------------------------------------------------------------


@router.post(
    "/suggest-processes",
    response_model=SuggestBatchResult,
    status_code=status.HTTP_201_CREATED,
)
def suggest_processes(
    payload: SuggestProcessesRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> SuggestBatchResult:
    claims = _load_claims_for_detection(db, project.id, payload.scope_input_ids)
    if not claims:
        raise HTTPException(
            status_code=422,
            detail="No claims found for this project (scope). Run extract-claims first.",
        )

    chunk_ref_cache: dict = {}
    claim_dicts = [
        {
            "kind": c.kind,
            "subject": c.subject,
            "chunk_ref": _chunk_ref_for_claim(db, c.id, chunk_ref_cache),
        }
        for c in claims
    ]
    try:
        result = detect_segments_from_claims(claim_dicts)
    except RuntimeError as exc:
        # LLM failure: nothing written, surface as 503 (suggestions only persist
        # after a successful parse).
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not result.segments:
        raise HTTPException(
            status_code=422,
            detail="The model could not identify any distinct processes in the supplied claims.",
        )

    by_index = dict(enumerate(claims))
    batch_id = uuid4()
    count = 0
    for det in result.segments:
        seg_claim_ids = [
            str(by_index[i].id) for i in det.claim_refs if i in by_index
        ]
        db.add(
            ProcessSuggestion(
                batch_id=batch_id,
                project_id=project.id,
                kind=SuggestionKind.PROCESS_DISCOVERY.value,
                process_id=None,
                op="create_process",
                payload={
                    "name": det.name,
                    "description": det.description,
                    "claim_ids": seg_claim_ids,
                },
                rationale=result.reasoning_summary,
                confidence=det.confidence,
                status=SuggestionStatus.PENDING.value,
                model_used=result.model_used,
                prompt_tokens=result.prompt_tokens,
                output_tokens=result.output_tokens,
            )
        )
        count += 1
    db.commit()
    return SuggestBatchResult(batch_id=batch_id, suggestion_count=count)


@router.get("/process-suggestions", response_model=list[SuggestionRead])
def list_suggestions(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
    status_: Annotated[str | None, Query(alias="status")] = None,
    kind: Annotated[str | None, Query()] = None,
) -> list[ProcessSuggestion]:
    q = select(ProcessSuggestion).where(ProcessSuggestion.project_id == project.id)
    if status_ is not None:
        q = q.where(ProcessSuggestion.status == status_)
    if kind is not None:
        q = q.where(ProcessSuggestion.kind == kind)
    q = q.order_by(ProcessSuggestion.created_at)
    return list(db.scalars(q).all())


def _get_suggestion(db: Session, project_id: UUID, suggestion_id: UUID) -> ProcessSuggestion:
    sug = db.get(ProcessSuggestion, suggestion_id)
    if sug is None or sug.project_id != project_id:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return sug


def _link_claims(
    db: Session, process: Process, claim_ids: list[str], project_id: UUID
) -> int:
    """Idempotently link the given claim ids (that belong to project) to the
    process. Returns the number of new links written."""
    if not claim_ids:
        return 0
    valid = set(
        db.scalars(
            select(Claim.id).where(
                Claim.id.in_(claim_ids), Claim.project_id == project_id
            )
        ).all()
    )
    existing = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == process.id,
                ProcessClaimLink.claim_id.in_(valid),
            )
        ).all()
    )
    linked = 0
    for cid in valid - existing:
        db.add(
            ProcessClaimLink(
                process_id=process.id,
                claim_id=cid,
                assigned_by=AssignedBy.AI_ACCEPTED.value,
            )
        )
        linked += 1
    return linked


def apply_suggestion(
    db: Session, project: Project, sug: ProcessSuggestion
) -> AcceptSuggestionResult:
    """Dispatch one accepted suggestion to its mutation. Phase 2 (sp7b)
    handles only the two discovery ops; reconcile ops (add_step, recite_node,
    flag_stale_node, relabel_node) are added by sp7c — they raise 422 here.

    Returns the result; the caller is responsible for stamping status/outcome
    and committing. A deleted target → graceful TARGET_GONE no-op (no raise),
    mirroring apply_proposed_step silently dropping unknown claim ids.
    """
    op = sug.op
    payload = sug.payload or {}

    if op == "create_process":
        proc = Process(
            project_id=project.id,
            name=str(payload.get("name", "")).strip() or "Untitled process",
            description=str(payload.get("description", "")),
            status=ProcessStatus.ACTIVE.value,
        )
        max_index = db.scalar(
            select(func.coalesce(func.max(Process.order_index), -1)).where(
                Process.project_id == project.id, Process.deleted_at.is_(None)
            )
        )
        proc.order_index = (max_index if max_index is not None else -1) + 1
        db.add(proc)
        db.flush()
        linked = _link_claims(db, proc, payload.get("claim_ids", []), project.id)
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=proc.id,
            linked=linked,
        )

    if op == "assign_claims":
        target_id = payload.get("process_id") or sug.process_id
        proc = db.get(Process, target_id) if target_id else None
        if proc is None or proc.project_id != project.id or proc.deleted_at is not None:
            # Target process vanished — graceful no-op.
            return AcceptSuggestionResult(
                suggestion_id=sug.id,
                status=SuggestionStatus.ACCEPTED.value,
                outcome=SuggestionOutcome.TARGET_GONE.value,
            )
        linked = _link_claims(db, proc, payload.get("claim_ids", []), project.id)
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=proc.id,
            linked=linked,
        )

    # Reconcile ops are not implemented in Phase 2; sp7c extends this dispatcher.
    raise HTTPException(
        status_code=422,
        detail=f"Suggestion op '{op}' is not supported in this phase.",
    )


@router.post(
    "/process-suggestions/{suggestion_id}/accept",
    response_model=AcceptSuggestionResult,
)
def accept_suggestion(
    suggestion_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> AcceptSuggestionResult:
    sug = _get_suggestion(db, project.id, suggestion_id)
    if sug.status != SuggestionStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Suggestion is not pending.")
    # apply_suggestion raises 422 for unknown ops BEFORE we touch status, so a
    # bad op leaves the row pending (asserted in the test).
    result = apply_suggestion(db, project, sug)
    sug.status = result.status
    sug.outcome = result.outcome
    sug.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return result


@router.post(
    "/process-suggestions/{suggestion_id}/reject",
    response_model=AcceptSuggestionResult,
)
def reject_suggestion(
    suggestion_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> AcceptSuggestionResult:
    sug = _get_suggestion(db, project.id, suggestion_id)
    if sug.status != SuggestionStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Suggestion is not pending.")
    sug.status = SuggestionStatus.REJECTED.value
    sug.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return AcceptSuggestionResult(
        suggestion_id=sug.id, status=sug.status, outcome=""
    )


@router.post(
    "/process-suggestion-batches/{batch_id}/accept",
    response_model=BatchAcceptResult,
)
def accept_batch(
    batch_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BatchAcceptResult:
    pending = list(
        db.scalars(
            select(ProcessSuggestion)
            .where(
                ProcessSuggestion.project_id == project.id,
                ProcessSuggestion.batch_id == batch_id,
                ProcessSuggestion.status == SuggestionStatus.PENDING.value,
            )
            .order_by(ProcessSuggestion.created_at)
        ).all()
    )
    accepted = 0
    skipped = 0
    for sug in pending:
        try:
            result = apply_suggestion(db, project, sug)
        except HTTPException:
            # Unsupported op in this phase — skip, leave pending.
            skipped += 1
            continue
        sug.status = result.status
        sug.outcome = result.outcome
        sug.resolved_at = datetime.now(timezone.utc)
        accepted += 1
    db.commit()
    return BatchAcceptResult(batch_id=batch_id, accepted=accepted, skipped=skipped)
```

> The `SuggestionRead` response model has `from_attributes=True`, so the list/accept endpoints can return ORM objects directly where typed as `ProcessSuggestion`; FastAPI serializes via the declared `response_model`.

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_suggestions_api.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/processes.py backend/tests/test_suggestions_api.py
git commit -m "feat(sp7b): suggest-processes, suggestion inbox, apply_suggestion dispatcher"
```

---

## Task 9: Rewire process_maps.py — generate by process_id, attach/detach, list rewrite

**Files:**
- Modify: `backend/app/schemas/process_map.py`
- Modify: `backend/app/api/v2/process_maps.py`
- Delete: `backend/tests/test_generate_map_with_segment.py`
- Create: `backend/tests/test_generate_map_with_process.py`

- [ ] **Step 1: Edit `schemas/process_map.py`**

Change `ProcessMapGenerateRequest.segment_id` to `process_id`:

```python
    process_id: UUID | None = None
```

(delete the `segment_id: UUID | None = None` line).

Add a new request model after `ProcessMapGenerateResult`:

```python
class ProcessMapAttachRequest(BaseModel):
    process_id: UUID | None = None  # null detaches
```

Replace `ProcessModelRead`'s two source fields:

```python
    latest_source_segment_id: UUID | None = None
    latest_source_run_status: str | None = None
```

with:

```python
    process_id: UUID | None = None
    process_name: str | None = None
    unreconciled_claim_count: int = 0
```

- [ ] **Step 2: Write the failing test**

Delete the old one and create `backend/tests/test_generate_map_with_process.py`:

```python
"""generate-process-map scopes claims to a process; list_process_maps surfaces
process info + unreconciled_claim_count; attach/detach toggles process_id."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project
from app.services.process_generation import GeneratedStructure


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    in_proc = Claim(project_id=proj.id, kind="task", subject="In process", normalized={}, confidence=0.9, source="extracted")
    out_proc = Claim(project_id=proj.id, kind="task", subject="Not in process", normalized={}, confidence=0.9, source="extracted")
    db.add_all([in_proc, out_proc]); db.flush()
    proc = Process(project_id=proj.id, name="O2C", status="active"); db.add(proc); db.flush()
    db.add(ProcessClaimLink(process_id=proc.id, claim_id=in_proc.id, assigned_by="user"))
    db.commit()
    return proj, proc, in_proc, out_proc


def test_generate_scopes_claims_to_process_and_stamps_model(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    structure = GeneratedStructure(
        process_name="O2C",
        steps=[{"id": "s1", "name": "Do thing", "role": "Ops", "type": "userTask", "claim_refs": [0]}],
        gateways=[],
    )
    captured = {}

    def _fake_generate(claim_payload, **kwargs):
        captured["claims"] = claim_payload
        return structure

    with patch("app.api.v2.process_maps.generate_structure_from_claims", side_effect=_fake_generate):
        r = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "O2C", "level": "2", "process_id": str(proc.id)},
        )
    assert r.status_code == 201, r.text
    # Only the linked claim was sent to Claude.
    assert [c["subject"] for c in captured["claims"]] == ["In process"]

    # The model is stamped with process_id.
    from app.models.process import ProcessModel
    model = db.get(ProcessModel, r.json()["model_id"])
    assert model.process_id == proc.id


def test_list_process_maps_reports_process_and_unreconciled_count(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    # Link a second claim to the process so it's "in process but uncited".
    db.add(ProcessClaimLink(process_id=proc.id, claim_id=out_proc.id, assigned_by="user"))
    db.commit()
    structure = GeneratedStructure(
        process_name="O2C",
        steps=[{"id": "s1", "name": "Do thing", "role": "Ops", "type": "userTask", "claim_refs": [0]}],
        gateways=[],
    )
    with patch("app.api.v2.process_maps.generate_structure_from_claims", return_value=structure):
        client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "O2C", "level": "2", "process_id": str(proc.id)},
        )
    rows = client.get(f"/api/v2/projects/{proj.id}/process-maps").json()
    assert len(rows) == 1
    assert rows[0]["process_id"] == str(proc.id)
    assert rows[0]["process_name"] == "O2C"
    # in_proc is cited by the generated node; out_proc is linked but uncited → 1.
    assert rows[0]["unreconciled_claim_count"] == 1


def test_attach_and_detach_process(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    structure = GeneratedStructure(
        process_name="Blank", steps=[{"id": "s1", "name": "x", "role": "Ops", "type": "userTask", "claim_refs": []}], gateways=[]
    )
    with patch("app.api.v2.process_maps.generate_structure_from_claims", return_value=structure):
        model_id = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "Blank", "level": "2"},
        ).json()["model_id"]

    r = client.patch(f"/api/v2/projects/{proj.id}/process-maps/{model_id}", json={"process_id": str(proc.id)})
    assert r.status_code == 200, r.text
    assert r.json()["process_id"] == str(proc.id)

    r = client.patch(f"/api/v2/projects/{proj.id}/process-maps/{model_id}", json={"process_id": None})
    assert r.status_code == 200
    assert r.json()["process_id"] is None
```

```bash
git rm backend/tests/test_generate_map_with_segment.py
```

- [ ] **Step 3: Run, expect failure**

```
cd backend && pytest tests/test_generate_map_with_process.py -v
```

Expected: import error from `process_maps.py` (still references deleted detection models) + route mismatches.

- [ ] **Step 4: Rewrite the `generate_process_map` claim-loading branch**

In `backend/app/api/v2/process_maps.py`, replace the entire `if payload.segment_id is not None: ... elif payload.scope_input_ids:` block (lines ~128–163) with:

```python
    if payload.process_id is not None:
        from app.models.process_inventory import Process, ProcessClaimLink

        process = db.get(Process, payload.process_id)
        if (
            process is None
            or process.project_id != project.id
            or process.deleted_at is not None
        ):
            raise HTTPException(status_code=404, detail="Process not found")
        claim_query = claim_query.join(
            ProcessClaimLink, ProcessClaimLink.claim_id == Claim.id
        ).where(ProcessClaimLink.process_id == payload.process_id)
    elif payload.scope_input_ids:
        from app.models.claim import ClaimCitation

        claim_query = (
            claim_query.join(ClaimCitation, ClaimCitation.claim_id == Claim.id)
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .where(DocumentSection.input_id.in_(payload.scope_input_ids))
            .distinct()
        )
```

In the `ProcessVersion(...)` construction (~line 230), delete the `source_segment_id=payload.segment_id,` keyword. After `db.add(version)` / the model find-or-create, stamp the model with the process id. Add right after the `if model is None: ... db.flush()` block (after line ~215), so it runs whether the model is new or reused:

```python
    if payload.process_id is not None:
        model.process_id = payload.process_id
```

- [ ] **Step 5: Rewrite `list_process_maps`**

Replace the body from the `from app.models.process_detection import DetectionRun, ProcessSegment` line through the `return [...]` (lines ~433–466) with:

```python
    from app.models.process_inventory import Process, ProcessClaimLink

    model_ids = [m.id for m in models]

    # Latest version per model (highest version_number) via DISTINCT ON.
    latest_rows = db.execute(
        select(ProcessVersion.model_id, ProcessVersion.id, ProcessVersion.version_number)
        .where(ProcessVersion.model_id.in_(model_ids))
        .order_by(ProcessVersion.model_id, ProcessVersion.version_number.desc())
        .distinct(ProcessVersion.model_id)
    ).all()
    latest_by_model: dict = {row[0]: (row[1], row[2]) for row in latest_rows}

    # Process name per model (process_id may be NULL for unlinked maps).
    proc_ids = [m.process_id for m in models if m.process_id is not None]
    proc_name_by_id: dict = {}
    if proc_ids:
        proc_name_by_id = {
            r[0]: r[1]
            for r in db.execute(
                select(Process.id, Process.name).where(Process.id.in_(proc_ids))
            ).all()
        }

    # Unreconciled claim count per model: claims linked to the model's process
    # but NOT cited by any node in the model's LATEST version. Computed per
    # model because the "latest version" differs per model.
    def _unreconciled(model: ProcessModel) -> int:
        if model.process_id is None:
            return 0
        latest = latest_by_model.get(model.id)
        if latest is None:
            # Process has links but no version yet — all linked claims are unreconciled.
            return db.scalar(
                select(func.count(ProcessClaimLink.id)).where(
                    ProcessClaimLink.process_id == model.process_id
                )
            ) or 0
        version_id = latest[0]
        cited_subq = (
            select(NodeClaimLink.claim_id)
            .join(ProcessNode, ProcessNode.id == NodeClaimLink.node_id)
            .where(ProcessNode.version_id == version_id)
        )
        return db.scalar(
            select(func.count(ProcessClaimLink.id))
            .where(
                ProcessClaimLink.process_id == model.process_id,
                ProcessClaimLink.claim_id.notin_(cited_subq),
            )
        ) or 0

    return [
        ProcessModelRead.model_validate(m).model_copy(
            update={
                "latest_version_id": latest_by_model.get(m.id, (None, None))[0],
                "latest_version_number": latest_by_model.get(m.id, (None, None))[1],
                "process_id": m.process_id,
                "process_name": proc_name_by_id.get(m.process_id),
                "unreconciled_claim_count": int(_unreconciled(m)),
            }
        )
        for m in models
    ]
```

> `NodeClaimLink` and `ProcessNode` are already imported at the top of `process_maps.py` (`from app.models.process import (...)`). `func` is imported from `sqlalchemy`.

- [ ] **Step 6: Add the attach/detach endpoint**

Append after `list_process_maps` (before `_check_node_in_project`), and add `ProcessMapAttachRequest` to the `from app.schemas.process_map import (...)` block at the top:

```python
@router.patch("/process-maps/{model_id}", response_model=ProcessModelRead)
def attach_process_to_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    payload: ProcessMapAttachRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessModelRead:
    """Attach (or detach, with process_id=null) a process to an existing map.
    Used to re-home migrated 'unlinked maps' onto a process."""
    from app.models.process_inventory import Process

    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id or model.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process map not found")
    if payload.process_id is not None:
        proc = db.get(Process, payload.process_id)
        if proc is None or proc.project_id != project.id or proc.deleted_at is not None:
            raise HTTPException(status_code=404, detail="Process not found")
    model.process_id = payload.process_id
    db.commit()
    db.refresh(model)
    proc_name = None
    if model.process_id is not None:
        proc = db.get(Process, model.process_id)
        proc_name = proc.name if proc else None
    return ProcessModelRead.model_validate(model).model_copy(
        update={"process_id": model.process_id, "process_name": proc_name}
    )
```

- [ ] **Step 7: Run, expect green; then verify the full API package imports**

```
cd backend && pytest tests/test_generate_map_with_process.py -v
```

Expected: 3 passed.

```
cd backend && python -c "from app.api.v2 import router; print('api ok')"
```

Expected stdout: `api ok` (the detection import is fully gone now).

- [ ] **Step 8: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_generate_map_with_process.py
git commit -m "feat(sp7b): generate-by-process, map attach/detach, list rewrite with unreconciled count"
```

---

## Task 10: Delete obsolete detection tests; Postgres-backed migration test

**Files:**
- Delete: `backend/tests/test_process_detection_api.py`, `backend/tests/test_process_detection_service.py`, `backend/tests/test_process_detection_heuristic.py`, `backend/tests/test_detection_end_to_end.py`, `backend/tests/test_migration_round_trip.py`
- Create: `backend/tests/test_inventory_migration.py`

> Note on the migration test environment: `conftest.py` provisions a **real Postgres** `poet_test` database on `localhost:5433` and runs `alembic upgrade head` once per session — there is no SQLite path. So the migration test can seed against the same engine. Because the conftest already upgraded to head (past `0009`, where the detection tables are dropped), the test must first `alembic downgrade` to `0008`, seed the legacy tables, then `alembic upgrade head` and assert. A guard skips the test if Postgres is unreachable.

- [ ] **Step 1: Delete the obsolete detection tests**

```bash
git rm backend/tests/test_process_detection_api.py backend/tests/test_process_detection_service.py backend/tests/test_process_detection_heuristic.py backend/tests/test_detection_end_to_end.py backend/tests/test_migration_round_trip.py
```

- [ ] **Step 2: Write the migration test**

Create `backend/tests/test_inventory_migration.py`:

```python
"""Postgres-backed test for migration 0009's data step.

Strategy: the session conftest already upgraded poet_test to head (0009),
where the detection tables are gone. This test downgrades to 0008, seeds an
ACCEPTED detection run with two real segments + memberships and a map whose
version points at one segment, upgrades to head, and asserts the data carried
over: 2 processes, links with assigned_by='inherited', and the map re-linked.
Skips if Postgres on localhost:5433 is unreachable."""
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_URL = "postgresql+psycopg://poet:poet@localhost:5433/poet_test"


def _alembic(target: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = TEST_URL
    alembic_bin = BACKEND_DIR / ".venv" / "bin" / "alembic"
    subprocess.run([str(alembic_bin), target.split()[0], *target.split()[1:]],
                   cwd=BACKEND_DIR, env=env, check=True)


@pytest.fixture()
def pg_engine():
    try:
        engine = create_engine(TEST_URL, pool_pre_ping=True, future=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError:
        pytest.skip("Postgres on localhost:5433 not reachable; skipping migration test.")
    yield engine
    engine.dispose()


def test_data_migration_carries_segments_links_and_map(pg_engine):
    # Start from a clean head, then go back to before this migration.
    _alembic("downgrade 0008_claim_source_and_conflict_reason")
    try:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        proj_id = uuid.uuid4()
        run_id = uuid.uuid4()
        seg_id = uuid.uuid4()
        unassigned_seg_id = uuid.uuid4()
        c1, c2, c3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        model_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with pg_engine.begin() as conn:
            conn.execute(text("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (:id, 't', now(), now())"), {"id": org_id})
            conn.execute(text("INSERT INTO users (id, email, name, org_id, created_at, updated_at) VALUES (:id, 'dev@local', 'dev', :org, now(), now())"), {"id": user_id, "org": org_id})
            conn.execute(text("INSERT INTO projects (id, name, org_id, status, created_at, updated_at) VALUES (:id, 'p', :org, 'active', now(), now())"), {"id": proj_id, "org": org_id})
            for cid, subj in [(c1, "AP a"), (c2, "AP b"), (c3, "ambient")]:
                conn.execute(text("INSERT INTO claims (id, project_id, kind, subject, normalized, confidence, source, created_at, updated_at) VALUES (:id, :p, 'task', :s, '{}'::jsonb, 0.9, 'extracted', now(), now())"), {"id": cid, "p": proj_id, "s": subj})
            conn.execute(text("INSERT INTO detection_runs (id, project_id, status, claim_count_at_run, claim_id_set, created_at, updated_at) VALUES (:id, :p, 'accepted', 3, '[]'::jsonb, now(), now())"), {"id": run_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_segments (id, detection_run_id, project_id, name, description, order_index, claim_count, is_unassigned, created_at, updated_at) VALUES (:id, :r, :p, 'Accounts Payable', 'ap', 0, 2, false, now(), now())"), {"id": seg_id, "r": run_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_segments (id, detection_run_id, project_id, name, description, order_index, claim_count, is_unassigned, created_at, updated_at) VALUES (:id, :r, :p, 'Unassigned', '', 10000, 1, true, now(), now())"), {"id": unassigned_seg_id, "r": run_id, "p": proj_id})
            for cid, sid in [(c1, seg_id), (c2, seg_id), (c3, unassigned_seg_id)]:
                conn.execute(text("INSERT INTO claim_segment_memberships (id, claim_id, segment_id, detection_run_id, created_at) VALUES (:id, :c, :s, :r, now())"), {"id": uuid.uuid4(), "c": cid, "s": sid, "r": run_id})
            conn.execute(text("INSERT INTO process_models (id, project_id, name, level, created_at, updated_at) VALUES (:id, :p, 'AP map', 'L2', now(), now())"), {"id": model_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_versions (id, model_id, version_number, status, source_segment_id, created_at, updated_at) VALUES (:id, :m, 1, 'draft', :seg, now(), now())"), {"id": version_id, "m": model_id, "seg": seg_id})

        # Run the migration under test.
        _alembic("upgrade head")

        with pg_engine.connect() as conn:
            proc_count = conn.execute(text("SELECT count(*) FROM processes WHERE project_id = :p"), {"p": proj_id}).scalar()
            assert proc_count == 1  # only the non-unassigned segment

            proc_id = conn.execute(text("SELECT id FROM processes WHERE project_id = :p"), {"p": proj_id}).scalar()
            assert proc_id == seg_id  # migration reuses the segment id

            link_rows = conn.execute(text("SELECT claim_id, assigned_by FROM process_claim_links WHERE process_id = :pid ORDER BY claim_id"), {"pid": proc_id}).fetchall()
            assert {r[0] for r in link_rows} == {c1, c2}
            assert all(r[1] == "inherited" for r in link_rows)

            mapped_proc = conn.execute(text("SELECT process_id FROM process_models WHERE id = :m"), {"m": model_id}).scalar()
            assert mapped_proc == proc_id

            # source_segment_id and the detection tables are gone.
            col = conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='process_versions' AND column_name='source_segment_id'")).fetchone()
            assert col is None
            tbls = conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('detection_runs','process_segments','claim_segment_memberships')")).fetchall()
            assert tbls == []
    finally:
        # Leave the DB at head so the rest of the suite (which assumes head) is happy.
        _alembic("upgrade head")
```

> The `_alembic` helper passes `downgrade <rev>` / `upgrade head` straight through to the alembic CLI. The seed uses raw SQL (not ORM) on purpose: the ORM models for the detection tables are deleted, so they cannot be imported. This test runs serially and mutates the shared `poet_test` schema, so it must restore head in a `finally` — other tests in the session depend on head.

- [ ] **Step 3: Run the migration test**

```
cd backend && pytest tests/test_inventory_migration.py -v
```

Expected: 1 passed (or 1 skipped if Postgres is down).

- [ ] **Step 4: Run the whole backend suite to confirm no dangling detection references**

```
cd backend && pytest -q
```

Expected: all green. If any test errors on importing `app.models.process_detection` or `app.schemas.process_detection`, that test was missed in the deletions — find and remove/rewire it.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_inventory_migration.py
git commit -m "test(sp7b): postgres migration test; drop obsolete detection tests"
```

---

## Task 11: Frontend types + api client surface

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Edit `src/lib/types.ts`**

Delete the four detection interfaces (`ProcessSegment`, `DetectionRunDetail`, `DetectionRunListRow`, `AcceptDetectionRunResult`, `DetectProcessesRequest`).

Update `ProcessModel`: delete `latest_source_segment_id` and `latest_source_run_status`, add:

```typescript
  process_id?: UUID | null;
  process_name?: string | null;
  unreconciled_claim_count?: number;
```

Add the new surface (place near the other process types):

```typescript
export interface Process {
  id: UUID;
  project_id: UUID;
  name: string;
  description: string;
  order_index: number;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  claim_count: number;
  map_count: number;
}

export interface TriageClaim {
  id: UUID;
  kind: string;
  subject: string;
  source: string;
}

export interface ProcessSuggestion {
  id: UUID;
  batch_id: UUID;
  project_id: UUID;
  kind: "process_discovery" | "map_reconcile";
  process_id: UUID | null;
  version_id: UUID | null;
  op: string;
  payload: Record<string, unknown>;
  rationale: string;
  confidence: number | null;
  status: "pending" | "accepted" | "rejected";
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SuggestBatchResult {
  batch_id: UUID;
  suggestion_count: number;
}

export interface AcceptSuggestionResult {
  suggestion_id: UUID;
  status: string;
  outcome: string;
  process_id?: UUID | null;
  linked?: number;
}

export interface BatchAcceptResult {
  batch_id: UUID;
  accepted: number;
  skipped: number;
}
```

Update `ProcessMapGenerateRequest` (find it in this file): replace `segment_id?: UUID | null;` with `process_id?: UUID | null;`.

- [ ] **Step 2: Edit `src/lib/api.ts`**

Delete the entire `// Process detection` block (the 9 methods: `detectProcesses`, `listDetectionRuns`, `getDetectionRun`, `updateSegment`, `createSegment`, `mergeSegment`, `deleteSegment`, `moveClaimToSegment`, `acceptDetectionRun`, `discardDetectionRun`).

Add a new block before the closing `};` of `api`:

```typescript
  // Process inventory
  listProcesses: (projectId: UUID) =>
    request<Process[]>(`/api/v2/projects/${projectId}/processes`),
  createProcess: (projectId: UUID, body: { name: string; description?: string }) =>
    request<Process>(`/api/v2/projects/${projectId}/processes`, {
      method: "POST",
      json: body,
    }),
  updateProcess: (
    projectId: UUID,
    processId: UUID,
    body: { name?: string; description?: string; order_index?: number; status?: string }
  ) =>
    request<Process>(`/api/v2/projects/${projectId}/processes/${processId}`, {
      method: "PATCH",
      json: body,
    }),
  deleteProcess: (projectId: UUID, processId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/processes/${processId}`, {
      method: "DELETE",
    }),
  assignClaims: (projectId: UUID, processId: UUID, claimIds: UUID[]) =>
    request<{ process_id: UUID; linked: number; already_linked: number }>(
      `/api/v2/projects/${projectId}/processes/${processId}/claims`,
      { method: "POST", json: { claim_ids: claimIds } }
    ),
  unassignClaims: (projectId: UUID, processId: UUID, claimIds: UUID[]) =>
    request<{ process_id: UUID; removed: number }>(
      `/api/v2/projects/${projectId}/processes/${processId}/claims`,
      { method: "DELETE", json: { claim_ids: claimIds } }
    ),
  listUnassignedClaims: (projectId: UUID) =>
    request<TriageClaim[]>(`/api/v2/projects/${projectId}/claims/unassigned`),

  // AI suggestions
  suggestProcesses: (projectId: UUID, body: { scope_input_ids?: UUID[] | null } = {}) =>
    request<SuggestBatchResult>(`/api/v2/projects/${projectId}/suggest-processes`, {
      method: "POST",
      json: body,
    }),
  listSuggestions: (
    projectId: UUID,
    params: { status?: string; kind?: string } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.kind) qs.set("kind", params.kind);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<ProcessSuggestion[]>(
      `/api/v2/projects/${projectId}/process-suggestions${suffix}`
    );
  },
  acceptSuggestion: (projectId: UUID, suggestionId: UUID) =>
    request<AcceptSuggestionResult>(
      `/api/v2/projects/${projectId}/process-suggestions/${suggestionId}/accept`,
      { method: "POST" }
    ),
  rejectSuggestion: (projectId: UUID, suggestionId: UUID) =>
    request<AcceptSuggestionResult>(
      `/api/v2/projects/${projectId}/process-suggestions/${suggestionId}/reject`,
      { method: "POST" }
    ),
  acceptSuggestionBatch: (projectId: UUID, batchId: UUID) =>
    request<BatchAcceptResult>(
      `/api/v2/projects/${projectId}/process-suggestion-batches/${batchId}/accept`,
      { method: "POST" }
    ),

  // Map ↔ process wiring
  attachMapToProcess: (projectId: UUID, modelId: UUID, processId: UUID | null) =>
    request<ProcessModel>(
      `/api/v2/projects/${projectId}/process-maps/${modelId}`,
      { method: "PATCH", json: { process_id: processId } }
    ),
```

Update `generateProcessMap`: it already passes the `ProcessMapGenerateRequest` payload through; no body change needed (the type now carries `process_id`). Update the import line at the top of `api.ts` to add the new types: `Process`, `TriageClaim`, `ProcessSuggestion`, `SuggestBatchResult`, `AcceptSuggestionResult`, `BatchAcceptResult`, and remove `DetectionRunDetail`, `DetectionRunListRow`, `AcceptDetectionRunResult`, `DetectProcessesRequest`, `ProcessSegment` from it.

- [ ] **Step 3: Typecheck**

```
npm run tsc 2>/dev/null || npx tsc --noEmit
```

Expected: this will surface errors in `processes/page.tsx`, `maps/page.tsx`, `generate-map-form.tsx`, and `detect-processes-button.tsx` that still reference removed methods/types. Those are fixed in Tasks 12–16. Confirm `api.ts` and `types.ts` themselves have no errors (the remaining errors are all in the consuming components).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(sp7b): frontend types + api client for inventory/suggestions"
```

---

## Task 12: Pure logic modules — triage selection + inbox grouping (Vitest)

**Files:**
- Create: `src/components/inventory/triage-selection.ts`
- Create: `src/components/inventory/triage-selection.test.ts`
- Create: `src/components/inventory/inbox-grouping.ts`
- Create: `src/components/inventory/inbox-grouping.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/inventory/triage-selection.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { toggleSelection, selectAll, clearSelection, isSelected } from "./triage-selection";

describe("triage selection state", () => {
  it("toggles a single id on and off", () => {
    let sel = new Set<string>();
    sel = toggleSelection(sel, "a");
    expect(isSelected(sel, "a")).toBe(true);
    sel = toggleSelection(sel, "a");
    expect(isSelected(sel, "a")).toBe(false);
  });

  it("does not mutate the input set", () => {
    const sel = new Set<string>(["a"]);
    const next = toggleSelection(sel, "b");
    expect(sel.has("b")).toBe(false);
    expect(next.has("b")).toBe(true);
  });

  it("selectAll adds every id; clearSelection empties", () => {
    const all = selectAll(["a", "b", "c"]);
    expect(all.size).toBe(3);
    expect(clearSelection().size).toBe(0);
  });
});
```

Create `src/components/inventory/inbox-grouping.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { groupByBatch } from "./inbox-grouping";
import type { ProcessSuggestion } from "@/lib/types";

function sug(partial: Partial<ProcessSuggestion>): ProcessSuggestion {
  return {
    id: "s",
    batch_id: "b1",
    project_id: "p",
    kind: "process_discovery",
    process_id: null,
    version_id: null,
    op: "create_process",
    payload: {},
    rationale: "",
    confidence: null,
    status: "pending",
    outcome: null,
    created_at: "2026-06-11T00:00:00Z",
    resolved_at: null,
    ...partial,
  };
}

describe("groupByBatch", () => {
  it("groups suggestions by batch_id, newest batch first", () => {
    const groups = groupByBatch([
      sug({ id: "1", batch_id: "old", created_at: "2026-06-10T00:00:00Z" }),
      sug({ id: "2", batch_id: "new", created_at: "2026-06-11T00:00:00Z" }),
      sug({ id: "3", batch_id: "new", created_at: "2026-06-11T00:01:00Z" }),
    ]);
    expect(groups.map((g) => g.batchId)).toEqual(["new", "old"]);
    expect(groups[0].suggestions.map((s) => s.id)).toEqual(["2", "3"]);
  });

  it("counts pending per batch", () => {
    const groups = groupByBatch([
      sug({ id: "1", batch_id: "b", status: "pending" }),
      sug({ id: "2", batch_id: "b", status: "accepted" }),
    ]);
    expect(groups[0].pendingCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```
npx vitest run src/components/inventory/triage-selection.test.ts src/components/inventory/inbox-grouping.test.ts
```

Expected: module-not-found for both `./triage-selection` and `./inbox-grouping`.

- [ ] **Step 3: Implement**

Create `src/components/inventory/triage-selection.ts`:

```typescript
/** Pure helpers for the multi-select state in the claim triage panel.
 * The selection is a Set<UUID>; every helper returns a NEW set so React
 * state updates stay referentially honest. */

export function toggleSelection(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function selectAll(ids: string[]): Set<string> {
  return new Set(ids);
}

export function clearSelection(): Set<string> {
  return new Set();
}

export function isSelected(current: Set<string>, id: string): boolean {
  return current.has(id);
}
```

Create `src/components/inventory/inbox-grouping.ts`:

```typescript
import type { ProcessSuggestion } from "@/lib/types";

export interface SuggestionBatch {
  batchId: string;
  suggestions: ProcessSuggestion[];
  pendingCount: number;
  /** Earliest created_at across the batch's suggestions (used for ordering). */
  createdAt: string;
}

/** Group suggestions by batch_id. Within a batch, suggestions keep
 * created_at order; batches are returned newest-first by their earliest
 * created_at. */
export function groupByBatch(suggestions: ProcessSuggestion[]): SuggestionBatch[] {
  const byBatch = new Map<string, ProcessSuggestion[]>();
  for (const s of suggestions) {
    const arr = byBatch.get(s.batch_id) ?? [];
    arr.push(s);
    byBatch.set(s.batch_id, arr);
  }
  const batches: SuggestionBatch[] = [];
  for (const [batchId, list] of byBatch) {
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    batches.push({
      batchId,
      suggestions: sorted,
      pendingCount: sorted.filter((s) => s.status === "pending").length,
      createdAt: sorted[0]?.created_at ?? "",
    });
  }
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return batches;
}
```

- [ ] **Step 4: Run, expect green**

```
npx vitest run src/components/inventory/triage-selection.test.ts src/components/inventory/inbox-grouping.test.ts
```

Expected: all tests pass (3 + 2).

- [ ] **Step 5: Commit**

```bash
git add src/components/inventory/triage-selection.ts src/components/inventory/triage-selection.test.ts src/components/inventory/inbox-grouping.ts src/components/inventory/inbox-grouping.test.ts
git commit -m "feat(sp7b): pure triage-selection + inbox-grouping modules with vitest"
```

---

## Task 13: Inventory components — process-list, bulk-assign-popover, claim-triage-panel, suggestion-inbox

**Files:**
- Create: `src/components/inventory/process-list.tsx`
- Create: `src/components/inventory/bulk-assign-popover.tsx`
- Create: `src/components/inventory/claim-triage-panel.tsx`
- Create: `src/components/inventory/suggestion-inbox.tsx`

- [ ] **Step 1: Create `process-list.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { Process, UUID } from "@/lib/types";

export function ProcessList({
  projectId,
  processes,
}: {
  projectId: UUID;
  processes: Process[];
}) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<UUID | null>(null);
  const [editName, setEditName] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["processes", projectId] });
    qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
  };

  const create = useMutation({
    mutationFn: (name: string) => api.createProcess(projectId, { name }),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: UUID; name: string }) =>
      api.updateProcess(projectId, id, { name }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(`Rename failed: ${e.message}`),
  });

  const archive = useMutation({
    mutationFn: (id: UUID) => api.updateProcess(projectId, id, { status: "archived" }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Archive failed: ${e.message}`),
  });

  const active = processes.filter((p) => p.status === "active");

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate(newName.trim());
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New process name (e.g. Order to Cash)"
          maxLength={300}
        />
        <Button type="submit" disabled={!newName.trim() || create.isPending}>
          Add process
        </Button>
      </form>

      <ul className="space-y-2">
        {active.map((p) => (
          <li key={p.id} className="flex items-center justify-between rounded border p-3">
            {editingId === p.id ? (
              <form
                className="flex flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (editName.trim()) rename.mutate({ id: p.id, name: editName.trim() });
                }}
              >
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus maxLength={300} />
                <Button type="submit" size="sm" disabled={rename.isPending}>Save</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.claim_count} claim{p.claim_count === 1 ? "" : "s"} · {p.map_count} map{p.map_count === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(p.id);
                      setEditName(p.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`Archive "${p.name}"? Its claim links stay intact; it's hidden from the active list.`)) {
                        archive.mutate(p.id);
                      }
                    }}
                  >
                    Archive
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
        {active.length === 0 && (
          <li className="rounded border border-dashed p-3 text-sm text-muted-foreground">
            No processes yet. Add one above, or use Suggest processes to have AI propose them.
          </li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Create `bulk-assign-popover.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { Process, UUID } from "@/lib/types";

/** Assign the given claim ids to one or more processes (multi-select).
 * Each chosen process gets a bulk assign call. */
export function BulkAssignPopover({
  projectId,
  processes,
  claimIds,
  onAssigned,
}: {
  projectId: UUID;
  processes: Process[];
  claimIds: UUID[];
  onAssigned: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<UUID>>(new Set());

  const assign = useMutation({
    mutationFn: async () => {
      for (const pid of chosen) {
        await api.assignClaims(projectId, pid, claimIds);
      }
    },
    onSuccess: () => {
      toast.success(`Assigned ${claimIds.length} claim(s) to ${chosen.size} process(es).`);
      qc.invalidateQueries({ queryKey: ["processes", projectId] });
      qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
      setChosen(new Set());
      setOpen(false);
      onAssigned();
    },
    onError: (e: Error) => toast.error(`Assign failed: ${e.message}`),
  });

  const active = processes.filter((p) => p.status === "active");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={claimIds.length === 0}>
          Assign {claimIds.length} selected…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <p className="text-xs text-muted-foreground">Assign to one or more processes:</p>
        <ul className="max-h-56 space-y-1 overflow-auto">
          {active.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(p.id)}
                  onChange={() => {
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    });
                  }}
                />
                {p.name}
              </label>
            </li>
          ))}
          {active.length === 0 && (
            <li className="text-xs text-muted-foreground">No active processes. Add one first.</li>
          )}
        </ul>
        <Button
          size="sm"
          className="w-full"
          disabled={chosen.size === 0 || assign.isPending}
          onClick={() => assign.mutate()}
        >
          {assign.isPending ? "Assigning…" : "Assign"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
```

> If `src/components/ui/popover.tsx` does not exist, scaffold it with `npx shadcn@latest add popover` before this step. Verify with `ls src/components/ui/popover.tsx`.

- [ ] **Step 3: Create `claim-triage-panel.tsx`**

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BulkAssignPopover } from "./bulk-assign-popover";
import { toggleSelection, selectAll, clearSelection } from "./triage-selection";
import type { Process, TriageClaim, UUID } from "@/lib/types";

export function ClaimTriagePanel({
  projectId,
  processes,
  claims,
}: {
  projectId: UUID;
  processes: Process[];
  claims: TriageClaim[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Unassigned claims{" "}
          <span className="text-muted-foreground">({claims.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(selectAll(claims.map((c) => c.id)))}
            disabled={claims.length === 0}
          >
            Select all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(clearSelection())} disabled={selected.size === 0}>
            Clear
          </Button>
          <BulkAssignPopover
            projectId={projectId}
            processes={processes}
            claimIds={[...selected] as UUID[]}
            onAssigned={() => setSelected(clearSelection())}
          />
        </div>
      </div>

      <ul className="max-h-[28rem] space-y-1 overflow-auto">
        {claims.map((c) => (
          <li key={c.id}>
            <label className="flex items-start gap-2 rounded p-2 text-sm hover:bg-muted/40">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(c.id)}
                onChange={() => setSelected((prev) => toggleSelection(prev, c.id))}
              />
              <span className="flex-1">
                <span className="text-muted-foreground">[{c.kind}]</span> {c.subject}
              </span>
              {c.source === "manual" && <Badge variant="outline">manual</Badge>}
            </label>
          </li>
        ))}
        {claims.length === 0 && (
          <li className="p-2 text-sm text-muted-foreground">
            Every claim is assigned to at least one process. Nothing to triage.
          </li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Create `suggestion-inbox.tsx`**

```tsx
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { groupByBatch } from "./inbox-grouping";
import { api } from "@/lib/api";
import type { ProcessSuggestion, UUID } from "@/lib/types";

/** Reusable per-item accept/reject diff surface, grouped by batch. Phase 2
 * uses it for process_discovery; sp7c reuses it for map_reconcile on the
 * canvas. */
export function SuggestionInbox({
  projectId,
  suggestions,
}: {
  projectId: UUID;
  suggestions: ProcessSuggestion[];
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
    qc.invalidateQueries({ queryKey: ["processes", projectId] });
    qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
  };

  const accept = useMutation({
    mutationFn: (id: UUID) => api.acceptSuggestion(projectId, id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });
  const reject = useMutation({
    mutationFn: (id: UUID) => api.rejectSuggestion(projectId, id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Reject failed: ${e.message}`),
  });
  const acceptBatch = useMutation({
    mutationFn: (batchId: UUID) => api.acceptSuggestionBatch(projectId, batchId),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Accept all failed: ${e.message}`),
  });

  const batches = groupByBatch(suggestions);
  if (batches.length === 0) return null;

  return (
    <div className="space-y-4">
      {batches.map((batch) => (
        <div key={batch.batchId} className="rounded border">
          <div className="flex items-center justify-between border-b p-2">
            <span className="text-sm font-medium">
              Suggestion batch · {batch.pendingCount} pending
            </span>
            {batch.pendingCount > 0 && (
              <Button
                size="sm"
                onClick={() => acceptBatch.mutate(batch.batchId as UUID)}
                disabled={acceptBatch.isPending}
              >
                Accept all
              </Button>
            )}
          </div>
          <ul className="divide-y">
            {batch.suggestions.map((s) => {
              const name = (s.payload as { name?: string }).name ?? s.op;
              const claimIds = (s.payload as { claim_ids?: string[] }).claim_ids ?? [];
              return (
                <li key={s.id} className="flex items-start justify-between gap-2 p-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {s.op === "create_process" ? "Create process: " : "Assign claims to: "}
                      {name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {claimIds.length} claim(s)
                      {s.confidence != null && ` · confidence ${(s.confidence * 100).toFixed(0)}%`}
                    </div>
                    {s.rationale && (
                      <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                    )}
                  </div>
                  {s.status === "pending" ? (
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => accept.mutate(s.id)} disabled={accept.isPending}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => reject.mutate(s.id)} disabled={reject.isPending}>
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <Badge variant={s.status === "accepted" ? "default" : "secondary"}>
                      {s.status}
                      {s.outcome === "target_gone" ? " (target gone)" : ""}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck the new components**

```
npx tsc --noEmit
```

Expected: no errors in the four new files (consuming-page errors remain until Task 14).

- [ ] **Step 6: Commit**

```bash
git add src/components/inventory/process-list.tsx src/components/inventory/bulk-assign-popover.tsx src/components/inventory/claim-triage-panel.tsx src/components/inventory/suggestion-inbox.tsx
git commit -m "feat(sp7b): inventory UI components (list, bulk-assign, triage, inbox)"
```

---

## Task 14: Rewrite the Processes page

**Files:**
- Modify: `src/app/(app)/projects/[id]/processes/page.tsx`

- [ ] **Step 1: Replace the file entirely**

```tsx
"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ProcessList } from "@/components/inventory/process-list";
import { ClaimTriagePanel } from "@/components/inventory/claim-triage-panel";
import { SuggestionInbox } from "@/components/inventory/suggestion-inbox";
import { api } from "@/lib/api";

export default function ProcessesPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const processesQuery = useQuery({
    queryKey: ["processes", projectId],
    queryFn: () => api.listProcesses(projectId),
  });
  const unassignedQuery = useQuery({
    queryKey: ["unassigned", projectId],
    queryFn: () => api.listUnassignedClaims(projectId),
  });
  const suggestionsQuery = useQuery({
    queryKey: ["suggestions", projectId],
    queryFn: () => api.listSuggestions(projectId, { status: "pending" }),
  });

  const suggest = useMutation({
    mutationFn: () => api.suggestProcesses(projectId, {}),
    onSuccess: (res) => {
      toast.success(`AI proposed ${res.suggestion_count} process(es). Review below.`);
      qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
    },
    onError: (e: Error) => toast.error(`Suggest failed: ${e.message}`),
  });

  if (processesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (processesQuery.error) {
    return <p className="text-sm text-red-600">{(processesQuery.error as Error).message}</p>;
  }

  const processes = processesQuery.data ?? [];
  const unassigned = unassignedQuery.data ?? [];
  const suggestions = suggestionsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Your process inventory. Create processes top-down and curate claims into
          them, or let AI suggest processes from the claims and accept the ones you
          want. Maps are generated per process on the Maps tab.
        </p>
        <Button onClick={() => suggest.mutate()} disabled={suggest.isPending}>
          {suggest.isPending ? "Suggesting…" : "Suggest processes"}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">AI suggestions</h2>
          <SuggestionInbox projectId={projectId} suggestions={suggestions} />
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Processes</h2>
          <ProcessList projectId={projectId} processes={processes} />
        </section>
        <aside>
          <ClaimTriagePanel projectId={projectId} processes={processes} claims={unassigned} />
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```
npx tsc --noEmit
```

Expected: `processes/page.tsx` now clean. Remaining errors only in `maps/page.tsx`, `generate-map-form.tsx`, and the to-be-deleted `detect-processes-button.tsx` / `detect/*`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/processes/page.tsx"
git commit -m "feat(sp7b): rewrite Processes page as durable inventory + triage + inbox"
```

---

## Task 15: Generate-map-form process picker; delete detect components

**Files:**
- Modify: `src/components/generate-map-form.tsx`
- Delete: `src/components/detect/*`, `src/components/detect-processes-button.tsx`

- [ ] **Step 1: Swap the segment picker for a process picker in `generate-map-form.tsx`**

Replace the detection-run queries (`runsQuery`, `accepted`, `acceptedRunDetail`, `acceptedSegments`) and the `segmentId` state with a processes query and a `processId` state:

```tsx
  const [processId, setProcessId] = useState<string>("none");

  const processesQuery = useQuery({
    queryKey: ["processes", projectId],
    queryFn: () => api.listProcesses(projectId),
  });
  const activeProcesses =
    processesQuery.data?.filter((p) => p.status === "active") ?? [];
```

Change the mutation body:

```tsx
      api.generateProcessMap(projectId, {
        name: name.trim(),
        level,
        focus: focus.trim() || null,
        map_type: mapType === "any" ? null : mapType,
        process_id: processId === "none" ? null : processId,
      }),
```

In `onSuccess`, replace `setSegmentId("none")` with `setProcessId("none")`.

Replace the "From detected process" select block with:

```tsx
          {activeProcesses.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="map-process">From process</Label>
              <Select value={processId} onValueChange={setProcessId}>
                <SelectTrigger id="map-process">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (use all claims)</SelectItem>
                  {activeProcesses.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.claim_count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Scopes generation to the claims assigned to the chosen process.
              </p>
            </div>
          )}
```

- [ ] **Step 2: Delete the detect components**

```bash
git rm src/components/detect/segment-card.tsx src/components/detect/merge-popover.tsx src/components/detect/move-claim-popover.tsx src/components/detect/new-empty-cluster-button.tsx src/components/detect/post-accept-panel.tsx src/components/detect-processes-button.tsx
```

(The `detect/[runId]` redirect page stays.)

- [ ] **Step 3: Typecheck**

```
npx tsc --noEmit
```

Expected: `generate-map-form.tsx` clean. The only remaining error is `maps/page.tsx` importing the now-deleted `PostAcceptPanel` — fixed in Task 16.

- [ ] **Step 4: Commit**

```bash
git add src/components/generate-map-form.tsx
git commit -m "feat(sp7b): generate-map-form process picker; delete detect components"
```

---

## Task 16: Regroup the Maps page by process; attach control; unreconciled badge

**Files:**
- Modify: `src/app/(app)/projects/[id]/maps/page.tsx`

- [ ] **Step 1: Replace the file entirely**

```tsx
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GenerateMapForm } from "@/components/generate-map-form";
import { api } from "@/lib/api";
import type { ProcessModel, UUID } from "@/lib/types";

export default function MapsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const mapsQuery = useQuery({
    queryKey: ["maps", id],
    queryFn: () => api.listProcessMaps(id),
  });
  const processesQuery = useQuery({
    queryKey: ["processes", id],
    queryFn: () => api.listProcesses(id),
  });

  const attach = useMutation({
    mutationFn: ({ modelId, processId }: { modelId: UUID; processId: UUID | null }) =>
      api.attachMapToProcess(id, modelId, processId),
    onSuccess: () => {
      toast.success("Map re-linked.");
      qc.invalidateQueries({ queryKey: ["maps", id] });
    },
    onError: (e: Error) => toast.error(`Attach failed: ${e.message}`),
  });

  const maps = mapsQuery.data ?? [];
  const processes = (processesQuery.data ?? []).filter((p) => p.status === "active");

  // Group maps: one bucket per process_id, plus an "unlinked" bucket.
  const byProcess = new Map<string, ProcessModel[]>();
  const unlinked: ProcessModel[] = [];
  for (const m of maps) {
    if (m.process_id) {
      const arr = byProcess.get(m.process_id) ?? [];
      arr.push(m);
      byProcess.set(m.process_id, arr);
    } else {
      unlinked.push(m);
    }
  }

  const renderCard = (m: ProcessModel) => {
    const targetHref = m.latest_version_id
      ? `/projects/${id}/maps/${m.id}/versions/${m.latest_version_id}`
      : `/projects/${id}/maps`;
    const unreconciled = m.unreconciled_claim_count ?? 0;
    return (
      <Card key={m.id} className="h-full">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-1">{m.name}</CardTitle>
            <div className="flex items-center gap-1">
              <Badge variant="outline">{m.level}</Badge>
              {unreconciled > 0 && (
                <Badge
                  variant="secondary"
                  title="Claims assigned to this process but not yet cited by any node in the latest version."
                >
                  {unreconciled} unreconciled
                </Badge>
              )}
            </div>
          </div>
          <CardDescription>
            {m.latest_version_number ? `v${m.latest_version_number} · ` : "no version yet · "}
            created {new Date(m.created_at).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={targetHref} className="text-xs text-primary underline">
            Open canvas
          </Link>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Process maps, grouped by the process they belong to. Generate a new map
          scoped to a process, or attach an unlinked map below.
        </p>
        <GenerateMapForm projectId={id} />
      </div>

      {mapsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {mapsQuery.error && <p className="text-sm text-red-600">{(mapsQuery.error as Error).message}</p>}

      {maps.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No maps yet</CardTitle>
            <CardDescription>
              Create processes on the Processes tab, then generate a map scoped to one
              with the button above.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {processes.map((p) => {
        const group = byProcess.get(p.id) ?? [];
        if (group.length === 0) return null;
        return (
          <section key={p.id} className="space-y-2">
            <h2 className="text-sm font-semibold">{p.name}</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {group.map(renderCard)}
            </div>
          </section>
        );
      })}

      {unlinked.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Unlinked maps</h2>
          <p className="text-xs text-muted-foreground">
            These maps are not attached to a process (e.g. migrated from the old
            detection model). Attach each to a process to group it.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {unlinked.map((m) => (
              <div key={m.id} className="space-y-2">
                {renderCard(m)}
                <Select
                  onValueChange={(value) =>
                    attach.mutate({ modelId: m.id, processId: value as UUID })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Attach to process…" />
                  </SelectTrigger>
                  <SelectContent>
                    {processes.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Final typecheck and vitest**

```
npx tsc --noEmit && npx vitest run
```

Expected: tsc clean (no remaining detection references anywhere); all Vitest suites pass, including the two new inventory modules.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/maps/page.tsx"
git commit -m "feat(sp7b): regroup Maps page by process; attach control; unreconciled badge"
```

---

## Verification

Run all gates from the repo root.

- [ ] **Backend tests (Postgres on localhost:5433 must be up):**

```
cd backend && pytest -q
```

Expected: all pass. The migration test passes (or skips cleanly if Postgres is down). No test imports `app.models.process_detection` or `app.schemas.process_detection`.

- [ ] **Frontend typecheck:**

```
npx tsc --noEmit
```

Expected: zero errors. Grep to confirm nothing references the deleted surface:

```
grep -rn "DetectionRun\|detect_segments\|source_segment_id\|detectProcesses\|listDetectionRuns\|SegmentCard\|detect-processes-button" src/ backend/app/ | grep -v "detect/\[runId\]"
```

Expected: only the kept `detect/[runId]` redirect shim (if anything).

- [ ] **Frontend unit tests:**

```
npx vitest run
```

Expected: all pass, including `triage-selection.test.ts` and `inbox-grouping.test.ts`.

- [ ] **Dev DB migration (after merge, per MEMORY.md — the hot-reloading backend 500s on new columns otherwise):**

```
cd backend && alembic upgrade head
```

- [ ] **Manual smoke (the full loop):**

1. Open a project's Processes tab. Click **Add process** → "Order to Cash". It appears with 0 claims, 0 maps.
2. In the **Unassigned claims** panel, multi-select two claims → **Assign N selected…** → check "Order to Cash" → **Assign**. The triage panel loses those claims; the process shows 2 claims.
3. Click **Suggest processes**. The AI suggestion inbox appears grouped by batch. **Accept** one `create_process` suggestion → a new process appears with its claims linked (`assigned_by=ai_accepted`).
4. Go to the Maps tab → **Generate map** → pick "Order to Cash" from **From process** → Generate. The map lands under the "Order to Cash" group on the Maps page.
5. Assign one more claim to "Order to Cash" that the new map's nodes don't cite → the map card shows a live **"1 unreconciled"** badge.
6. (Migrated data only) Confirm any map that came across the migration with no process appears under **Unlinked maps** with a working **Attach to process…** control.

Lint is advisory only (7 pre-existing errors are the baseline per MEMORY.md); it is not a gate.
