# Extraction Progress UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claim extraction progress visible in the UI and survive backend restarts, by committing per-chunk and exposing live counters through the existing `listInputs` endpoint.

**Architecture:** The extract-claims endpoint keeps its synchronous request shape but writes a transient `extracting` status plus `chunks_processed` / `chunks_total` / `extraction_started_at` / `extraction_error` columns on the `inputs` row, committing once per chunk. A FastAPI lifespan startup sweep flips any stale `extracting` rows to `failed`. The Documents page polls inputs every 3 seconds while any row is extracting, and renders a progress cell driven entirely by the row's own state (no dependence on the client's mutation flag).

**Tech Stack:** FastAPI 0.115, SQLAlchemy 2.0, Alembic 1.14, Postgres + pgvector, Next.js 16 App Router, React 19, TanStack Query 5, shadcn/ui, pytest (newly introduced).

**Companion spec:** `docs/superpowers/specs/2026-05-27-extraction-progress-ui-design.md`

---

## File Structure

**Created**
- `backend/alembic/versions/0004_extraction_progress_fields.py` — DB migration adding the 4 columns.
- `backend/app/services/startup.py` — `sweep_stale_extracting_inputs(db)` function.
- `backend/pytest.ini` — pytest config.
- `backend/tests/__init__.py` — empty marker.
- `backend/tests/conftest.py` — `db` + `fresh_session_factory` fixtures using the existing dockerized Postgres on a fresh `poet_test` database; truncates all data tables between tests so per-test commits don't leak.
- `backend/tests/test_extract_input_claims.py` — unit tests for the rewritten extraction loop (happy path + failure mid-loop).
- `backend/tests/test_startup_sweep.py` — unit test for the startup sweep.
- `src/components/ui/progress.tsx` — shadcn Progress primitive (generated via CLI).
- `src/components/extraction-progress-cell.tsx` — self-contained progress cell rendered in the documents row.

**Modified**
- `backend/app/enums.py` — add `EXTRACTING = "extracting"`.
- `backend/app/models/input.py` — add `chunks_processed`, `chunks_total`, `extraction_started_at`, `extraction_error` columns.
- `backend/app/schemas/input.py` — add the same four fields to `InputRead`.
- `backend/app/api/v2/claims.py` — rewrite `extract_input_claims` with per-chunk commits and progress tracking.
- `backend/main.py` — register a FastAPI `lifespan` that runs the startup sweep.
- `backend/requirements.txt` — add `pytest==8.3.4`.
- `src/lib/types.ts` — add the four new fields to `InputRow`.
- `src/app/(app)/projects/[id]/documents/page.tsx` — add Progress column, polling, extracting-aware badge, and status-driven button gating.

**Documentation**
- `docs/superpowers/plans/2026-05-27-extraction-progress-ui.md` (this file).

---

## Task 0: Initialize git repository (optional but recommended)

**Files:**
- Create: `.gitignore` (already present in the repo at `poet-webpage/.gitignore` per spec — skip if present)

The project root `poet-webpage` is not currently a git repository. Without git, the commit steps in later tasks are no-ops. Recommended to initialize so we get atomic checkpoints during a multi-hour implementation.

- [ ] **Step 1: Check whether git is already initialized**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage"
test -d .git && echo "git already initialized — skip the rest of Task 0" || echo "needs init"
```

- [ ] **Step 2: Initialize and make the baseline commit**

If the previous step said "needs init":

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage"
git init
git add .
git commit -m "chore: snapshot before extraction-progress-ui work

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Expected: a single commit with all current files. Now subsequent `git commit` steps work.

If you skip Task 0, every later `git add` / `git commit` step becomes a no-op — proceed without them.

---

## Task 1: Add `EXTRACTING` to the `InputStatus` enum

**Files:**
- Modify: `backend/app/enums.py:25-29`

The Python enum is the single source of truth for status values; the DB column is plain `String(30)` so there is no Postgres enum type to update.

- [ ] **Step 1: Add the enum value**

In `backend/app/enums.py`, change the `InputStatus` class from:

```python
class InputStatus(StrEnum):
    UPLOADED = "uploaded"
    PARSING = "parsing"
    PARSED = "parsed"
    FAILED = "failed"
```

to:

```python
class InputStatus(StrEnum):
    UPLOADED = "uploaded"
    PARSING = "parsing"
    PARSED = "parsed"
    EXTRACTING = "extracting"
    FAILED = "failed"
```

- [ ] **Step 2: Verify the import path resolves**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && python -c "from app.enums import InputStatus; print(InputStatus.EXTRACTING.value)"
```

Expected output: `extracting`

- [ ] **Step 3: Commit**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage"
git add backend/app/enums.py
git commit -m "feat: add EXTRACTING value to InputStatus enum

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add the four progress columns to the `Input` SQLAlchemy model

**Files:**
- Modify: `backend/app/models/input.py:30-40` (the `Input` class body, after `status`)

- [ ] **Step 1: Update imports if needed**

At the top of `backend/app/models/input.py`, the imports should already include `Integer`, `String`, `Text`, `ForeignKey`. Add `DateTime` if it isn't already imported. Current imports look like:

```python
from sqlalchemy import ForeignKey, Integer, String, Text
```

Change to:

```python
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
```

Also add this import if it isn't already present:

```python
from datetime import datetime
```

- [ ] **Step 2: Add the four columns to the `Input` class**

Inside `class Input(IdMixin, TimestampMixin, Base):`, after the existing `status` column and before `uploaded_by`, add:

```python
    chunks_processed: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    chunks_total: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    extraction_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    extraction_error: Mapped[str | None] = mapped_column(Text, nullable=True)
```

`server_default` is required so the migration's `ADD COLUMN` is safe on the existing rows without a separate UPDATE pass.

- [ ] **Step 3: Verify the model imports without error**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && python -c "from app.models.input import Input; print([c.name for c in Input.__table__.columns if c.name.startswith('chunks_') or c.name.startswith('extraction_')])"
```

Expected output: `['chunks_processed', 'chunks_total', 'extraction_started_at', 'extraction_error']`

- [ ] **Step 4: Commit**

```bash
git add backend/app/models/input.py
git commit -m "feat: add extraction progress columns to Input model

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add the same fields to the `InputRead` Pydantic schema

**Files:**
- Modify: `backend/app/schemas/input.py:6-19`

- [ ] **Step 1: Add the four fields to `InputRead`**

Change `InputRead` from:

```python
class InputRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    type: str
    name: str
    file_path: str | None
    file_size: int | None
    mime_type: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    claim_count: int = 0
```

to:

```python
class InputRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    type: str
    name: str
    file_path: str | None
    file_size: int | None
    mime_type: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    claim_count: int = 0
    chunks_processed: int = 0
    chunks_total: int = 0
    extraction_started_at: datetime | None = None
    extraction_error: str | None = None
```

- [ ] **Step 2: Verify**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && python -c "from app.schemas.input import InputRead; print(sorted(InputRead.model_fields.keys()))"
```

Expected output (alphabetized): includes `chunks_processed`, `chunks_total`, `claim_count`, `extraction_error`, `extraction_started_at`, plus the original fields.

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/input.py
git commit -m "feat: surface extraction progress fields on InputRead

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Write the Alembic migration

**Files:**
- Create: `backend/alembic/versions/0004_extraction_progress_fields.py`

The repo has two coexisting filename styles. We'll follow the leading-revision-id pattern of `0001_…`, `0002_…`, `0003_…` for clarity.

- [ ] **Step 1: Verify the current Alembic head**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && alembic current
```

Expected output: ends with `0003_edge_bend_offsets (head)` (or similar). Note the revision id; the new migration's `down_revision` must point to it.

- [ ] **Step 2: Create the migration file**

Create `backend/alembic/versions/0004_extraction_progress_fields.py` with this exact content:

```python
"""add extraction progress fields to inputs

Revision ID: 0004_extraction_progress_fields
Revises: 0003_edge_bend_offsets
Create Date: 2026-05-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_extraction_progress_fields"
down_revision: Union[str, None] = "0003_edge_bend_offsets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "inputs",
        sa.Column(
            "chunks_processed",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "inputs",
        sa.Column(
            "chunks_total",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "inputs",
        sa.Column(
            "extraction_started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "inputs",
        sa.Column("extraction_error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("inputs", "extraction_error")
    op.drop_column("inputs", "extraction_started_at")
    op.drop_column("inputs", "chunks_total")
    op.drop_column("inputs", "chunks_processed")
```

- [ ] **Step 3: Apply the migration**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate
set -a; source .env; set +a
alembic upgrade head
```

Expected output: `Running upgrade 0003_edge_bend_offsets -> 0004_extraction_progress_fields, add extraction progress fields to inputs`.

- [ ] **Step 4: Verify the columns exist**

```bash
docker.exe exec -i poet-postgres psql -U poet -d poet -t -A -c "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='inputs' AND column_name IN ('chunks_processed','chunks_total','extraction_started_at','extraction_error') ORDER BY column_name;"
```

Expected: four rows with the new column names, `0` defaults on the integers, `NULL` on the rest.

- [ ] **Step 5: Commit**

```bash
git add backend/alembic/versions/0004_extraction_progress_fields.py
git commit -m "feat: alembic 0004 — add extraction progress columns to inputs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add pytest scaffolding (one-time setup for backend tests)

**Files:**
- Create: `backend/pytest.ini`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`
- Modify: `backend/requirements.txt` (add `pytest==8.3.4`)

The backend has no existing test infrastructure. This task adds the bare minimum needed for the tests in Task 7 and Task 9.

- [ ] **Step 1: Add pytest to requirements**

In `backend/requirements.txt`, append a new line at the end:

```
pytest==8.3.4
```

Then install:

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && pip install pytest==8.3.4
```

- [ ] **Step 2: Create `pytest.ini`**

Create `backend/pytest.ini` with this exact content:

```ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -ra --strict-markers
```

- [ ] **Step 3: Create the tests directory marker**

Create `backend/tests/__init__.py` with this exact content (empty file):

```python
```

- [ ] **Step 4: Create the `conftest.py` with a test DB fixture**

Create `backend/tests/conftest.py` with this exact content:

```python
"""Pytest fixtures for backend tests.

Strategy: use the existing dockerized Postgres on localhost:5433 with a
separate `poet_test` database. The session-scoped autouse fixture
(a) creates the test database if it doesn't exist, and
(b) runs alembic migrations against it once per session.

The per-test `db` fixture TRUNCATEs all data tables before each test runs,
because the production code we're testing calls db.commit() during its run.
A rollback-at-teardown pattern would either fight those commits or leave
the test seeing nothing across sessions. Truncate-before-test is the
simplest pattern that lets us test real commit semantics.
"""
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker


BACKEND_DIR = Path(__file__).resolve().parent.parent
ADMIN_URL = "postgresql+psycopg://poet:poet@localhost:5433/postgres"
TEST_DB_NAME = "poet_test"
TEST_URL = f"postgresql+psycopg://poet:poet@localhost:5433/{TEST_DB_NAME}"


@pytest.fixture(scope="session", autouse=True)
def _prepare_test_database() -> Iterator[None]:
    """Create the test database (if missing) and run migrations."""
    admin_engine = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :name"),
            {"name": TEST_DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    admin_engine.dispose()

    env = os.environ.copy()
    env["DATABASE_URL"] = TEST_URL
    subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=env,
        check=True,
    )
    yield


@pytest.fixture(scope="session")
def test_engine():
    engine = create_engine(TEST_URL, pool_pre_ping=True, future=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def _data_table_names(test_engine) -> list[str]:
    """Every public table except alembic_version."""
    with test_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname='public' AND tablename <> 'alembic_version' "
                "ORDER BY tablename"
            )
        ).fetchall()
    return [r[0] for r in rows]


@pytest.fixture()
def db(test_engine, _data_table_names) -> Iterator[Session]:
    """Per-test session. Truncates all data tables before yielding so each
    test starts from an empty database. Production code's db.commit() calls
    produce real commits that ARE visible to other sessions opened via
    `fresh_session_factory`."""
    tables = ", ".join(f'"{t}"' for t in _data_table_names)
    with test_engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))

    SessionLocal = sessionmaker(
        bind=test_engine, autoflush=False, expire_on_commit=False
    )
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def fresh_session_factory(test_engine):
    """Returns a sessionmaker that opens NEW sessions on the same engine —
    used inside production-code callbacks to verify that per-chunk commits
    are visible to other sessions."""
    return sessionmaker(
        bind=test_engine, autoflush=False, expire_on_commit=False
    )
```

- [ ] **Step 5: Verify pytest discovers the directory**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && set -a; source .env; set +a && pytest --collect-only -q
```

Expected: no tests collected yet (`0 tests collected`), no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/pytest.ini backend/tests/ backend/requirements.txt
git commit -m "test: add pytest scaffolding + transactional DB fixture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite `extract_input_claims` with per-chunk commits

**Files:**
- Modify: `backend/app/api/v2/claims.py:27-95`

This is the load-bearing behavior change. The old handler accumulated the whole 136-chunk loop in one transaction; the new one commits after every chunk.

- [ ] **Step 1: Update imports at top of file**

In `backend/app/api/v2/claims.py`, the current imports look like:

```python
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.enums import ConflictStatus
```

Change to:

```python
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_project_or_404
from app.db.session import get_db
from app.enums import ConflictStatus, InputStatus
```

(Adds `datetime`, `timezone`, and `InputStatus`.)

- [ ] **Step 2: Replace `extract_input_claims`**

Replace the entire body of `extract_input_claims` (lines 27–95 in the current file) with:

```python
@router.post(
    "/inputs/{input_id}/extract-claims", response_model=ClaimExtractionResult
)
def extract_input_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    input_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimExtractionResult:
    inp = db.get(Input, input_id)
    if inp is None or inp.project_id != project.id:
        raise HTTPException(status_code=404, detail="Input not found")

    chunks = list(
        db.scalars(
            select(Chunk)
            .join(DocumentSection)
            .where(DocumentSection.input_id == input_id)
            .order_by(DocumentSection.order_index, Chunk.char_start)
        ).all()
    )
    if not chunks:
        return ClaimExtractionResult(
            input_id=input_id, claim_count=0, citation_count=0
        )

    # Wipe any prior claims for this input via citations. Committed eagerly
    # so the failure path doesn't resurrect the old claims.
    chunk_ids = [c.id for c in chunks]
    prior_claim_ids = list(
        db.scalars(
            select(ClaimCitation.claim_id)
            .where(ClaimCitation.chunk_id.in_(chunk_ids))
            .distinct()
        ).all()
    )
    if prior_claim_ids:
        db.execute(delete(Claim).where(Claim.id.in_(prior_claim_ids)))
    inp.status = InputStatus.EXTRACTING.value
    inp.chunks_total = len(chunks)
    inp.chunks_processed = 0
    inp.extraction_started_at = datetime.now(timezone.utc)
    inp.extraction_error = None
    db.commit()

    claim_count = 0
    citation_count = 0
    try:
        for chunk in chunks:
            extracted = extract_claims_from_text(chunk.text)
            for ec in extracted:
                claim = Claim(
                    project_id=project.id,
                    kind=ec.kind,
                    subject=ec.subject,
                    normalized=ec.normalized,
                    confidence=ec.confidence,
                )
                db.add(claim)
                db.flush()
                db.add(
                    ClaimCitation(
                        claim_id=claim.id,
                        chunk_id=chunk.id,
                        quote=ec.quote,
                        confidence=ec.confidence,
                    )
                )
                claim_count += 1
                citation_count += 1
            inp.chunks_processed += 1
            db.commit()
    except RuntimeError as e:
        # Anthropic key missing or similar service error → 503
        db.rollback()
        inp_refresh = db.get(Input, input_id)
        if inp_refresh is not None:
            inp_refresh.status = InputStatus.FAILED.value
            inp_refresh.extraction_error = str(e)
            db.commit()
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        db.rollback()
        inp_refresh = db.get(Input, input_id)
        if inp_refresh is not None:
            inp_refresh.status = InputStatus.FAILED.value
            inp_refresh.extraction_error = str(e)
            db.commit()
        raise HTTPException(status_code=500, detail=f"Extraction failed: {e}")

    inp.status = InputStatus.PARSED.value
    inp.extraction_error = None
    db.commit()
    return ClaimExtractionResult(
        input_id=input_id, claim_count=claim_count, citation_count=citation_count
    )
```

- [ ] **Step 3: Verify the file imports cleanly**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && python -c "from app.api.v2.claims import extract_input_claims; print('ok')"
```

Expected output: `ok`

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/v2/claims.py
git commit -m "feat: per-chunk commits + extracting status on claim extraction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Backend unit tests for `extract_input_claims`

**Files:**
- Create: `backend/tests/test_extract_input_claims.py`

These tests stub `extract_claims_from_text` and verify the per-chunk commit semantics.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_extract_input_claims.py` with this exact content:

```python
"""Tests for the per-chunk commit behavior of extract_input_claims."""
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.api.v2.claims import extract_input_claims
from app.enums import InputStatus
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.project import Project
from app.schemas.claim import ClaimExtractionResult
from app.services.claims_extraction import ExtractedClaim


def _seed_project_with_chunks(db, n_chunks: int) -> tuple[Project, Input, list[Chunk]]:
    """Create an Org + User + Project + Input + N chunks. Returns the trio."""
    org = Organization(name="t-org")
    db.add(org)
    db.flush()
    user = User(email=f"u-{uuid4()}@t.local", name="t", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="t-proj", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="t.txt",
        file_path="t.txt",
        file_size=10,
        mime_type="text/plain",
        status=InputStatus.PARSED.value,
        uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    section = DocumentSection(
        input_id=inp.id, kind="page", order_index=0, ref={}, text="all text"
    )
    db.add(section)
    db.flush()
    chunks = []
    for i in range(n_chunks):
        c = Chunk(
            section_id=section.id,
            char_start=i * 10,
            char_end=(i + 1) * 10,
            text=f"chunk {i}",
            tokens=2,
        )
        db.add(c)
        chunks.append(c)
    db.flush()
    db.commit()
    return proj, inp, chunks


def _one_claim_per_chunk(text: str) -> list[ExtractedClaim]:
    return [
        ExtractedClaim(
            kind="task",
            subject=f"do thing for {text}",
            normalized={},
            confidence=0.9,
            quote=text,
        )
    ]


def test_per_chunk_commit_visible_to_other_sessions(
    db, fresh_session_factory
):
    """As chunks are processed, a SEPARATE session should see chunks_processed
    rising — proving the per-chunk commits are durable."""
    proj, inp, chunks = _seed_project_with_chunks(db, n_chunks=4)
    project_id = proj.id
    input_id = inp.id

    observed = []

    def fake_extract(text: str):
        # In the middle of the loop, peek at the row from a *fresh* session.
        with fresh_session_factory() as peek:
            row = peek.get(Input, input_id)
            observed.append((row.status, row.chunks_processed))
        return _one_claim_per_chunk(text)

    with patch(
        "app.api.v2.claims.extract_claims_from_text", side_effect=fake_extract
    ):
        # Build the dependency call by hand — we don't go through FastAPI.
        result = extract_input_claims(project=proj, input_id=input_id, db=db)

    assert isinstance(result, ClaimExtractionResult)
    assert result.claim_count == 4
    assert result.citation_count == 4

    # Observations were taken BEFORE the chunk's commit fires (the increment
    # happens after extract_claims_from_text returns), so each call sees the
    # state from the PREVIOUS iteration. The first call observes the
    # post-init commit: status=extracting, chunks_processed=0.
    assert observed[0] == (InputStatus.EXTRACTING.value, 0)
    assert observed[1] == (InputStatus.EXTRACTING.value, 1)
    assert observed[2] == (InputStatus.EXTRACTING.value, 2)
    assert observed[3] == (InputStatus.EXTRACTING.value, 3)

    # Final state, observed from a fresh session post-call.
    with fresh_session_factory() as peek:
        row = peek.get(Input, input_id)
        assert row.status == InputStatus.PARSED.value
        assert row.chunks_processed == 4
        assert row.chunks_total == 4
        assert row.extraction_error is None
        assert row.extraction_started_at is not None

        claim_count = peek.scalar(
            select(__import__("sqlalchemy").func.count(Claim.id)).where(
                Claim.project_id == project_id
            )
        )
        assert claim_count == 4


def test_failure_mid_loop_preserves_prior_chunks(
    db, fresh_session_factory
):
    """If extract_claims_from_text raises on chunk 3, chunks 1-2 should be
    durable and the row should land on status='failed'."""
    from fastapi import HTTPException

    proj, inp, _ = _seed_project_with_chunks(db, n_chunks=4)
    project_id = proj.id
    input_id = inp.id

    call = {"n": 0}

    def fake_extract(text: str):
        call["n"] += 1
        if call["n"] == 3:
            raise RuntimeError("simulated anthropic failure")
        return _one_claim_per_chunk(text)

    with patch(
        "app.api.v2.claims.extract_claims_from_text", side_effect=fake_extract
    ):
        with pytest.raises(HTTPException) as excinfo:
            extract_input_claims(project=proj, input_id=input_id, db=db)
        assert excinfo.value.status_code == 503

    with fresh_session_factory() as peek:
        row = peek.get(Input, input_id)
        assert row.status == InputStatus.FAILED.value
        assert row.extraction_error == "simulated anthropic failure"
        # Chunks 1 and 2 succeeded.
        assert row.chunks_processed == 2
        # Two claims should be durable.
        claim_count = peek.scalar(
            select(__import__("sqlalchemy").func.count(Claim.id)).where(
                Claim.project_id == project_id
            )
        )
        assert claim_count == 2
```

- [ ] **Step 2: Run the tests — expect them to PASS (Task 6 already made them pass)**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && set -a; source .env; set +a && pytest tests/test_extract_input_claims.py -v
```

Expected: 2 passed.

If a test fails, the implementation in Task 6 has a bug — go back, fix it, and re-run before moving on.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_extract_input_claims.py
git commit -m "test: verify per-chunk commit + failure path for extraction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Startup sweep — clear stale `extracting` rows on backend boot

**Files:**
- Create: `backend/app/services/startup.py`
- Modify: `backend/main.py:20-30` (FastAPI app construction)

- [ ] **Step 1: Create the sweep service**

Create `backend/app/services/startup.py` with this exact content:

```python
"""One-shot tasks that run on FastAPI startup."""
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.enums import InputStatus
from app.models.input import Input


def sweep_stale_extracting_inputs(db: Session) -> int:
    """Flip any rows left in `extracting` to `failed`.

    Called at app startup. Any row in `extracting` at startup is the result
    of a previous process getting killed mid-extraction (uvicorn --reload,
    OS signal, crash). Its work was partially committed thanks to per-chunk
    commits, but the row is no longer being driven forward — convert it to
    a terminal failure so the next click on Re-extract restarts cleanly.

    Returns the number of rows updated.
    """
    result = db.execute(
        update(Input)
        .where(Input.status == InputStatus.EXTRACTING.value)
        .values(
            status=InputStatus.FAILED.value,
            extraction_error="Interrupted by backend restart",
        )
    )
    db.commit()
    return result.rowcount or 0
```

- [ ] **Step 2: Wire the sweep into a FastAPI lifespan**

In `backend/main.py`, find the section near the top that looks like:

```python
load_dotenv()

app = FastAPI(title="POET API", version="1.0.0")

# === v2 API (Phase 1.5+) — registered before the catch-all at end of file ===
from app.api.v2 import router as _v2_router  # noqa: E402
app.include_router(_v2_router, prefix="/api/v2")
```

Replace it with:

```python
load_dotenv()

from contextlib import asynccontextmanager  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.services.startup import sweep_stale_extracting_inputs  # noqa: E402


@asynccontextmanager
async def lifespan(_app):
    # Startup: clean up any rows stuck in 'extracting' from a prior crash.
    with SessionLocal() as db:
        swept = sweep_stale_extracting_inputs(db)
        if swept:
            print(f"[startup] swept {swept} stale extracting input(s) to failed")
    yield


app = FastAPI(title="POET API", version="1.0.0", lifespan=lifespan)

# === v2 API (Phase 1.5+) — registered before the catch-all at end of file ===
from app.api.v2 import router as _v2_router  # noqa: E402
app.include_router(_v2_router, prefix="/api/v2")
```

- [ ] **Step 3: Smoke-test the lifespan runs without errors**

Restart the backend via `run-local.sh` (or kill + start). Then:

```bash
tail -n 30 "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/.run/backend.log"
```

Expected: the application starts cleanly. If any rows happened to be in `extracting`, you'll see `[startup] swept N stale extracting input(s) to failed`. If none were, no message — also fine. No traceback either way.

- [ ] **Step 4: Commit**

```bash
git add backend/app/services/startup.py backend/main.py
git commit -m "feat: startup sweep — flip stale extracting rows to failed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Backend test for the startup sweep

**Files:**
- Create: `backend/tests/test_startup_sweep.py`

- [ ] **Step 1: Write the test**

Create `backend/tests/test_startup_sweep.py` with this exact content:

```python
"""Test the startup sweep that clears stale 'extracting' rows."""
from uuid import uuid4

from app.enums import InputStatus
from app.models.identity import Organization, User
from app.models.input import Input
from app.models.project import Project
from app.services.startup import sweep_stale_extracting_inputs


def _seed_input(db, status: str) -> Input:
    org = Organization(name="t-org")
    db.add(org)
    db.flush()
    user = User(email=f"u-{uuid4()}@t.local", name="t", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="t-proj", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="t.txt",
        file_path="t.txt",
        file_size=10,
        mime_type="text/plain",
        status=status,
        uploaded_by=user.id,
    )
    db.add(inp)
    db.commit()
    return inp


def test_sweep_flips_extracting_to_failed(db):
    inp = _seed_input(db, status=InputStatus.EXTRACTING.value)

    swept = sweep_stale_extracting_inputs(db)
    assert swept == 1

    db.refresh(inp)
    assert inp.status == InputStatus.FAILED.value
    assert inp.extraction_error == "Interrupted by backend restart"


def test_sweep_leaves_non_extracting_rows_alone(db):
    parsed = _seed_input(db, status=InputStatus.PARSED.value)
    failed = _seed_input(db, status=InputStatus.FAILED.value)

    swept = sweep_stale_extracting_inputs(db)
    assert swept == 0

    db.refresh(parsed)
    db.refresh(failed)
    assert parsed.status == InputStatus.PARSED.value
    assert failed.status == InputStatus.FAILED.value
    assert parsed.extraction_error is None
    assert failed.extraction_error is None
```

- [ ] **Step 2: Run the tests — expect them to PASS**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage/backend" && source .venv/bin/activate && set -a; source .env; set +a && pytest tests/test_startup_sweep.py -v
```

Expected: 2 passed.

- [ ] **Step 3: Run the FULL backend test suite to confirm nothing else broke**

```bash
pytest -v
```

Expected: 4 passed, 0 failed (2 from extract_input_claims + 2 from startup_sweep).

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_startup_sweep.py
git commit -m "test: startup sweep correctness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Add the shadcn Progress component to the frontend

**Files:**
- Create: `src/components/ui/progress.tsx` (via shadcn CLI)

- [ ] **Step 1: Run the shadcn add command**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage" && npx shadcn@latest add progress --yes
```

Expected: creates `src/components/ui/progress.tsx`. The CLI may also tweak `package.json` / `package-lock.json` to add `@radix-ui/react-progress` if it isn't already pulled in transitively.

- [ ] **Step 2: Verify the component exists**

```bash
test -f "src/components/ui/progress.tsx" && head -5 "src/components/ui/progress.tsx"
```

Expected: file exists and starts with a TypeScript/React import (likely `"use client"` then imports from `@radix-ui/react-progress`).

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/progress.tsx package.json package-lock.json
git commit -m "feat: add shadcn Progress component

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Update the frontend `InputRow` type

**Files:**
- Modify: `src/lib/types.ts:35-47` (the `InputRow` interface)

- [ ] **Step 1: Add the new fields**

In `src/lib/types.ts`, change `InputRow` from:

```typescript
export interface InputRow {
  id: UUID;
  project_id: UUID;
  type: string;
  name: string;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  claim_count: number;
}
```

to:

```typescript
export interface InputRow {
  id: UUID;
  project_id: UUID;
  type: string;
  name: string;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  claim_count: number;
  chunks_processed: number;
  chunks_total: number;
  extraction_started_at: string | null;
  extraction_error: string | null;
}
```

(The `status` field stays a plain `string` — Pydantic doesn't emit a narrowed enum and we want TS to accept any value the backend chooses to send.)

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage" && npx tsc --noEmit
```

Expected: no errors. (If errors mention the documents page or upload-form not knowing about the new fields, that's fine — they're optional-by-default in TS interfaces *only* if marked with `?`, which these are not, so any callsite constructing a fixture `InputRow` would break. None do in this codebase: `InputRow` is only ever consumed from API responses.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: extend InputRow type with extraction progress fields

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Build the `ExtractionProgressCell` component

**Files:**
- Create: `src/components/extraction-progress-cell.tsx`

A self-contained cell that renders progress for a single row. Depends only on the four new `InputRow` fields plus `status`.

- [ ] **Step 1: Create the component**

Create `src/components/extraction-progress-cell.tsx` with this exact content:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";
import type { InputRow } from "@/lib/types";

interface Props {
  row: InputRow;
}

export function ExtractionProgressCell({ row }: Props) {
  // Re-render once per second while extracting so the elapsed/ETA stays fresh
  // between polls.
  const [, force] = useState(0);
  useEffect(() => {
    if (row.status !== "extracting") return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [row.status]);

  if (row.status !== "extracting") {
    return <span className="text-muted-foreground">—</span>;
  }

  const total = Math.max(row.chunks_total, 1);
  const done = Math.min(row.chunks_processed, total);
  const pct = Math.round((done / total) * 100);

  const startedAt = row.extraction_started_at
    ? new Date(row.extraction_started_at).getTime()
    : null;
  const elapsedMs = startedAt ? Date.now() - startedAt : null;

  let etaText = "";
  if (elapsedMs && done > 0 && done < total) {
    const msPerChunk = elapsedMs / done;
    const remainingMs = msPerChunk * (total - done);
    etaText = ` · ~${formatDuration(remainingMs)} left`;
  }
  const elapsedText = elapsedMs ? formatDuration(elapsedMs) : "";

  return (
    <div className="space-y-1 min-w-32">
      <div className="text-xs tabular-nums">
        {done} / {total} chunks ({pct}%)
      </div>
      <Progress value={pct} className="h-1.5" />
      {elapsedText && (
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {elapsedText}
          {etaText}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage" && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/extraction-progress-cell.tsx
git commit -m "feat: ExtractionProgressCell component with elapsed + ETA

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Wire the progress cell + polling into the Documents page

**Files:**
- Modify: `src/app/(app)/projects/[id]/documents/page.tsx` (full rewrite of the page component body — see Step 1)

- [ ] **Step 1: Replace the page**

Replace the entire contents of `src/app/(app)/projects/[id]/documents/page.tsx` with:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { UploadForm } from "@/components/upload-form";
import { ExtractionProgressCell } from "@/components/extraction-progress-cell";
import type { InputRow } from "@/lib/types";

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 3000;

export default function DocumentsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [confirmRow, setConfirmRow] = useState<InputRow | null>(null);
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["inputs", id, "page", offset],
    queryFn: () => api.listInputs(id, { limit: PAGE_SIZE, offset }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((r) => r.status === "extracting")
        ? POLL_INTERVAL_MS
        : false;
    },
  });

  const extract = useMutation({
    mutationFn: ({ inputId }: { inputId: string }) =>
      api.extractClaims(id, inputId),
    onSuccess: (res) => {
      toast.success(`Extracted ${res.claim_count} claim(s) from input.`);
      qc.invalidateQueries({ queryKey: ["inputs", id] });
      qc.invalidateQueries({ queryKey: ["claims", id] });
      qc.invalidateQueries({ queryKey: ["conflicts", id] });
    },
    onError: (e: Error) => toast.error(`Extraction failed: ${e.message}`),
  });

  const onExtractClick = (row: InputRow) => {
    if (row.claim_count > 0) {
      setConfirmRow(row);
    } else {
      extract.mutate({ inputId: row.id });
    }
  };

  const onConfirmReextract = () => {
    if (!confirmRow) return;
    extract.mutate({ inputId: confirmRow.id });
    setConfirmRow(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Upload documents (interviews, SOPs, policies, …) to feed the claim
          extractor and process generator.
        </p>
        <UploadForm projectId={id} />
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead className="text-right">Claims</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-sm text-muted-foreground py-8"
                >
                  No documents yet. Upload one to get started.
                </TableCell>
              </TableRow>
            )}
            {data.items.map((row) => {
              const isExtracting = row.status === "extracting";
              const buttonLabel = isExtracting
                ? "Extracting…"
                : row.claim_count > 0
                  ? "Re-extract"
                  : "Extract claims";
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.type.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={statusVariant(row.status)}
                      title={
                        row.status === "failed" && row.extraction_error
                          ? row.extraction_error
                          : undefined
                      }
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ExtractionProgressCell row={row} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.claim_count > 0 ? row.claim_count : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {row.file_size != null ? formatBytes(row.file_size) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(row.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={row.claim_count > 0 ? "secondary" : "outline"}
                      disabled={
                        row.status !== "parsed" &&
                        row.status !== "failed"
                      }
                      onClick={() => onExtractClick(row)}
                    >
                      {buttonLabel}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground tabular-nums">
            {data.total === 0 ? 0 : offset + 1}–
            {Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= data.total}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={confirmRow !== null}
        onOpenChange={(o) => !o && setConfirmRow(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-extract claims?</DialogTitle>
            <DialogDescription>
              This will permanently delete the{" "}
              <span className="font-semibold text-foreground">
                {confirmRow?.claim_count} existing claim
                {confirmRow?.claim_count === 1 ? "" : "s"}
              </span>{" "}
              for <span className="font-medium">{confirmRow?.name}</span> and
              run extraction again. Any conflicts referencing these claims will
              also be cleared on the next detection run.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRow(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmReextract}>
              Wipe and re-extract
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusVariant(
  s: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (s === "parsed") return "default";
  if (s === "failed") return "destructive";
  if (s === "parsing" || s === "extracting") return "secondary";
  return "outline";
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
```

**Changes from the previous version:**
1. New `Progress` column header + cell.
2. `useQuery` now has a `refetchInterval` that returns `3000` whenever any row has `status === "extracting"`, otherwise `false`. Polling is automatic and self-cancelling.
3. Button gating is now `row.status !== "parsed" && row.status !== "failed"` — the button is enabled for `parsed` (first extract) and `failed` (retry) rows, disabled for `uploaded`/`parsing`/`extracting`.
4. `buttonLabel` switches to `"Extracting…"` based on the row's status, not the mutation's `isPending` flag. This means a page refresh during extraction still shows the right label, and a second tab can't fire a duplicate extract.
5. The `failed` status badge now shows the `extraction_error` text as a native `title` tooltip on hover. (We can promote this to a shadcn tooltip later if the native one feels weak.)
6. `colSpan` on the empty-state row bumped from 7 to 8 to match the new column count.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage" && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/projects/\[id\]/documents/page.tsx
git commit -m "feat: progress column + polling on documents page

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Manual end-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Restart backend and frontend cleanly**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/Nidhi Projects/poet-webpage" && ./run-local.sh stop && ./run-local.sh start
```

Expected: postgres, backend, frontend all come up; no traceback in `.run/backend.log`; the startup sweep message either prints (if there were stale rows) or doesn't (if there weren't).

- [ ] **Step 2: Open the app and navigate to a project's documents tab**

In a browser visit `http://localhost:3000` → pick a project → "Documents" tab.

Expected: existing rows now show a `—` in the new "Progress" column (because none are `extracting`).

- [ ] **Step 3: Upload a small test file (~5–10 chunks worth)**

A 2-page interview transcript or a short SOP. Use the Upload form. After upload, the row should appear with `status="parsed"`.

- [ ] **Step 4: Click "Extract claims" and observe**

Expected behavior within 1–4 seconds:
- Row's `status` badge flips from `parsed` to `extracting` (secondary variant).
- Progress cell appears: `0 / N chunks (0%)` with a thin bar.
- Action button becomes "Extracting…" and is disabled.

Expected behavior over the next ~30 seconds–few minutes (depending on chunk count):
- Progress cell ticks up `1/N`, `2/N`, …, both via polling (3 s) and via the once-per-second elapsed timer.
- Claims column also climbs.
- When done: status flips to `parsed`, progress cell shows `—`, claim count is final, button becomes "Re-extract".

- [ ] **Step 5: Test the restart-recovery path**

While a fresh extraction is in flight:

```bash
./run-local.sh stop && ./run-local.sh start
```

Then refresh the documents page.

Expected:
- The row's status is now `failed`.
- Hovering the failed badge shows the tooltip `Interrupted by backend restart`.
- The action button is enabled with label "Re-extract".

- [ ] **Step 6: Test the failed-extraction retry**

Click "Re-extract" on the failed row, confirm the dialog. Extraction restarts cleanly; progress cell shows live counters again.

- [ ] **Step 7: Confirm polling auto-stops**

Once all rows are `parsed`, open the Network tab in DevTools and watch for ~10 seconds. There should be no auto-firing `GET /api/v2/projects/.../inputs?...` requests (polling has stopped because no row is `extracting`).

- [ ] **Step 8: Commit any incidental fixes from the smoke test**

If the smoke test caught a bug, fix it inline and:

```bash
git commit -am "fix: <whatever the smoke test caught>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done

All spec requirements have a corresponding task. The implementation is bounded to: 1 enum value, 4 new DB columns, 1 migration, 1 new service module, ~80 lines of changes in the existing extract endpoint, 1 small lifespan addition, 4 unit tests, 1 new frontend component, and a focused rewrite of the documents page. No new dependencies on the backend except `pytest`, no new Python services to babysit, no background-worker process to manage.