# SP-7a — Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four schema-light "quick win" gaps from SP-7 Phase 1 — manual claim CRUD (with a conflict-detection bug fix), conflict resolution, node↔claim link editing, and blank-map creation — each independently shippable, without introducing the Phase 2 inventory tables.

**Architecture:** One additive Alembic migration (`0008`) adds `claims.source` and `claim_conflicts.detection_reason`; everything else is new endpoints on the existing `claims` and `process_maps` routers plus thin frontend wiring. Manual claims are distinguished from extracted ones by the new `source` column so re-extraction never wipes them. Blank-map creation is unlocked by extracting the model/version/default-lane scaffolding out of `generate_process_map` into a reusable `_create_model_and_version` helper, so the AI path and the blank path share one code path for lineage stamping and version numbering.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + pytest; Next.js 16 + React 19 + react-query + Vitest

---

## Notes for the implementer (read once)

- **Python interpreter:** the venv python is `backend/.venv/bin/python`. Bare `python` is not on PATH. Run pytest from the `backend/` directory as `.venv/bin/python -m pytest ...`.
- **Backend test DB:** tests use a separate `poet_test` DB on `localhost:5433`; the session fixture runs `alembic upgrade head` once, and the per-test `db` fixture TRUNCATEs every data table before each test. Adding migration `0008` means the test DB picks it up automatically on the next run.
- **Backend test style (this slice):** use the **FastAPI `TestClient`** pattern from `backend/tests/test_node_lane_editing.py` — a `client` fixture overrides `get_db` with the test `db` session, and tests hit real HTTP routes (`client.post(...)`, `client.patch(...)`). This is the established pattern for endpoint tests in this repo. Seed via Org → User (`email="dev@local"`, the dev user the project-scoping dep expects) → Project → … using the `_seed_*` helper style shown there.
- **Dev DB after merge:** the hot-reloading dev backend 500s on new columns until you run `cd backend && .venv/bin/alembic upgrade head` against the dev `poet` DB. Do this immediately after Task 1 lands.
- **Frontend gates:** `npx tsc --noEmit` (must be clean) and `npx vitest run` (node-env; only `src/**/*.test.ts`, never `.test.tsx`). UI pages/components are verified by `tsc` + manual smoke, not component tests — the repo has no page/JSX tests, and that is the established convention. Any pure logic gets a `.test.ts`.
- **Commits:** local only. Never push. Never use `rm`/`git rm`. Never switch branches. End every commit message with the `Co-Authored-By` trailer shown in the steps.
- **Project-scoping guard:** every endpoint that takes a `claim_id` / `conflict_id` / `node_id` must re-verify the entity belongs to `project.id` and raise `404` otherwise (the pattern `_check_node_in_project` already uses, and the `inp.project_id != project.id` check in `claims.py`).

---

## File structure

**Backend — create:**
- `backend/alembic/versions/0008_claim_source_and_detection_reason.py` — additive migration: `claims.source` (String(20), server_default `'extracted'`, NOT NULL) + `claim_conflicts.detection_reason` (Text, nullable).
- `backend/tests/test_claim_crud.py` — pytest for POST/PATCH/DELETE claims, the impact endpoint, the wipe-skips-manual fix, and the conflict-reason column fix.
- `backend/tests/test_conflict_resolution.py` — pytest for PATCH conflict resolution.
- `backend/tests/test_node_claim_links.py` — pytest for attach (bulk/idempotent) and detach node↔claim links.
- `backend/tests/test_blank_map.py` — pytest for the `_create_model_and_version` helper and the blank-map endpoint.

**Backend — modify:**
- `backend/app/models/claim.py` — add `source` column to `Claim`; add `detection_reason` column to `ClaimConflict`.
- `backend/app/schemas/claim.py` — add `source` to `ClaimRead`, `detection_reason` to `ClaimConflictRead`; new `ClaimCreate`, `ClaimUpdate`, `ClaimImpact`, `ConflictResolve` schemas.
- `backend/app/api/v2/claims.py` — add `source='manual'` to created claims is N/A (extraction stays `extracted`); add POST/PATCH/DELETE claim endpoints + GET impact; fix the wipe (add `Claim.source` filter); fix `run_conflict_detection` to write `detection_reason` not `resolution_notes`; add PATCH conflict-resolution endpoint.
- `backend/app/schemas/process_map.py` — new `NodeClaimLinkRequest`, `NodeClaimLinkResult`, `BlankMapRequest`, `BlankMapResult` schemas.
- `backend/app/api/v2/process_maps.py` — extract `_create_model_and_version` helper; rewire `generate_process_map` to use it; add POST/DELETE node-claim-link endpoints beside `get_node_citations`; add POST `/process-maps` blank-map endpoint.

**Frontend — modify:**
- `src/lib/types.ts` — add `source` to `Claim`, `detection_reason` to `ClaimConflict`; new `ClaimCreate`, `ClaimUpdate`, `ClaimImpact`, `ConflictResolve`, `NodeClaimLinkRequest`, `NodeClaimLinkResult`, `BlankMapRequest`, `BlankMapResult` interfaces.
- `src/lib/api.ts` — new methods: `createClaim`, `updateClaim`, `deleteClaim`, `getClaimImpact`, `resolveConflict`, `attachNodeClaims`, `detachNodeClaim`, `createBlankMap`.
- `src/app/(app)/projects/[id]/claims/page.tsx` — "Add claim" dialog, per-row edit/delete actions, delete-impact confirm; source badge.
- `src/app/(app)/projects/[id]/conflicts/page.tsx` — resolve/dismiss buttons + notes field per row.
- `src/components/canvas/properties-panel.tsx` — resolve/dismiss action inside `IssueCard`; attach/detach controls in the Provenance section.
- `src/app/(app)/projects/[id]/maps/page.tsx` — "New blank map" button routing into the canvas.

---

## Task 1: Migration 0008 — claims.source + claim_conflicts.detection_reason

**Files:**
- Create: `backend/alembic/versions/0008_claim_source_and_detection_reason.py`
- Modify: `backend/app/models/claim.py` (`Claim` ~line 22-25; `ClaimConflict` ~line 72)
- Test: `backend/tests/test_claim_crud.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_claim_crud.py
from sqlalchemy import text as sa_text


def test_claim_source_and_detection_reason_columns_exist(test_engine):
    with test_engine.connect() as conn:
        claim_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claims' AND column_name='source'"
                )
            ).fetchall()
        }
        conflict_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claim_conflicts' "
                    "AND column_name='detection_reason'"
                )
            ).fetchall()
        }
    assert claim_cols == {"source"}
    assert conflict_cols == {"detection_reason"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: FAIL — the columns don't exist yet (the assertions get empty sets). (The session fixture already ran `alembic upgrade head`, but there's no `0008` to add them.)

- [ ] **Step 3: Write the migration**

```python
# backend/alembic/versions/0008_claim_source_and_detection_reason.py
"""add claims.source and claim_conflicts.detection_reason

Revision ID: 0008_claim_source_and_detection_reason
Revises: 0007_lane_color_collapsed
Create Date: 2026-06-11

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_claim_source_and_detection_reason"
down_revision: Union[str, None] = "0007_lane_color_collapsed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "claims",
        sa.Column(
            "source",
            sa.String(length=20),
            nullable=False,
            server_default="extracted",
        ),
    )
    op.add_column(
        "claim_conflicts",
        sa.Column("detection_reason", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("claim_conflicts", "detection_reason")
    op.drop_column("claims", "source")
```

- [ ] **Step 4: Add the ORM columns**

In `backend/app/models/claim.py`, add `source` to `Claim` (after the `kind` column, before `subject` is fine — keep it near the top of the table's own columns):

```python
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, default="extracted", server_default="extracted"
    )
```

And add `detection_reason` to `ClaimConflict` (after `resolution_notes`):

```python
    detection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
```

(`String` and `Text` are already imported at the top of `claim.py`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: PASS (1 passed). The session fixture re-ran `alembic upgrade head`, applying `0008`.

- [ ] **Step 6: Commit**

```bash
git add backend/alembic/versions/0008_claim_source_and_detection_reason.py backend/app/models/claim.py backend/tests/test_claim_crud.py
git commit -m "feat(sp7a): migration 0008 — claims.source + claim_conflicts.detection_reason

After merge, run 'alembic upgrade head' on the dev poet DB or the
hot-reloading backend will 500 on the new columns.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Claim read/write schemas

**Files:**
- Modify: `backend/app/schemas/claim.py`
- Test: covered indirectly by Task 3-6 endpoint tests (no standalone test — these are pure DTOs validated by the endpoint tests that import them).

- [ ] **Step 1: Add `source` to `ClaimRead` and `detection_reason` to `ClaimConflictRead`, plus the new request/response schemas**

In `backend/app/schemas/claim.py`, add `source: str` to `ClaimRead` (after `kind`/`subject`/`normalized`/`confidence` — put it right after `confidence`):

```python
class ClaimRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    kind: str
    subject: str
    normalized: dict
    confidence: float | None
    source: str
    created_at: datetime
    updated_at: datetime
```

Add `detection_reason: str | None` to `ClaimConflictRead` (after `resolution_notes`):

```python
class ClaimConflictRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    claim_a_id: UUID
    claim_b_id: UUID
    kind: str
    detected_by: str
    resolution_status: str
    resolution_notes: str | None
    detection_reason: str | None
    created_at: datetime
```

Then append the new schemas at the end of the file (note `Field` and `field_validator` imports):

```python
from pydantic import BaseModel, ConfigDict, Field, field_validator  # update the existing import line

from app.enums import ClaimKind, ConflictStatus  # add this import near the top


class ClaimCreate(BaseModel):
    """Body for POST /claims — a manual claim. normalized defaults to empty."""

    kind: str = Field(min_length=1, max_length=30)
    subject: str = Field(min_length=1)
    normalized: dict = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind_in_enum(cls, v: str) -> str:
        allowed = {k.value for k in ClaimKind}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class ClaimUpdate(BaseModel):
    """Partial edit of a claim's kind / subject / normalized."""

    kind: str | None = Field(default=None, min_length=1, max_length=30)
    subject: str | None = Field(default=None, min_length=1)
    normalized: dict | None = None

    @field_validator("kind")
    @classmethod
    def _kind_in_enum(cls, v: str | None) -> str | None:
        if v is None:
            return v
        allowed = {k.value for k in ClaimKind}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class ClaimImpactMap(BaseModel):
    """One process map whose nodes cite this claim."""

    model_id: UUID
    name: str


class ClaimImpact(BaseModel):
    """What a DELETE of this claim would empty — surfaced in the confirm dialog."""

    claim_id: UUID
    node_link_count: int
    maps: list[ClaimImpactMap]


class ConflictResolve(BaseModel):
    """Body for PATCH /conflicts/{id} — set the resolution state + notes."""

    resolution_status: str
    resolution_notes: str | None = None

    @field_validator("resolution_status")
    @classmethod
    def _status_in_enum(cls, v: str) -> str:
        allowed = {s.value for s in ConflictStatus}
        if v not in allowed:
            raise ValueError(f"resolution_status must be one of {sorted(allowed)}")
        return v
```

- [ ] **Step 2: Verify it imports**

Run: `cd backend && .venv/bin/python -c "from app.schemas.claim import ClaimCreate, ClaimUpdate, ClaimImpact, ConflictResolve, ClaimRead, ClaimConflictRead; print('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/claim.py
git commit -m "feat(sp7a): claim CRUD + conflict-resolve schemas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: POST /claims — create a manual claim

**Files:**
- Modify: `backend/app/api/v2/claims.py` (imports near top; new route after `list_claims` ~line 145)
- Test: `backend/tests/test_claim_crud.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_claim_crud.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project(db) -> Project:
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    return proj


def test_create_manual_claim(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "task", "subject": "Approve the invoice"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "task"
    assert body["subject"] == "Approve the invoice"
    assert body["source"] == "manual"
    assert body["normalized"] == {}
    db.expire_all()
    claim = db.get(Claim, body["id"])
    assert claim is not None and claim.source == "manual"


def test_create_claim_rejects_bad_kind(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "not_a_kind", "subject": "x"},
    )
    assert resp.status_code == 422, resp.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: FAIL — `test_create_manual_claim` returns 404/405 (no POST route yet).

- [ ] **Step 3: Write the route**

In `backend/app/api/v2/claims.py`, extend the schema import block to include the new schemas:

```python
from app.schemas.claim import (
    ClaimConflictRead,
    ClaimCreate,
    ClaimExtractionResult,
    ClaimImpact,
    ClaimImpactMap,
    ClaimRead,
    ClaimUpdate,
    ConflictDetectionResult,
    ConflictResolve,
)
```

Add `status` to the FastAPI import (it is `from fastapi import APIRouter, Depends, HTTPException, Query` today — change to add `status`):

```python
from fastapi import APIRouter, Depends, HTTPException, Query, status
```

Add this route after `list_claims` (after line ~145):

```python
@router.post(
    "/claims", response_model=ClaimRead, status_code=status.HTTP_201_CREATED
)
def create_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    payload: ClaimCreate,
    db: Annotated[Session, Depends(get_db)],
) -> Claim:
    """Create a manual claim. No citation required; source is 'manual' so the
    extraction wipe never deletes it."""
    claim = Claim(
        project_id=project.id,
        kind=payload.kind,
        subject=payload.subject,
        normalized=payload.normalized,
        confidence=None,
        source="manual",
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return claim
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: PASS (create + bad-kind + columns tests green).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/claims.py backend/tests/test_claim_crud.py
git commit -m "feat(sp7a): POST /claims creates a manual claim

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: PATCH /claims/{id} + DELETE /claims/{id} + GET impact

**Files:**
- Modify: `backend/app/api/v2/claims.py` (new routes after `create_claim`)
- Test: `backend/tests/test_claim_crud.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_claim_crud.py` (extend the existing imports with the process + input models):

```python
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)


def _seed_claim(db, proj, *, kind="task", subject="s", source="manual") -> Claim:
    claim = Claim(
        project_id=proj.id, kind=kind, subject=subject, normalized={},
        confidence=None, source=source,
    )
    db.add(claim)
    db.commit()
    return claim


def test_patch_claim_edits_fields(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj, kind="task", subject="old")
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/claims/{claim.id}",
        json={"kind": "decision", "subject": "new"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "decision"
    assert resp.json()["subject"] == "new"
    db.expire_all()
    fresh = db.get(Claim, claim.id)
    assert fresh.kind == "decision" and fresh.subject == "new"


def test_patch_claim_cross_project_404(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.patch(
        f"/api/v2/projects/{other.id}/claims/{claim.id}",
        json={"subject": "x"},
    )
    assert resp.status_code == 404, resp.text


def _seed_node_citing_claim(db, proj, claim) -> tuple[ProcessModel, ProcessNode]:
    model = ProcessModel(project_id=proj.id, name="AP Map", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Lane", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Do it",
        position={}, properties={},
    )
    db.add(node)
    db.flush()
    db.add(NodeClaimLink(node_id=node.id, claim_id=claim.id))
    db.commit()
    return model, node


def test_claim_impact_lists_affected_maps(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    model, _node = _seed_node_citing_claim(db, proj, claim)
    resp = client.get(
        f"/api/v2/projects/{proj.id}/claims/{claim.id}/impact"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["claim_id"] == str(claim.id)
    assert body["node_link_count"] == 1
    assert body["maps"] == [{"model_id": str(model.id), "name": "AP Map"}]


def test_delete_claim_cascades_links(client, db):
    proj = _seed_project(db)
    claim = _seed_claim(db, proj)
    _model, node = _seed_node_citing_claim(db, proj, claim)
    resp = client.delete(f"/api/v2/projects/{proj.id}/claims/{claim.id}")
    assert resp.status_code == 204, resp.text
    db.expire_all()
    assert db.get(Claim, claim.id) is None
    remaining = (
        db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    )
    assert remaining == 0  # FK cascade dropped the link
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: FAIL — the PATCH/DELETE/impact routes don't exist (404/405).

- [ ] **Step 3: Write the routes**

Add these to `backend/app/api/v2/claims.py` after `create_claim`. The impact query walks `NodeClaimLink → ProcessNode → ProcessVersion → ProcessModel`, scoped to this project. Add the needed model import near the top of the file (alongside the existing `from app.models.claim import ...`):

```python
from app.models.process import NodeClaimLink, ProcessModel, ProcessNode, ProcessVersion
```

```python
def _get_project_claim_or_404(claim_id: UUID, project: Project, db: Session) -> Claim:
    claim = db.get(Claim, claim_id)
    if claim is None or claim.project_id != project.id:
        raise HTTPException(status_code=404, detail="Claim not found")
    return claim


@router.patch("/claims/{claim_id}", response_model=ClaimRead)
def update_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    payload: ClaimUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> Claim:
    claim = _get_project_claim_or_404(claim_id, project, db)
    if payload.kind is not None:
        claim.kind = payload.kind
    if payload.subject is not None:
        claim.subject = payload.subject
    if payload.normalized is not None:
        claim.normalized = payload.normalized
    db.commit()
    db.refresh(claim)
    return claim


@router.get("/claims/{claim_id}/impact", response_model=ClaimImpact)
def get_claim_impact(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimImpact:
    """Which process maps would have node evidence emptied if this claim were
    deleted. Drives the frontend delete-confirm dialog."""
    claim = _get_project_claim_or_404(claim_id, project, db)
    rows = list(
        db.execute(
            select(ProcessModel.id, ProcessModel.name)
            .join(ProcessVersion, ProcessVersion.model_id == ProcessModel.id)
            .join(ProcessNode, ProcessNode.version_id == ProcessVersion.id)
            .join(NodeClaimLink, NodeClaimLink.node_id == ProcessNode.id)
            .where(
                NodeClaimLink.claim_id == claim.id,
                ProcessModel.project_id == project.id,
                ProcessModel.deleted_at.is_(None),
            )
            .distinct()
        ).all()
    )
    link_count = (
        db.scalar(
            select(func.count(NodeClaimLink.id)).where(
                NodeClaimLink.claim_id == claim.id
            )
        )
        or 0
    )
    return ClaimImpact(
        claim_id=claim.id,
        node_link_count=link_count,
        maps=[ClaimImpactMap(model_id=r[0], name=r[1]) for r in rows],
    )


@router.delete("/claims/{claim_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    claim = _get_project_claim_or_404(claim_id, project, db)
    db.delete(claim)
    db.commit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: PASS (patch + cross-project 404 + impact + delete-cascade green).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/claims.py backend/tests/test_claim_crud.py
git commit -m "feat(sp7a): PATCH/DELETE /claims + claim impact endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Fix extraction wipe (keep manual claims) + conflict-reason column

**Files:**
- Modify: `backend/app/api/v2/claims.py` (wipe at ~53-64; `run_conflict_detection` at ~200-201)
- Test: `backend/tests/test_claim_crud.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_claim_crud.py`:

```python
from app.api.v2.claims import extract_input_claims, run_conflict_detection
from app.models.claim import ClaimCitation, ClaimConflict


def _seed_input_with_chunk(db, proj) -> tuple[Input, Chunk]:
    user = db.query(User).filter(User.email == "dev@local").first()
    inp = Input(
        project_id=proj.id, type="interview_transcript", name="i.txt",
        file_path="i.txt", file_size=10, mime_type="text/plain",
        status="parsed", uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    db.add(ch)
    db.commit()
    return inp, ch


def test_extraction_wipe_keeps_manual_claims(client, db, monkeypatch):
    """A manual claim that happens to be cited on a chunk of the re-extracted
    input must survive; only extracted claims for that input are wiped."""
    import app.api.v2.claims as claims_mod

    proj = _seed_project(db)
    inp, ch = _seed_input_with_chunk(db, proj)

    extracted = _seed_claim(db, proj, subject="extracted one", source="extracted")
    manual = _seed_claim(db, proj, subject="manual one", source="manual")
    db.add(ClaimCitation(claim_id=extracted.id, chunk_id=ch.id, quote="a"))
    db.add(ClaimCitation(claim_id=manual.id, chunk_id=ch.id, quote="a"))
    db.commit()

    # Stub the LLM extractor so re-extraction adds nothing new.
    monkeypatch.setattr(claims_mod, "extract_claims_from_text", lambda text: [])

    resp = client.post(
        f"/api/v2/projects/{proj.id}/inputs/{inp.id}/extract-claims"
    )
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(Claim, extracted.id) is None  # extracted wiped
    assert db.get(Claim, manual.id) is not None  # manual preserved


def test_conflict_detection_writes_detection_reason_not_notes(client, db, monkeypatch):
    import app.api.v2.claims as claims_mod
    from app.services.conflict_detection import DetectedConflict

    proj = _seed_project(db)
    a = _seed_claim(db, proj, kind="threshold", subject="limit is 500")
    b = _seed_claim(db, proj, kind="threshold", subject="limit is 1000")
    monkeypatch.setattr(
        claims_mod,
        "detect_conflicts",
        lambda summaries: [
            DetectedConflict(
                claim_a_index=0,
                claim_b_index=1,
                kind="threshold_mismatch",
                reason="500 vs 1000",
            )
        ],
    )
    resp = client.post(f"/api/v2/projects/{proj.id}/detect-conflicts")
    assert resp.status_code == 200, resp.text
    db.expire_all()
    conflict = db.query(ClaimConflict).one()
    assert conflict.detection_reason == "500 vs 1000"
    assert conflict.resolution_notes is None  # user notes column stays free
```

(`DetectedConflict` ordering: its dataclass fields are `claim_a_index`, `claim_b_index`, `kind`, `reason` — verified in `app/services/conflict_detection.py`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: FAIL — the wipe currently deletes the manual claim (its citation matches the chunk), and the conflict row writes `resolution_notes="500 vs 1000"` with `detection_reason=None`.

- [ ] **Step 3: Fix the wipe to exclude manual claims**

In `backend/app/api/v2/claims.py`, the wipe block (~53-64) currently is:

```python
    prior_claim_ids = list(
        db.scalars(
            select(ClaimCitation.claim_id)
            .where(ClaimCitation.chunk_id.in_(chunk_ids))
            .distinct()
        ).all()
    )
    if prior_claim_ids:
        db.execute(delete(Claim).where(Claim.id.in_(prior_claim_ids)))
```

Change the `delete` to filter on `source` so manual claims are never wiped:

```python
    prior_claim_ids = list(
        db.scalars(
            select(ClaimCitation.claim_id)
            .where(ClaimCitation.chunk_id.in_(chunk_ids))
            .distinct()
        ).all()
    )
    if prior_claim_ids:
        # Only wipe claims this extractor produced — manual claims that happen
        # to cite the same chunk must survive a re-extraction.
        db.execute(
            delete(Claim).where(
                Claim.id.in_(prior_claim_ids),
                Claim.source == "extracted",
            )
        )
```

- [ ] **Step 4: Fix the conflict-detection column**

In `run_conflict_detection` (~194-203), the `ClaimConflict(...)` constructor currently passes `resolution_notes=d.reason`. Change it to write the AI reason into `detection_reason` and leave `resolution_notes` unset:

```python
        db.add(
            ClaimConflict(
                claim_a_id=a.id,
                claim_b_id=b.id,
                kind=d.kind,
                detected_by="ai",
                resolution_status=ConflictStatus.DETECTED.value,
                detection_reason=d.reason,
            )
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_claim_crud.py -q`
Expected: PASS (wipe-keeps-manual + detection-reason green; all prior claim_crud tests still green).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/claims.py backend/tests/test_claim_crud.py
git commit -m "fix(sp7a): wipe spares manual claims; AI reason → detection_reason

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: PATCH conflict resolution endpoint

**Files:**
- Modify: `backend/app/api/v2/claims.py` (new route after `list_conflicts` ~line 236)
- Test: `backend/tests/test_conflict_resolution.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_conflict_resolution.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.enums import ConflictStatus
from app.models.claim import Claim, ClaimConflict
from app.models.identity import Organization, User
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_conflict(db) -> tuple[Project, ClaimConflict]:
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    a = Claim(project_id=proj.id, kind="threshold", subject="a", normalized={}, source="extracted")
    b = Claim(project_id=proj.id, kind="threshold", subject="b", normalized={}, source="extracted")
    db.add_all([a, b])
    db.flush()
    conflict = ClaimConflict(
        claim_a_id=a.id, claim_b_id=b.id, kind="threshold_mismatch",
        detected_by="ai", resolution_status=ConflictStatus.DETECTED.value,
        detection_reason="500 vs 1000",
    )
    db.add(conflict)
    db.commit()
    return proj, conflict


def test_resolve_conflict_sets_status_and_notes(client, db):
    proj, conflict = _seed_conflict(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "resolved", "resolution_notes": "Picked 1000 per SLA"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["resolution_status"] == "resolved"
    assert body["resolution_notes"] == "Picked 1000 per SLA"
    assert body["detection_reason"] == "500 vs 1000"  # untouched
    db.expire_all()
    fresh = db.get(ClaimConflict, conflict.id)
    assert fresh.resolution_status == "resolved"


def test_resolve_conflict_rejects_bad_status(client, db):
    proj, conflict = _seed_conflict(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "bogus"},
    )
    assert resp.status_code == 422, resp.text


def test_resolve_conflict_cross_project_404(client, db):
    proj, conflict = _seed_conflict(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.patch(
        f"/api/v2/projects/{other.id}/conflicts/{conflict.id}",
        json={"resolution_status": "dismissed"},
    )
    assert resp.status_code == 404, resp.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_conflict_resolution.py -q`
Expected: FAIL — no PATCH conflict route (404/405).

- [ ] **Step 3: Write the route**

Add to `backend/app/api/v2/claims.py` after `list_conflicts`. The cross-project guard joins the conflict's `claim_a_id` to a project-scoped `Claim` (mirrors the `list_conflicts` join):

```python
@router.patch(
    "/conflicts/{conflict_id}", response_model=ClaimConflictRead
)
def resolve_conflict(
    project: Annotated[Project, Depends(get_project_or_404)],
    conflict_id: UUID,
    payload: ConflictResolve,
    db: Annotated[Session, Depends(get_db)],
) -> ClaimConflict:
    conflict = db.get(ClaimConflict, conflict_id)
    if conflict is None:
        raise HTTPException(status_code=404, detail="Conflict not found")
    # Project scope: claim_a must belong to this project.
    claim_a = db.get(Claim, conflict.claim_a_id)
    if claim_a is None or claim_a.project_id != project.id:
        raise HTTPException(status_code=404, detail="Conflict not found")
    conflict.resolution_status = payload.resolution_status
    conflict.resolution_notes = payload.resolution_notes
    db.commit()
    db.refresh(conflict)
    return conflict
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_conflict_resolution.py -q`
Expected: PASS (set + bad-status + cross-project green).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v2/claims.py backend/tests/test_conflict_resolution.py
git commit -m "feat(sp7a): PATCH /conflicts/{id} resolve/dismiss with notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Node↔claim link schemas + attach/detach endpoints

**Files:**
- Modify: `backend/app/schemas/process_map.py` (append new schemas)
- Modify: `backend/app/api/v2/process_maps.py` (new routes after `get_node_citations` ~line 875)
- Test: `backend/tests/test_node_claim_links.py`

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas/process_map.py`:

```python
class NodeClaimLinkRequest(BaseModel):
    """Body for POST /nodes/{id}/claims — attach a batch of claims as evidence."""

    claim_ids: list[UUID] = Field(min_length=1)
    link_kind: str = Field(default="evidence", max_length=20)


class NodeClaimLinkResult(BaseModel):
    node_id: UUID
    linked_claim_ids: list[UUID]
    added_count: int
    already_linked_count: int
```

- [ ] **Step 2: Write the failing tests**

```python
# backend/tests/test_node_claim_links.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_node_and_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="L", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="n",
        position={}, properties={},
    )
    db.add(node)
    db.flush()
    c1 = Claim(project_id=proj.id, kind="task", subject="c1", normalized={}, source="manual")
    c2 = Claim(project_id=proj.id, kind="task", subject="c2", normalized={}, source="manual")
    db.add_all([c1, c2])
    db.commit()
    return proj, node, c1, c2


def test_attach_claims_creates_links(client, db):
    proj, node, c1, c2 = _seed_node_and_claims(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id), str(c2.id)], "link_kind": "evidence"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["added_count"] == 2
    assert body["already_linked_count"] == 0
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 2


def test_attach_claims_idempotent(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    db.add(NodeClaimLink(node_id=node.id, claim_id=c1.id))
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id)]},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["added_count"] == 0
    assert body["already_linked_count"] == 1
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 1  # no duplicate row


def test_detach_claim_removes_link(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    db.add(NodeClaimLink(node_id=node.id, claim_id=c1.id))
    db.commit()
    resp = client.delete(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims/{c1.id}"
    )
    assert resp.status_code == 204, resp.text
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 0


def test_attach_cross_project_node_404(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{other.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id)]},
    )
    assert resp.status_code == 404, resp.text


def test_attach_rejects_claim_from_other_project(client, db):
    proj, node, _c1, _c2 = _seed_node_and_claims(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.flush()
    foreign = Claim(project_id=other.id, kind="task", subject="x", normalized={}, source="manual")
    db.add(foreign)
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(foreign.id)]},
    )
    assert resp.status_code == 422, resp.text
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_node_claim_links.py -q`
Expected: FAIL — the attach/detach routes don't exist.

- [ ] **Step 4: Write the routes**

In `backend/app/api/v2/process_maps.py`, extend the schema import block to include the two new schemas:

```python
from app.schemas.process_map import (
    # ... existing imports ...
    NodeClaimLinkRequest,
    NodeClaimLinkResult,
)
```

Add these routes after `get_node_citations` (after ~line 875). Idempotency is enforced by pre-checking existing links against the `uq_node_claim_links_node_claim` constraint (`node_id`, `claim_id`):

```python
@router.post(
    "/nodes/{node_id}/claims",
    response_model=NodeClaimLinkResult,
    status_code=status.HTTP_201_CREATED,
)
def attach_node_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeClaimLinkRequest,
    db: Annotated[Session, Depends(get_db)],
) -> NodeClaimLinkResult:
    """Attach a batch of claims to a node as evidence. Idempotent on the
    (node_id, claim_id) unique constraint — re-attaching an existing link is a
    no-op counted in already_linked_count."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    # Every claim id must belong to this project.
    requested_ids = list(dict.fromkeys(payload.claim_ids))  # de-dup, keep order
    found = {
        c.id
        for c in db.scalars(
            select(Claim).where(
                Claim.id.in_(requested_ids), Claim.project_id == project.id
            )
        ).all()
    }
    missing = [cid for cid in requested_ids if cid not in found]
    if missing:
        raise HTTPException(
            status_code=422,
            detail="One or more claim_ids do not belong to this project",
        )

    existing = set(
        db.scalars(
            select(NodeClaimLink.claim_id).where(
                NodeClaimLink.node_id == node_id,
                NodeClaimLink.claim_id.in_(requested_ids),
            )
        ).all()
    )
    added = 0
    for cid in requested_ids:
        if cid in existing:
            continue
        db.add(
            NodeClaimLink(node_id=node_id, claim_id=cid, link_kind=payload.link_kind)
        )
        added += 1
    db.commit()
    return NodeClaimLinkResult(
        node_id=node_id,
        linked_claim_ids=requested_ids,
        added_count=added,
        already_linked_count=len(requested_ids) - added,
    )


@router.delete(
    "/nodes/{node_id}/claims/{claim_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def detach_node_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)
    db.execute(
        delete(NodeClaimLink).where(
            NodeClaimLink.node_id == node_id,
            NodeClaimLink.claim_id == claim_id,
        )
    )
    db.commit()
```

(`delete`, `select`, `NodeClaimLink`, `Claim`, `ProcessNode`, and `_check_node_in_project` are all already imported/defined in `process_maps.py`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_node_claim_links.py -q`
Expected: PASS (attach + idempotent + detach + both 404/422 guards green).

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_node_claim_links.py
git commit -m "feat(sp7a): node↔claim attach (bulk/idempotent) + detach endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Extract _create_model_and_version helper (refactor, no behavior change)

**Files:**
- Modify: `backend/app/api/v2/process_maps.py` (extract from `generate_process_map` steps 4-6 ~196-259 + lineage stamping ~326-328)
- Test: `backend/tests/test_blank_map.py`

This is a pure refactor: pull the find-or-create-model / version-numbering / default-lane creation out of `generate_process_map` into a reusable helper. `generate_process_map` keeps producing identical results (its existing tests must stay green).

- [ ] **Step 1: Write the failing test for the helper**

```python
# backend/tests/test_blank_map.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.api.v2.process_maps import _create_model_and_version
from app.models.identity import Organization, User
from app.models.process import (
    ProcessLane,
    ProcessModel,
    ProcessVersion,
)
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project_and_user(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    return proj, user


def test_helper_creates_model_version_and_default_lane(db):
    proj, user = _seed_project_and_user(db)
    model, version, lane = _create_model_and_version(
        db, project=proj, name="New Map", level="L2", created_by=user.id
    )
    db.commit()
    assert model.name == "New Map"
    assert model.level == "L2"
    assert version.model_id == model.id
    assert version.version_number == 1
    assert version.parent_version_id is None
    assert lane.version_id == version.id
    assert lane.order_index == 0


def test_helper_finds_existing_model_and_bumps_version(db):
    proj, user = _seed_project_and_user(db)
    model = ProcessModel(project_id=proj.id, name="Reuse", level="L2")
    db.add(model)
    db.flush()
    v1 = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(v1)
    db.commit()

    model2, version2, _lane = _create_model_and_version(
        db, project=proj, name="Reuse", level="L2", created_by=user.id
    )
    db.commit()
    assert model2.id == model.id  # found, not duplicated
    assert version2.version_number == 2
    assert version2.parent_version_id == v1.id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_blank_map.py -q`
Expected: FAIL — `ImportError: cannot import name '_create_model_and_version'`.

- [ ] **Step 3: Add the helper**

In `backend/app/api/v2/process_maps.py`, add this helper just above `generate_process_map` (after the `_level_for_prompt` function, ~line 113). It captures find-or-create model, version numbering, lineage from the prior version, and the default lane:

```python
def _create_model_and_version(
    db: Session,
    *,
    project: Project,
    name: str,
    level: str,
    created_by: UUID,
    bpmn_xml: str | None = None,
    notes: str | None = None,
    source_segment_id: UUID | None = None,
    default_lane_name: str = "Process Team",
) -> tuple[ProcessModel, ProcessVersion, ProcessLane]:
    """Find-or-create the (project, level, name) ProcessModel, create the next
    ProcessVersion (lineage stamped from the prior top version), and one default
    lane. Shared by AI generation and blank-map creation.

    The caller is responsible for db.flush()/db.commit() and for adding nodes."""
    canonical_level = _normalize_level(level)
    model = db.scalars(
        select(ProcessModel)
        .where(
            ProcessModel.project_id == project.id,
            ProcessModel.level == canonical_level,
            ProcessModel.name == name,
            ProcessModel.deleted_at.is_(None),
        )
        .limit(1)
    ).first()
    if model is None:
        model = ProcessModel(
            project_id=project.id, name=name, level=canonical_level
        )
        db.add(model)
        db.flush()

    last_version_num = (
        db.scalar(
            select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
                ProcessVersion.model_id == model.id
            )
        )
        or 0
    )
    parent_version = db.scalars(
        select(ProcessVersion)
        .where(
            ProcessVersion.model_id == model.id,
            ProcessVersion.version_number == last_version_num,
        )
        .limit(1)
    ).first()

    version = ProcessVersion(
        model_id=model.id,
        version_number=last_version_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        bpmn_xml=bpmn_xml,
        notes=notes,
        created_by=created_by,
        source_segment_id=source_segment_id,
    )
    db.add(version)
    db.flush()

    lane = ProcessLane(version_id=version.id, name=default_lane_name, order_index=0)
    db.add(lane)
    db.flush()
    return model, version, lane
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_blank_map.py -q`
Expected: PASS (both helper tests green).

- [ ] **Step 5: Rewire generate_process_map to use the helper (keeping behavior)**

The AI path creates one lane per role, not a single default lane — so it should NOT use the helper's lane. Replace steps 4-6 in `generate_process_map` (the find-or-create model block ~196-215, the version-numbering block ~217-241, but NOT the per-role lane loop ~243-259) with a single call that passes `default_lane_name` and then deletes that scaffolding lane in favor of the role lanes. The cleanest behavior-preserving rewrite: call the helper for model+version, ignore its lane by giving the role loop ownership.

Replace the model block (~196-241) with:

```python
    # 4-5. Find-or-create ProcessModel + next ProcessVersion (shared helper).
    canonical_level = _normalize_level(payload.level)
    model, version, _default_lane = _create_model_and_version(
        db,
        project=project,
        name=structure.process_name,
        level=canonical_level,
        created_by=user.id,
        bpmn_xml=bpmn_xml,
        notes=f"Generated from {len(claims)} claim(s).",
        source_segment_id=payload.segment_id,
    )
    # The AI path builds one lane per role; drop the helper's placeholder lane.
    db.delete(_default_lane)
    db.flush()
```

The existing role-lane loop (step 6, ~243-259) is unchanged and runs next. Everything from step 7 onward is unchanged.

- [ ] **Step 6: Run the full generation regression suite**

Run: `cd backend && .venv/bin/python -m pytest tests/ -q -k "generate or process_map or map"`
Expected: PASS — the existing generation tests still pass (same model/version/lane/node/edge counts; the placeholder lane is created and deleted in the same transaction, so no role lane is affected).

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v2/process_maps.py backend/tests/test_blank_map.py
git commit -m "refactor(sp7a): extract _create_model_and_version; reuse in generate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: POST /process-maps — blank map endpoint

**Files:**
- Modify: `backend/app/schemas/process_map.py` (append `BlankMapRequest`, `BlankMapResult`)
- Modify: `backend/app/api/v2/process_maps.py` (new route after `_create_model_and_version` / `generate_process_map`)
- Test: `backend/tests/test_blank_map.py`

- [ ] **Step 1: Add the schemas**

Append to `backend/app/schemas/process_map.py`:

```python
class BlankMapRequest(BaseModel):
    """Body for POST /process-maps — create an empty editable map."""

    name: str = Field(min_length=1, max_length=300)
    level: str = Field(pattern=r"^(1|2|3|4|L1|L2|L3|L4)$")


class BlankMapResult(BaseModel):
    model_id: UUID
    version_id: UUID
    name: str
    level: str
    lane_id: UUID
    start_node_id: UUID
    end_node_id: UUID
```

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/test_blank_map.py`:

```python
from app.models.process import ProcessNode


def test_create_blank_map_endpoint(client, db):
    proj, _user = _seed_project_and_user(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/process-maps",
        json={"name": "Blank AP", "level": "2"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Blank AP"
    assert body["level"] == "L2"
    db.expire_all()
    # Model + version + one lane + Start/End nodes exist.
    model = db.get(ProcessModel, body["model_id"])
    assert model is not None and model.project_id == proj.id
    version = db.get(ProcessVersion, body["version_id"])
    assert version is not None and version.version_number == 1
    lane = db.get(ProcessLane, body["lane_id"])
    assert lane is not None and lane.version_id == version.id
    start = db.get(ProcessNode, body["start_node_id"])
    end = db.get(ProcessNode, body["end_node_id"])
    assert start.type == "event_start"
    assert end.type == "event_end"
    # Lineage key stamped on the nodes (canvas relies on it).
    from app.constants import LINEAGE_KEY
    assert start.properties.get(LINEAGE_KEY) == str(start.id)
    assert end.properties.get(LINEAGE_KEY) == str(end.id)


def test_create_blank_map_rejects_bad_level(client, db):
    proj, _user = _seed_project_and_user(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/process-maps",
        json={"name": "x", "level": "L9"},
    )
    assert resp.status_code == 422, resp.text
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_blank_map.py -q`
Expected: FAIL — no POST `/process-maps` route (the existing route is GET only).

- [ ] **Step 4: Write the route**

In `backend/app/api/v2/process_maps.py`, extend the schema import block with `BlankMapRequest, BlankMapResult`. Add the route after `generate_process_map` (before `list_process_maps`). Nodes get positioned in two columns and lineage-stamped exactly like the generation path (~310-328):

```python
@router.post(
    "/process-maps",
    response_model=BlankMapResult,
    status_code=status.HTTP_201_CREATED,
)
def create_blank_map(
    payload: BlankMapRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> BlankMapResult:
    """Create an empty, fully editable map: model + version + one default lane +
    Start and End nodes. No AI, no claims required."""
    model, version, lane = _create_model_and_version(
        db,
        project=project,
        name=payload.name,
        level=payload.level,
        created_by=user.id,
        notes="Created as a blank map.",
    )
    start = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type=NodeType.EVENT_START.value,
        name="Start",
        position={"col": 0},
        properties={"col": 0, "external_id": "Start_1"},
    )
    end = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type=NodeType.EVENT_END.value,
        name="End",
        position={"col": 1},
        properties={"col": 1, "external_id": "End_1"},
    )
    db.add(start)
    db.add(end)
    db.flush()
    for node in (start, end):
        node.properties = {**(node.properties or {}), LINEAGE_KEY: str(node.id)}
    db.flush()
    db.commit()
    return BlankMapResult(
        model_id=model.id,
        version_id=version.id,
        name=model.name,
        level=model.level,
        lane_id=lane.id,
        start_node_id=start.id,
        end_node_id=end.id,
    )
```

(`NodeType`, `LINEAGE_KEY`, `ProcessNode`, `get_current_user`, `User` are all already imported.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_blank_map.py -q`
Expected: PASS (blank-map create + bad-level + the two helper tests green).

- [ ] **Step 6: Run the full backend suite (no regressions)**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS (all SP-7a tests + every prior test green).

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas/process_map.py backend/app/api/v2/process_maps.py backend/tests/test_blank_map.py
git commit -m "feat(sp7a): POST /process-maps creates a blank editable map

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Frontend types + api client methods

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Update types**

In `src/lib/types.ts`, add `source: string;` to the `Claim` interface (after `confidence`) and `detection_reason: string | null;` to `ClaimConflict` (after `resolution_notes`):

```ts
export interface Claim {
  id: UUID;
  project_id: UUID;
  kind: string;
  subject: string;
  normalized: Record<string, unknown>;
  confidence: number | null;
  source: string;
  created_at: string;
  updated_at: string;
}
```

```ts
export interface ClaimConflict {
  id: UUID;
  claim_a_id: UUID;
  claim_b_id: UUID;
  kind: string;
  detected_by: string;
  resolution_status: string;
  resolution_notes: string | null;
  detection_reason: string | null;
  created_at: string;
}
```

Append the new interfaces at the end of `src/lib/types.ts`:

```ts
export interface ClaimCreate {
  kind: string;
  subject: string;
  normalized?: Record<string, unknown>;
}

export interface ClaimUpdate {
  kind?: string;
  subject?: string;
  normalized?: Record<string, unknown>;
}

export interface ClaimImpactMap {
  model_id: UUID;
  name: string;
}

export interface ClaimImpact {
  claim_id: UUID;
  node_link_count: number;
  maps: ClaimImpactMap[];
}

export interface ConflictResolve {
  resolution_status: string;
  resolution_notes?: string | null;
}

export interface NodeClaimLinkRequest {
  claim_ids: UUID[];
  link_kind?: string;
}

export interface NodeClaimLinkResult {
  node_id: UUID;
  linked_claim_ids: UUID[];
  added_count: number;
  already_linked_count: number;
}

export interface BlankMapRequest {
  name: string;
  level: string;
}

export interface BlankMapResult {
  model_id: UUID;
  version_id: UUID;
  name: string;
  level: string;
  lane_id: UUID;
  start_node_id: UUID;
  end_node_id: UUID;
}
```

- [ ] **Step 2: Add the api methods**

In `src/lib/api.ts`, extend the type import from `@/lib/types` to include the new types (`BlankMapRequest, BlankMapResult, ClaimCreate, ClaimImpact, ClaimUpdate, ConflictResolve, NodeClaimLinkRequest, NodeClaimLinkResult`). Then add these methods inside the `api` object.

After `listClaims` (~line 167), add:

```ts
  createClaim: (projectId: UUID, body: ClaimCreate) =>
    request<Claim>(`/api/v2/projects/${projectId}/claims`, {
      method: "POST",
      json: body,
    }),
  updateClaim: (projectId: UUID, claimId: UUID, body: ClaimUpdate) =>
    request<Claim>(`/api/v2/projects/${projectId}/claims/${claimId}`, {
      method: "PATCH",
      json: body,
    }),
  deleteClaim: (projectId: UUID, claimId: UUID) =>
    request<void>(`/api/v2/projects/${projectId}/claims/${claimId}`, {
      method: "DELETE",
    }),
  getClaimImpact: (projectId: UUID, claimId: UUID) =>
    request<ClaimImpact>(
      `/api/v2/projects/${projectId}/claims/${claimId}/impact`
    ),
```

After `listConflicts` (~line 185), add:

```ts
  resolveConflict: (projectId: UUID, conflictId: UUID, body: ConflictResolve) =>
    request<ClaimConflict>(
      `/api/v2/projects/${projectId}/conflicts/${conflictId}`,
      { method: "PATCH", json: body }
    ),
```

After `getNodeCitations` (~line 300), add:

```ts
  attachNodeClaims: (
    projectId: UUID,
    nodeId: UUID,
    body: NodeClaimLinkRequest
  ) =>
    request<NodeClaimLinkResult>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/claims`,
      { method: "POST", json: body }
    ),
  detachNodeClaim: (projectId: UUID, nodeId: UUID, claimId: UUID) =>
    request<void>(
      `/api/v2/projects/${projectId}/nodes/${nodeId}/claims/${claimId}`,
      { method: "DELETE" }
    ),
```

After `generateProcessMap` (~line 194), add:

```ts
  createBlankMap: (projectId: UUID, body: BlankMapRequest) =>
    request<BlankMapResult>(`/api/v2/projects/${projectId}/process-maps`, {
      method: "POST",
      json: body,
    }),
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean (no errors). `Claim` and `ClaimConflict` are already imported in `api.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(sp7a): frontend types + api methods for claim/conflict/link/blank-map

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Claims page — Add claim dialog, row actions, delete-impact confirm

**Files:**
- Modify: `src/app/(app)/projects/[id]/claims/page.tsx`

UI wiring — verified by `tsc` + live smoke per repo convention (no page tests).

- [ ] **Step 1: Rewrite the page with mutations, an Add-claim dialog, a source badge, and per-row edit/delete actions**

Replace the entire contents of `src/app/(app)/projects/[id]/claims/page.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { CLAIM_KINDS, type Claim, type ClaimImpact } from "@/lib/types";

const PAGE_SIZE = 50;

export default function ClaimsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Claim | null>(null);
  const [deleting, setDeleting] = useState<Claim | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["claims", id, "page", offset],
    queryFn: () => api.listClaims(id, { limit: PAGE_SIZE, offset }),
  });

  const counts: Record<string, number> = Object.fromEntries(
    CLAIM_KINDS.map((k) => [k, 0])
  );
  if (data) {
    for (const c of data.items) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  const total = data?.total ?? 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["claims", id] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Kind counts on this page (of {total} total):
        </p>
        <AddClaimDialog projectId={id} onSaved={invalidate} />
      </div>
      <div className="flex flex-wrap gap-2">
        {CLAIM_KINDS.map((k) => (
          <Badge key={k} variant="outline" className="text-xs">
            {k.replace(/_/g, " ")}: {counts[k] ?? 0}
          </Badge>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Kind</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="w-20">Source</TableHead>
              <TableHead className="w-24">Confidence</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-sm text-muted-foreground py-8"
                >
                  No claims yet. Upload documents and click &quot;Extract
                  claims&quot;, or add one manually.
                </TableCell>
              </TableRow>
            )}
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Badge variant="secondary">{c.kind.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell>{c.subject}</TableCell>
                <TableCell>
                  <Badge
                    variant={c.source === "manual" ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {c.source}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {c.confidence != null ? c.confidence.toFixed(2) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(c)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleting(c)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {data && total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground tabular-nums">
            {start}–{end} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={!hasPrev}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!hasNext}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <EditClaimDialog
          projectId={id}
          claim={editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
      {deleting && (
        <DeleteClaimDialog
          projectId={id}
          claim={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={invalidate}
        />
      )}
    </div>
  );
}

function AddClaimDialog({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>(CLAIM_KINDS[0]);
  const [subject, setSubject] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createClaim(projectId, { kind, subject: subject.trim() }),
    onSuccess: () => {
      toast.success("Claim added.");
      onSaved();
      setOpen(false);
      setSubject("");
      setKind(CLAIM_KINDS[0]);
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add claim</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a manual claim</DialogTitle>
          <DialogDescription>
            Manual claims survive re-extraction and are badged as manual.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="claim-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="claim-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAIM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="claim-subject">Subject *</Label>
            <Input
              id="claim-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Invoices over $5k require manager approval"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!subject.trim() || create.isPending}
          >
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditClaimDialog({
  projectId,
  claim,
  onClose,
  onSaved,
}: {
  projectId: string;
  claim: Claim;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(claim.kind);
  const [subject, setSubject] = useState(claim.subject);

  const update = useMutation({
    mutationFn: () =>
      api.updateClaim(projectId, claim.id, { kind, subject: subject.trim() }),
    onSuccess: () => {
      toast.success("Claim updated.");
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit claim</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="edit-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAIM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-subject">Subject *</Label>
            <Input
              id="edit-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => update.mutate()}
            disabled={!subject.trim() || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteClaimDialog({
  projectId,
  claim,
  onClose,
  onDeleted,
}: {
  projectId: string;
  claim: Claim;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { data: impact, isLoading } = useQuery<ClaimImpact>({
    queryKey: ["claim-impact", projectId, claim.id],
    queryFn: () => api.getClaimImpact(projectId, claim.id),
  });

  const del = useMutation({
    mutationFn: () => api.deleteClaim(projectId, claim.id),
    onSuccess: () => {
      toast.success("Claim deleted.");
      onDeleted();
      onClose();
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this claim?</DialogTitle>
          <DialogDescription>
            &ldquo;{claim.subject}&rdquo; — this drops its citations, node links,
            and any conflicts. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="text-sm">
          {isLoading && (
            <p className="text-muted-foreground">Checking affected maps…</p>
          )}
          {impact && impact.maps.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="font-medium text-amber-800">
                Empties node evidence in {impact.maps.length} map
                {impact.maps.length === 1 ? "" : "s"}:
              </p>
              <ul className="mt-1 list-disc pl-5 text-amber-700">
                {impact.maps.map((m) => (
                  <li key={m.model_id}>{m.name}</li>
                ))}
              </ul>
            </div>
          )}
          {impact && impact.maps.length === 0 && (
            <p className="text-muted-foreground">
              No process maps cite this claim.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => del.mutate()}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting…" : "Delete claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean. (Confirm `@/components/ui/dialog`, `input`, `label`, `select` resolve — they exist in `src/components/ui/`.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/claims/page.tsx"
git commit -m "feat(sp7a): claims page — add/edit/delete with impact confirm + source badge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Conflicts page — resolve / dismiss buttons + notes

**Files:**
- Modify: `src/app/(app)/projects/[id]/conflicts/page.tsx`

- [ ] **Step 1: Add a per-row resolution control**

In `src/app/(app)/projects/[id]/conflicts/page.tsx`, the table already renders Kind / Claim A / Claim B / Reason / Status. Change the `Reason` cell to read `c.detection_reason` (the AI reason now lives there, not in `resolution_notes`), and add a new `Resolution` column with resolve/dismiss/reopen buttons and an inline notes input.

Add the mutation + the queryClient invalidation. After the `detect` mutation block (~44), add:

```tsx
  const resolve = useMutation({
    mutationFn: (vars: {
      conflictId: string;
      resolution_status: string;
      resolution_notes: string | null;
    }) =>
      api.resolveConflict(id, vars.conflictId, {
        resolution_status: vars.resolution_status,
        resolution_notes: vars.resolution_notes,
      }),
    onSuccess: () => {
      toast.success("Conflict updated.");
      qc.invalidateQueries({ queryKey: ["conflicts", id] });
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });
```

Change the `Reason` header cell + body cell to use `detection_reason`:

```tsx
              <TableHead>Reason (AI)</TableHead>
```

```tsx
                  <TableCell className="text-sm text-muted-foreground">
                    {c.detection_reason ?? "—"}
                  </TableCell>
```

Add a `Resolution` header after `Status`:

```tsx
              <TableHead className="w-80">Resolution</TableHead>
```

And a new cell at the end of each row (after the Status cell), rendered by a small child component so each row owns its notes input:

```tsx
                  <TableCell>
                    <ResolutionControls
                      conflict={c}
                      pending={resolve.isPending}
                      onSubmit={(resolution_status, resolution_notes) =>
                        resolve.mutate({
                          conflictId: c.id,
                          resolution_status,
                          resolution_notes,
                        })
                      }
                    />
                  </TableCell>
```

Update the empty-state `colSpan` from `5` to `6`.

- [ ] **Step 2: Add the ResolutionControls component + the useState import**

At the top, change `import { useParams } ...` to also bring `useState`:

```tsx
import { useState } from "react";
```

Add `ClaimConflict` to the types import (or import the type) — at the top:

```tsx
import type { ClaimConflict } from "@/lib/types";
```

Add this component at the bottom of the file:

```tsx
function ResolutionControls({
  conflict,
  pending,
  onSubmit,
}: {
  conflict: ClaimConflict;
  pending: boolean;
  onSubmit: (status: string, notes: string | null) => void;
}) {
  const [notes, setNotes] = useState(conflict.resolution_notes ?? "");
  const isOpen = conflict.resolution_status === "detected";
  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Resolution notes (optional)"
        className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
      />
      <div className="flex gap-1">
        {isOpen ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onSubmit("resolved", notes.trim() || null)}
            >
              Resolve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onSubmit("dismissed", notes.trim() || null)}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onSubmit("detected", notes.trim() || null)}
          >
            Reopen
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/projects/[id]/conflicts/page.tsx"
git commit -m "feat(sp7a): conflicts page — resolve/dismiss/reopen with notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Properties panel — resolve conflicts + attach/detach claims

**Files:**
- Modify: `src/components/canvas/properties-panel.tsx` (`IssueCard` ~522-549; Provenance section ~329-374)

- [ ] **Step 1: Add resolve/dismiss to IssueCard**

`IssueCard` currently takes only `{ issue }`. Thread a `projectId` and an invalidator down to it so it can call `api.resolveConflict`. At the render site (~319-321), change:

```tsx
                  {issues.map((iss) => (
                    <IssueCard
                      key={iss.conflict_id}
                      issue={iss}
                      projectId={projectId}
                      onResolved={() => {
                        qc.invalidateQueries({
                          queryKey: ["node-issues", projectId, selected.id],
                        });
                      }}
                    />
                  ))}
```

Add `useMutation` + `useQueryClient` to the react-query import at the top:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
```

In the `PropertiesPanel` component body, near the other hooks (~72), add:

```tsx
  const qc = useQueryClient();
```

Update `IssueCard` to take the new props and render resolve/dismiss buttons:

```tsx
function IssueCard({
  issue,
  projectId,
  onResolved,
}: {
  issue: NodeIssueDetail;
  projectId: UUID;
  onResolved: () => void;
}) {
  const kindLabel =
    CONFLICT_KIND_LABEL[issue.kind] ?? issue.kind.replace(/_/g, " ");
  const resolve = useMutation({
    mutationFn: (status: string) =>
      api.resolveConflict(projectId, issue.conflict_id, {
        resolution_status: status,
      }),
    onSuccess: onResolved,
  });
  return (
    <li className="rounded-md border border-rose-200 bg-white px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700">
          {kindLabel}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">
          {issue.detected_by}
        </span>
      </div>
      <div className="mt-1 space-y-1">
        <ClaimLine label="This step" claim={issue.this_claim} />
        <div className="pl-3 text-[9px] uppercase tracking-wider text-rose-500">
          ↕ vs.
        </div>
        <ClaimLine label="Other claim" claim={issue.other_claim} />
      </div>
      {issue.resolution_notes && (
        <div className="mt-1.5 rounded border-l-2 border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10.5px] italic text-slate-600">
          {issue.resolution_notes}
        </div>
      )}
      <div className="mt-1.5 flex gap-1">
        <button
          type="button"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate("resolved")}
          className="flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
        >
          Resolve
        </button>
        <button
          type="button"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate("dismissed")}
          className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
```

(Resolving/dismissing flips the conflict off `detected`, so the canvas badge — which filters `DETECTED` — disappears on the next issues refetch. No canvas change needed.)

- [ ] **Step 2: Add attach/detach in the Provenance section**

The Provenance section (~329-374) lists `CitationCard`s. Add (a) a detach control per linked claim and (b) an "Attach claim" button opening a picker dialog. The simplest non-invasive change: render a small "Attach claim" button in the Provenance header area and a detach "×" on each claim group.

Because `getNodeCitations` returns claims grouped (`data.claims`), add a detach button keyed by `claim.id`. Inside the Provenance `<div>` (after the `<button>` toggle header, ~349), add the attach trigger and the per-claim detach. Replace the provenance body `{provenanceExpanded && (...)}` block with:

```tsx
        {provenanceExpanded && (
          <div className="mt-1.5 space-y-2">
            <button
              type="button"
              onClick={() => setAttachOpen(true)}
              className="w-full rounded-md border border-dashed border-slate-300 px-2 py-1 text-[10.5px] font-semibold text-slate-500 hover:border-violet-300 hover:text-violet-700"
            >
              + Attach claim
            </button>
            {isLoading && (
              <div className="text-[11px] italic text-slate-400">Loading…</div>
            )}
            {!isLoading && claims.length === 0 && (
              <div className="text-[11px] italic text-slate-400">
                No source citations for this node.
              </div>
            )}
            {claims.map((claim) => (
              <div key={claim.id} className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[10.5px] font-medium text-slate-600">
                    {claim.subject}
                  </span>
                  <button
                    type="button"
                    title="Detach this claim from the node"
                    disabled={detach.isPending}
                    onClick={() => detach.mutate(claim.id)}
                    className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {claim.citations.map((cit) => (
                    <CitationCard
                      key={cit.citation_id}
                      kind={claim.kind}
                      citation={cit}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
```

Add the detach mutation + attach-dialog state near the other hooks (~86):

```tsx
  const [attachOpen, setAttachOpen] = useState(false);
  const detach = useMutation({
    mutationFn: (claimId: UUID) =>
      api.detachNodeClaim(projectId, selected.id, claimId),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["node-citations", projectId, selected.id],
      }),
  });
```

Render the picker dialog at the end of the component (just before the final closing `</div>` that ends the panel, after the Stakeholder Review block / before `{/* end scrollable body */}`):

```tsx
      {attachOpen && (
        <AttachClaimDialog
          projectId={projectId}
          nodeId={selected.id}
          linkedClaimIds={new Set(claims.map((c) => c.id))}
          onClose={() => setAttachOpen(false)}
          onAttached={() =>
            qc.invalidateQueries({
              queryKey: ["node-citations", projectId, selected.id],
            })
          }
        />
      )}
```

- [ ] **Step 3: Add the AttachClaimDialog component**

Add this component at the bottom of `properties-panel.tsx`. It lists all project claims (paged at 500), offers a simple kind filter (no text search), and attaches the selected ones via `api.attachNodeClaims`:

```tsx
function AttachClaimDialog({
  projectId,
  nodeId,
  linkedClaimIds,
  onClose,
  onAttached,
}: {
  projectId: UUID;
  nodeId: UUID;
  linkedClaimIds: Set<UUID>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<UUID>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ["attach-claims", projectId],
    queryFn: () => api.listClaims(projectId, { limit: 500 }),
  });
  const attach = useMutation({
    mutationFn: () =>
      api.attachNodeClaims(projectId, nodeId, {
        claim_ids: Array.from(selected),
        link_kind: "evidence",
      }),
    onSuccess: () => {
      onAttached();
      onClose();
    },
  });

  const kinds = Array.from(
    new Set((data?.items ?? []).map((c) => c.kind))
  ).sort();
  const visible = (data?.items ?? []).filter(
    (c) => !linkedClaimIds.has(c.id) && (kindFilter === "all" || c.kind === kindFilter)
  );

  const toggle = (cid: UUID) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[420px] flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-sm font-semibold text-slate-800">
            Attach claims to this node
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            ×
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
          <label className="text-[11px] text-slate-500">Kind</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {isLoading && (
            <div className="text-[11px] italic text-slate-400">Loading…</div>
          )}
          {!isLoading && visible.length === 0 && (
            <div className="py-6 text-center text-[11px] text-slate-400">
              No unlinked claims for this filter.
            </div>
          )}
          <ul className="space-y-1">
            {visible.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-2 py-1.5 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] uppercase tracking-wide text-slate-400">
                      {c.kind.replace(/_/g, " ")}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-slate-700">
                      {c.subject}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || attach.isPending}
            onClick={() => attach.mutate()}
            className="rounded-md bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {attach.isPending ? "Attaching…" : `Attach ${selected.size || ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean. (`api`, `useQuery`, `UUID` are already imported; `useMutation`/`useQueryClient` were added in Step 1.)

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/properties-panel.tsx
git commit -m "feat(sp7a): properties panel — resolve conflicts + attach/detach claims

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: Maps page — "New blank map" button

**Files:**
- Modify: `src/app/(app)/projects/[id]/maps/page.tsx`

- [ ] **Step 1: Add the blank-map dialog + button beside Generate map**

In `src/app/(app)/projects/[id]/maps/page.tsx`, add a `NewBlankMapButton` next to `<GenerateMapForm projectId={id} />` in the header row. Change the header `<div>`:

```tsx
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated process maps for this project. Each map can have multiple
          versions; clicking opens the latest.
        </p>
        <div className="flex gap-2">
          <NewBlankMapButton projectId={id} />
          <GenerateMapForm projectId={id} />
        </div>
      </div>
```

Add imports at the top:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

(`useQuery` is already imported; merge the react-query import rather than duplicating. `useRouter` is already imported.)

Add the component at the bottom of the file:

```tsx
const BLANK_LEVELS = [
  { value: "1", label: "L1 — Process Landscape" },
  { value: "2", label: "L2 — Cross-Functional" },
  { value: "3", label: "L3 — Detailed Operational" },
  { value: "4", label: "L4 — Work Instruction" },
];

function NewBlankMapButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("2");

  const create = useMutation({
    mutationFn: () =>
      api.createBlankMap(projectId, { name: name.trim(), level }),
    onSuccess: (res) => {
      toast.success(`Created blank map "${res.name}".`);
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      setOpen(false);
      setName("");
      router.push(
        `/projects/${projectId}/maps/${res.model_id}/versions/${res.version_id}`
      );
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">New blank map</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New blank map</DialogTitle>
          <DialogDescription>
            Creates an empty map with Start and End nodes. No AI, no claims
            required — you build it on the canvas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="blank-name">Name *</Label>
            <Input
              id="blank-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Order to Cash"
              maxLength={300}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="blank-level">Level</Label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger id="blank-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLANK_LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/maps/page.tsx"
git commit -m "feat(sp7a): maps page — New blank map button routes into the canvas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification

**Files:** none (gates only)

- [ ] **Step 1: Full backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all pass — the four new test files (`test_claim_crud.py`, `test_conflict_resolution.py`, `test_node_claim_links.py`, `test_blank_map.py`) plus every prior test (notably the existing generation tests, which exercise the refactored `_create_model_and_version` path).

- [ ] **Step 2: Frontend type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Frontend unit tests**

Run: `npx vitest run`
Expected: all pass (no new `.test.ts` were added in this slice — the new logic is endpoint/UI, not pure functions — so the existing suite must stay green and unbroken).

- [ ] **Step 4: Lint (advisory)**

Run: `npm run lint`
Expected: no NEW errors in SP-7a files (the repo ships with ~7 pre-existing lint errors in untouched files; do not introduce new ones).

- [ ] **Step 5: Dev DB migration**

Run: `cd backend && .venv/bin/alembic upgrade head`
Expected: applies `0008`. Required before smoking — the hot-reloading dev backend 500s on `claims.source` / `claim_conflicts.detection_reason` until this runs.

- [ ] **Step 6: Live smoke (manual, document in the outcome)**

With the backend and frontend dev servers running, and a project that has some extracted claims and at least one map:

1. **Claim CRUD:** Claims tab → "Add claim" (kind + subject) → row appears with a `manual` source badge. Edit it (change kind/subject) → persists. Delete a claim that's cited by a map → the confirm dialog names the affected map(s); confirm → row gone, and the map's node loses that evidence.
2. **Re-extraction preserves manual:** add a manual claim, re-run extract-claims on a document → the manual claim survives; extracted claims for that input are refreshed.
3. **Conflict resolution:** Conflicts tab → run detection (needs `ANTHROPIC_API_KEY`) → a row shows the AI reason under "Reason (AI)" → click Resolve with a note → status flips to `resolved`, note saved; Reopen restores `detected`.
4. **Canvas conflict resolve:** open a map, select a node with an issue badge → Issues panel shows the conflict → click Resolve → badge disappears after refetch.
5. **Node↔claim links:** on a selected node, Provenance → "+ Attach claim" → pick claims (filter by kind) → Attach → they appear with citations; click "×" to detach → gone.
6. **Blank map:** Maps tab → "New blank map" (name + level) → routes straight into the canvas with one lane and Start/End nodes, fully editable.

Note pass/gaps in the plan's outcome section. If `ANTHROPIC_API_KEY` is unavailable locally, smoke steps 1, 2, 5, 6 (no AI needed) and exercise conflict resolution by seeding a conflict row directly.

---

## Self-review (author)

**Spec coverage (Phase 1, sections 1.1–1.4):**
- 1.1 Claim CRUD: POST/PATCH/DELETE → Tasks 3, 4. `source` column + manual claims survive re-extraction → Tasks 1, 5. Delete names affected maps (impact endpoint) → Task 4 + Task 11 confirm dialog. Conflict-reason bug fix (`detection_reason`) → Tasks 1, 5. UI row actions + Add dialog → Task 11. ✅
- 1.2 Conflict resolution: PATCH endpoint with `ConflictStatus` validation → Task 6. UI on conflicts page → Task 12; in node Issues panel → Task 13. Canvas badge filters `DETECTED` already, so no canvas change beyond the buttons. ✅
- 1.3 Node↔claim links: bulk idempotent POST + DELETE, reusing `_check_node_in_project` and `uq_node_claim_links_node_claim` → Task 7. UI attach picker / detach in Provenance → Task 13. ✅
- 1.4 Blank maps: `_create_model_and_version` extraction (reused by generation) → Task 8; POST `/process-maps` → Task 9; UI button → Task 14. ✅

**Verified against the code (no guesses):**
- Wipe at `claims.py:53-64` selects prior claims by `ClaimCitation.chunk_id.in_(chunk_ids)` then deletes by id — Task 5 adds `Claim.source == "extracted"` to the delete. ✅
- `run_conflict_detection` writes `resolution_notes=d.reason` at `claims.py:201` — Task 5 changes it to `detection_reason=d.reason`. `DetectedConflict` fields confirmed (`claim_a_index, claim_b_index, kind, reason`). ✅
- `generate_process_map` model/version/lane blocks at `process_maps.py:196-259` and lineage stamping at `326-328` — Task 8 extracts them; the per-role lane loop is preserved by deleting the helper's placeholder lane (the AI path is multi-lane, the blank path single-lane). ✅
- `_check_node_in_project(node, project_id, db)` at `process_maps.py:469`; `get_node_citations` at `791` — link endpoints sit beside it. ✅
- `ProcessNode` manual creation uses `position={"x":..,"relative_y":..}` (palette path) but the generation path uses `position={"col":..}`; the blank map uses `{"col":0/1}` to match the generation/canvas column layout. ✅
- Migration head is `0007_lane_color_collapsed`; `0008` chains off it. Migration style (server_default, add_column/drop_column) mirrors `0007`. ✅
- Test pattern follows `test_node_lane_editing.py` (TestClient + `client` fixture overriding `get_db`, dev user `dev@local` for the project-scoping dep). ✅
- Frontend UI primitives (`dialog`, `input`, `label`, `select`, `textarea`, `button`, `badge`, `table`) all exist in `src/components/ui/`. ✅

**Deviations (intentional, called out):**
1. **Conflicts page "Reason" column now reads `detection_reason`,** not `resolution_notes` — because Task 5 moves the AI reason to its own column. The old page showed `resolution_notes`, which after the fix would be empty for AI-detected conflicts. This is the correct follow-through of the bug fix, not a regression.
2. **Attach-claim picker is a hand-rolled overlay,** not the shadcn `Dialog`, because it lives inside the canvas properties panel (already an absolutely-positioned surface) and needs a scrollable checkbox list — simpler than nesting a Dialog portal inside the panel. Behavior is the same; it's closeable via backdrop/×/Cancel.
3. **No Vitest tests added.** Every new piece is either an endpoint (covered by pytest) or JSX UI (repo convention: `tsc` + smoke). There's no new pure-logic module to unit-test — consistent with the SP-6 precedent where pages were smoke-verified.

**Placeholder scan:** none. Every code step shows complete code. No "TBD" / "similar to Task N" / test-less endpoint steps.
