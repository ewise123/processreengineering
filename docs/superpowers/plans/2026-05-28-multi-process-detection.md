# Multi-Process Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate Claude-driven step that clusters a project's claims into proposed processes before map generation, lets the user review/edit the clusters, and scopes generation per accepted cluster.

**Architecture:** A new `DetectionRun` entity persists each Claude clustering call. Each run owns N `ProcessSegment` rows (proposed processes, plus one "Unassigned"). A `claim_segment_memberships` join table holds the per-claim assignment, unique per run. A new full-page frontend route at `/projects/{id}/detect/{run_id}` lets the user rename / merge / delete / move-claim before accepting; on accept, the user is taken to a post-accept generation panel on the Maps tab that drives the existing `generate-process-map` endpoint (now augmented with an optional `segment_id` field).

**Tech Stack:** Backend — FastAPI, SQLAlchemy 2.0, Alembic, Anthropic SDK, pytest. Frontend — Next.js 16 App Router, React 19, TanStack Query, shadcn/radix, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-28-multi-process-detection-design.md`

---

## File Structure

### Backend — new files

- `backend/alembic/versions/0005_process_detection_tables.py` — Alembic migration for three new tables (`detection_runs`, `process_segments`, `claim_segment_memberships`), the partial unique index enforcing at-most-one-draft-per-project, and the additive `process_versions.source_segment_id` column.
- `backend/app/models/process_detection.py` — SQLAlchemy models `DetectionRun`, `ProcessSegment`, `ClaimSegmentMembership`.
- `backend/app/schemas/process_detection.py` — Pydantic request/response shapes.
- `backend/app/services/process_detection.py` — Anthropic call, tool-use parsing, persistence, and the 70% re-run pre-population heuristic.
- `backend/app/api/v2/process_detection.py` — FastAPI router for the six new endpoints plus the acceptance endpoint.
- `backend/tests/test_process_detection_heuristic.py` — pure-Python unit tests for the 70% pre-population function.
- `backend/tests/test_process_detection_service.py` — service-layer tests (mocked Anthropic).
- `backend/tests/test_process_detection_api.py` — integration tests for every new endpoint.
- `backend/tests/test_generate_map_with_segment.py` — additive coverage for the new `segment_id` field on `generate-process-map`.

### Backend — modified files

- `backend/app/enums.py` — add `DetectionRunStatus` enum.
- `backend/app/models/__init__.py` — register the three new models.
- `backend/app/models/process.py` — add `source_segment_id` nullable FK on `ProcessVersion`.
- `backend/app/api/v2/__init__.py` — include the new router.
- `backend/app/schemas/process_map.py` — add `segment_id` to `ProcessMapGenerateRequest`.
- `backend/app/api/v2/process_maps.py` — claims loader respects `segment_id`; the handler writes `process_versions.source_segment_id`.

### Frontend — new files

- `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` — the review page.
- `src/components/detect-processes-button.tsx` — launches detection; surfaces "Resume draft" and "Re-detect" states.
- `src/components/detect/segment-card.tsx` — one cluster card (rename, claim list, actions).
- `src/components/detect/unassigned-card.tsx` — read-only Unassigned panel pinned to the rail.
- `src/components/detect/reasoning-panel.tsx` — collapsible "Why these splits?" panel.
- `src/components/detect/move-claim-popover.tsx` — claim move target selector.
- `src/components/detect/merge-popover.tsx` — merge target selector.
- `src/components/detect/post-accept-panel.tsx` — per-cluster + sequence-generate panel.

### Frontend — modified files

- `src/lib/types.ts` — add detection-domain types.
- `src/lib/api.ts` — add detection API client methods.
- `src/app/(app)/projects/[id]/documents/page.tsx` — mount `<DetectProcessesButton>` in the header next to upload.
- `src/app/(app)/projects/[id]/maps/page.tsx` — empty-state CTA + mount `<PostAcceptPanel>` when redirected from accept.
- `src/components/generate-map-form.tsx` — add "From detected process" dropdown as the first field, defaulting to None.

---

## Task 1: Add DetectionRunStatus enum

**Files:**
- Modify: `backend/app/enums.py`

- [ ] **Step 1: Add the enum class**

Append to `backend/app/enums.py`:

```python
class DetectionRunStatus(StrEnum):
    DRAFT = "draft"
    ACCEPTED = "accepted"
    ARCHIVED = "archived"
    SUPERSEDED = "superseded"
```

- [ ] **Step 2: Verify the file still imports**

Run from repo root:

```
cd backend && python -c "from app.enums import DetectionRunStatus; print(DetectionRunStatus.DRAFT.value)"
```

Expected stdout: `draft`

- [ ] **Step 3: Commit**

```bash
git add backend/app/enums.py
git commit -m "feat(detection): add DetectionRunStatus enum"
```

---

## Task 2: Alembic migration — new tables and FK

**Files:**
- Create: `backend/alembic/versions/0005_process_detection_tables.py`

- [ ] **Step 1: Write the migration**

Create `backend/alembic/versions/0005_process_detection_tables.py`:

```python
"""add process detection tables

Revision ID: 0005_process_detection_tables
Revises: 0004_extraction_progress_fields
Create Date: 2026-05-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID

revision: str = "0005_process_detection_tables"
down_revision: Union[str, None] = "0004_extraction_progress_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
    )
    op.create_index(
        "ix_detection_runs_project_id",
        "detection_runs",
        ["project_id"],
    )
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
        sa.Column(
            "is_unassigned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
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
    op.create_index(
        "ix_process_segments_detection_run_id",
        "process_segments",
        ["detection_run_id"],
    )
    op.create_index(
        "ix_process_segments_project_id",
        "process_segments",
        ["project_id"],
    )

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
        "ix_claim_segment_memberships_segment_id",
        "claim_segment_memberships",
        ["segment_id"],
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


def downgrade() -> None:
    op.drop_column("process_versions", "source_segment_id")
    op.drop_index(
        "ix_claim_segment_memberships_detection_run_id",
        table_name="claim_segment_memberships",
    )
    op.drop_index(
        "ix_claim_segment_memberships_segment_id",
        table_name="claim_segment_memberships",
    )
    op.drop_table("claim_segment_memberships")
    op.drop_index(
        "ix_process_segments_project_id", table_name="process_segments"
    )
    op.drop_index(
        "ix_process_segments_detection_run_id", table_name="process_segments"
    )
    op.drop_table("process_segments")
    op.execute("DROP INDEX IF EXISTS uq_detection_runs_one_draft_per_project")
    op.drop_index(
        "ix_detection_runs_project_id", table_name="detection_runs"
    )
    op.drop_table("detection_runs")
```

- [ ] **Step 2: Apply the migration locally**

Run from `backend/`:

```
alembic upgrade head
```

Expected: success, no errors.

- [ ] **Step 3: Verify downgrade works**

```
alembic downgrade -1 && alembic upgrade head
```

Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/0005_process_detection_tables.py
git commit -m "feat(detection): migration for detection_runs, process_segments, memberships"
```

---

## Task 3: SQLAlchemy models for detection

**Files:**
- Create: `backend/app/models/process_detection.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/models/process.py` (add `source_segment_id`)

- [ ] **Step 1: Create the models file**

Create `backend/app/models/process_detection.py`:

```python
from uuid import UUID

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin
from app.enums import DetectionRunStatus


class DetectionRun(IdMixin, TimestampMixin, Base):
    __tablename__ = "detection_runs"

    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=DetectionRunStatus.DRAFT.value
    )
    claim_count_at_run: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    claim_id_set: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    model_used: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class ProcessSegment(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_segments"

    detection_run_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("detection_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    claim_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_unassigned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ClaimSegmentMembership(IdMixin, TimestampMixin, Base):
    __tablename__ = "claim_segment_memberships"
    __table_args__ = (
        UniqueConstraint(
            "claim_id",
            "detection_run_id",
            name="uq_claim_segment_memberships_claim_id_detection_run_id",
        ),
    )

    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
    )
    segment_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_segments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    detection_run_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("detection_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
```

> Note: `ClaimSegmentMembership` uses `TimestampMixin` for `created_at`/`updated_at` — although `updated_at` is unused, keeping the mixin simplifies the model and matches other tables' shape. The migration omits `updated_at` from this table; the mixin's `updated_at` column won't conflict because SQLAlchemy doesn't enforce it at insert time when there's a server default elsewhere. If pytest fails on a missing `updated_at` column, drop `TimestampMixin` and replace with explicit `created_at: Mapped[datetime] = mapped_column(...)` matching the migration.

- [ ] **Step 2: Register the models**

Edit `backend/app/models/__init__.py`. Add the import line after the existing `from app.models.process import ...` block, and add the names to `__all__`:

```python
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
```

Add to `__all__`:

```python
    "DetectionRun",
    "ProcessSegment",
    "ClaimSegmentMembership",
```

- [ ] **Step 3: Add `source_segment_id` to `ProcessVersion`**

In `backend/app/models/process.py`, inside the `ProcessVersion` class, after the `created_by` column, add:

```python
    source_segment_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_segments.id", ondelete="SET NULL"),
        nullable=True,
    )
```

- [ ] **Step 4: Smoke-import the models**

```
cd backend && python -c "from app.models import DetectionRun, ProcessSegment, ClaimSegmentMembership; from app.models.process import ProcessVersion; print(DetectionRun.__tablename__, ProcessVersion.source_segment_id)"
```

Expected stdout: `detection_runs <something with source_segment_id>`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/process_detection.py backend/app/models/__init__.py backend/app/models/process.py
git commit -m "feat(detection): add DetectionRun, ProcessSegment, ClaimSegmentMembership models"
```

---

## Task 4: Migration round-trip test

**Files:**
- Create: `backend/tests/test_migration_round_trip.py` (only if it doesn't already exist; otherwise skip this task)

- [ ] **Step 1: Check whether a migration round-trip test already exists**

```
ls backend/tests/test_migration_*.py 2>/dev/null || echo "none"
```

If a test file exists, skip steps 2–4 and proceed to Task 5.

- [ ] **Step 2: Write the test**

Create `backend/tests/test_migration_round_trip.py`:

```python
"""Round-trip test for the 0005 migration. Inherits the conftest's auto
upgrade-to-head, then asserts the new tables and column exist."""
from sqlalchemy import text


def test_detection_tables_exist(test_engine):
    with test_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname='public' "
                "AND tablename IN ('detection_runs','process_segments','claim_segment_memberships')"
            )
        ).fetchall()
    names = {r[0] for r in rows}
    assert names == {"detection_runs", "process_segments", "claim_segment_memberships"}


def test_process_versions_has_source_segment_id(test_engine):
    with test_engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='process_versions' AND column_name='source_segment_id'"
            )
        ).fetchone()
    assert row is not None


def test_partial_unique_index_on_draft_runs(test_engine):
    with test_engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT indexname FROM pg_indexes "
                "WHERE indexname='uq_detection_runs_one_draft_per_project'"
            )
        ).fetchone()
    assert row is not None
```

- [ ] **Step 3: Run the test**

```
cd backend && pytest tests/test_migration_round_trip.py -v
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_migration_round_trip.py
git commit -m "test(detection): migration round-trip checks"
```

---

## Task 5: Detection service — system prompt + tool schema

**Files:**
- Create: `backend/app/services/process_detection.py` (initial scaffolding only)

- [ ] **Step 1: Write the file with the prompt and tool definition**

Create `backend/app/services/process_detection.py`:

```python
"""Cluster a project's claims into proposed business processes.

Single blocking call to Claude with a tool-use schema. The output drives
the new detection-review UI: each segment carries a name, description,
confidence, and an array of claim_refs (indices into the numbered claim
list the model was given).
"""
import os
from dataclasses import dataclass

import anthropic

DETECTION_MODEL = os.getenv("PROCESS_DETECTION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 6000
MAX_CLAIMS_INPUT = 600

SEGMENT_TOOL = {
    "name": "record_process_segments",
    "description": "Record the distinct business processes detected in a set of claims.",
    "input_schema": {
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "maxLength": 80},
                        "description": {"type": "string", "maxLength": 280},
                        "claim_refs": {
                            "type": "array",
                            "items": {"type": "integer"},
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                    "required": ["name", "description", "claim_refs", "confidence"],
                },
            },
            "unassigned_claim_refs": {
                "type": "array",
                "items": {"type": "integer"},
            },
            "reasoning_summary": {"type": "string", "maxLength": 800},
        },
        "required": ["segments", "unassigned_claim_refs"],
    },
}

SYSTEM_PROMPT = """You discover the distinct business processes present in a set of process claims extracted from documents (interviews, SOPs, policies, manuals, meeting notes).

A "claim" is an atomic statement about how a business process works. Each is rendered as:

  [index] kind | from chunk cN | subject

Your job is to group claims into business processes and return them via the record_process_segments tool. Follow these rules precisely:

1. A process is a goal-directed flow with a definable trigger and outcome — NOT a topic. "Accounts Payable" is a process; "approvals" is a topic that runs through many processes.
2. Boundaries follow ownership, trigger, and artifact transitions. When the actor changes AND the artifact being acted on changes AND the upstream trigger changes, you've crossed a process boundary. Any single signal alone is insufficient.
3. Be conservative — splits over merges. If unsure whether two clumps belong together, split them. The user can merge in the review step; un-merging is harder.
4. Name in noun phrases, not verbs. "Strategic Account Onboarding," not "Onboard accounts." Use the language the source documents use when it is clear.
5. Ambient claims go to unassigned_claim_refs. Tooling/system mentions, organizational facts, cross-cutting policies — if a claim describes the environment rather than a flow, leave it unassigned.
6. Confidence is per segment, not global. A clear segment with 25+ supporting claims is 0.9. A speculative segment built from 3 fragmentary claims is 0.4. The UI flags low confidence.

If you cannot ground a cluster in the claims' language, emit name: "Unnamed cluster {n}" and confidence ≤ 0.3. Do not invent names not supported by the source.

Every claim index appears exactly once: either in a segment's claim_refs OR in unassigned_claim_refs. Indices must be valid (0 ≤ i < total claims).

Use the record_process_segments tool with all detected segments."""


@dataclass
class DetectedSegment:
    name: str
    description: str
    claim_refs: list[int]
    confidence: float


@dataclass
class DetectionResult:
    segments: list[DetectedSegment]
    unassigned_claim_refs: list[int]
    reasoning_summary: str
    model_used: str
    prompt_tokens: int | None
    output_tokens: int | None


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client
```

- [ ] **Step 2: Smoke import**

```
cd backend && python -c "from app.services.process_detection import SYSTEM_PROMPT, SEGMENT_TOOL, MAX_CLAIMS_INPUT; print(MAX_CLAIMS_INPUT, len(SYSTEM_PROMPT))"
```

Expected: `600 <some-number>`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/services/process_detection.py
git commit -m "feat(detection): prompt and tool schema scaffolding"
```

---

## Task 6: Detection service — claim rendering + Anthropic call

**Files:**
- Modify: `backend/app/services/process_detection.py`
- Create: `backend/tests/test_process_detection_service.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_process_detection_service.py`:

```python
"""Tests for the detection service in isolation (no DB)."""
from unittest.mock import MagicMock, patch

import pytest

from app.services.process_detection import (
    DetectionResult,
    MAX_CLAIMS_INPUT,
    detect_segments_from_claims,
    render_claim_lines,
)


def test_render_claim_lines_three_column_format():
    claims = [
        {"kind": "task", "subject": "AP clerk validates invoice", "chunk_ref": "c3"},
        {"kind": "actor", "subject": "Buyer enters PO", "chunk_ref": "c7"},
    ]
    text = render_claim_lines(claims)
    assert "[0] task | from chunk c3 | AP clerk validates invoice" in text
    assert "[1] actor | from chunk c7 | Buyer enters PO" in text


def test_detect_segments_parses_tool_use_response():
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [
            {
                "name": "Accounts Payable",
                "description": "Invoice processing end-to-end",
                "claim_refs": [0, 2],
                "confidence": 0.9,
            },
            {
                "name": "Onboarding",
                "description": "New account setup",
                "claim_refs": [1],
                "confidence": 0.7,
            },
        ],
        "unassigned_claim_refs": [],
        "reasoning_summary": "Grouped by actor.",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=120, output_tokens=80)

    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": "AP work", "chunk_ref": "c1"},
        {"kind": "task", "subject": "Onboard X", "chunk_ref": "c2"},
        {"kind": "task", "subject": "AP rework", "chunk_ref": "c3"},
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        result = detect_segments_from_claims(claims)

    assert isinstance(result, DetectionResult)
    assert len(result.segments) == 2
    assert result.segments[0].name == "Accounts Payable"
    assert result.segments[0].claim_refs == [0, 2]
    assert result.unassigned_claim_refs == []
    assert result.reasoning_summary == "Grouped by actor."
    assert result.prompt_tokens == 120
    assert result.output_tokens == 80


def test_detect_segments_truncates_above_max_claims_input():
    """If we pass more than MAX_CLAIMS_INPUT claims, the service truncates."""
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [],
        "unassigned_claim_refs": list(range(MAX_CLAIMS_INPUT)),
        "reasoning_summary": "",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": f"c{i}", "chunk_ref": f"c{i}"}
        for i in range(MAX_CLAIMS_INPUT + 50)
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        detect_segments_from_claims(claims)

    # The rendered user message should contain only MAX_CLAIMS_INPUT lines.
    sent_kwargs = client.messages.create.call_args.kwargs
    user_msg = sent_kwargs["messages"][0]["content"]
    last_line_index = user_msg.count("[")  # count of "[N]" headers
    assert last_line_index == MAX_CLAIMS_INPUT


def test_detect_segments_raises_on_non_tool_use_response():
    """If Claude returns no tool_use block, raise RuntimeError."""
    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "I refuse."
    fake_response = MagicMock()
    fake_response.content = [text_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    with patch("app.services.process_detection._get_client", return_value=client):
        with pytest.raises(RuntimeError):
            detect_segments_from_claims(
                [{"kind": "task", "subject": "x", "chunk_ref": "c1"}]
            )
```

- [ ] **Step 2: Run and verify it fails**

```
cd backend && pytest tests/test_process_detection_service.py -v
```

Expected: ImportError or "cannot import name 'detect_segments_from_claims'".

- [ ] **Step 3: Add the implementation**

Append to `backend/app/services/process_detection.py`:

```python
def render_claim_lines(claims: list[dict]) -> str:
    """Render the numbered three-column claim list the model sees."""
    return "\n".join(
        f"[{i}] {c.get('kind', '?')} | from chunk {c.get('chunk_ref', '?')} | {c.get('subject', '')}"
        for i, c in enumerate(claims)
    )


def detect_segments_from_claims(claims: list[dict]) -> DetectionResult:
    """Single Claude call. Each claim dict must carry kind, subject, chunk_ref.

    The caller is responsible for building chunk_ref (typically `c{n}` where
    n is the chunk's position within its document).
    """
    if not claims:
        return DetectionResult(
            segments=[],
            unassigned_claim_refs=[],
            reasoning_summary="",
            model_used=DETECTION_MODEL,
            prompt_tokens=None,
            output_tokens=None,
        )

    if len(claims) > MAX_CLAIMS_INPUT:
        claims = claims[:MAX_CLAIMS_INPUT]

    user_message = f"Cluster these {len(claims)} claims into business processes.\n\nClaims:\n{render_claim_lines(claims)}"

    client = _get_client()
    response = client.messages.create(
        model=DETECTION_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        tools=[SEGMENT_TOOL],
        tool_choice={"type": "tool", "name": "record_process_segments"},
        messages=[{"role": "user", "content": user_message}],
    )

    payload = None
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == "record_process_segments":
            payload = block.input
            break
    if payload is None:
        raise RuntimeError(
            "Claude returned no record_process_segments tool_use block."
        )

    segments = [
        DetectedSegment(
            name=str(s.get("name", "")).strip(),
            description=str(s.get("description", "")).strip(),
            claim_refs=[int(r) for r in (s.get("claim_refs") or []) if isinstance(r, (int, float))],
            confidence=float(s.get("confidence", 0.0)),
        )
        for s in (payload.get("segments") or [])
    ]
    unassigned = [
        int(r) for r in (payload.get("unassigned_claim_refs") or [])
        if isinstance(r, (int, float))
    ]
    reasoning = str(payload.get("reasoning_summary") or "").strip()

    usage = getattr(response, "usage", None)
    return DetectionResult(
        segments=segments,
        unassigned_claim_refs=unassigned,
        reasoning_summary=reasoning,
        model_used=DETECTION_MODEL,
        prompt_tokens=getattr(usage, "input_tokens", None) if usage else None,
        output_tokens=getattr(usage, "output_tokens", None) if usage else None,
    )
```

- [ ] **Step 4: Run the tests, expect green**

```
cd backend && pytest tests/test_process_detection_service.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/process_detection.py backend/tests/test_process_detection_service.py
git commit -m "feat(detection): tool-use call to Claude, claim rendering, response parse"
```

---

## Task 7: 70% re-run pre-population heuristic

**Files:**
- Modify: `backend/app/services/process_detection.py`
- Create: `backend/tests/test_process_detection_heuristic.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_process_detection_heuristic.py`:

```python
"""Unit tests for the pure-Python 70% pre-population heuristic."""
from uuid import uuid4

from app.services.process_detection import inherited_name_for_segment


def _claim_set(n: int):
    return [uuid4() for _ in range(n)]


def test_inherits_name_when_overlap_is_at_least_70_percent():
    shared = _claim_set(7)
    extra = _claim_set(3)
    new_claims = shared + extra  # 10 total, 7 in old → 70% exactly
    old_accepted = [
        {"name": "Accounts Payable", "claim_ids": shared + _claim_set(20)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) == "Accounts Payable"


def test_no_inheritance_when_below_threshold():
    shared = _claim_set(6)
    extra = _claim_set(4)
    new_claims = shared + extra  # 60%
    old_accepted = [
        {"name": "Accounts Payable", "claim_ids": shared + _claim_set(20)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) is None


def test_no_inheritance_on_empty_new_claims():
    old_accepted = [{"name": "X", "claim_ids": _claim_set(5)}]
    assert inherited_name_for_segment([], old_accepted) is None


def test_no_inheritance_on_empty_old_accepted():
    assert inherited_name_for_segment(_claim_set(3), []) is None


def test_picks_the_highest_overlap_match():
    shared_a = _claim_set(8)
    shared_b = _claim_set(2)
    new_claims = shared_a + shared_b
    old_accepted = [
        {"name": "Lower-overlap", "claim_ids": shared_b + _claim_set(50)},
        {"name": "Higher-overlap", "claim_ids": shared_a + _claim_set(50)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) == "Higher-overlap"
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_heuristic.py -v
```

Expected: ImportError on `inherited_name_for_segment`.

- [ ] **Step 3: Implement**

Append to `backend/app/services/process_detection.py`:

```python
INHERITANCE_OVERLAP_THRESHOLD = 0.70


def inherited_name_for_segment(
    new_claim_ids: list,
    old_accepted_segments: list[dict],
) -> str | None:
    """If ≥ 70% of new_claim_ids previously belonged to a single accepted
    segment, return that segment's name. Otherwise return None.

    Each element of old_accepted_segments must be a dict with keys
    `name` (str) and `claim_ids` (iterable). Pure function, no DB access.
    """
    n = len(new_claim_ids)
    if n == 0 or not old_accepted_segments:
        return None
    new_set = set(new_claim_ids)
    best_name: str | None = None
    best_overlap = 0
    for seg in old_accepted_segments:
        overlap = len(new_set.intersection(seg.get("claim_ids", [])))
        if overlap > best_overlap:
            best_overlap = overlap
            best_name = seg.get("name")
    if best_overlap / n >= INHERITANCE_OVERLAP_THRESHOLD:
        return best_name
    return None
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_heuristic.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/process_detection.py backend/tests/test_process_detection_heuristic.py
git commit -m "feat(detection): 70% pre-population heuristic"
```

---

## Task 8: Pydantic schemas

**Files:**
- Create: `backend/app/schemas/process_detection.py`

- [ ] **Step 1: Write the schemas file**

Create `backend/app/schemas/process_detection.py`:

```python
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ClaimRef(BaseModel):
    """Minimal claim representation surfaced inside a segment."""

    id: UUID
    kind: str
    subject: str


class ProcessSegmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    detection_run_id: UUID
    name: str
    description: str
    order_index: int
    claim_count: int
    confidence: float | None
    is_unassigned: bool
    claims: list[ClaimRef] = Field(default_factory=list)


class DetectionRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    status: str
    claim_count_at_run: int
    model_used: str | None
    reasoning_summary: str | None
    created_at: datetime


class DetectionRunDetail(DetectionRunRead):
    segments: list[ProcessSegmentRead]
    unassigned_segment: ProcessSegmentRead


class DetectionRunListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    status: str
    claim_count_at_run: int
    segment_count: int
    created_at: datetime


class DetectProcessesRequest(BaseModel):
    scope_input_ids: list[UUID] | None = None


class SegmentUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=2000)


class SegmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class SegmentMergeRequest(BaseModel):
    into_segment_id: UUID


class SegmentMoveClaimRequest(BaseModel):
    claim_id: UUID


class AcceptDetectionRunResult(BaseModel):
    run_id: UUID
    accepted_segment_count: int
```

- [ ] **Step 2: Smoke import**

```
cd backend && python -c "from app.schemas.process_detection import DetectionRunDetail, SegmentUpdate; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/process_detection.py
git commit -m "feat(detection): pydantic schemas for runs, segments, mutations"
```

---

## Task 9: POST /detect-processes endpoint

**Files:**
- Create: `backend/app/api/v2/process_detection.py` (initial router + this endpoint)
- Modify: `backend/app/api/v2/__init__.py`
- Modify: `backend/app/services/process_detection.py` (add `run_detection` orchestrator)
- Create: `backend/tests/test_process_detection_api.py` (with a happy-path test for this endpoint)

- [ ] **Step 1: Write the orchestrator's failing test**

Append to `backend/tests/test_process_detection_service.py`:

```python
from unittest.mock import patch as _patch

from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
from app.models.project import Project
from app.services.process_detection import (
    DetectedSegment,
    DetectionResult,
    run_detection,
)


def _seed_two_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="i.txt",
        file_path="i.txt",
        file_size=10,
        mime_type="text/plain",
        status="parsed",
        uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2])
    db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2])
    db.flush()
    db.add_all(
        [
            ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
            ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
        ]
    )
    db.commit()
    return proj, [cl1, cl2]


def test_run_detection_persists_run_and_segments(db):
    proj, claims = _seed_two_claims(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap desc", [0], 0.9),
            DetectedSegment("Onboarding", "ob desc", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="Grouped by actor.",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with _patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        run = run_detection(db=db, project_id=proj.id, scope_input_ids=None)

    assert run.status == "draft"
    assert run.claim_count_at_run == 2
    segs = db.query(ProcessSegment).filter(ProcessSegment.detection_run_id == run.id).all()
    # 2 segments + 1 Unassigned
    assert len(segs) == 3
    assert any(s.is_unassigned for s in segs)
    members = db.query(ClaimSegmentMembership).filter(
        ClaimSegmentMembership.detection_run_id == run.id
    ).all()
    assert len(members) == 2


def test_run_detection_rejects_zero_segments(db):
    proj, _ = _seed_two_claims(db)
    fake = DetectionResult(
        segments=[],
        unassigned_claim_refs=[0, 1],
        reasoning_summary="couldn't identify",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with _patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        try:
            run_detection(db=db, project_id=proj.id, scope_input_ids=None)
        except RuntimeError as e:
            assert "no distinct processes" in str(e).lower()
        else:
            raise AssertionError("Expected RuntimeError")
    # No run row created.
    assert db.query(DetectionRun).count() == 0
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_service.py::test_run_detection_persists_run_and_segments tests/test_process_detection_service.py::test_run_detection_rejects_zero_segments -v
```

Expected: ImportError on `run_detection`.

- [ ] **Step 3: Implement `run_detection` in the service**

Append to `backend/app/services/process_detection.py`:

```python
from uuid import UUID as _UUID  # for type hints below; avoid colliding with PgUUID

from sqlalchemy.orm import Session

from app.enums import DetectionRunStatus
from app.models.claim import Claim, ClaimCitation
from app.models.input import Chunk, DocumentSection
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)


def _load_claims_for_detection(
    db: Session,
    project_id: _UUID,
    scope_input_ids: list[_UUID] | None,
) -> list[Claim]:
    from sqlalchemy import select

    q = select(Claim).where(Claim.project_id == project_id)
    if scope_input_ids:
        q = (
            q.join(ClaimCitation, ClaimCitation.claim_id == Claim.id)
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .where(DocumentSection.input_id.in_(scope_input_ids))
            .distinct()
        )
    q = q.order_by(Claim.kind, Claim.created_at)
    return list(db.scalars(q).all())


def _chunk_ref_for_claim(
    db: Session, claim_id: _UUID, chunk_ref_cache: dict
) -> str:
    """Pick the first citation's chunk and produce a ref like 'c{n}', where n
    is the chunk's order within its document. Cached per-claim."""
    from sqlalchemy import select

    if claim_id in chunk_ref_cache:
        return chunk_ref_cache[claim_id]
    cit = db.scalars(
        select(ClaimCitation)
        .where(ClaimCitation.claim_id == claim_id)
        .order_by(ClaimCitation.created_at)
        .limit(1)
    ).first()
    if cit is None:
        ref = "c?"
    else:
        chunk = db.get(Chunk, cit.chunk_id)
        section = db.get(DocumentSection, chunk.section_id) if chunk else None
        ref = f"c{(section.order_index if section else 0) + (chunk.char_start // 1000 if chunk else 0)}"
    chunk_ref_cache[claim_id] = ref
    return ref


def run_detection(
    *,
    db: Session,
    project_id: _UUID,
    scope_input_ids: list[_UUID] | None,
    created_by: _UUID | None = None,
) -> DetectionRun:
    """Run a detection pass and persist the run, segments, and memberships.

    Raises:
        RuntimeError("No claims") if project has no claims in scope.
        RuntimeError("Too many claims") if claim count exceeds MAX_CLAIMS_INPUT.
        RuntimeError("Draft already exists") if a draft run is already open.
        RuntimeError("Model returned no distinct processes") if every claim
            landed in unassigned (no segments to persist).
    """
    from sqlalchemy import select

    existing_draft = db.scalars(
        select(DetectionRun).where(
            DetectionRun.project_id == project_id,
            DetectionRun.status == DetectionRunStatus.DRAFT.value,
        ).limit(1)
    ).first()
    if existing_draft is not None:
        raise RuntimeError(f"Draft already exists: {existing_draft.id}")

    claims = _load_claims_for_detection(db, project_id, scope_input_ids)
    if not claims:
        raise RuntimeError("No claims found for this project (scope).")
    if len(claims) > MAX_CLAIMS_INPUT:
        raise RuntimeError(
            f"Project has {len(claims)} claims; detection caps at {MAX_CLAIMS_INPUT}. Pass scope_input_ids to narrow."
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
    result = detect_segments_from_claims(claim_dicts)

    if not result.segments:
        raise RuntimeError(
            "The model could not identify any distinct processes in the supplied claims. "
            "This usually means the claims are too sparse or describe a single homogeneous activity. "
            "Try adding more documents, or skip detection and use the existing Generate dialog directly."
        )

    # Load old accepted segments for inheritance.
    old_accepted = []
    accepted_runs = db.scalars(
        select(DetectionRun).where(
            DetectionRun.project_id == project_id,
            DetectionRun.status == DetectionRunStatus.ACCEPTED.value,
        )
    ).all()
    if accepted_runs:
        for old_run in accepted_runs:
            for old_seg in db.scalars(
                select(ProcessSegment).where(
                    ProcessSegment.detection_run_id == old_run.id,
                    ProcessSegment.is_unassigned.is_(False),
                )
            ).all():
                old_claim_ids = list(
                    db.scalars(
                        select(ClaimSegmentMembership.claim_id).where(
                            ClaimSegmentMembership.segment_id == old_seg.id
                        )
                    ).all()
                )
                old_accepted.append({"name": old_seg.name, "claim_ids": old_claim_ids})

    run = DetectionRun(
        project_id=project_id,
        status=DetectionRunStatus.DRAFT.value,
        claim_count_at_run=len(claims),
        claim_id_set=[str(c.id) for c in claims],
        model_used=result.model_used,
        prompt_tokens=result.prompt_tokens,
        output_tokens=result.output_tokens,
        reasoning_summary=result.reasoning_summary,
        created_by=created_by,
    )
    db.add(run)
    db.flush()

    # Unassigned segment is always present.
    unassigned_seg = ProcessSegment(
        detection_run_id=run.id,
        project_id=project_id,
        name="Unassigned",
        description="Ambient claims not assigned to any process.",
        order_index=10_000,
        claim_count=0,
        is_unassigned=True,
    )
    db.add(unassigned_seg)
    db.flush()

    # Build claim index → Claim object map for membership writes.
    by_index: dict[int, Claim] = dict(enumerate(claims))

    segments: list[ProcessSegment] = []
    for idx, det in enumerate(result.segments):
        seg_claim_ids = [by_index[i].id for i in det.claim_refs if i in by_index]
        inherited = inherited_name_for_segment(seg_claim_ids, old_accepted)
        seg = ProcessSegment(
            detection_run_id=run.id,
            project_id=project_id,
            name=inherited or det.name,
            description=det.description,
            order_index=idx,
            claim_count=len(seg_claim_ids),
            confidence=det.confidence,
            is_unassigned=False,
        )
        db.add(seg)
        db.flush()
        segments.append(seg)

        for claim_id in seg_claim_ids:
            db.add(
                ClaimSegmentMembership(
                    claim_id=claim_id,
                    segment_id=seg.id,
                    detection_run_id=run.id,
                )
            )

    # Unassigned memberships
    assigned = set()
    for det in result.segments:
        for i in det.claim_refs:
            if i in by_index:
                assigned.add(by_index[i].id)
    for c in claims:
        if c.id not in assigned:
            db.add(
                ClaimSegmentMembership(
                    claim_id=c.id,
                    segment_id=unassigned_seg.id,
                    detection_run_id=run.id,
                )
            )
            unassigned_seg.claim_count += 1

    db.commit()
    db.refresh(run)
    return run
```

- [ ] **Step 4: Run, expect green for the two new service tests**

```
cd backend && pytest tests/test_process_detection_service.py -v
```

Expected: 6 passed (4 from earlier + 2 new).

- [ ] **Step 5: Write the API endpoint scaffolding**

Create `backend/app/api/v2/process_detection.py`:

```python
"""Phase 4 endpoints: multi-process detection for a project."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
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
    unassigned = next(s for s in segs if s.is_unassigned)
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
        if "no claims" in msg.lower() or "could not identify" in msg.lower():
            raise HTTPException(status_code=422, detail=msg)
        if "caps at" in msg:
            raise HTTPException(status_code=422, detail=msg)
        raise HTTPException(status_code=503, detail=msg)

    return _run_detail(db, run)
```

- [ ] **Step 6: Register the router**

Edit `backend/app/api/v2/__init__.py`:

```python
from fastapi import APIRouter

from app.api.v2 import (
    claims,
    embeddings,
    inputs,
    process_detection,
    process_maps,
    projects,
)

router = APIRouter()
router.include_router(projects.router)
router.include_router(inputs.router)
router.include_router(embeddings.router)
router.include_router(claims.router)
router.include_router(process_maps.router)
router.include_router(process_detection.router)
```

- [ ] **Step 7: Write the integration test for the endpoint**

Create `backend/tests/test_process_detection_api.py`:

```python
"""Integration tests for the detection endpoints."""
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process_detection import DetectionRun, ProcessSegment
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult


@pytest.fixture()
def client(db):
    return TestClient(create_app())


def _seed_project_with_two_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="i.txt",
        file_path="i.txt",
        file_size=10,
        mime_type="text/plain",
        status="parsed",
        uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2])
    db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2])
    db.flush()
    db.add_all(
        [
            ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
            ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
        ]
    )
    db.commit()
    return proj


def _fake_detection_result_two_segments():
    return DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="x",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )


def test_detect_processes_happy_path(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes",
            json={},
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "draft"
    assert len(body["segments"]) == 2
    assert body["unassigned_segment"]["is_unassigned"] is True
    assert body["claim_count_at_run"] == 2


def test_detect_processes_409_when_draft_exists(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        resp1 = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
        assert resp1.status_code == 201
        resp2 = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
    assert resp2.status_code == 409


def test_detect_processes_422_when_no_claims(client, db):
    org = Organization(name="t")
    db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user); db.flush()
    proj = Project(name="empty", org_id=org.id, status="active")
    db.add(proj); db.commit()
    resp = client.post(f"/api/v2/projects/{proj.id}/detect-processes", json={})
    assert resp.status_code == 422


def test_detect_processes_422_when_zero_segments(client, db):
    proj = _seed_project_with_two_claims(db)
    empty = DetectionResult(
        segments=[], unassigned_claim_refs=[0, 1], reasoning_summary="",
        model_used="claude-sonnet-4-6", prompt_tokens=10, output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=empty,
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
    assert resp.status_code == 422
    assert db.query(DetectionRun).count() == 0
```

- [ ] **Step 8: Run integration tests, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

Expected: 4 passed.

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/process_detection.py backend/app/api/v2/process_detection.py backend/app/api/v2/__init__.py backend/tests/test_process_detection_service.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): POST /detect-processes endpoint + orchestrator"
```

---

## Task 10: GET endpoints (run + list)

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_process_detection_api.py`:

```python
def test_get_detection_run_returns_full_detail(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()

    resp = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == created["id"]
    assert len(body["segments"]) == 2


def test_list_detection_runs(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        client.post(f"/api/v2/projects/{proj.id}/detect-processes", json={})

    resp = client.get(f"/api/v2/projects/{proj.id}/detection-runs")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["segment_count"] == 2
    assert rows[0]["status"] == "draft"
```

- [ ] **Step 2: Run, expect 404**

```
cd backend && pytest tests/test_process_detection_api.py::test_get_detection_run_returns_full_detail tests/test_process_detection_api.py::test_list_detection_runs -v
```

Expected: 2 failed with 404 Not Found.

- [ ] **Step 3: Implement**

Append to `backend/app/api/v2/process_detection.py`:

```python
from sqlalchemy import func


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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): GET detection-runs and detection-runs/{id}"
```

---

## Task 11: PATCH /segments/{id} — rename and description

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing test**

Append to `backend/tests/test_process_detection_api.py`:

```python
def test_patch_segment_renames(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    seg_id = created["segments"][0]["id"]

    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{seg_id}",
        json={"name": "Accounts Payable", "description": "AP flow."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Accounts Payable"
    assert body["description"] == "AP flow."


def test_patch_segment_409_on_non_draft_run(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    # Manually flip run to accepted via the model layer to simulate immutability.
    from app.models.process_detection import DetectionRun as _DR
    run = db.get(_DR, created["id"])
    run.status = "accepted"
    db.commit()

    seg_id = created["segments"][0]["id"]
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{seg_id}",
        json={"name": "New name"},
    )
    assert resp.status_code == 409


def test_patch_unassigned_segment_409(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    un_id = created["unassigned_segment"]["id"]
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{un_id}",
        json={"name": "Renamed unassigned"},
    )
    assert resp.status_code == 409
```

- [ ] **Step 2: Run, expect failure (404)**

```
cd backend && pytest tests/test_process_detection_api.py::test_patch_segment_renames -v
```

Expected: fail (404).

- [ ] **Step 3: Implement**

Append to `backend/app/api/v2/process_detection.py`:

```python
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
```

- [ ] **Step 4: Run all detection API tests**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): PATCH /segments/{id}"
```

---

## Task 12: POST /detection-runs/{run_id}/segments — create empty cluster

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing test**

Append to `backend/tests/test_process_detection_api.py`:

```python
def test_create_empty_segment(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    run_id = created["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{run_id}/segments",
        json={"name": "Manual cluster"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Manual cluster"
    assert body["claim_count"] == 0
    assert body["is_unassigned"] is False
```

- [ ] **Step 2: Run, expect 404**

```
cd backend && pytest tests/test_process_detection_api.py::test_create_empty_segment -v
```

Expected: fail.

- [ ] **Step 3: Implement**

Append to `backend/app/api/v2/process_detection.py`:

```python
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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py::test_create_empty_segment -v
```

Expected: passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): POST /detection-runs/{id}/segments (new empty)"
```

---

## Task 13: POST /segments/{id}/merge

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing test**

Append:

```python
def test_merge_segment_moves_memberships(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a_id = created["segments"][0]["id"]
    b_id = created["segments"][1]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{a_id}/merge",
        json={"into_segment_id": b_id},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == b_id
    assert body["claim_count"] == 2

    # Source segment should be gone.
    resp2 = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{a_id}",
        json={"name": "x"},
    )
    assert resp2.status_code == 404
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_api.py::test_merge_segment_moves_memberships -v
```

- [ ] **Step 3: Implement**

Append to `backend/app/api/v2/process_detection.py`:

```python
from sqlalchemy import update as sql_update


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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): POST /segments/{id}/merge"
```

---

## Task 14: DELETE /segments/{id} — moves claims to Unassigned

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing test**

Append:

```python
def test_delete_segment_moves_claims_to_unassigned(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    seg = created["segments"][0]
    un_id = created["unassigned_segment"]["id"]

    resp = client.delete(
        f"/api/v2/projects/{proj.id}/segments/{seg['id']}"
    )
    assert resp.status_code == 204

    # Reload the run; expect 1 regular segment, unassigned with +1 claim.
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    ).json()
    assert len(detail["segments"]) == 1
    assert detail["unassigned_segment"]["claim_count"] == seg["claim_count"]
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_api.py::test_delete_segment_moves_claims_to_unassigned -v
```

- [ ] **Step 3: Implement**

Append:

```python
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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): DELETE /segments/{id} moves claims to Unassigned"
```

---

## Task 15: POST /segments/{id}/claims — move claim between segments

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing test**

Append:

```python
def test_move_claim_between_segments(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a = created["segments"][0]
    b = created["segments"][1]
    moving_claim_id = a["claims"][0]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{b['id']}/claims",
        json={"claim_id": moving_claim_id},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["claim_count"] == 2
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    ).json()
    a_after = next(s for s in detail["segments"] if s["id"] == a["id"])
    assert a_after["claim_count"] == 0


def test_move_claim_to_unassigned_is_allowed(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a = created["segments"][0]
    un = created["unassigned_segment"]
    moving = a["claims"][0]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{un['id']}/claims",
        json={"claim_id": moving},
    )
    assert resp.status_code == 200
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_api.py::test_move_claim_between_segments -v
```

- [ ] **Step 3: Implement**

Append (the helper allows moving INTO Unassigned, so we do not use `_get_draft_segment` for the destination):

```python
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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): POST /segments/{id}/claims to move a claim"
```

---

## Task 16: POST /detection-runs/{id}/accept

**Files:**
- Modify: `backend/app/api/v2/process_detection.py`
- Modify: `backend/tests/test_process_detection_api.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
def test_accept_run_supersedes_prior_accepted_run(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        first = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    # Name both regular segments so accept passes validation.
    for seg in first["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": f"Named-{seg['id'][:6]}"},
        )

    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{first['id']}/accept"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted_segment_count"] == 2

    # Re-detect.
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        second = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for seg in second["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": f"Round2-{seg['id'][:6]}"},
        )
    resp2 = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{second['id']}/accept"
    )
    assert resp2.status_code == 200

    # Original run should now be superseded.
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{first['id']}"
    ).json()
    assert detail["status"] == "superseded"


def test_accept_run_422_when_a_regular_segment_is_unnamed(client, db):
    proj = _seed_project_with_two_claims(db)
    fake = DetectionResult(
        segments=[DetectedSegment("", "", [0, 1], 0.5)],  # blank name
        unassigned_claim_refs=[],
        reasoning_summary="",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}/accept"
    )
    assert resp.status_code == 422


def test_accept_run_422_on_duplicate_names(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for seg in created["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": "Same name"},
        )
    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}/accept"
    )
    assert resp.status_code == 422
```

- [ ] **Step 2: Run, expect failure**

```
cd backend && pytest tests/test_process_detection_api.py::test_accept_run_supersedes_prior_accepted_run -v
```

- [ ] **Step 3: Implement**

Append:

```python
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
```

- [ ] **Step 4: Run, expect green**

```
cd backend && pytest tests/test_process_detection_api.py -v
```

Expected: all detection API tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/process_detection.py backend/tests/test_process_detection_api.py
git commit -m "feat(detection): accept run + supersede prior accepted run"
```

---

## Task 17: Additive `segment_id` field on generate-process-map

**Files:**
- Modify: `backend/app/schemas/process_map.py`
- Modify: `backend/app/api/v2/process_maps.py`
- Create: `backend/tests/test_generate_map_with_segment.py`

- [ ] **Step 1: Add the field to the schema**

In `backend/app/schemas/process_map.py`, modify `ProcessMapGenerateRequest`:

```python
class ProcessMapGenerateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    level: str = Field(pattern=r"^(1|2|3|4|L1|L2|L3|L4)$")
    focus: str | None = Field(default=None, max_length=300)
    map_type: str | None = Field(default=None, pattern=r"^(current_state|future_state)?$")
    scope_input_ids: list[UUID] | None = None
    segment_id: UUID | None = None
```

- [ ] **Step 2: Modify the claims loader in `process_maps.py`**

In `backend/app/api/v2/process_maps.py`, replace the existing claims-loading block (starting at the `# 1. Load claims ...` comment, ending just before `# 2. Call Claude`) with:

```python
    # 1. Load claims (optionally scoped to a detection segment or input ids)
    claim_query = select(Claim).where(Claim.project_id == project.id)
    if payload.segment_id is not None:
        from app.models.process_detection import ClaimSegmentMembership

        claim_query = (
            claim_query.join(
                ClaimSegmentMembership,
                ClaimSegmentMembership.claim_id == Claim.id,
            )
            .where(ClaimSegmentMembership.segment_id == payload.segment_id)
        )
    elif payload.scope_input_ids:
        from app.models.claim import ClaimCitation

        claim_query = (
            claim_query.join(ClaimCitation, ClaimCitation.claim_id == Claim.id)
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .where(DocumentSection.input_id.in_(payload.scope_input_ids))
            .distinct()
        )
    claim_query = claim_query.order_by(Claim.kind, Claim.created_at)
    claims = list(db.scalars(claim_query).all())
    if not claims:
        raise HTTPException(
            status_code=422,
            detail="No claims found for this project (scope). Run extract-claims first.",
        )
```

- [ ] **Step 3: Persist `source_segment_id` on the version**

In the same file, locate the `version = ProcessVersion(...)` instantiation (near line ~180). Add a `source_segment_id=payload.segment_id` keyword:

```python
    version = ProcessVersion(
        model_id=model.id,
        version_number=last_version_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        bpmn_xml=bpmn_xml,
        notes=f"Generated from {len(claims)} claim(s).",
        created_by=user.id,
        source_segment_id=payload.segment_id,
    )
```

- [ ] **Step 4: Write the integration test**

Create `backend/tests/test_generate_map_with_segment.py`:

```python
"""Generate-process-map scoped to a detection segment."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import ProcessVersion
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult
from app.services.process_generation import GeneratedStructure


@pytest.fixture()
def client(db):
    return TestClient(create_app())


def _seed_project_with_two_claims(db):
    org = Organization(name="t")
    db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj); db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="i.txt",
        file_path="i.txt",
        file_size=10,
        mime_type="text/plain",
        status="parsed",
        uploaded_by=user.id,
    )
    db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec); db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2]); db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2]); db.flush()
    db.add_all([
        ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
        ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
    ])
    db.commit()
    return proj


def test_generate_with_segment_id_uses_only_segment_claims(client, db):
    proj = _seed_project_with_two_claims(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10, output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        run = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    ap_seg = next(s for s in run["segments"] if s["name"] == "AP")

    captured: dict = {}
    def fake_generate(claims, **kwargs):
        captured["count"] = len(claims)
        return GeneratedStructure(
            process_name="AP",
            steps=[{"id": "s1", "type": "userTask", "name": "Do x", "role": "AP", "claim_refs": [0]}],
            gateways=[],
        )

    with patch(
        "app.api.v2.process_maps.generate_structure_from_claims",
        side_effect=fake_generate,
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={
                "name": "AP map",
                "level": "2",
                "segment_id": ap_seg["id"],
            },
        )

    assert resp.status_code == 201, resp.text
    # Only the one AP claim should have been passed to Claude.
    assert captured["count"] == 1
    version_id = resp.json()["version_id"]
    v = db.get(ProcessVersion, version_id)
    assert str(v.source_segment_id) == ap_seg["id"]
```

- [ ] **Step 5: Run, expect green**

```
cd backend && pytest tests/test_generate_map_with_segment.py -v
```

Expected: 1 passed.

- [ ] **Step 6: Verify existing generate-map tests still pass**

```
cd backend && pytest tests/ -v
```

Expected: all tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_generate_map_with_segment.py
git commit -m "feat(detection): segment_id additive on generate-process-map"
```

---

## Task 18: Frontend types and api client

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Append the detection types**

Append to `src/lib/types.ts`:

```typescript
export interface ProcessSegment {
  id: UUID;
  detection_run_id: UUID;
  name: string;
  description: string;
  order_index: number;
  claim_count: number;
  confidence: number | null;
  is_unassigned: boolean;
  claims: Array<{ id: UUID; kind: string; subject: string }>;
}

export interface DetectionRunDetail {
  id: UUID;
  project_id: UUID;
  status: "draft" | "accepted" | "archived" | "superseded";
  claim_count_at_run: number;
  model_used: string | null;
  reasoning_summary: string | null;
  created_at: string;
  segments: ProcessSegment[];
  unassigned_segment: ProcessSegment;
}

export interface DetectionRunListRow {
  id: UUID;
  status: "draft" | "accepted" | "archived" | "superseded";
  claim_count_at_run: number;
  segment_count: number;
  created_at: string;
}

export interface AcceptDetectionRunResult {
  run_id: UUID;
  accepted_segment_count: number;
}

export interface DetectProcessesRequest {
  scope_input_ids?: UUID[] | null;
}
```

Also extend `ProcessMapGenerateRequest`:

Search for `export interface ProcessMapGenerateRequest` in `src/lib/types.ts` and add the `segment_id` field:

```typescript
export interface ProcessMapGenerateRequest {
  name: string;
  level: string;
  focus?: string | null;
  map_type?: string | null;
  scope_input_ids?: UUID[] | null;
  segment_id?: UUID | null;
}
```

- [ ] **Step 2: Add the api client methods**

In `src/lib/api.ts`, add to the top imports:

```typescript
import type {
  AcceptDetectionRunResult,
  DetectionRunDetail,
  DetectionRunListRow,
  DetectProcessesRequest,
  ProcessSegment,
} from "@/lib/types";
```

> Note: if your types are already imported via the existing block at the top of the file, append the four new identifiers to that import instead of adding a second `import type` line.

Add at the end of the `api` object (before the closing brace), before existing trailing methods if needed:

```typescript
  // Process detection
  detectProcesses: (projectId: UUID, body: DetectProcessesRequest = {}) =>
    request<DetectionRunDetail>(
      `/api/v2/projects/${projectId}/detect-processes`,
      { method: "POST", json: body }
    ),
  listDetectionRuns: (projectId: UUID) =>
    request<DetectionRunListRow[]>(
      `/api/v2/projects/${projectId}/detection-runs`
    ),
  getDetectionRun: (projectId: UUID, runId: UUID) =>
    request<DetectionRunDetail>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}`
    ),
  updateSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { name?: string | null; description?: string | null }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}`,
      { method: "PATCH", json: body }
    ),
  createSegment: (
    projectId: UUID,
    runId: UUID,
    body: { name: string }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}/segments`,
      { method: "POST", json: body }
    ),
  mergeSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { into_segment_id: UUID }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}/merge`,
      { method: "POST", json: body }
    ),
  deleteSegment: (projectId: UUID, segmentId: UUID) =>
    request<void>(
      `/api/v2/projects/${projectId}/segments/${segmentId}`,
      { method: "DELETE" }
    ),
  moveClaimToSegment: (
    projectId: UUID,
    segmentId: UUID,
    body: { claim_id: UUID }
  ) =>
    request<ProcessSegment>(
      `/api/v2/projects/${projectId}/segments/${segmentId}/claims`,
      { method: "POST", json: body }
    ),
  acceptDetectionRun: (projectId: UUID, runId: UUID) =>
    request<AcceptDetectionRunResult>(
      `/api/v2/projects/${projectId}/detection-runs/${runId}/accept`,
      { method: "POST" }
    ),
```

- [ ] **Step 3: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(detection): frontend types and api client methods"
```

---

## Task 19: Detect-processes button on the Documents tab

**Files:**
- Create: `src/components/detect-processes-button.tsx`
- Modify: `src/app/(app)/projects/[id]/documents/page.tsx`

- [ ] **Step 1: Create the button component**

Create `src/components/detect-processes-button.tsx`:

```typescript
"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

export function DetectProcessesButton({ projectId }: { projectId: UUID }) {
  const router = useRouter();
  const qc = useQueryClient();

  const runsQuery = useQuery({
    queryKey: ["detection-runs", projectId],
    queryFn: () => api.listDetectionRuns(projectId),
  });

  const draft = runsQuery.data?.find((r) => r.status === "draft");
  const accepted = runsQuery.data?.find((r) => r.status === "accepted");

  const detect = useMutation({
    mutationFn: () => api.detectProcesses(projectId),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      router.push(`/projects/${projectId}/detect/${run.id}`);
    },
    onError: (e: Error) => toast.error(`Detection failed: ${e.message}`),
  });

  const onClick = () => {
    if (draft) {
      router.push(`/projects/${projectId}/detect/${draft.id}`);
      return;
    }
    detect.mutate();
  };

  let label = "Detect processes";
  if (detect.isPending) label = "Detecting…";
  else if (draft) label = `Resume draft (${draft.segment_count} segments)`;
  else if (accepted) label = "Re-detect processes";

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        onClick={onClick}
        disabled={detect.isPending}
      >
        {label}
      </Button>
      {accepted && !draft && (
        <Badge variant="outline">{accepted.segment_count} accepted</Badge>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount the button on the Documents page**

In `src/app/(app)/projects/[id]/documents/page.tsx`:

Add the import at the top with the other component imports:

```typescript
import { DetectProcessesButton } from "@/components/detect-processes-button";
```

Locate the header block at the top of the JSX (the `<div className="flex items-center justify-between">` containing `<UploadForm projectId={id} />`). Replace that block with:

```tsx
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Upload documents (interviews, SOPs, policies, …) to feed the claim
          extractor and process generator.
        </p>
        <div className="flex items-center gap-2">
          <DetectProcessesButton projectId={id} />
          <UploadForm projectId={id} />
        </div>
      </div>
```

- [ ] **Step 3: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

Start the dev server (`npm run dev`), navigate to a project's Documents tab. Verify the button appears next to Upload. Click it on a project with no claims — expect a toast "No claims found for this project (scope). Run extract-claims first." (or similar 422 message).

- [ ] **Step 5: Commit**

```bash
git add src/components/detect-processes-button.tsx "src/app/(app)/projects/[id]/documents/page.tsx"
git commit -m "feat(detection): Detect-processes button on the Documents tab"
```

---

## Task 20: Review-page route and shell

**Files:**
- Create: `src/app/(app)/projects/[id]/detect/[runId]/page.tsx`

- [ ] **Step 1: Create the route file**

Create `src/app/(app)/projects/[id]/detect/[runId]/page.tsx`:

```typescript
"use client";

import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function DetectionReviewPage() {
  const params = useParams<{ id: string; runId: string }>();
  const projectId = params.id;
  const runId = params.runId;
  const router = useRouter();
  const qc = useQueryClient();

  const runQuery = useQuery({
    queryKey: ["detection-run", projectId, runId],
    queryFn: () => api.getDetectionRun(projectId, runId),
  });

  const accept = useMutation({
    mutationFn: () => api.acceptDetectionRun(projectId, runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      router.push(`/projects/${projectId}/maps?postAcceptRun=${runId}`);
    },
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });

  if (runQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (runQuery.error) {
    return (
      <p className="text-sm text-red-600">{(runQuery.error as Error).message}</p>
    );
  }
  const run = runQuery.data;
  if (!run) return null;

  const created = new Date(run.created_at).toLocaleString();
  const isDraft = run.status === "draft";
  const segCount = run.segments.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Detected processes
          </h1>
          <p className="text-sm text-muted-foreground">
            {segCount} candidates · {run.claim_count_at_run} claims · Run{" "}
            {created} · Status: {run.status}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            disabled={!isDraft || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Accepting…" : "Accept & continue"}
          </Button>
        </div>
      </div>

      {segCount === 1 && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          We found a single process. You can still rename and accept, or skip to
          direct generation.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          {/* segment cards mounted in Task 21 */}
          <p className="text-sm text-muted-foreground">
            ({segCount} segments — cards rendered in the next task.)
          </p>
        </div>
        <aside className="space-y-4">
          {run.reasoning_summary && (
            <div className="rounded border p-3">
              <h2 className="text-sm font-semibold mb-2">Why these splits?</h2>
              <p className="text-xs text-muted-foreground whitespace-pre-line">
                {run.reasoning_summary}
              </p>
            </div>
          )}
          <div className="rounded border p-3">
            <h2 className="text-sm font-semibold">Unassigned</h2>
            <p className="text-xs text-muted-foreground">
              {run.unassigned_segment.claim_count} claim
              {run.unassigned_segment.claim_count === 1 ? "" : "s"}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 3: Manual verification**

With the dev server running, create a draft via the Documents-tab button. Verify the URL routes you to `/projects/{id}/detect/{runId}` and the page renders header info + count.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/projects/[id]/detect/[runId]/page.tsx"
git commit -m "feat(detection): review-page route shell"
```

---

## Task 21: Segment card (rename, delete, move-claim popover)

**Files:**
- Create: `src/components/detect/segment-card.tsx`
- Create: `src/components/detect/move-claim-popover.tsx`
- Modify: `src/app/(app)/projects/[id]/detect/[runId]/page.tsx`

- [ ] **Step 1: Create the move-claim popover**

Create `src/components/detect/move-claim-popover.tsx`:

```typescript
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { ProcessSegment, UUID } from "@/lib/types";

export function MoveClaimPopover({
  projectId,
  runId,
  claimId,
  currentSegmentId,
  candidates,
}: {
  projectId: UUID;
  runId: UUID;
  claimId: UUID;
  currentSegmentId: UUID;
  candidates: ProcessSegment[];
}) {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (toId: UUID) =>
      api.moveClaimToSegment(projectId, toId, { claim_id: claimId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Move failed: ${e.message}`),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Move ↓
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <p className="text-xs text-muted-foreground mb-2 px-1">Move to…</p>
        <div className="space-y-1 max-h-72 overflow-auto">
          {candidates
            .filter((c) => c.id !== currentSegmentId)
            .map((c) => (
              <button
                key={c.id}
                disabled={move.isPending}
                onClick={() => move.mutate(c.id)}
                className="w-full text-left text-sm px-2 py-1 rounded hover:bg-muted"
              >
                {c.name || "(unnamed)"}
                {c.is_unassigned && (
                  <span className="ml-2 text-muted-foreground text-xs">
                    · unassigned
                  </span>
                )}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

> If a `Popover` component does not exist under `src/components/ui/popover.tsx`, add it now with `npx shadcn@latest add popover` from the repo root, then re-run type-check.

- [ ] **Step 2: Create the segment card**

Create `src/components/detect/segment-card.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { MoveClaimPopover } from "@/components/detect/move-claim-popover";
import type { ProcessSegment, UUID } from "@/lib/types";

const RENAME_DEBOUNCE_MS = 400;

export function SegmentCard({
  projectId,
  runId,
  segment,
  allSegments,
  unassignedSegment,
  disabled,
}: {
  projectId: UUID;
  runId: UUID;
  segment: ProcessSegment;
  allSegments: ProcessSegment[];
  unassignedSegment: ProcessSegment;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(segment.name);

  useEffect(() => setName(segment.name), [segment.name]);

  const renameMutation = useMutation({
    mutationFn: (newName: string) =>
      api.updateSegment(projectId, segment.id, { name: newName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Rename failed: ${e.message}`),
  });

  useEffect(() => {
    if (disabled || name === segment.name) return;
    const t = setTimeout(
      () => renameMutation.mutate(name),
      RENAME_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [name]);

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSegment(projectId, segment.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  const low = (segment.confidence ?? 1) < 0.5;
  const candidates = [...allSegments, unassignedSegment];

  return (
    <div
      className={`rounded border p-3 space-y-2 ${low ? "border-amber-400" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          className="font-medium"
          maxLength={300}
        />
        {segment.confidence != null && (
          <Badge variant={low ? "destructive" : "outline"}>
            {segment.confidence.toFixed(2)}
          </Badge>
        )}
        <Badge variant="secondary">{segment.claim_count}</Badge>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || deleteMutation.isPending}
          onClick={() => deleteMutation.mutate()}
        >
          Delete
        </Button>
      </div>
      {segment.description && (
        <p className="text-xs text-muted-foreground">{segment.description}</p>
      )}
      <ul className="space-y-1 max-h-72 overflow-auto">
        {segment.claims.map((cl) => (
          <li
            key={cl.id}
            className="flex items-center justify-between text-sm px-1"
          >
            <span className="truncate">
              <Badge variant="outline" className="mr-2 uppercase text-[10px]">
                {cl.kind}
              </Badge>
              {cl.subject}
            </span>
            {!disabled && (
              <MoveClaimPopover
                projectId={projectId}
                runId={runId}
                claimId={cl.id}
                currentSegmentId={segment.id}
                candidates={candidates}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Wire the cards into the page**

In `src/app/(app)/projects/[id]/detect/[runId]/page.tsx`, replace the placeholder `<p className="text-sm text-muted-foreground">({segCount} segments — cards rendered in the next task.)</p>` block with:

```tsx
          {run.segments.map((seg) => (
            <SegmentCard
              key={seg.id}
              projectId={projectId}
              runId={runId}
              segment={seg}
              allSegments={run.segments}
              unassignedSegment={run.unassigned_segment}
              disabled={!isDraft}
            />
          ))}
          {isDraft && <NewEmptyClusterButton projectId={projectId} runId={runId} />}
```

Add the imports at the top of the page:

```typescript
import { SegmentCard } from "@/components/detect/segment-card";
import { NewEmptyClusterButton } from "@/components/detect/new-empty-cluster-button";
```

- [ ] **Step 4: Create the "new empty cluster" button**

Create `src/components/detect/new-empty-cluster-button.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

export function NewEmptyClusterButton({
  projectId,
  runId,
}: {
  projectId: UUID;
  runId: UUID;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (n: string) =>
      api.createSegment(projectId, runId, { name: n }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
      setName("");
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  return (
    <div className="flex items-center gap-2 pt-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name a new empty cluster"
        maxLength={300}
        className="max-w-xs"
      />
      <Button
        size="sm"
        disabled={!name.trim() || create.isPending}
        onClick={() => create.mutate(name.trim())}
      >
        + New empty cluster
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 6: Manual verification**

Start the dev server. Create a draft (Detect from Documents). Confirm the page renders one card per segment. Verify rename (type a new name; wait 400 ms; refresh — the rename persisted). Verify delete moves the segment's claims to Unassigned. Verify Move ↓ on a claim moves it to another cluster.

- [ ] **Step 7: Commit**

```bash
git add src/components/detect/ "src/app/(app)/projects/[id]/detect/[runId]/page.tsx"
git commit -m "feat(detection): segment cards with rename, delete, move, new empty"
```

---

## Task 22: Merge popover

**Files:**
- Create: `src/components/detect/merge-popover.tsx`
- Modify: `src/components/detect/segment-card.tsx`

- [ ] **Step 1: Create the merge popover**

Create `src/components/detect/merge-popover.tsx`:

```typescript
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { ProcessSegment, UUID } from "@/lib/types";

export function MergePopover({
  projectId,
  runId,
  source,
  candidates,
}: {
  projectId: UUID;
  runId: UUID;
  source: ProcessSegment;
  candidates: ProcessSegment[];
}) {
  const qc = useQueryClient();
  const merge = useMutation({
    mutationFn: (intoId: UUID) =>
      api.mergeSegment(projectId, source.id, { into_segment_id: intoId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Merge failed: ${e.message}`),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Merge
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <p className="text-xs text-muted-foreground mb-2 px-1">Merge into…</p>
        <div className="space-y-1 max-h-72 overflow-auto">
          {candidates
            .filter((c) => c.id !== source.id && !c.is_unassigned)
            .map((c) => (
              <button
                key={c.id}
                disabled={merge.isPending}
                onClick={() => merge.mutate(c.id)}
                className="w-full text-left text-sm px-2 py-1 rounded hover:bg-muted"
              >
                {c.name || "(unnamed)"}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Wire it into the segment card**

In `src/components/detect/segment-card.tsx`, add the import:

```typescript
import { MergePopover } from "@/components/detect/merge-popover";
```

Inside the action row (next to the Delete button), insert before Delete:

```tsx
        <MergePopover
          projectId={projectId}
          runId={runId}
          source={segment}
          candidates={allSegments}
        />
```

Disable the merge for the disabled case by wrapping it:

```tsx
        {!disabled && (
          <MergePopover
            projectId={projectId}
            runId={runId}
            source={segment}
            candidates={allSegments}
          />
        )}
```

- [ ] **Step 3: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 4: Manual verification**

In a draft review screen, click Merge on a card → select a target → confirm both cards collapse into one with combined claim count.

- [ ] **Step 5: Commit**

```bash
git add src/components/detect/merge-popover.tsx src/components/detect/segment-card.tsx
git commit -m "feat(detection): merge popover wired into segment card"
```

---

## Task 23: Post-accept generation panel + Maps page changes

**Files:**
- Create: `src/components/detect/post-accept-panel.tsx`
- Modify: `src/app/(app)/projects/[id]/maps/page.tsx`

- [ ] **Step 1: Create the panel**

Create `src/components/detect/post-accept-panel.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import type { ProcessSegment, UUID } from "@/lib/types";

const LEVELS = [
  { value: "1", label: "L1" },
  { value: "2", label: "L2" },
  { value: "3", label: "L3" },
  { value: "4", label: "L4" },
];
const MAP_TYPES = [
  { value: "any", label: "Either / unspecified" },
  { value: "current_state", label: "Current state" },
  { value: "future_state", label: "Future state" },
];

export function PostAcceptPanel({
  projectId,
  runId,
  onDismiss,
}: {
  projectId: UUID;
  runId: UUID;
  onDismiss: () => void;
}) {
  const qc = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["detection-run", projectId, runId],
    queryFn: () => api.getDetectionRun(projectId, runId),
  });

  const [defaultLevel, setDefaultLevel] = useState("2");
  const [mapType, setMapType] = useState("current_state");
  const [perSegLevel, setPerSegLevel] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, "idle" | "running" | "done" | "failed">>({});

  if (!runQuery.data) return null;
  const segments = runQuery.data.segments.filter((s) => !s.is_unassigned);

  const levelFor = (id: UUID) => perSegLevel[id] || defaultLevel;

  const generateOne = async (seg: ProcessSegment) => {
    setStatus((s) => ({ ...s, [seg.id]: "running" }));
    try {
      await api.generateProcessMap(projectId, {
        name: seg.name,
        level: levelFor(seg.id),
        map_type: mapType === "any" ? null : mapType,
        segment_id: seg.id,
      });
      setStatus((s) => ({ ...s, [seg.id]: "done" }));
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
    } catch (e) {
      setStatus((s) => ({ ...s, [seg.id]: "failed" }));
      toast.error(
        `Generate failed for ${seg.name}: ${(e as Error).message}`,
      );
    }
  };

  const generateAll = async () => {
    for (const seg of segments) {
      if (status[seg.id] === "done" || status[seg.id] === "running") continue;
      // eslint-disable-next-line no-await-in-loop
      await generateOne(seg);
    }
  };

  const allDone = segments.length > 0 && segments.every((s) => status[s.id] === "done");

  return (
    <div className="rounded border p-4 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">
          Generate maps from {segments.length} accepted process
          {segments.length === 1 ? "" : "es"}
        </h2>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Skip — generate manually
        </Button>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <span>Default level:</span>
        <Select value={defaultLevel} onValueChange={setDefaultLevel}>
          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>Map type:</span>
        <Select value={mapType} onValueChange={setMapType}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MAP_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ul className="space-y-2">
        {segments.map((seg) => (
          <li
            key={seg.id}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="truncate flex-1">{seg.name}</span>
            <Select
              value={levelFor(seg.id)}
              onValueChange={(v) =>
                setPerSegLevel((p) => ({ ...p, [seg.id]: v }))
              }
            >
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={status[seg.id] === "done" ? "outline" : "default"}
              disabled={status[seg.id] === "running" || status[seg.id] === "done"}
              onClick={() => generateOne(seg)}
            >
              {status[seg.id] === "running"
                ? "Generating…"
                : status[seg.id] === "done"
                  ? "Done"
                  : status[seg.id] === "failed"
                    ? "Retry"
                    : "Generate now"}
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex justify-end gap-2">
        <Button variant="default" onClick={generateAll} disabled={allDone}>
          Generate all in sequence
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it on the Maps page**

In `src/app/(app)/projects/[id]/maps/page.tsx`:

Add imports:

```typescript
import { useSearchParams, useRouter } from "next/navigation";
import { PostAcceptPanel } from "@/components/detect/post-accept-panel";
```

Replace the function body's existing top to thread the panel in. The relevant slice of the JSX (inside the existing return) becomes:

```tsx
  const params = useSearchParams();
  const router = useRouter();
  const postAcceptRun = params.get("postAcceptRun");

  const dismissPanel = () => {
    const sp = new URLSearchParams(params);
    sp.delete("postAcceptRun");
    router.replace(`/projects/${id}/maps${sp.toString() ? `?${sp}` : ""}`);
  };
```

Inside the rendered JSX (just below the header row with `<GenerateMapForm />`), add:

```tsx
      {postAcceptRun && (
        <PostAcceptPanel
          projectId={id}
          runId={postAcceptRun}
          onDismiss={dismissPanel}
        />
      )}
```

- [ ] **Step 3: Update the empty state copy**

In the same Maps page, replace the existing `{data && data.length === 0 && (...)}` block with:

```tsx
      {data && data.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No maps yet</CardTitle>
            <CardDescription>
              Find the processes in your documents — open the Documents tab and
              click Detect processes. You can also generate a single map
              directly with the button above.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
```

- [ ] **Step 4: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 5: Manual verification**

End-to-end: upload a doc, extract, detect, name segments, accept. Verify redirect to `/projects/{id}/maps?postAcceptRun=...`. Verify the panel renders with one row per accepted segment, lets you generate per row or all-in-sequence, and that completed maps appear in the maps grid below.

- [ ] **Step 6: Commit**

```bash
git add src/components/detect/post-accept-panel.tsx "src/app/(app)/projects/[id]/maps/page.tsx"
git commit -m "feat(detection): post-accept generation panel + Maps empty-state copy"
```

---

## Task 24: Generate-map form: "From detected process" dropdown

**Files:**
- Modify: `src/components/generate-map-form.tsx`

- [ ] **Step 1: Add a segment dropdown that defaults to None**

In `src/components/generate-map-form.tsx`:

Add the new imports near the existing import block:

```typescript
import { useQuery } from "@tanstack/react-query";
```

Inside the `GenerateMapForm` component body, after the other `useState` hooks, add:

```typescript
  const [segmentId, setSegmentId] = useState<string>("none");

  const runsQuery = useQuery({
    queryKey: ["detection-runs", projectId],
    queryFn: () => api.listDetectionRuns(projectId),
  });
  const accepted = runsQuery.data?.find((r) => r.status === "accepted");
  const acceptedRunDetail = useQuery({
    queryKey: ["detection-run", projectId, accepted?.id],
    queryFn: () =>
      accepted ? api.getDetectionRun(projectId, accepted.id) : Promise.resolve(null),
    enabled: !!accepted,
  });
  const acceptedSegments =
    acceptedRunDetail.data?.segments.filter((s) => !s.is_unassigned) ?? [];
```

Inside the mutation function, thread `segment_id`:

```typescript
  const generate = useMutation({
    mutationFn: () =>
      api.generateProcessMap(projectId, {
        name: name.trim(),
        level,
        focus: focus.trim() || null,
        map_type: mapType === "any" ? null : mapType,
        segment_id: segmentId === "none" ? null : segmentId,
      }),
    onSuccess: (res) => {
      toast.success(
        `Generated "${res.process_name}" v${res.lane_count}-lane / ${res.node_count}-node map.`
      );
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      setOpen(false);
      setName("");
      setFocus("");
      setSegmentId("none");
      router.push(
        `/projects/${projectId}/maps/${res.model_id}/versions/${res.version_id}`
      );
    },
    onError: (e: Error) => toast.error(`Generation failed: ${e.message}`),
  });
```

In the dialog body, add the dropdown as the FIRST `space-y-2` block — above the existing Process Name field:

```tsx
          {acceptedSegments.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="map-segment">From detected process</Label>
              <Select value={segmentId} onValueChange={setSegmentId}>
                <SelectTrigger id="map-segment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (use all claims)</SelectItem>
                  {acceptedSegments.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Scopes generation to claims in the chosen detected process.
              </p>
            </div>
          )}
```

- [ ] **Step 2: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 3: Manual verification**

In a project with an accepted detection run, open the existing Generate map dialog from the Maps tab. The dropdown should appear above Process Name with one entry per accepted segment plus "None." Selecting one and generating should produce a map whose `source_segment_id` matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/generate-map-form.tsx
git commit -m "feat(detection): from-detected-process dropdown on Generate map form"
```

---

## Task 25: End-to-end backend smoke test

**Files:**
- Create: `backend/tests/test_detection_end_to_end.py`

- [ ] **Step 1: Write the smoke test**

Create `backend/tests/test_detection_end_to_end.py`:

```python
"""End-to-end smoke: extract → detect → name → accept → generate two maps."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import ProcessVersion
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult
from app.services.process_generation import GeneratedStructure


@pytest.fixture()
def client(db):
    return TestClient(create_app())


def test_extract_to_detect_to_generate_two_maps(client, db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    inp = Input(
        project_id=proj.id, type="interview_transcript", name="i.txt",
        file_path="i.txt", file_size=10, mime_type="text/plain",
        status="parsed", uploaded_by=user.id,
    )
    db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec); db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="ap", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="ob", tokens=1)
    db.add_all([ch1, ch2]); db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2]); db.flush()
    db.add_all([
        ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="ap", confidence=0.9),
        ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="ob", confidence=0.9),
    ])
    db.commit()

    detect_result = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10, output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=detect_result,
    ):
        run = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for seg in run["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": seg["name"]},  # ensure named
        )
    client.post(f"/api/v2/projects/{proj.id}/detection-runs/{run['id']}/accept")

    def fake_generate(claims, **kwargs):
        return GeneratedStructure(
            process_name=kwargs.get("process_name", "X"),
            steps=[{"id": "s1", "type": "userTask", "name": "Do",
                    "role": "R", "claim_refs": [0]}],
            gateways=[],
        )
    with patch(
        "app.api.v2.process_maps.generate_structure_from_claims",
        side_effect=fake_generate,
    ):
        for seg in run["segments"]:
            r = client.post(
                f"/api/v2/projects/{proj.id}/generate-process-map",
                json={
                    "name": seg["name"],
                    "level": "2",
                    "segment_id": seg["id"],
                },
            )
            assert r.status_code == 201, r.text

    versions = db.query(ProcessVersion).all()
    # Two maps, both with non-null source_segment_id.
    assert len(versions) == 2
    assert all(v.source_segment_id is not None for v in versions)
    seg_ids = {str(v.source_segment_id) for v in versions}
    expected_seg_ids = {s["id"] for s in run["segments"]}
    assert seg_ids == expected_seg_ids
```

- [ ] **Step 2: Run**

```
cd backend && pytest tests/test_detection_end_to_end.py -v
```

Expected: 1 passed.

- [ ] **Step 3: Run the full backend test suite**

```
cd backend && pytest -v
```

Expected: every test green.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_detection_end_to_end.py
git commit -m "test(detection): end-to-end extract → detect → accept → generate"
```

---

## Task 26: Stale-maps indicator on the Maps tab

A map generated from a now-superseded detection run should surface that fact on the maps list so the user knows the cluster definition has moved on. Non-blocking; no behavior change to the map itself.

**Files:**
- Modify: `backend/app/schemas/process_map.py` (add fields to `ProcessModelRead`)
- Modify: `backend/app/api/v2/process_maps.py` (populate the new fields in `list_process_maps`)
- Modify: `src/lib/types.ts` (extend the `ProcessModel` TS type)
- Modify: `src/app/(app)/projects/[id]/maps/page.tsx` (render the indicator)

- [ ] **Step 1: Backend — extend `ProcessModelRead`**

In `backend/app/schemas/process_map.py`, append two optional fields to `ProcessModelRead`:

```python
class ProcessModelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    name: str
    level: str
    parent_model_id: UUID | None
    created_at: datetime
    updated_at: datetime
    latest_version_id: UUID | None = None
    latest_version_number: int | None = None
    latest_source_segment_id: UUID | None = None
    latest_source_run_status: str | None = None
```

- [ ] **Step 2: Backend — populate the new fields in `list_process_maps`**

In `backend/app/api/v2/process_maps.py`, the existing `list_process_maps` query already returns the latest `(version_id, version_number)` per model. Extend it to also return `source_segment_id` and join through `process_segments` → `detection_runs` to get the run status. Replace the existing inner block that builds `latest_by_model`:

```python
    model_ids = [m.id for m in models]
    from app.models.process_detection import DetectionRun, ProcessSegment

    rows = db.execute(
        select(
            ProcessVersion.model_id,
            ProcessVersion.id,
            ProcessVersion.version_number,
            ProcessVersion.source_segment_id,
            DetectionRun.status,
        )
        .outerjoin(ProcessSegment, ProcessSegment.id == ProcessVersion.source_segment_id)
        .outerjoin(DetectionRun, DetectionRun.id == ProcessSegment.detection_run_id)
        .where(ProcessVersion.model_id.in_(model_ids))
        .order_by(
            ProcessVersion.model_id,
            ProcessVersion.version_number.desc(),
        )
        .distinct(ProcessVersion.model_id)
    ).all()
    latest_by_model: dict = {
        row[0]: (row[1], row[2], row[3], row[4]) for row in rows
    }

    return [
        ProcessModelRead.model_validate(m).model_copy(
            update={
                "latest_version_id": latest_by_model.get(m.id, (None, None, None, None))[0],
                "latest_version_number": latest_by_model.get(m.id, (None, None, None, None))[1],
                "latest_source_segment_id": latest_by_model.get(m.id, (None, None, None, None))[2],
                "latest_source_run_status": latest_by_model.get(m.id, (None, None, None, None))[3],
            }
        )
        for m in models
    ]
```

- [ ] **Step 3: Backend — quick smoke test**

```
cd backend && pytest tests/ -v
```

Expected: all tests still green (existing list-maps tests should keep passing since the new fields are optional with defaults).

- [ ] **Step 4: Frontend — extend the type**

In `src/lib/types.ts`, locate the `ProcessModel` interface and add the two new optional fields:

```typescript
export interface ProcessModel {
  id: UUID;
  project_id: UUID;
  name: string;
  level: string;
  parent_model_id: UUID | null;
  created_at: string;
  updated_at: string;
  latest_version_id: UUID | null;
  latest_version_number: number | null;
  latest_source_segment_id?: UUID | null;
  latest_source_run_status?:
    | "draft"
    | "accepted"
    | "archived"
    | "superseded"
    | null;
}
```

- [ ] **Step 5: Frontend — render the indicator on each map card**

In `src/app/(app)/projects/[id]/maps/page.tsx`, inside the map card's `<CardHeader>` (next to the level badge), add the stale indicator. Find the existing badge:

```tsx
                      <Badge variant="outline">{m.level}</Badge>
```

Wrap it and the new indicator together:

```tsx
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">{m.level}</Badge>
                        {m.latest_source_run_status === "superseded" && (
                          <Badge variant="secondary" title="Generated from a detection run that has since been superseded.">
                            stale
                          </Badge>
                        )}
                      </div>
```

- [ ] **Step 6: Type-check**

```
cd "/home/chagood/workspace/projects/Process Engineering" && npx tsc --noEmit
```

- [ ] **Step 7: Manual verification**

Run two detection cycles in the same project; accept both. Maps generated from the first (now superseded) run should show a `stale` badge on the Maps tab.

- [ ] **Step 8: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py src/lib/types.ts "src/app/(app)/projects/[id]/maps/page.tsx"
git commit -m "feat(detection): stale-maps badge for maps from superseded runs"
```

---

## Task 27: Manual UI verification checklist

**Files:** none — manual.

Run the dev server (`./run-local.sh` or `npm run dev` + `cd backend && uvicorn main:app --reload`) and walk through each item:

- [ ] Documents tab shows the **Detect processes** button next to **Upload**.
- [ ] With no claims in the project, clicking **Detect processes** surfaces a 422 toast ("No claims found …").
- [ ] After extracting claims from at least one document, clicking **Detect processes** routes to `/projects/{id}/detect/{runId}` and renders one card per cluster.
- [ ] Each card supports rename (debounced), Move ↓ on a claim, Delete, and Merge into another card.
- [ ] **+ New empty cluster** creates an empty card you can name and move claims into.
- [ ] **Accept & continue** redirects to `/projects/{id}/maps?postAcceptRun=…`; the post-accept panel renders with one row per accepted cluster.
- [ ] **Generate all in sequence** generates N maps serially; **Generate now** generates a single map.
- [ ] Visiting the Documents tab afterwards shows **Re-detect processes** with the accepted count badge.
- [ ] Triggering a fresh draft while one already exists routes to **Resume draft (N segments)** instead of failing.
- [ ] The existing **Generate map** dialog shows a new **From detected process** dropdown above Process Name, defaulting to **None**, listing accepted segments.
- [ ] On a project with one detected cluster, the review screen shows the "We found a single process" banner.

- [ ] **Commit any notes if a checklist item fails:** open a follow-up TODO file and reference the failure inline; do not silently move on.

---

## Self-Review

The writer ran the writing-plans self-review checklist after the initial draft. Two findings, both fixed inline:

1. **Dead `inherited_name_match` field** on `ProcessSegmentRead` / the matching TS type — never set by the service. Per the spec, the "Matches existing 'X'" banner is UI-only and the inherited name is already baked into `segment.name` by the orchestrator. Removed from both Pydantic and TS.
2. **Missing stale-maps indicator task** — the spec calls for a non-blocking "Generated from older detection run" badge on the Maps tab for maps whose `source_segment_id` belongs to a superseded run. Added as Task 26 (Manual UI verification renumbered to Task 27).

Post-fix checklist:

- **Spec coverage** — every section/requirement maps to a task: data model and partial unique index (Tasks 2–4), at-most-one-draft invariant (enforced at the DB by Task 2's index plus the service in Task 9), prompt + tool schema (Tasks 5–6), 70% heuristic (Task 7), Pydantic surface (Task 8), six API endpoints + acceptance (Tasks 9–16), additive `segment_id` on generate-process-map (Task 17), backward-compat (preserved — old generate calls pass `segment_id=null` unchanged), frontend types/api (Task 18), Detect button + state machine (Task 19), review page (Tasks 20–22), post-accept generation panel + Maps empty state (Task 23), generate-map dropdown (Task 24), end-to-end backend smoke (Task 25), stale-maps badge (Task 26), manual UI verification (Task 27).
- **Placeholder scan** — every code step contains the full code the engineer needs. No "TODO", no "fill in error handling," no "similar to Task N" without the code repeated.
- **Type consistency** — `ProcessSegment` (TS) ↔ `ProcessSegmentRead` (Pydantic) field names match exactly; `DetectionRunDetail` carries `segments` + `unassigned_segment` consistently in both layers; `api.moveClaimToSegment`/`api.acceptDetectionRun` URL templates match the FastAPI route paths exactly; `segment_id` is `UUID | None` in both stacks; the new `latest_source_segment_id` / `latest_source_run_status` fields on `ProcessModelRead` are optional with defaults so existing callers don't break.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-multi-process-detection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
